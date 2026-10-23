import type { Candle } from "./types.js";
import { priceAction, volumeVs7dAvg, rsi, smaCrossover, momentumTrigger } from "./indicators.js";
import { MOMENTUM_THRESHOLD_PCT } from "./types.js";

// Alpaca Market Data API (data.alpaca.markets) - free IEX-feed tier.
// UNVERIFIED AGAINST LIVE ALPACA as of this writing: this environment
// doesn't have ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY set yet, and
// data.alpaca.markets isn't allowlisted in this environment's network
// policy (only api.kraken.com is, inherited from the live trading
// branches - see CLAUDE.md). Built against Alpaca's documented request/
// response shape; must be live-smoke-tested the moment credentials and
// network access exist, same discipline this project already applies to
// anything built against a doc instead of a live call (see the live
// Kraken branch's kraken-private.ts history).
const ALPACA_DATA_BASE = "https://data.alpaca.markets/v2";

export class AlpacaApiError extends Error {}

function authHeaders(): Record<string, string> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) {
    throw new AlpacaApiError(
      "ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set in this environment. Stock data is unavailable until a free Alpaca market-data API key is created and set as env vars on this environment (see CLAUDE.md's credential-setup section)."
    );
  }
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
}

export type AlpacaTimeframe = "1Day" | "1Hour";

interface AlpacaBarRaw {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
}

function toCandle(raw: AlpacaBarRaw): Candle {
  return {
    time: Math.floor(new Date(raw.t).getTime() / 1000),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    vwap: raw.vw ?? raw.c,
    volume: raw.v,
    count: raw.n ?? 0,
  };
}

// Alpaca's bars endpoint defaults to a narrow recent window (effectively
// just today) when no `start` is given - confirmed live 2026-10-23:
// requesting limit=30 with no start/end returned exactly 1 bar (today's),
// not 30. `limit` alone does not backfill history; an explicit `start` is
// required. Computed generously (3x the requested bar count in calendar
// days, minimum 90) to comfortably cover weekends/holidays for daily bars.
function startParamFor(limit: number, timeframe: AlpacaTimeframe): string {
  const calendarDaysBack = timeframe === "1Day" ? Math.max(limit * 3, 90) : Math.max(limit, 14);
  const start = new Date(Date.now() - calendarDaysBack * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

// Fetches daily bars for a single symbol, oldest-first, up to `limit` most
// recent closed trading days. Alpaca's /stocks/bars endpoint already only
// returns completed bars for historical ranges (no "still forming" bar to
// drop, unlike Kraken's OHLC endpoint).
export async function fetchStockBars(symbol: string, timeframe: AlpacaTimeframe, limit = 60): Promise<Candle[]> {
  const url = new URL(`${ALPACA_DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", startParamFor(limit, timeframe));
  url.searchParams.set("adjustment", "split"); // split-adjusted so a historical RSI/SMA read isn't skewed by a split that happened mid-window

  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    throw new AlpacaApiError(`Alpaca bars HTTP ${res.status} for ${symbol}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { bars: AlpacaBarRaw[] };
  return (body.bars ?? []).map(toCandle);
}

// Fetches daily bars for many symbols in one call where Alpaca's multi-
// symbol endpoint allows it, paging through next_page_token. Batches the
// symbol list to stay under Alpaca's documented per-request symbol cap
// (conservatively batched at 100 - verify against Alpaca's actual current
// limit once live, not yet confirmed).
const MULTI_SYMBOL_BATCH_SIZE = 100;

// screen_sp500's full ~500-ticker scan hit Alpaca's free-tier rate limit
// (HTTP 429) confirmed live 2026-10-23, once the CSV/ticker-normalization
// bugs that were silently truncating the real request were fixed. Two
// mitigations: a small fixed pacing delay between requests (both batches
// and pagination pages) so a full scan doesn't fire its ~5-10 requests
// back-to-back, and a real retry-with-backoff on 429 specifically -
// honoring the Retry-After header when Alpaca sends one, falling back to
// exponential backoff (1s, 2s, 4s) otherwise. Not yet re-verified live
// against the actual 429 (this fix was written same-day but the
// environment's verification sessions were tied up elsewhere) - the
// pacing delay and backoff values are reasonable defaults, not tuned
// against Alpaca's actual published rate-limit numbers; revisit if a 429
// still gets through.
const INTER_REQUEST_DELAY_MS = 350;
const MAX_429_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRateLimitRetry(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status !== 429) return res;
    if (attempt === MAX_429_RETRIES) return res; // give up, let the caller surface the final 429

    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const backoffMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 1000 * 2 ** attempt;
    await sleep(backoffMs);
  }
  // Unreachable (loop always returns), but keeps TypeScript's control-flow analysis happy.
  throw new AlpacaApiError("Alpaca rate-limit retry loop exited unexpectedly");
}

export async function fetchMultiStockBars(
  symbols: string[],
  timeframe: AlpacaTimeframe,
  limit = 60
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();

  for (let i = 0; i < symbols.length; i += MULTI_SYMBOL_BATCH_SIZE) {
    const batch = symbols.slice(i, i + MULTI_SYMBOL_BATCH_SIZE);
    let pageToken: string | undefined;

    do {
      const url = new URL(`${ALPACA_DATA_BASE}/stocks/bars`);
      url.searchParams.set("symbols", batch.join(","));
      url.searchParams.set("timeframe", timeframe);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("start", startParamFor(limit, timeframe));
      url.searchParams.set("adjustment", "split");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const res = await fetchWithRateLimitRetry(url.toString(), authHeaders());
      if (!res.ok) {
        throw new AlpacaApiError(`Alpaca multi-bars HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const body = (await res.json()) as { bars: Record<string, AlpacaBarRaw[]>; next_page_token: string | null };
      for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
        const existing = out.get(symbol) ?? [];
        out.set(symbol, existing.concat(bars.map(toCandle)));
      }
      pageToken = body.next_page_token ?? undefined;
      if (pageToken) await sleep(INTER_REQUEST_DELAY_MS);
    } while (pageToken);

    if (i + MULTI_SYMBOL_BATCH_SIZE < symbols.length) await sleep(INTER_REQUEST_DELAY_MS);
  }

  return out;
}

export interface StockSignalReport {
  symbol: string;
  as_of: string;
  current_price: number;
  price_action_1d_5d: ReturnType<typeof priceAction> | null;
  price_action_1d_20d: ReturnType<typeof priceAction> | null;
  volume: ReturnType<typeof volumeVs7dAvg> | null;
  rsi_14_1d: number | null;
  sma_crossover_1d: ReturnType<typeof smaCrossover> | null;
  momentum_trigger: ReturnType<typeof momentumTrigger>;
  data_gaps: string[];
}

// Deliberately reuses the exact same indicator functions
// (priceAction/volumeVs7dAvg/rsi/smaCrossover/momentumTrigger) the crypto
// side uses - they already operate on generic Candle[] data, not
// anything Kraken-specific, so "similar metrics to what we have today for
// crypto" (the user's own framing) falls out directly rather than being a
// separate reimplementation to keep in sync.
//
// No order-book-imbalance equivalent: Alpaca's free IEX-feed tier doesn't
// include L2 depth. Always reported as a data_gap rather than omitted
// silently, matching this project's fail-safe/flag-the-gap convention.
export async function computeStockSignals(symbol: string): Promise<StockSignalReport> {
  const dataGaps: string[] = ["Order-book imbalance not available (Alpaca free/IEX tier has no L2 depth data)."];

  const dailyBars = await fetchStockBars(symbol, "1Day", 40);
  if (dailyBars.length === 0) {
    throw new AlpacaApiError(`No daily bars returned for ${symbol} - check the symbol is valid and markets have been open.`);
  }
  const currentPrice = dailyBars[dailyBars.length - 1].close;

  let pa5d: ReturnType<typeof priceAction> | null = null;
  if (dailyBars.length >= 6) pa5d = priceAction(dailyBars.slice(-5), 120);
  else dataGaps.push("Not enough daily bars for a 5-trading-day price-action read.");

  let pa20d: ReturnType<typeof priceAction> | null = null;
  if (dailyBars.length >= 21) pa20d = priceAction(dailyBars.slice(-20), 480);
  else dataGaps.push("Not enough daily bars for a 20-trading-day price-action read.");

  const closes = dailyBars.map((c) => c.close);
  const rsiSeries = rsi(closes, 14);
  const rsiValue = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : null;
  if (rsiValue === null) dataGaps.push("Not enough daily history for a reliable 14-period RSI (need 15+ bars).");

  const crossover = smaCrossover(closes, 20, 50);
  if (!crossover) dataGaps.push("Not enough daily history for a 20/50 SMA crossover read (need 51+ bars - request more history than the default 40-bar fetch if this matters).");

  const volumeSignal = volumeVs7dAvg(dailyBars);
  if (!volumeSignal) dataGaps.push("Not enough daily bars for a 7-day volume average (need 8+).");

  return {
    symbol,
    as_of: new Date().toISOString(),
    current_price: currentPrice,
    price_action_1d_5d: pa5d,
    price_action_1d_20d: pa20d,
    volume: volumeSignal,
    rsi_14_1d: rsiValue,
    sma_crossover_1d: crossover,
    momentum_trigger: momentumTrigger(pa5d, pa20d, MOMENTUM_THRESHOLD_PCT),
    data_gaps: dataGaps,
  };
}

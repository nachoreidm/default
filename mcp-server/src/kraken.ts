import type { AllowedPair, Candle, OrderBook, Ticker } from "./types.js";
import { ALLOWED_PAIRS, isAllowedPair } from "./types.js";

const KRAKEN_API_BASE = "https://api.kraken.com/0/public";

// LIVE TRADING - EUR pair codes, confirmed live against Kraken's Ticker
// endpoint 2026-09-21 (see CLAUDE.md's live-build decision log). Kraken
// nests BTC/ETH/XRP's responses under legacy X/Z-prefixed keys (XXBTZEUR,
// XETHZEUR, XXRPZEUR) while the others key directly - firstResultKey()
// below already handles either case generically, no special-casing needed.
const PAIR_CODE: Record<AllowedPair, string> = {
  "BTC/EUR": "XBTEUR",
  "ETH/EUR": "ETHEUR",
  "SOL/EUR": "SOLEUR",
  "XRP/EUR": "XRPEUR",
  "ADA/EUR": "ADAEUR",
  "LINK/EUR": "LINKEUR",
  "SUI/EUR": "SUIEUR",
};

export const INTERVAL_MINUTES = {
  "1h": 60,
  "4h": 240,
  "1d": 1440,
} as const;
export type IntervalKey = keyof typeof INTERVAL_MINUTES;

export class KrakenApiError extends Error {}

function assertAllowedPair(pair: string): AllowedPair {
  if (!isAllowedPair(pair)) {
    throw new KrakenApiError(
      `Pair "${pair}" is out of scope. This agent is only authorized to look at: ${ALLOWED_PAIRS.join(", ")}.`
    );
  }
  return pair;
}

async function krakenFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${KRAKEN_API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    throw new KrakenApiError(`Kraken API HTTP ${res.status} for ${path}`);
  }
  const body = (await res.json()) as { error: string[]; result: T };
  if (body.error && body.error.length > 0) {
    throw new KrakenApiError(`Kraken API error for ${path}: ${body.error.join(", ")}`);
  }
  return body.result;
}

// Kraken nests the pair's data under an exchange-internal key (e.g.
// "XXBTZUSD") that doesn't match the altname we queried with, plus a "last"
// key on OHLC responses. Grab whichever key isn't "last".
function firstResultKey(result: Record<string, unknown>): string {
  const keys = Object.keys(result).filter((k) => k !== "last");
  if (keys.length === 0) {
    throw new KrakenApiError("Kraken response contained no pair data");
  }
  return keys[0];
}

// Exposes the pair-code lookup for callers that need to place real orders
// (kraken-private.ts's AddOrder needs Kraken's own pair code, e.g.
// "XBTEUR" for "BTC/EUR") - avoids duplicating the PAIR_CODE table.
export function pairCode(pair: AllowedPair): string {
  return PAIR_CODE[pair];
}

export async function fetchOHLC(pair: string, interval: IntervalKey): Promise<Candle[]> {
  const p = assertAllowedPair(pair);
  const result = await krakenFetch<Record<string, unknown>>("OHLC", {
    pair: PAIR_CODE[p],
    interval: String(INTERVAL_MINUTES[interval]),
  });
  const key = firstResultKey(result);
  const rows = result[key] as string[][];
  return rows.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    vwap: Number(r[5]),
    volume: Number(r[6]),
    count: Number(r[7]),
  }));
}

// Drops the final candle, which Kraken reports even while it's still
// forming (i.e. not a closed bar yet) - indicators should only use closed
// candles.
export function closedCandles(candles: Candle[]): Candle[] {
  return candles.slice(0, -1);
}

export async function fetchTicker(pair: string): Promise<Ticker> {
  const p = assertAllowedPair(pair);
  const result = await krakenFetch<Record<string, any>>("Ticker", { pair: PAIR_CODE[p] });
  const key = firstResultKey(result);
  const t = result[key];
  return {
    pair: p,
    ask: Number(t.a[0]),
    bid: Number(t.b[0]),
    last: Number(t.c[0]),
    volume24h: Number(t.v[1]),
    vwap24h: Number(t.p[1]),
    low24h: Number(t.l[1]),
    high24h: Number(t.h[1]),
  };
}

export interface PairPrecision {
  priceDecimals: number;
  volumeDecimals: number;
}

// Kraken's per-pair price/volume tick sizes vary (e.g. BTC/EUR prices are
// whole-euro-plus-1-decimal, SUI/EUR volumes are 5 decimals not 8) - an
// incident on 2026-09-25 showed formatPrice/formatVolume in
// portfolio-live.ts assuming a flat 8 decimals for every pair, which
// Kraken's AddOrder rejected for SOL/EUR's trailing-stop price and left
// that position's stop order cancelled with no replacement placed (see
// CLAUDE.md). Fetched here from Kraken's public AssetPairs endpoint (same
// api.kraken.com host already allowlisted) and cached per pair for the
// process lifetime - these tick sizes don't change within a session.
const pairPrecisionCache = new Map<AllowedPair, PairPrecision>();

export async function fetchPairPrecision(pair: string): Promise<PairPrecision> {
  const p = assertAllowedPair(pair);
  const cached = pairPrecisionCache.get(p);
  if (cached) return cached;

  const result = await krakenFetch<Record<string, any>>("AssetPairs", { pair: PAIR_CODE[p] });
  const key = firstResultKey(result);
  const info = result[key];
  const precision: PairPrecision = {
    priceDecimals: Number(info.pair_decimals),
    volumeDecimals: Number(info.lot_decimals),
  };
  pairPrecisionCache.set(p, precision);
  return precision;
}

export async function fetchDepth(pair: string, count = 10): Promise<OrderBook> {
  const p = assertAllowedPair(pair);
  const result = await krakenFetch<Record<string, any>>("Depth", {
    pair: PAIR_CODE[p],
    count: String(count),
  });
  const key = firstResultKey(result);
  const d = result[key];
  const toLevels = (rows: string[][]) =>
    rows.map((r) => ({ price: Number(r[0]), volume: Number(r[1]) }));
  return { pair: p, bids: toLevels(d.bids), asks: toLevels(d.asks) };
}

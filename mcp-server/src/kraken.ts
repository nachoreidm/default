import type { AllowedPair, Candle, OrderBook, Ticker } from "./types.js";
import { ALLOWED_PAIRS, isAllowedPair } from "./types.js";

const KRAKEN_API_BASE = "https://api.kraken.com/0/public";

const PAIR_CODE: Record<AllowedPair, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
  "POL/USD": "POLUSD",
  "XRP/USD": "XRPUSD",
};

export const INTERVAL_MINUTES = {
  "1h": 60,
  "4h": 240,
  "1d": 1440,
} as const;
export type IntervalKey = keyof typeof INTERVAL_MINUTES;

class KrakenApiError extends Error {}

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

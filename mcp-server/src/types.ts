// ADVISORY AGENT - crypto side reuses the live Kraken trading branch's
// 8-pair EUR list verbatim (not the original paper-trading USD 7-pair
// list this file was forked from) - per the user's explicit 2026-10-23
// decision to keep the same proven-liquid pairs now that there's no
// position-count/execution-risk reason to widen or narrow the list. See
// this repo's CLAUDE.md for the full re-screen history behind this list.
export const ALLOWED_PAIRS = [
  "BTC/EUR",
  "ETH/EUR",
  "SOL/EUR",
  "XRP/EUR",
  "ADA/EUR",
  "LINK/EUR",
  "SUI/EUR",
  "LTC/EUR",
] as const;
export type AllowedPair = (typeof ALLOWED_PAIRS)[number];

export function isAllowedPair(pair: string): pair is AllowedPair {
  return (ALLOWED_PAIRS as readonly string[]).includes(pair);
}

export interface Candle {
  time: number; // unix seconds, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  count: number;
}

export interface Ticker {
  pair: AllowedPair;
  ask: number;
  bid: number;
  last: number;
  volume24h: number;
  vwap24h: number;
  low24h: number;
  high24h: number;
}

export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface OrderBook {
  pair: AllowedPair;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

// Advisory confidence tiers - this agent only ever recommends, it never
// sizes or executes anything, so this is purely a label on how strong the
// signal confluence is, not an input to a position-sizing formula like the
// live trading branches used.
export type Confidence = "low" | "medium" | "high";

// A 48h price move at or above this, on either the 1h or 4h window, flags
// compute_signals' momentum_trigger. Calibrated against a real missed
// move (2026-09-13, XRP ran 3.84% -> 5.22% on genuine CLARITY Act news
// while RSI/SMA/volume all stayed unremarkable) - 6% catches a genuine
// breakout while filtering ordinary day-to-day crypto noise.
export const MOMENTUM_THRESHOLD_PCT = 6;

// Momentum alone isn't confirmed by anything else the way a crossover,
// RSI extreme, or volume spike is - so a recommendation whose ONLY
// supporting signal is momentum_trigger.flagged (no other signal present)
// should never be labeled "high" confidence. Enforced nowhere in code here
// (there's no portfolio_open_position gate to enforce it against, since
// this agent never opens anything) - it's a rule for the daily-report
// write-up itself, documented in instructions/market-advisory-
// instructions.md.
export const MOMENTUM_ONLY_MAX_CONFIDENCE: Confidence = "medium";

// --- Stock-side types (Alpaca market data + SEC EDGAR) ---

export interface StockBar {
  symbol: string;
  bar: Candle; // same OHLCV(+vwap/count) shape Alpaca's bars already use
}

export interface Sp500Constituent {
  ticker: string;
  name: string;
  sector: string;
}

export interface InsiderTransaction {
  filed_at: string; // ISO date the Form 4 was filed
  transaction_date: string;
  insider_name: string;
  insider_title: string;
  transaction_code: string; // Form 4 code, e.g. "P" (open-market buy), "S" (sale)
  shares: number | null;
  price_per_share: number | null;
  acquired_or_disposed: "A" | "D" | null;
  accession_number: string;
  source_url: string;
}

export interface Institutional13FMention {
  filer_name: string;
  filed_at: string;
  form_type: string;
  accession_number: string;
  source_url: string;
}

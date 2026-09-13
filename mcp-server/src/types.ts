export const ALLOWED_PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "POL/USD", "XRP/USD"] as const;
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

export type Confidence = "low" | "medium" | "high";

export interface Position {
  id: string;
  pair: AllowedPair;
  direction: "long";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  size_pct: number;
  size_usd: number;
  quantity: number;
  entry_fee: number;
  opened_at: string;
  signals_at_entry: Record<string, unknown>;
  invalidation: string;
  confidence: Confidence;
  confidence_reason: string;
  status: "open";
}

export interface ClosedPosition extends Omit<Position, "status"> {
  status: "closed";
  exit_price: number;
  exit_fee: number;
  closed_at: string;
  close_reason: string;
  pnl_usd: number;
  pnl_pct_of_portfolio: number;
}

export interface DailyLoss {
  date: string; // UTC YYYY-MM-DD
  realized_pnl_usd: number;
  halted: boolean;
}

export interface PortfolioState {
  starting_balance: number;
  cash: number;
  open_positions: Position[];
  closed_positions: ClosedPosition[];
  daily_loss: DailyLoss[];
  created_at: string;
  updated_at: string;
}

export const RISK_LIMITS = {
  MAX_POSITION_PCT: 5,
  MAX_TOTAL_EXPOSURE_PCT: 25,
  MAX_OPEN_POSITIONS: 3,
  MAX_DAILY_LOSS_PCT: 5,
} as const;

// Fixed profit-taking rule: take-profit is set automatically at entry, at
// this multiple of the trade's own risk (entry-to-stop distance) above
// entry - a standard risk/reward target, not something the agent chooses
// or can override. A 2:1 target means a trade risking $1/unit to the stop
// takes profit at $2/unit of gain. Checked every cycle by
// portfolio_check_stops alongside the stop-loss.
export const TAKE_PROFIT_RR_MULTIPLE = 2;

// Position size is capped by stated confidence, not just the global 5% max.
// Formalizes a pattern the agent was already applying ad hoc (e.g. sizing a
// medium-confidence trade at 3% on its own judgment) into a fixed, code-
// enforced rule so sizing is consistent and auditable across cycles rather
// than a case-by-case call. Low confidence doesn't trade at all - if the
// signal isn't strong enough to size at least 2%, it isn't strong enough to
// act on; that's what "no trade" is for.
export const CONFIDENCE_MAX_SIZE_PCT: Record<Confidence, number> = {
  low: 0,
  medium: 3,
  high: RISK_LIMITS.MAX_POSITION_PCT,
};

// Kraken's lowest-volume-tier fee schedule (approximate as of 2025; fees are
// tier/volume dependent and change over time - update if you care about
// precise paper-vs-live parity). We model market-style (taker) fills since
// paper "recommendations" are meant to be actionable immediately.
export const TAKER_FEE_PCT = 0.4;
// Small modeled slippage on top of the quoted ask/bid to approximate market
// impact and quote staleness. Not derived from real depth data.
export const SLIPPAGE_PCT = 0.05;

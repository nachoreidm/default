export const ALLOWED_PAIRS = [
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
  "XRP/USD",
  "ADA/USD",
  "LINK/USD",
  "DOGE/USD",
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

export type Confidence = "low" | "medium" | "high";

export interface Position {
  id: string;
  pair: AllowedPair;
  direction: "long";
  entry_price: number;
  stop_loss: number;
  // The stop-loss level as originally set at entry - never mutated after
  // that. `stop_loss` above moves (breakeven, then trailing) once the
  // trade earns it; `initial_stop_loss` stays fixed so R (the trade's own
  // risk-per-unit) can always be recomputed correctly from entry.
  initial_stop_loss: number;
  take_profit: number;
  // Flips true (permanently) the first time price reaches entry + 1R. From
  // then on the fixed take_profit target above is superseded - checkStops
  // stops checking it and instead trails `stop_loss` up (breakeven floor,
  // then below the rising 20-period 4h SMA), so a strong trend isn't
  // capped at the original 2:1 target.
  trailing_active: boolean;
  size_pct: number;
  size_usd: number;
  quantity: number;
  entry_fee: number;
  opened_at: string;
  signals_at_entry: Record<string, unknown>;
  invalidation: string;
  confidence: Confidence;
  confidence_reason: string;
  momentum_only: boolean;
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
  // Matches ALLOWED_PAIRS.length (one open position per pair, see
  // ONE_POSITION_PER_PAIR below) - not a loosening of actual risk, since
  // MAX_TOTAL_EXPOSURE_PCT stays the binding aggregate-risk constraint
  // either way. Recompute this if the pair list changes.
  MAX_OPEN_POSITIONS: 7,
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

// A 48h price move at or above this, on either the 1h or 4h window, flags
// compute_signals' momentum_trigger. Calibrated against a real missed
// move (2026-09-13, XRP ran 3.84% -> 5.22% on genuine CLARITY Act news
// while RSI/SMA/volume all stayed unremarkable) - 6% catches a genuine
// breakout while filtering ordinary day-to-day crypto noise.
export const MOMENTUM_THRESHOLD_PCT = 6;

// Momentum alone isn't confirmed by anything else the way a crossover,
// RSI extreme, or volume spike is - so a trade whose ONLY trigger is
// momentum_trigger.flagged (no other signal present) is capped at medium
// confidence in code, same enforcement mechanism as CONFIDENCE_MAX_SIZE_PCT
// above. Enforced in portfolio_open_position: momentum_only=true rejects
// confidence="high" outright.
export const MOMENTUM_ONLY_MAX_CONFIDENCE: Confidence = "medium";

// Exit-logic upgrade layered on top of the fixed 2:1 take-profit (see
// TAKE_PROFIT_RR_MULTIPLE): once a position reaches +1R (its own
// entry-to-stop risk, in profit), portfolio_check_stops moves stop_loss to
// breakeven (entry_price) and from then on trails it below this period's
// SMA on the 4h chart instead of exiting flat at the fixed target - lets a
// strong trend run further while a real reversal still cuts the trade,
// never below breakeven once earned. Same 20-period already used by
// smaCrossover's fast SMA, reused here rather than adding a new indicator.
export const BREAKEVEN_TRAIL_SMA_PERIOD = 20;

// Kraken's lowest-volume-tier fee schedule (approximate as of 2025; fees are
// tier/volume dependent and change over time - update if you care about
// precise paper-vs-live parity). We model market-style (taker) fills since
// paper "recommendations" are meant to be actionable immediately.
export const TAKER_FEE_PCT = 0.4;
// Small modeled slippage on top of the quoted ask/bid to approximate market
// impact and quote staleness. Not derived from real depth data.
export const SLIPPAGE_PCT = 0.05;

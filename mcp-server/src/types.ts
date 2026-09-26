// LIVE TRADING - EUR-denominated (see CLAUDE.md's live-build decision log).
// Re-screened for EUR liquidity 2026-09-21, not just carried over from the
// USD-based paper-trading list: DOGE (weakest in the old lineup at ~$2.6M
// 24h EUR volume) swapped for SUI (~$8.0M, ~3x better) - see CLAUDE.md for
// the full liquidity table and the L1-diversity tradeoff that swap accepts.
// LTC/EUR added 2026-09-26 as an 8th pair (expansion, not a swap) - a
// re-check of live EUR volume found it (and NEAR) had overtaken 3 of the
// original 7 on liquidity; LTC was picked over NEAR specifically for
// diversification, not just volume - the pool already leans heavily
// L1-smart-contract-platform (SOL/ADA/SUI), and LTC is a genuinely
// different, older, payments-focused asset rather than another L1. See
// CLAUDE.md for the full re-screen table and reasoning.
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
  // stops checking it and instead trails `stop_loss` up (floored at a
  // guaranteed profit lock that scales with `peak_price` - see
  // PEAK_PROFIT_LOCK_FRACTION - then below the rising 20-period 4h SMA once
  // that climbs higher), so a strong trend isn't capped at the original 2:1
  // target and a post-trigger pullback still closes in profit rather than
  // at a scratch.
  trailing_active: boolean;
  // Highest price observed since entry (updated every portfolio_check_stops
  // cycle, regardless of trailing_active). Used to scale the profit-lock
  // floor with how far the trade has actually run - a rally that reaches
  // +3R and then reverses locks in more guaranteed profit than one that
  // barely ticked over +1R, rather than both being floored at the same
  // fixed fraction of the original 1R.
  peak_price: number;
  size_pct: number;
  size_eur: number;
  quantity: number;
  entry_fee: number;
  opened_at: string;
  signals_at_entry: Record<string, unknown>;
  invalidation: string;
  confidence: Confidence;
  confidence_reason: string;
  momentum_only: boolean;
  status: "open";
  // LIVE TRADING: Kraken's transaction IDs for this position's real orders -
  // needed to cancel/replace the resting stop as the trailing floor rises,
  // and to reconcile against Kraken's order history each cycle to detect a
  // fill that happened between runs. Absent for paper positions.
  entry_order_txid?: string;
  stop_order_txid?: string;
}

export interface ClosedPosition extends Omit<Position, "status"> {
  status: "closed";
  exit_price: number;
  exit_fee: number;
  closed_at: string;
  close_reason: string;
  pnl_eur: number;
  pnl_pct_of_portfolio: number;
}

export interface DailyLoss {
  date: string; // UTC YYYY-MM-DD
  realized_pnl_eur: number;
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

// LIVE TRADING limits. Raised from paper trading's 5%/25% (see CLAUDE.md's
// live-build decision log, 2026-09-20): since every position always carries
// a stop-loss, real per-trade risk is size_pct x stop_distance_pct, not
// size_pct alone - a stop makes a larger position meaningfully safer than
// the raw number suggests. All three numbers scaled by the same 8/5=1.6x
// factor (high 5->8, exposure 25->40) so the exposure cap's *relative*
// headroom - "5 full-size high-confidence positions before it binds" - is
// unchanged at the new sizes, not an arbitrary jump.
export const RISK_LIMITS = {
  MAX_POSITION_PCT: 8,
  MAX_TOTAL_EXPOSURE_PCT: 40,
  // Matches ALLOWED_PAIRS.length (one open position per pair, see
  // ONE_POSITION_PER_PAIR below) - not a loosening of actual risk, since
  // MAX_TOTAL_EXPOSURE_PCT stays the binding aggregate-risk constraint
  // either way. Recompute this if the pair list changes - bumped to 8
  // 2026-09-26 when LTC/EUR was added.
  MAX_OPEN_POSITIONS: 8,
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
  medium: 5,
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
// entry-to-stop risk, in profit), portfolio_check_stops moves stop_loss up
// to a guaranteed-profit floor (see PEAK_PROFIT_LOCK_FRACTION below) and
// from then on trails it below this period's SMA on the 4h chart instead
// of exiting flat at the fixed target - lets a strong trend run further
// while a real reversal still cuts the trade, never below the locked-in
// floor once earned. Same 20-period already used by smaCrossover's fast
// SMA, reused here rather than adding a new indicator.
export const TRAIL_SMA_PERIOD = 20;

// What fraction of the position's PEAK gain (peak_price - entry_price, the
// highest price actually reached so far - not just the gain at the moment
// +1R first triggered) to lock in as guaranteed profit, instead of
// flooring at bare breakeven. Decided 2026-09-19, revised the same day:
// breakeven alone means a trade that spikes to +1R and immediately
// reverses closes at a scratch - or, after real round-trip fees/slippage
// (see ROUND_TRIP_COST_PCT below), a small guaranteed LOSS - which defeats
// the point of having reached +1R at all. The first fix locked a flat 0.3R
// (0.3x the ORIGINAL 1R) the moment trailing activated - correct at that
// exact moment, but it meant the floor never rose any further no matter
// how much higher the rally went afterward; a trade that ran to +3R and
// then round-tripped all the way back down would still only be guaranteed
// the same 0.3R as one that barely ticked over +1R. Locking a fraction of
// the PEAK gain instead means the floor keeps ratcheting up as the rally
// extends (peak_price only ever increases - see Position.peak_price) - a
// bigger rally that reverses now guarantees more locked-in profit than a
// small one that barely qualified, matching the intuition that a trade
// that ran further earned the right to a better worst case.
//
// Revised again 2026-09-26: the fraction itself now also ratchets up in
// tiers as the peak's own R-multiple grows, not just the absolute euro
// floor. Motivated by SUI/EUR running to +3R+ while still only guaranteed
// 30% of that peak gain - a deep winner deserves a bigger fraction locked,
// not just a bigger absolute number at the same 30%. Tiers, keyed by how
// many multiples of the position's own entry-to-stop risk the peak has
// reached: 0.4 from +1R (the moment trailing activates - up from the
// original flat 0.3, a deliberate small tightening of the baseline
// guarantee), 0.5 from +2R (reuses TAKE_PROFIT_RR_MULTIPLE as the
// threshold - once a trade has run as far as its own take-profit target
// would have taken it, lock more), 0.6 from +3R (a genuinely extended,
// often fast/parabolic move - see effectiveTrailingStop in
// trailing-math.ts for how peakRMultiple is computed and which tier
// applies). Sorted ascending by minRMultiple - trailing-math.ts picks the
// highest tier whose threshold the peak has cleared. At exactly +1R this
// still produces the same behavior the original design intended (lock a
// fraction of the peak gain, floored by round-trip costs) - only the
// fraction used, and how it grows with the rally, has changed.
export interface PeakLockTier {
  minRMultiple: number;
  fraction: number;
}
export const PEAK_PROFIT_LOCK_TIERS: PeakLockTier[] = [
  { minRMultiple: 1, fraction: 0.4 },
  { minRMultiple: TAKE_PROFIT_RR_MULTIPLE, fraction: 0.5 },
  { minRMultiple: 3, fraction: 0.6 },
];

// Kraken's spot taker fee for this account's tier (verified 2026-09-22
// against Kraken's current published schedule: entry tier is 0.40%/0.80%
// maker/taker below $2,500 in 30-day volume or assets-on-platform (AoP,
// whichever is better); above $2,500 it drops to 0.30%/0.60%. This
// account's ~€5,000 AoP alone clears the $2,500 threshold, so 0.60% taker
// is the applicable rate even at zero trading volume - update this if the
// balance/volume later crosses the next tier ($10,000 -> 0.38% taker) or
// if Kraken revises the schedule again. Every order this system places
// (market entry, triggered stop-loss, market take-profit close) is a
// taker fill - there is no maker-fee path in this design (see
// portfolio-live.ts) - so this is the real, not approximate, rate that
// applies to every trade.
export const TAKER_FEE_PCT = 0.6;
// Small modeled slippage on top of the quoted ask/bid to approximate market
// impact and quote staleness. Not derived from real depth data.
export const SLIPPAGE_PCT = 0.05;

// Approximate round-trip cost (entry + exit fee, plus entry + exit
// slippage) as a percentage of entry price - used only as a safety floor
// under PEAK_PROFIT_LOCK_FRACTION so the profit lock is guaranteed to
// clear real transaction costs even for a hypothetical future trade with
// an unusually tight R. In every trade seen so far, 0.3x the peak gain has
// cleared this comfortably on its own at the moment of the +1R trigger
// (roughly 1.5-2.1% given observed stop distances) - this is defensive,
// not the normally-binding term.
export const ROUND_TRIP_COST_PCT = 2 * (TAKER_FEE_PCT + SLIPPAGE_PCT);

export const ALLOWED_PAIRS = [
    "BTC/USD",
    "ETH/USD",
    "SOL/USD",
    "XRP/USD",
    "ADA/USD",
    "LINK/USD",
    "DOGE/USD",
];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
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
};
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
export const CONFIDENCE_MAX_SIZE_PCT = {
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
export const MOMENTUM_ONLY_MAX_CONFIDENCE = "medium";
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

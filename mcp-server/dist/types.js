export const ALLOWED_PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "POL/USD", "XRP/USD"];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
}
export const RISK_LIMITS = {
    MAX_POSITION_PCT: 5,
    MAX_TOTAL_EXPOSURE_PCT: 25,
    MAX_OPEN_POSITIONS: 3,
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
// Kraken's lowest-volume-tier fee schedule (approximate as of 2025; fees are
// tier/volume dependent and change over time - update if you care about
// precise paper-vs-live parity). We model market-style (taker) fills since
// paper "recommendations" are meant to be actionable immediately.
export const TAKER_FEE_PCT = 0.4;
// Small modeled slippage on top of the quoted ask/bid to approximate market
// impact and quote staleness. Not derived from real depth data.
export const SLIPPAGE_PCT = 0.05;

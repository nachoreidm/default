export const ALLOWED_PAIRS = [
    "BTC/USD",
    "SOL/USD",
    "XRP/USD",
    "AAPLx/USD",
    "TSLAx/USD",
    "NVDAx/USD",
    "CRCLx/USD",
];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
}
export const RISK_LIMITS = {
    MAX_POSITION_PCT: 5,
    MAX_TOTAL_EXPOSURE_PCT: 25,
    MAX_OPEN_POSITIONS: 3,
    MAX_DAILY_LOSS_PCT: 5,
};
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
// Kraken's lowest-volume-tier fee schedule (approximate as of 2025; fees are
// tier/volume dependent and change over time - update if you care about
// precise paper-vs-live parity). We model market-style (taker) fills since
// paper "recommendations" are meant to be actionable immediately.
export const TAKER_FEE_PCT = 0.4;
// Small modeled slippage on top of the quoted ask/bid to approximate market
// impact and quote staleness. Not derived from real depth data.
export const SLIPPAGE_PCT = 0.05;

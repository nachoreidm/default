// LIVE TRADING - EUR-denominated (see CLAUDE.md's live-build decision log).
// Re-screened for EUR liquidity 2026-09-21, not just carried over from the
// USD-based paper-trading list: DOGE (weakest in the old lineup at ~$2.6M
// 24h EUR volume) swapped for SUI (~$8.0M, ~3x better) - see CLAUDE.md for
// the full liquidity table and the L1-diversity tradeoff that swap accepts.
export const ALLOWED_PAIRS = [
    "BTC/EUR",
    "ETH/EUR",
    "SOL/EUR",
    "XRP/EUR",
    "ADA/EUR",
    "LINK/EUR",
    "SUI/EUR",
];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
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
export const MOMENTUM_ONLY_MAX_CONFIDENCE = "medium";
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
// that ran further earned the right to a better worst case. At the exact
// moment of the +1R trigger, peak gain == the original 1R, so this
// produces the identical 0.3R floor as before - the change only matters
// for what happens as the rally continues past that point.
export const PEAK_PROFIT_LOCK_FRACTION = 0.3;
// Kraken's lowest-volume-tier fee schedule (approximate as of 2025; fees are
// tier/volume dependent and change over time - update if you care about
// precise paper-vs-live parity). We model market-style (taker) fills since
// paper "recommendations" are meant to be actionable immediately.
export const TAKER_FEE_PCT = 0.4;
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

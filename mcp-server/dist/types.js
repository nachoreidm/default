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
];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
}
// K=3: the number of consecutive closed 1h candles a momentum_only
// breakout must hold above its own breakout-candle low before
// portfolio_open_position will allow the entry. See PendingBreakout's
// comment above for the backtest that picked this value - K=3 was the
// smallest window that rejected real losers without ever rejecting a real
// winner; K=7-9 would also catch two slower-fading losers (LINK#3, ADA#3)
// but at that length the entry-price drift gets large enough that a
// simple fixed-exit backtest is no longer trustworthy (would need a full
// re-simulation with the stop/target recomputed from the delayed entry,
// not done here) - left for a future revisit, not built blind.
export const BREAKOUT_CONFIRM_CANDLES = 3;
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
};
// Fixed profit-taking rule: take-profit is set automatically at entry, at
// this multiple of the trade's own risk (entry-to-stop distance) above
// entry - a standard risk/reward target, not something the agent chooses
// or can override. A 2:1 target means a trade risking $1/unit to the stop
// takes profit at $2/unit of gain. Checked every cycle by
// portfolio_check_stops alongside the stop-loss.
export const TAKE_PROFIT_RR_MULTIPLE = 2;
// Position size is now DERIVED, not chosen directly - see TARGET_RISK_PCT
// and computePositionSizePct (portfolio-live.ts), added 2026-10-03. Flat
// confidence-based sizing (this constant's original role, formalizing a
// pattern the agent had been applying ad hoc) meant two trades at the same
// confidence tier could carry very different REAL risk purely because one
// pair's technical stop level happened to sit further from entry than the
// other's - e.g. LINK's ~8-9%-stop trades risked nearly double the euros
// of ADA's ~4.5%-stop trade at the identical 4% size and medium confidence
// (see CLAUDE.md's 2026-10-03 entry for the full trade-by-trade numbers
// that motivated this). This constant now only serves as a CEILING on the
// computed size - a backstop against a freak very-tight stop producing an
// oversized position - not the primary sizing dial. Low confidence still
// doesn't trade at all; that's what "no trade" is for.
export const CONFIDENCE_MAX_SIZE_PCT = {
    low: 0,
    medium: 5,
    high: RISK_LIMITS.MAX_POSITION_PCT,
};
// The real risk (as % of portfolio value) a position now TARGETS at its
// stop, by confidence - the primary sizing dial, replacing
// CONFIDENCE_MAX_SIZE_PCT's old role. Actual size = this ÷ the trade's own
// stop distance (entry-to-stop as % of entry price), clamped to
// CONFIDENCE_MAX_SIZE_PCT and RISK_LIMITS.MAX_POSITION_PCT - so a wide
// stop gets a smaller position and a tight stop gets a larger one, and
// every trade's real euro loss-if-stopped stays roughly constant instead
// of varying with wherever a pair's technical stop level happens to sit.
// Ratio between high and medium kept at 0.2/0.125 = 1.6x, same as the
// original 0.4/0.25 and the flat caps before that (8/5 = 1.6x), so
// high-confidence trades still target proportionally more risk than
// medium ones. **Halved 2026-10-07** (0.25->0.125 medium, 0.4->0.2 high)
// after a string of real stop-outs (ADA#1, LTC, SUI#2, ADA#3) landed
// right on the old 0.25% target (€10-14 each on a ~€5,000 account) - not
// a sizing bug, every one hit its intended risk exactly, but the user
// asked to cut the EUR loss-per-trade in half going forward. This changes
// the euro amount at risk directly without moving where any stop sits -
// stops stay exactly where each trade's own technical thesis places them
// (see effectiveTrailingStop/invalidationCheck in trailing-math.ts, both
// keyed off real technical levels, not this constant); only the position
// size scales down to match the smaller risk budget. Originally
// calibrated against this account's own actual historical risk (closed
// trades realized 0.18%-0.35% of portfolio value per stop-hit before the
// 2026-10-03 change existed) - this halving is a deliberate choice to
// trade smaller losses for smaller wins too (the trailing-lock floor and
// nominal 2R target both scale down proportionally with position size),
// not a response to the sizing formula itself being wrong.
export const TARGET_RISK_PCT = {
    low: 0,
    medium: 0.125,
    high: 0.2,
};
// Below this computed size, a position isn't worth opening - too small
// relative to the real ~1.3% round-trip fee cost (ROUND_TRIP_COST_PCT
// below) to be worth the capital or attention. Only binds when a pair's
// stop sits unusually far from entry relative to the confidence tier's
// risk budget - portfolio_open_position rejects the call (log a no-trade
// instead) rather than opening a dust position in that case.
export const MIN_POSITION_PCT = 1;
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
export const PEAK_PROFIT_LOCK_TIERS = [
    { minRMultiple: 1, fraction: 0.5 },
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

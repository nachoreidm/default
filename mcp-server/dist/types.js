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
];
export function isAllowedPair(pair) {
    return ALLOWED_PAIRS.includes(pair);
}
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
export const MOMENTUM_ONLY_MAX_CONFIDENCE = "medium";

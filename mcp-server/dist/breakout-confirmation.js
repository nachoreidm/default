// Pure pullback-confirmation logic for momentum_only entries - see
// PendingBreakout's comment in types.ts for the backtest that motivated
// this and picked K=3. Deliberately a pure function over plain data (no
// network, no state I/O) so it's directly unit-testable with synthetic
// candles, mirroring how peakFromCandles/fastInvalidationFromCloses are
// already structured in trailing-math.ts.
import { BREAKOUT_CONFIRM_CANDLES } from "./types.js";
// closedCandles must be sorted ascending by time (oldest first), already
// excluding any still-forming candle - same convention as the existing
// invalidationCheck/fastInvalidationCheck in trailing-math.ts.
//
// - existing === null and momentumFlagged === false: nothing to do.
// - existing === null and momentumFlagged === true: a fresh breakout -
//   start tracking from the most recently closed candle (the breakout
//   candle itself), confirmed_count 0.
// - existing !== null: fold in every closed candle strictly newer than
//   last_checked_time. Any one closing below breakout_level rejects the
//   whole thing outright (delete the record - a failed hold doesn't get
//   a second chance at the same level). Otherwise confirmed_count
//   advances, capped at BREAKOUT_CONFIRM_CANDLES - portfolio_open_position
//   reads "confirmed" and is responsible for consuming (deleting) the
//   record on actual entry, not this function, so advancing state here
//   never races against the entry decision happening in the same cycle.
export function evaluateBreakoutConfirmation(existing, momentumFlagged, closedCandles) {
    if (!existing) {
        if (!momentumFlagged || closedCandles.length === 0) {
            return { next: null, result: { status: "none" } };
        }
        const breakoutCandle = closedCandles[closedCandles.length - 1];
        const pending = {
            breakout_time: breakoutCandle.time,
            breakout_level: breakoutCandle.low,
            confirmed_count: 0,
            last_checked_time: breakoutCandle.time,
        };
        return {
            next: pending,
            result: { status: "started", candles_remaining: BREAKOUT_CONFIRM_CANDLES },
        };
    }
    // Already at the cap from a prior cycle - nothing new to evaluate,
    // report confirmed again so the caller can consume it on entry.
    if (existing.confirmed_count >= BREAKOUT_CONFIRM_CANDLES) {
        return {
            next: existing,
            result: { status: "confirmed", confirmed_count: existing.confirmed_count },
        };
    }
    const newCandles = closedCandles.filter((c) => c.time > existing.last_checked_time);
    let confirmed_count = existing.confirmed_count;
    let last_checked_time = existing.last_checked_time;
    for (const c of newCandles) {
        if (c.close < existing.breakout_level) {
            return {
                next: null,
                result: {
                    status: "rejected",
                    breakout_level: existing.breakout_level,
                    failed_close: c.close,
                },
            };
        }
        confirmed_count += 1;
        last_checked_time = c.time;
        if (confirmed_count >= BREAKOUT_CONFIRM_CANDLES) {
            const next = {
                ...existing,
                confirmed_count,
                last_checked_time,
            };
            return { next, result: { status: "confirmed", confirmed_count } };
        }
    }
    const next = { ...existing, confirmed_count, last_checked_time };
    return {
        next,
        result: {
            status: "pending",
            candles_remaining: BREAKOUT_CONFIRM_CANDLES - confirmed_count,
        },
    };
}

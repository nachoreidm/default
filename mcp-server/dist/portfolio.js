import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchTicker, fetchOHLC, closedCandles } from "./kraken.js";
import { sma } from "./indicators.js";
import { ALLOWED_PAIRS, RISK_LIMITS, CONFIDENCE_MAX_SIZE_PCT, TAKER_FEE_PCT, SLIPPAGE_PCT, TAKE_PROFIT_RR_MULTIPLE, MOMENTUM_ONLY_MAX_CONFIDENCE, TRAIL_SMA_PERIOD, PEAK_PROFIT_LOCK_FRACTION, ROUND_TRIP_COST_PCT, isAllowedPair, } from "./types.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "portfolio_state.json");
const TRADES_LOG_PATH = path.join(REPO_ROOT, "trades.md");
const STARTING_BALANCE = 10_000;
function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}
export async function loadState() {
    try {
        const raw = await fs.readFile(STATE_PATH, "utf-8");
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === "ENOENT") {
            const fresh = {
                starting_balance: STARTING_BALANCE,
                cash: STARTING_BALANCE,
                open_positions: [],
                closed_positions: [],
                daily_loss: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            await saveState(fresh);
            return fresh;
        }
        throw err;
    }
}
async function saveState(state) {
    state.updated_at = new Date().toISOString();
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
async function appendTradeLog(entry) {
    await fs.appendFile(TRADES_LOG_PATH, entry.endsWith("\n") ? entry : entry + "\n", "utf-8");
}
async function currentPriceOf(pair) {
    const ticker = await fetchTicker(pair);
    return ticker.last;
}
async function portfolioValue(state) {
    let value = state.cash;
    const positionValues = {};
    for (const pos of state.open_positions) {
        const price = await currentPriceOf(pos.pair);
        const marketValue = pos.quantity * price;
        positionValues[pos.id] = marketValue;
        value += marketValue;
    }
    return { value, positionValues };
}
function getOrInitDailyLoss(state, date) {
    let rec = state.daily_loss.find((d) => d.date === date);
    if (!rec) {
        rec = { date, realized_pnl_usd: 0, halted: false };
        state.daily_loss.push(rec);
    }
    return rec;
}
export async function getSnapshot() {
    const state = await loadState();
    const { value, positionValues } = await portfolioValue(state);
    const openWithPricing = [];
    for (const pos of state.open_positions) {
        const marketValue = positionValues[pos.id];
        const currentPrice = marketValue / pos.quantity;
        const unrealized = marketValue - pos.size_usd;
        openWithPricing.push({
            ...pos,
            current_price: currentPrice,
            market_value: marketValue,
            unrealized_pnl_usd: unrealized,
            unrealized_pnl_pct: (unrealized / pos.size_usd) * 100,
        });
    }
    const totalExposure = state.open_positions.reduce((a, p) => a + positionValues[p.id], 0);
    const today = todayUtc();
    const todayRec = state.daily_loss.find((d) => d.date === today);
    return {
        starting_balance: state.starting_balance,
        cash: state.cash,
        portfolio_value: value,
        open_positions: openWithPricing,
        open_position_count: state.open_positions.length,
        total_exposure_pct: (totalExposure / value) * 100,
        today_utc: today,
        today_realized_pnl_usd: todayRec?.realized_pnl_usd ?? 0,
        today_halted: todayRec?.halted ?? false,
        closed_position_count: state.closed_positions.length,
    };
}
export async function openPosition(input) {
    if (!isAllowedPair(input.pair)) {
        return { ok: false, reason: `Pair "${input.pair}" is out of scope. Allowed: ${ALLOWED_PAIRS.join(", ")}.` };
    }
    if (!input.stop_loss || input.stop_loss <= 0) {
        return { ok: false, reason: "A stop-loss level is required for every position." };
    }
    if (input.size_pct <= 0 || input.size_pct > RISK_LIMITS.MAX_POSITION_PCT) {
        return { ok: false, reason: `Position size must be > 0% and <= ${RISK_LIMITS.MAX_POSITION_PCT}% of portfolio value (requested ${input.size_pct}%).` };
    }
    const confidenceCap = CONFIDENCE_MAX_SIZE_PCT[input.confidence];
    if (confidenceCap === 0) {
        return { ok: false, reason: `Confidence "low" doesn't trade at all - if the signal isn't strong enough to size at least 2%, log a no-trade instead.` };
    }
    if (input.size_pct > confidenceCap) {
        return { ok: false, reason: `Position size ${input.size_pct}% exceeds the ${confidenceCap}% cap for "${input.confidence}" confidence.` };
    }
    if (input.momentum_only && input.confidence === "high") {
        return {
            ok: false,
            reason: `A momentum-only trigger (no crossover, RSI extreme, or volume spike corroborating it) can't be "high" confidence - it isn't confirmed by anything else. Use "${MOMENTUM_ONLY_MAX_CONFIDENCE}" or lower.`,
        };
    }
    if (!input.invalidation || input.invalidation.trim().length === 0) {
        return { ok: false, reason: "An invalidation condition (what proves this wrong) is required." };
    }
    const state = await loadState();
    const today = todayUtc();
    const dailyRec = getOrInitDailyLoss(state, today);
    if (dailyRec.halted) {
        return { ok: false, reason: `Daily paper loss limit already hit today (UTC ${today}). No new positions until tomorrow.` };
    }
    if (state.open_positions.length >= RISK_LIMITS.MAX_OPEN_POSITIONS) {
        return { ok: false, reason: `Max open positions (${RISK_LIMITS.MAX_OPEN_POSITIONS}) already reached.` };
    }
    if (state.open_positions.some((p) => p.pair === input.pair)) {
        return { ok: false, reason: `A position on ${input.pair} is already open - only one open position per pair is allowed. Close it first, or wait for it to hit its stop/target.` };
    }
    const { value: portfolioVal, positionValues } = await portfolioValue(state);
    const totalExposureUsd = state.open_positions.reduce((a, p) => a + positionValues[p.id], 0);
    const newSizeUsd = portfolioVal * (input.size_pct / 100);
    const newTotalExposurePct = ((totalExposureUsd + newSizeUsd) / portfolioVal) * 100;
    if (newTotalExposurePct > RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT) {
        return {
            ok: false,
            reason: `Opening this position would bring total exposure to ${newTotalExposurePct.toFixed(1)}%, over the ${RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT}% cap.`,
        };
    }
    if (newSizeUsd > state.cash) {
        return { ok: false, reason: `Insufficient paper cash: need $${newSizeUsd.toFixed(2)}, have $${state.cash.toFixed(2)}.` };
    }
    const ticker = await fetchTicker(input.pair);
    const fillPrice = ticker.ask * (1 + SLIPPAGE_PCT / 100);
    if (input.stop_loss >= fillPrice) {
        return { ok: false, reason: `Stop-loss (${input.stop_loss}) must be below the entry/fill price (${fillPrice.toFixed(2)}) for a long position.` };
    }
    const fee = newSizeUsd * (TAKER_FEE_PCT / 100);
    const quantity = (newSizeUsd - fee) / fillPrice;
    const takeProfit = fillPrice + TAKE_PROFIT_RR_MULTIPLE * (fillPrice - input.stop_loss);
    const position = {
        id: randomUUID(),
        pair: input.pair,
        direction: "long",
        entry_price: fillPrice,
        stop_loss: input.stop_loss,
        initial_stop_loss: input.stop_loss,
        take_profit: takeProfit,
        trailing_active: false,
        peak_price: fillPrice,
        size_pct: input.size_pct,
        size_usd: newSizeUsd,
        quantity,
        entry_fee: fee,
        opened_at: new Date().toISOString(),
        signals_at_entry: input.signals_at_entry,
        invalidation: input.invalidation,
        confidence: input.confidence,
        confidence_reason: input.confidence_reason,
        momentum_only: input.momentum_only,
        status: "open",
    };
    state.cash -= newSizeUsd;
    state.open_positions.push(position);
    await saveState(state);
    await appendTradeLog(formatOpenEntry(position));
    return { ok: true, position };
}
export async function closePosition(input) {
    const state = await loadState();
    const idx = state.open_positions.findIndex((p) => p.id === input.position_id);
    if (idx === -1) {
        return { ok: false, reason: `No open position with id ${input.position_id}.` };
    }
    const position = state.open_positions[idx];
    const ticker = await fetchTicker(position.pair);
    const fillPrice = ticker.bid * (1 - SLIPPAGE_PCT / 100);
    const grossProceeds = position.quantity * fillPrice;
    const fee = grossProceeds * (TAKER_FEE_PCT / 100);
    const netProceeds = grossProceeds - fee;
    const pnlUsd = netProceeds - position.size_usd;
    const { value: portfolioValBeforeClose } = await portfolioValue(state);
    const closed = {
        ...position,
        status: "closed",
        exit_price: fillPrice,
        exit_fee: fee,
        closed_at: new Date().toISOString(),
        close_reason: input.reason,
        pnl_usd: pnlUsd,
        pnl_pct_of_portfolio: (pnlUsd / portfolioValBeforeClose) * 100,
    };
    state.open_positions.splice(idx, 1);
    state.closed_positions.push(closed);
    state.cash += netProceeds;
    const today = todayUtc();
    const dailyRec = getOrInitDailyLoss(state, today);
    dailyRec.realized_pnl_usd += pnlUsd;
    const { value: portfolioValAfterClose } = await portfolioValue(state);
    if (dailyRec.realized_pnl_usd < 0 && Math.abs(dailyRec.realized_pnl_usd) / portfolioValAfterClose * 100 >= RISK_LIMITS.MAX_DAILY_LOSS_PCT) {
        dailyRec.halted = true;
    }
    await saveState(state);
    await appendTradeLog(formatCloseEntry(closed, dailyRec.halted));
    return { ok: true, position: closed };
}
// Pure math, exported for unit testing: has price reached the position's
// own +1R level (up by its entry-to-stop risk amount)? False for a
// zero/negative risk (shouldn't happen - openPosition requires stop_loss
// below entry - but guards against a divide-by-nothing style edge case).
export function hasReachedOneR(entryPrice, initialStopLoss, currentPrice) {
    const risk = entryPrice - initialStopLoss;
    return risk > 0 && currentPrice >= entryPrice + risk;
}
// Pure math, exported for unit testing: the effective stop once trailing is
// active. Floor guarantees PEAK_PROFIT_LOCK_FRACTION of the trade's PEAK
// gain (peakPrice - entryPrice, the highest price reached so far - not
// just the gain at the moment +1R first triggered) as locked-in profit -
// or enough to clear real round-trip transaction costs
// (ROUND_TRIP_COST_PCT), whichever is larger - rather than bare breakeven
// or a floor pinned at the original 1R forever. Since peakPrice only ever
// grows, this floor ratchets up as a rally extends: a trade that runs to
// +3R and reverses locks in more than one that barely cleared +1R. Trails
// higher still if sma20 has risen above that floor. Never returns a value
// below currentStopLoss - the trail only ever moves up, regardless of
// which term (peak-lock, fee-floor, or SMA) is driving it.
export function effectiveTrailingStop(entryPrice, peakPrice, currentStopLoss, sma20) {
    const peakGain = peakPrice - entryPrice;
    const profitFloor = entryPrice + Math.max(PEAK_PROFIT_LOCK_FRACTION * peakGain, entryPrice * (ROUND_TRIP_COST_PCT / 100));
    const candidate = sma20 !== null && sma20 > profitFloor ? sma20 : profitFloor;
    return Math.max(candidate, currentStopLoss);
}
// Fetches the current TRAIL_SMA_PERIOD 4h SMA for a position's pair and
// combines it with effectiveTrailingStop above. Falls back to the
// guaranteed-profit floor alone if 4h candles can't be fetched this cycle.
async function trailingStopCandidate(pos) {
    let sma20 = null;
    try {
        const candles4h = closedCandles(await fetchOHLC(pos.pair, "4h"));
        const closes = candles4h.map((c) => c.close);
        const smaSeries = sma(closes, TRAIL_SMA_PERIOD);
        if (smaSeries.length > 0)
            sma20 = smaSeries[smaSeries.length - 1];
    }
    catch {
        // 4h candles unavailable this cycle - trail on the guaranteed-profit floor alone.
    }
    return effectiveTrailingStop(pos.entry_price, pos.peak_price, pos.stop_loss, sma20);
}
// Meant to be called on a schedule (or on demand) to auto-close any open
// position whose stop-loss or take-profit has been breached, independent
// of whether anyone is actively chatting with the agent.
//
// Two-pass: first bring every position's trailing state up to date and
// persist it (so a stop-loss advance survives even if nothing closes this
// cycle), then decide closes against that freshly-saved state. Exit rule
// per position:
//   - Before the trade has ever reached +1R: unchanged fixed-target
//     behavior - take-profit (2:1) checked first, then the original
//     stop-loss. Take-profit checked first so a candle that gaps through
//     both levels in one tick is recorded as the win it is.
//   - Once price has reached entry + 1R (trailing_active flips true,
//     permanently, the first time this happens): the fixed take-profit is
//     superseded - it stops being checked - and the trade is governed
//     purely by the trailing stop_loss (floored at a guaranteed profit
//     lock that scales with peak_price - see PEAK_PROFIT_LOCK_FRACTION -
//     then below the rising 4h SMA once that climbs higher), so a strong
//     trend isn't capped at the original 2:1 target and a post-trigger
//     reversal still closes in profit rather than at a scratch. The stop
//     can only move up from here, never back down.
export async function checkStops() {
    const state = await loadState();
    let stateChanged = false;
    for (const pos of state.open_positions) {
        const ticker = await fetchTicker(pos.pair);
        if (ticker.last > pos.peak_price) {
            pos.peak_price = ticker.last;
            stateChanged = true;
        }
        if (!pos.trailing_active && hasReachedOneR(pos.entry_price, pos.initial_stop_loss, ticker.last)) {
            pos.trailing_active = true;
            stateChanged = true;
        }
        if (pos.trailing_active) {
            const candidate = await trailingStopCandidate(pos);
            if (candidate > pos.stop_loss) {
                pos.stop_loss = candidate;
                stateChanged = true;
            }
        }
    }
    if (stateChanged) {
        await saveState(state);
    }
    const actions = [];
    for (const pos of [...state.open_positions]) {
        const ticker = await fetchTicker(pos.pair);
        if (!pos.trailing_active && ticker.last >= pos.take_profit) {
            const result = await closePosition({ position_id: pos.id, reason: `Take-profit auto-triggered (price ${ticker.last} >= target ${pos.take_profit}, ${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward).` });
            if (result.ok) {
                actions.push({ position_id: pos.id, pair: pos.pair, triggered: "take_profit", closed: result.position });
            }
        }
        else if (ticker.last <= pos.stop_loss) {
            const reason = pos.trailing_active
                ? `Trailing stop-loss auto-triggered (price ${ticker.last} <= stop ${pos.stop_loss}) - position had reached +1R, so the fixed ${TAKE_PROFIT_RR_MULTIPLE}:1 take-profit was superseded by the guaranteed-profit trailing rule (stop locked in at least ${PEAK_PROFIT_LOCK_FRACTION * 100}% of the peak gain reached - peak price $${pos.peak_price.toFixed(2)} above entry $${pos.entry_price.toFixed(2)}) before this reversal closed it.`
                : `Stop-loss auto-triggered (price ${ticker.last} <= stop ${pos.stop_loss}).`;
            const result = await closePosition({ position_id: pos.id, reason });
            if (result.ok) {
                actions.push({ position_id: pos.id, pair: pos.pair, triggered: "stop_loss", closed: result.position });
            }
        }
    }
    return actions;
}
export async function logNoTrade(input) {
    const ts = new Date().toISOString();
    const lines = [
        `### ${ts} — ${input.pair} — NO TRADE`,
        "",
        `**Reasoning:** ${input.reasoning}`,
        "",
        "**Signals considered:**",
        "```json",
        JSON.stringify(input.signals_considered, null, 2),
        "```",
        "",
        "---",
        "",
    ];
    await appendTradeLog(lines.join("\n"));
    return { ok: true, pair: input.pair, logged_at: ts };
}
function formatOpenEntry(p) {
    const lines = [
        `### ${p.opened_at} — ${p.pair} — LONG — OPENED`,
        "",
        `- Entry price: $${p.entry_price.toFixed(2)}`,
        `- Stop-loss: $${p.stop_loss.toFixed(2)}`,
        `- Take-profit: $${p.take_profit.toFixed(2)} (${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward, fixed at entry)`,
        `- Position size: ${p.size_pct}% of portfolio ($${p.size_usd.toFixed(2)}, qty ${p.quantity.toFixed(8)})`,
        `- Entry fee (paper): $${p.entry_fee.toFixed(2)}`,
        `- Confidence: ${p.confidence} — ${p.confidence_reason}`,
        `- Momentum-only trigger: ${p.momentum_only ? "yes (no crossover/RSI-extreme/volume-spike corroborating this trade)" : "no"}`,
        `- Invalidation (what proves this wrong): ${p.invalidation}`,
        "- Signals supporting this trade:",
        "```json",
        JSON.stringify(p.signals_at_entry, null, 2),
        "```",
        `- Position id: ${p.id}`,
        "",
        "---",
        "",
    ];
    return lines.join("\n");
}
function formatCloseEntry(p, dayHalted) {
    const lines = [
        `### ${p.closed_at} — ${p.pair} — LONG — CLOSED`,
        "",
        `- Exit price: $${p.exit_price.toFixed(2)}`,
        `- Exit fee (paper): $${p.exit_fee.toFixed(2)}`,
        `- Reason: ${p.close_reason}`,
        `- Realized P&L: $${p.pnl_usd.toFixed(2)} (${p.pnl_pct_of_portfolio.toFixed(2)}% of portfolio)`,
        `- Position id: ${p.id}`,
        ...(dayHalted
            ? ["", "**⚠ Daily paper loss limit hit — no new positions until tomorrow (UTC).**"]
            : []),
        "",
        "---",
        "",
    ];
    return lines.join("\n");
}

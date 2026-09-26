import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchTicker, fetchPairPrecision, pairCode, KrakenApiError } from "./kraken.js";
import { addOrder, cancelOrder, queryBalance, queryOrdersInfo, type KrakenOrderInfo } from "./kraken-private.js";
import { hasReachedOneR, effectiveTrailingStop, trailingStopCandidate, historicalPeakSinceEntry, invalidationCheck } from "./trailing-math.js";
import {
  ALLOWED_PAIRS,
  RISK_LIMITS,
  CONFIDENCE_MAX_SIZE_PCT,
  TAKE_PROFIT_RR_MULTIPLE,
  MOMENTUM_ONLY_MAX_CONFIDENCE,
  TRAIL_SMA_PERIOD,
  isAllowedPair,
  type AllowedPair,
  type ClosedPosition,
  type Confidence,
  type PortfolioState,
  type Position,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "live_portfolio_state.json");
const TRADES_LOG_PATH = path.join(REPO_ROOT, "trades.md");

// Informational only - actual position sizing always uses the REAL
// portfolio value (live EUR balance + live position market values, see
// portfolioValue() below), never this constant. Set once the account is
// funded; not touched again.
const STARTING_BALANCE_EUR = 5_000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadState(): Promise<PortfolioState> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw) as PortfolioState;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      const fresh: PortfolioState = {
        starting_balance: STARTING_BALANCE_EUR,
        cash: STARTING_BALANCE_EUR,
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

async function saveState(state: PortfolioState): Promise<void> {
  state.updated_at = new Date().toISOString();
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function appendTradeLog(entry: string): Promise<void> {
  await fs.appendFile(TRADES_LOG_PATH, entry.endsWith("\n") ? entry : entry + "\n", "utf-8");
}

// Real EUR cash from Kraken's own balance - never a locally-tracked ledger.
// Kraken's legacy asset-class naming nests fiat under a Z-prefixed code
// (ZEUR); falls back to a bare "EUR" key defensively in case that's wrong -
// this is one of the assumptions the validate:true / first-balance-query
// smoke test (see the live-build plan's Verification section) is meant to
// catch immediately rather than silently.
async function liveCashEur(): Promise<number> {
  const balance = await queryBalance();
  const raw = balance["ZEUR"] ?? balance["EUR"];
  if (raw === undefined) {
    // Kraken's Balance endpoint omits zero-balance assets entirely - an
    // empty response is a genuine, valid "nothing in this account yet"
    // (e.g. before funding, or fully deployed with zero cash left), not an
    // error. Only throw if the account holds OTHER assets but still has no
    // EUR key - that's the actually-surprising case (the assumed key name
    // may be wrong), not a plain empty balance.
    if (Object.keys(balance).length === 0) {
      return 0;
    }
    throw new KrakenApiError(
      `Kraken Balance response has assets (${Object.keys(balance).join(", ")}) but no ZEUR/EUR key - the assumed EUR balance key may be wrong. Verify before trusting any sizing math.`
    );
  }
  return Number(raw);
}

async function currentPriceOf(pair: AllowedPair): Promise<number> {
  const ticker = await fetchTicker(pair);
  return ticker.last;
}

async function portfolioValue(state: PortfolioState): Promise<{ value: number; cash: number; positionValues: Record<string, number> }> {
  const cash = await liveCashEur();
  let value = cash;
  const positionValues: Record<string, number> = {};
  for (const pos of state.open_positions) {
    const price = await currentPriceOf(pos.pair);
    const marketValue = pos.quantity * price;
    positionValues[pos.id] = marketValue;
    value += marketValue;
  }
  return { value, cash, positionValues };
}

function getOrInitDailyLoss(state: PortfolioState, date: string) {
  let rec = state.daily_loss.find((d) => d.date === date);
  if (!rec) {
    rec = { date, realized_pnl_eur: 0, halted: false };
    state.daily_loss.push(rec);
  }
  return rec;
}

export interface PortfolioSnapshot {
  starting_balance: number;
  cash: number;
  portfolio_value: number;
  open_positions: Array<Position & { current_price: number; market_value: number; unrealized_pnl_eur: number; unrealized_pnl_pct: number }>;
  open_position_count: number;
  total_exposure_pct: number;
  today_utc: string;
  today_realized_pnl_eur: number;
  today_halted: boolean;
  closed_position_count: number;
}

export async function getSnapshot(): Promise<PortfolioSnapshot> {
  const state = await loadState();
  const { value, cash, positionValues } = await portfolioValue(state);
  const openWithPricing = [];
  for (const pos of state.open_positions) {
    const marketValue = positionValues[pos.id];
    const currentPrice = marketValue / pos.quantity;
    const unrealized = marketValue - pos.size_eur;
    openWithPricing.push({
      ...pos,
      current_price: currentPrice,
      market_value: marketValue,
      unrealized_pnl_eur: unrealized,
      unrealized_pnl_pct: (unrealized / pos.size_eur) * 100,
    });
  }
  const totalExposure = state.open_positions.reduce((a, p) => a + positionValues[p.id], 0);
  const today = todayUtc();
  const todayRec = state.daily_loss.find((d) => d.date === today);

  return {
    starting_balance: state.starting_balance,
    cash,
    portfolio_value: value,
    open_positions: openWithPricing,
    open_position_count: state.open_positions.length,
    total_exposure_pct: (totalExposure / value) * 100,
    today_utc: today,
    today_realized_pnl_eur: todayRec?.realized_pnl_eur ?? 0,
    today_halted: todayRec?.halted ?? false,
    closed_position_count: state.closed_positions.length,
  };
}

export interface OpenPositionInput {
  pair: string;
  size_pct: number;
  stop_loss: number;
  invalidation: string;
  confidence: Confidence;
  confidence_reason: string;
  momentum_only: boolean;
  signals_at_entry: Record<string, unknown>;
}

export interface RiskCheckFailure {
  ok: false;
  reason: string;
}

export type OpenPositionResult = RiskCheckFailure | { ok: true; position: Position };

// Rounds to the pair's REAL tick size (fetched live from Kraken's
// AssetPairs endpoint, see fetchPairPrecision) rather than a flat 8
// decimals - the earlier blind-8-decimals version left SOL/EUR's
// trailing-stop AddOrder rejected on 2026-09-25 (Kraken only allows 2
// price decimals for that pair) after its old stop had already been
// cancelled, and SUI/EUR's 5-decimal volume limit meant it was one
// unlucky quantity away from the same failure (see CLAUDE.md). Volume is
// floored, never rounded up, so a sell/stop order never requests more
// than the position actually holds.
async function formatVolume(pair: AllowedPair, n: number): Promise<string> {
  const { volumeDecimals } = await fetchPairPrecision(pair);
  const factor = 10 ** volumeDecimals;
  return (Math.floor(n * factor) / factor).toFixed(volumeDecimals);
}
async function formatPrice(pair: AllowedPair, n: number): Promise<string> {
  const { priceDecimals } = await fetchPairPrecision(pair);
  return n.toFixed(priceDecimals);
}

async function pollForFill(txid: string, maxAttempts = 12, delayMs = 1500): Promise<KrakenOrderInfo> {
  for (let i = 0; i < maxAttempts; i++) {
    const info = await queryOrdersInfo([txid]);
    const order = info[txid];
    if (order && order.status === "closed") return order;
    if (order && (order.status === "canceled" || order.status === "expired")) {
      throw new KrakenApiError(`Order ${txid} did not fill - status ${order.status}${order.reason ? `: ${order.reason}` : ""}.`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new KrakenApiError(`Order ${txid} did not report "closed" within ${(maxAttempts * delayMs) / 1000}s - check Kraken directly before assuming anything about this position.`);
}

export async function openPosition(input: OpenPositionInput): Promise<OpenPositionResult> {
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
      reason: `A momentum-only trigger can't be "high" confidence - it isn't confirmed by anything else. Use "${MOMENTUM_ONLY_MAX_CONFIDENCE}" or lower.`,
    };
  }
  if (!input.invalidation || input.invalidation.trim().length === 0) {
    return { ok: false, reason: "An invalidation condition (what proves this wrong) is required." };
  }

  const state = await loadState();
  const today = todayUtc();
  const dailyRec = getOrInitDailyLoss(state, today);
  if (dailyRec.halted) {
    return { ok: false, reason: `Daily loss limit already hit today (UTC ${today}). No new positions until tomorrow.` };
  }
  if (state.open_positions.length >= RISK_LIMITS.MAX_OPEN_POSITIONS) {
    return { ok: false, reason: `Max open positions (${RISK_LIMITS.MAX_OPEN_POSITIONS}) already reached.` };
  }
  if (state.open_positions.some((p) => p.pair === input.pair)) {
    return { ok: false, reason: `A position on ${input.pair} is already open - only one open position per pair is allowed.` };
  }

  const { value: portfolioVal, cash, positionValues } = await portfolioValue(state);
  const totalExposureEur = Object.values(positionValues).reduce((a, v) => a + v, 0);
  const newSizeEur = portfolioVal * (input.size_pct / 100);
  const newTotalExposurePct = ((totalExposureEur + newSizeEur) / portfolioVal) * 100;
  if (newTotalExposurePct > RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT) {
    return {
      ok: false,
      reason: `Opening this position would bring total exposure to ${newTotalExposurePct.toFixed(1)}%, over the ${RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT}% cap.`,
    };
  }

  const ticker = await fetchTicker(input.pair);
  if (input.stop_loss >= ticker.ask) {
    return { ok: false, reason: `Stop-loss (${input.stop_loss}) must be below the current ask (${ticker.ask}) for a long position.` };
  }
  if (newSizeEur > cash) {
    return { ok: false, reason: `Insufficient EUR balance: need €${newSizeEur.toFixed(2)}, have €${cash.toFixed(2)}.` };
  }

  // --- Real money from here on: place the entry order. ---
  const estVolume = newSizeEur / ticker.ask;
  const entryOrder = await addOrder({
    pair: pairCode(input.pair as AllowedPair),
    type: "buy",
    ordertype: "market",
    volume: await formatVolume(input.pair as AllowedPair, estVolume),
  });
  const entryTxid = entryOrder.txid?.[0];
  if (!entryTxid) {
    return { ok: false, reason: `Kraken AddOrder (entry) did not return a txid - response: ${JSON.stringify(entryOrder)}. No position was recorded; check Kraken directly before retrying.` };
  }
  const filledEntry = await pollForFill(entryTxid);
  const entryPrice = Number(filledEntry.price);
  const quantity = Number(filledEntry.vol_exec);
  const entryFee = Number(filledEntry.fee);

  const takeProfit = entryPrice + TAKE_PROFIT_RR_MULTIPLE * (entryPrice - input.stop_loss);

  // The critical protective leg: a REAL resting stop-loss order on Kraken,
  // placed immediately after the entry fills. Take-profit for the
  // pre-trailing phase is intentionally NOT a resting order (see
  // checkStops below) - Kraken's AddOrder only supports one contingent
  // close per parent order, and running stop-loss + take-profit as two
  // independent resting orders would need manual OCO emulation (cancel the
  // sibling the instant either fills) for a problem (missing a take-profit
  // gap) that was never the one motivating real resting orders in the
  // first place - only the stop-loss/trailing-floor gap was (see
  // CLAUDE.md's live-build decision log). Keeping this to a single real
  // resting order per position avoids that whole class of dangling-order
  // risk for a benefit (closing exactly at a fixed target) that isn't the
  // safety-critical piece.
  const stopOrder = await addOrder({
    pair: pairCode(input.pair as AllowedPair),
    type: "sell",
    ordertype: "stop-loss",
    price: await formatPrice(input.pair as AllowedPair, input.stop_loss),
    volume: await formatVolume(input.pair as AllowedPair, quantity),
  });
  const stopTxid = stopOrder.txid?.[0];
  if (!stopTxid) {
    // Entry is filled and UNPROTECTED - surface this as loudly as possible.
    return {
      ok: false,
      reason: `CRITICAL: entry order ${entryTxid} filled (qty ${quantity} @ ${entryPrice}) but the resting stop-loss order was NOT placed - Kraken response: ${JSON.stringify(stopOrder)}. This position has NO stop-loss protection right now. Check Kraken directly and place one manually before doing anything else.`,
    };
  }

  const position: Position = {
    id: randomUUID(),
    pair: input.pair as AllowedPair,
    direction: "long",
    entry_price: entryPrice,
    stop_loss: input.stop_loss,
    initial_stop_loss: input.stop_loss,
    take_profit: takeProfit,
    trailing_active: false,
    peak_price: entryPrice,
    size_pct: input.size_pct,
    size_eur: newSizeEur,
    quantity,
    entry_fee: entryFee,
    opened_at: new Date().toISOString(),
    signals_at_entry: input.signals_at_entry,
    invalidation: input.invalidation,
    confidence: input.confidence,
    confidence_reason: input.confidence_reason,
    momentum_only: input.momentum_only,
    status: "open",
    entry_order_txid: entryTxid,
    stop_order_txid: stopTxid,
  };

  state.open_positions.push(position);
  await saveState(state);
  await appendTradeLog(formatOpenEntry(position));

  return { ok: true, position };
}

async function recordClose(
  state: PortfolioState,
  pos: Position,
  exitPrice: number,
  exitFee: number,
  reason: string
): Promise<ClosedPosition> {
  const grossProceeds = pos.quantity * exitPrice;
  const netProceeds = grossProceeds - exitFee;
  const pnlEur = netProceeds - pos.size_eur;

  const { value: portfolioValBefore } = await portfolioValue(state);

  const closed: ClosedPosition = {
    ...pos,
    status: "closed",
    exit_price: exitPrice,
    exit_fee: exitFee,
    closed_at: new Date().toISOString(),
    close_reason: reason,
    pnl_eur: pnlEur,
    pnl_pct_of_portfolio: (pnlEur / portfolioValBefore) * 100,
  };

  state.open_positions = state.open_positions.filter((p) => p.id !== pos.id);
  state.closed_positions.push(closed);

  const today = todayUtc();
  const dailyRec = getOrInitDailyLoss(state, today);
  dailyRec.realized_pnl_eur += pnlEur;
  const { value: portfolioValAfter } = await portfolioValue(state);
  if (dailyRec.realized_pnl_eur < 0 && Math.abs(dailyRec.realized_pnl_eur) / portfolioValAfter * 100 >= RISK_LIMITS.MAX_DAILY_LOSS_PCT) {
    dailyRec.halted = true;
  }

  await appendTradeLog(formatCloseEntry(closed, dailyRec.halted));
  return closed;
}

export interface ClosePositionInput {
  position_id: string;
  reason: string;
}

export type ClosePositionResult = RiskCheckFailure | { ok: true; position: ClosedPosition };

// Manual override only - cancels the resting stop and market-sells. The
// resting stop order handles the ordinary case; this exists for explicit
// intervention (e.g. the agent's own judgment overrides the mechanical
// exit, or a cleanup after something went wrong).
export async function closePosition(input: ClosePositionInput): Promise<ClosePositionResult> {
  const state = await loadState();
  const pos = state.open_positions.find((p) => p.id === input.position_id);
  if (!pos) {
    return { ok: false, reason: `No open position with id ${input.position_id}.` };
  }

  if (pos.stop_order_txid) {
    try {
      await cancelOrder(pos.stop_order_txid);
    } catch {
      // Already filled/canceled - fine, proceed to close at market.
    }
  }

  const sellOrder = await addOrder({
    pair: pairCode(pos.pair),
    type: "sell",
    ordertype: "market",
    volume: await formatVolume(pos.pair, pos.quantity),
  });
  const sellTxid = sellOrder.txid?.[0];
  if (!sellTxid) {
    return { ok: false, reason: `Kraken AddOrder (manual close) did not return a txid - response: ${JSON.stringify(sellOrder)}. Check Kraken directly.` };
  }
  const filled = await pollForFill(sellTxid);
  const closed = await recordClose(state, pos, Number(filled.price), Number(filled.fee), input.reason);
  await saveState(state);
  return { ok: true, position: closed };
}

export interface StopCheckAction {
  position_id: string;
  pair: AllowedPair;
  triggered: "stop_loss" | "take_profit" | "invalidation";
  closed: ClosedPosition;
}

// Called on a schedule. Two duties, both new relative to paper trading's
// checkStops (which never had a real order book to reconcile against):
//
//   1. Reconciliation - the resting stop order can fill at ANY moment,
//      not just when this runs. Check each position's stop_order_txid
//      first; if it's already closed, Kraken (not this code) decided the
//      exit - record the REAL fill price/fee rather than assuming.
//   2. Trailing maintenance - for positions still open, refresh peak_price,
//      evaluate +1R/trailing-floor (same math as paper, imported from
//      trailing-math.ts), and if the floor has risen, cancel + replace the
//      resting stop order with one at the new level.
//
// Take-profit (pre-trailing only - superseded once trailing_active) is
// still a polled check against live ticker, same as paper - see the
// "single real resting order" reasoning in openPosition above.
export async function checkStops(): Promise<StopCheckAction[]> {
  const state = await loadState();
  const actions: StopCheckAction[] = [];
  let stateChanged = false;

  for (const pos of [...state.open_positions]) {
    // --- 1. Reconciliation: did the resting stop already fill? ---
    if (pos.stop_order_txid) {
      const info = await queryOrdersInfo([pos.stop_order_txid]);
      const stopOrder = info[pos.stop_order_txid];
      if (stopOrder && stopOrder.status === "closed") {
        const closed = await recordClose(
          state,
          pos,
          Number(stopOrder.price),
          Number(stopOrder.fee),
          pos.trailing_active
            ? `Trailing stop-loss filled on Kraken (order ${pos.stop_order_txid}) - position had reached +1R, guaranteed-profit floor was in effect.`
            : `Stop-loss filled on Kraken (order ${pos.stop_order_txid}).`
        );
        actions.push({ position_id: pos.id, pair: pos.pair, triggered: "stop_loss", closed });
        stateChanged = true;
        continue; // nothing left to maintain for a position that's now closed
      }
    }

    const ticker = await fetchTicker(pos.pair);

    // --- Take-profit check (pre-trailing only, polled) ---
    if (!pos.trailing_active) {
      if (ticker.last >= pos.take_profit) {
        if (pos.stop_order_txid) {
          try {
            await cancelOrder(pos.stop_order_txid);
          } catch {
            // If this fails because it already filled, the reconciliation
            // branch above will have already caught it this same cycle
            // (order matters: reconciliation ran first) - safe to proceed.
          }
        }
        const sellOrder = await addOrder({ pair: pairCode(pos.pair), type: "sell", ordertype: "market", volume: await formatVolume(pos.pair, pos.quantity) });
        const sellTxid = sellOrder.txid?.[0];
        if (sellTxid) {
          const filled = await pollForFill(sellTxid);
          const closed = await recordClose(
            state,
            pos,
            Number(filled.price),
            Number(filled.fee),
            `Take-profit auto-triggered (price ${ticker.last} >= target ${pos.take_profit}, ${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward).`
          );
          actions.push({ position_id: pos.id, pair: pos.pair, triggered: "take_profit", closed });
          stateChanged = true;
          continue;
        }
      }
    }

    // --- Invalidation check (pre-trailing only, profitable only) ---
    // A position that's profitable but hasn't yet earned trailing
    // protection is otherwise only guarded by its original hard stop -
    // meaning it can round-trip all the way back down to a loss even after
    // its own stated thesis has already broken. Added 2026-09-26: if the
    // most recently CLOSED 4h candle has closed below the rising
    // TRAIL_SMA_PERIOD-period 4h SMA this trade depends on (see
    // invalidationCheck in trailing-math.ts), close early rather than wait
    // for the hard stop. Deliberately scoped to non-trailing positions only
    // (trailing_active positions are already governed by their own
    // ratcheting stop) and to currently-profitable positions only (an
    // already-underwater position is left to the original hard stop, per
    // this feature's own framing - it's about protecting a winner, not a
    // general early-exit rule).
    if (!pos.trailing_active && ticker.last > pos.entry_price) {
      const invalidation = await invalidationCheck(pos.pair);
      if (invalidation.breached) {
        if (pos.stop_order_txid) {
          try {
            await cancelOrder(pos.stop_order_txid);
          } catch {
            // If this fails because it already filled, the reconciliation
            // branch above will have already caught it this same cycle.
          }
        }
        const sellOrder = await addOrder({ pair: pairCode(pos.pair), type: "sell", ordertype: "market", volume: await formatVolume(pos.pair, pos.quantity) });
        const sellTxid = sellOrder.txid?.[0];
        if (sellTxid) {
          const filled = await pollForFill(sellTxid);
          const closed = await recordClose(
            state,
            pos,
            Number(filled.price),
            Number(filled.fee),
            `Invalidation close: still-profitable pre-+1R position, but the stated technical invalidation broke - most recent closed 4h candle (${invalidation.lastClose}) closed below the ${TRAIL_SMA_PERIOD}-period 4h SMA (${invalidation.sma20}) this trade's thesis depended on. Closed early rather than risk a round-trip back to the hard stop.`
          );
          actions.push({ position_id: pos.id, pair: pos.pair, triggered: "invalidation", closed });
          stateChanged = true;
          continue;
        }
      }
    }

    // --- 2. Trailing maintenance ---
    const newPeak = Math.max(await historicalPeakSinceEntry(pos), ticker.last, pos.peak_price);
    if (newPeak > pos.peak_price) {
      pos.peak_price = newPeak;
      stateChanged = true;
    }
    if (!pos.trailing_active && hasReachedOneR(pos.entry_price, pos.initial_stop_loss, pos.peak_price)) {
      pos.trailing_active = true;
      stateChanged = true;
    }
    if (pos.trailing_active) {
      const candidate = await trailingStopCandidate(pos);
      if (candidate > pos.stop_loss && pos.stop_order_txid) {
        try {
          await cancelOrder(pos.stop_order_txid);
        } catch {
          // Already filled - reconciliation will catch it next cycle; don't
          // place a duplicate resting order for a position that just closed.
          continue;
        }
        const newStopOrder = await addOrder({
          pair: pairCode(pos.pair),
          type: "sell",
          ordertype: "stop-loss",
          price: await formatPrice(pos.pair, candidate),
          volume: await formatVolume(pos.pair, pos.quantity),
        });
        const newStopTxid = newStopOrder.txid?.[0];
        if (!newStopTxid) {
          // Cancelled the old stop but failed to place the new one - the
          // position is now UNPROTECTED. Surface loudly rather than silently
          // continuing; caller must see this in the tool result.
          throw new KrakenApiError(
            `CRITICAL: cancelled stop order ${pos.stop_order_txid} for position ${pos.id} (${pos.pair}) to raise the trailing floor to ${candidate}, but the replacement order failed - Kraken response: ${JSON.stringify(newStopOrder)}. This position has NO stop-loss protection right now. Check Kraken directly immediately.`
          );
        }
        pos.stop_loss = candidate;
        pos.stop_order_txid = newStopTxid;
        stateChanged = true;
      }
    }
  }

  if (stateChanged) {
    await saveState(state);
  }
  return actions;
}

export async function logNoTrade(input: { pair: string; reasoning: string; signals_considered: Record<string, unknown> }): Promise<{ ok: true; pair: string; logged_at: string }> {
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

function formatOpenEntry(p: Position): string {
  const lines = [
    `### ${p.opened_at} — ${p.pair} — LONG — OPENED (LIVE)`,
    "",
    `- Entry price: €${p.entry_price.toFixed(2)} (real fill, Kraken order ${p.entry_order_txid})`,
    `- Stop-loss: €${p.stop_loss.toFixed(2)} (real resting order ${p.stop_order_txid})`,
    `- Take-profit target: €${p.take_profit.toFixed(2)} (${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward, polled - not a resting order, see checkStops)`,
    `- Position size: ${p.size_pct}% of portfolio (€${p.size_eur.toFixed(2)}, qty ${p.quantity.toFixed(8)})`,
    `- Entry fee (real): €${p.entry_fee.toFixed(2)}`,
    `- Confidence: ${p.confidence} — ${p.confidence_reason}`,
    `- Momentum-only trigger: ${p.momentum_only ? "yes" : "no"}`,
    `- Invalidation: ${p.invalidation}`,
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

function formatCloseEntry(p: ClosedPosition, dayHalted: boolean): string {
  const lines = [
    `### ${p.closed_at} — ${p.pair} — LONG — CLOSED (LIVE)`,
    "",
    `- Exit price: €${p.exit_price.toFixed(2)} (real fill)`,
    `- Exit fee (real): €${p.exit_fee.toFixed(2)}`,
    `- Reason: ${p.close_reason}`,
    `- Realized P&L: €${p.pnl_eur.toFixed(2)} (${p.pnl_pct_of_portfolio.toFixed(2)}% of portfolio)`,
    `- Position id: ${p.id}`,
    ...(dayHalted
      ? ["", "**⚠ Daily loss limit hit — no new positions until tomorrow (UTC).**"]
      : []),
    "",
    "---",
    "",
  ];
  return lines.join("\n");
}

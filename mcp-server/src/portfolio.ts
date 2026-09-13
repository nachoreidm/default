import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchTicker } from "./kraken.js";
import {
  ALLOWED_PAIRS,
  RISK_LIMITS,
  CONFIDENCE_MAX_SIZE_PCT,
  TAKER_FEE_PCT,
  SLIPPAGE_PCT,
  TAKE_PROFIT_RR_MULTIPLE,
  isAllowedPair,
  type AllowedPair,
  type ClosedPosition,
  type Confidence,
  type PortfolioState,
  type Position,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "portfolio_state.json");
const TRADES_LOG_PATH = path.join(REPO_ROOT, "trades.md");

const STARTING_BALANCE = 10_000;

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

async function saveState(state: PortfolioState): Promise<void> {
  state.updated_at = new Date().toISOString();
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function appendTradeLog(entry: string): Promise<void> {
  await fs.appendFile(TRADES_LOG_PATH, entry.endsWith("\n") ? entry : entry + "\n", "utf-8");
}

async function currentPriceOf(pair: AllowedPair): Promise<number> {
  const ticker = await fetchTicker(pair);
  return ticker.last;
}

async function portfolioValue(state: PortfolioState): Promise<{ value: number; positionValues: Record<string, number> }> {
  let value = state.cash;
  const positionValues: Record<string, number> = {};
  for (const pos of state.open_positions) {
    const price = await currentPriceOf(pos.pair);
    const marketValue = pos.quantity * price;
    positionValues[pos.id] = marketValue;
    value += marketValue;
  }
  return { value, positionValues };
}

function getOrInitDailyLoss(state: PortfolioState, date: string) {
  let rec = state.daily_loss.find((d) => d.date === date);
  if (!rec) {
    rec = { date, realized_pnl_usd: 0, halted: false };
    state.daily_loss.push(rec);
  }
  return rec;
}

export interface PortfolioSnapshot {
  starting_balance: number;
  cash: number;
  portfolio_value: number;
  open_positions: Array<Position & { current_price: number; market_value: number; unrealized_pnl_usd: number; unrealized_pnl_pct: number }>;
  open_position_count: number;
  total_exposure_pct: number;
  today_utc: string;
  today_realized_pnl_usd: number;
  today_halted: boolean;
  closed_position_count: number;
}

export async function getSnapshot(): Promise<PortfolioSnapshot> {
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

export interface OpenPositionInput {
  pair: string;
  size_pct: number;
  stop_loss: number;
  invalidation: string;
  confidence: Confidence;
  confidence_reason: string;
  signals_at_entry: Record<string, unknown>;
}

export interface RiskCheckFailure {
  ok: false;
  reason: string;
}

export type OpenPositionResult = RiskCheckFailure | { ok: true; position: Position };

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

  const position: Position = {
    id: randomUUID(),
    pair: input.pair,
    direction: "long",
    entry_price: fillPrice,
    stop_loss: input.stop_loss,
    take_profit: takeProfit,
    size_pct: input.size_pct,
    size_usd: newSizeUsd,
    quantity,
    entry_fee: fee,
    opened_at: new Date().toISOString(),
    signals_at_entry: input.signals_at_entry,
    invalidation: input.invalidation,
    confidence: input.confidence,
    confidence_reason: input.confidence_reason,
    status: "open",
  };

  state.cash -= newSizeUsd;
  state.open_positions.push(position);
  await saveState(state);

  await appendTradeLog(formatOpenEntry(position));

  return { ok: true, position };
}

export interface ClosePositionInput {
  position_id: string;
  reason: string;
}

export type ClosePositionResult = RiskCheckFailure | { ok: true; position: ClosedPosition };

export async function closePosition(input: ClosePositionInput): Promise<ClosePositionResult> {
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

  const closed: ClosedPosition = {
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

export interface StopCheckAction {
  position_id: string;
  pair: AllowedPair;
  triggered: "stop_loss" | "take_profit";
  closed: ClosedPosition;
}

// Meant to be called on a schedule (or on demand) to auto-close any open
// position whose stop-loss or take-profit has been breached, independent
// of whether anyone is actively chatting with the agent. Take-profit is
// checked first so a candle that gaps through both levels in one tick
// (rare, but possible with slippage) is recorded as the win it is rather
// than the loss the stop would otherwise claim.
export async function checkStops(): Promise<StopCheckAction[]> {
  const state = await loadState();
  const actions: StopCheckAction[] = [];
  for (const pos of [...state.open_positions]) {
    const ticker = await fetchTicker(pos.pair);
    if (ticker.last >= pos.take_profit) {
      const result = await closePosition({ position_id: pos.id, reason: `Take-profit auto-triggered (price ${ticker.last} >= target ${pos.take_profit}, ${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward).` });
      if (result.ok) {
        actions.push({ position_id: pos.id, pair: pos.pair, triggered: "take_profit", closed: result.position });
      }
    } else if (ticker.last <= pos.stop_loss) {
      const result = await closePosition({ position_id: pos.id, reason: `Stop-loss auto-triggered (price ${ticker.last} <= stop ${pos.stop_loss}).` });
      if (result.ok) {
        actions.push({ position_id: pos.id, pair: pos.pair, triggered: "stop_loss", closed: result.position });
      }
    }
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
    `### ${p.opened_at} — ${p.pair} — LONG — OPENED`,
    "",
    `- Entry price: $${p.entry_price.toFixed(2)}`,
    `- Stop-loss: $${p.stop_loss.toFixed(2)}`,
    `- Take-profit: $${p.take_profit.toFixed(2)} (${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward, fixed at entry)`,
    `- Position size: ${p.size_pct}% of portfolio ($${p.size_usd.toFixed(2)}, qty ${p.quantity.toFixed(8)})`,
    `- Entry fee (paper): $${p.entry_fee.toFixed(2)}`,
    `- Confidence: ${p.confidence} — ${p.confidence_reason}`,
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

function formatCloseEntry(p: ClosedPosition, dayHalted: boolean): string {
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

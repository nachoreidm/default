// Exchange-agnostic trailing-stop / profit-lock math, shared between the
// (now-removed on this branch) paper-trading engine and portfolio-live.ts.
// Originally lived in portfolio.ts; moved out on the live-trading branch
// since portfolio.ts's paper-simulation code (local fill/fee modeling,
// self-triggered closes) has no live counterpart and was deleted here -
// this file holds only the parts that were always exchange-agnostic.
import { fetchOHLC, closedCandles } from "./kraken.js";
import { sma } from "./indicators.js";
import { TRAIL_SMA_PERIOD, PEAK_PROFIT_LOCK_FRACTION, ROUND_TRIP_COST_PCT, type Candle, type Position } from "./types.js";

// Has price reached the position's own +1R level (up by its entry-to-stop
// risk amount)? False for zero/negative risk (shouldn't happen - open
// requires stop_loss below entry - but guards a divide-by-nothing edge
// case). Call with the position's peak_price (see peakFromCandles below),
// not a live point-sample - a trade that briefly touched +1R and pulled
// back before the next check still earned the trailing treatment.
export function hasReachedOneR(entryPrice: number, initialStopLoss: number, currentPrice: number): boolean {
  const risk = entryPrice - initialStopLoss;
  return risk > 0 && currentPrice >= entryPrice + risk;
}

// The effective stop once trailing is active. Floor guarantees
// PEAK_PROFIT_LOCK_FRACTION of the trade's PEAK gain (peakPrice -
// entryPrice, the highest price reached so far - not just the gain at the
// moment +1R first triggered) as locked-in profit, or enough to clear real
// round-trip transaction costs (ROUND_TRIP_COST_PCT), whichever is larger.
// Since peakPrice only ever grows, this floor ratchets up as a rally
// extends. Trails higher still if sma20 has risen above that floor. Never
// returns a value below currentStopLoss - the trail only ever moves up.
export function effectiveTrailingStop(entryPrice: number, peakPrice: number, currentStopLoss: number, sma20: number | null): number {
  const peakGain = peakPrice - entryPrice;
  const profitFloor = entryPrice + Math.max(PEAK_PROFIT_LOCK_FRACTION * peakGain, entryPrice * (ROUND_TRIP_COST_PCT / 100));
  const candidate = sma20 !== null && sma20 > profitFloor ? sma20 : profitFloor;
  return Math.max(candidate, currentStopLoss);
}

// Fetches the current TRAIL_SMA_PERIOD 4h SMA for a position's pair and
// combines it with effectiveTrailingStop above. Falls back to the
// guaranteed-profit floor alone if 4h candles can't be fetched this cycle.
export async function trailingStopCandidate(pos: Position): Promise<number> {
  let sma20: number | null = null;
  try {
    const candles4h = closedCandles(await fetchOHLC(pos.pair, "4h"));
    const closes = candles4h.map((c) => c.close);
    const smaSeries = sma(closes, TRAIL_SMA_PERIOD);
    if (smaSeries.length > 0) sma20 = smaSeries[smaSeries.length - 1];
  } catch {
    // 4h candles unavailable this cycle - trail on the guaranteed-profit floor alone.
  }
  return effectiveTrailingStop(pos.entry_price, pos.peak_price, pos.stop_loss, sma20);
}

// The highest candle `high` at or after entryTs, floored at currentPeak
// (never regresses even if no candles qualify). Deliberately takes the
// still-forming last candle too (its `high` is a true running high-so-far,
// updated in real time by Kraken - unlike `close`), so a spike-and-reversal
// within the current hour is still captured.
export function peakFromCandles(candles: Candle[], entryTs: number, currentPeak: number): number {
  const highsSinceEntry = candles.filter((c) => c.time >= entryTs).map((c) => c.high);
  return highsSinceEntry.length > 0 ? Math.max(...highsSinceEntry, currentPeak) : currentPeak;
}

// Fetches 1h candles since the position's entry and combines them with
// peakFromCandles above. Point-sampling ticker.last once per cycle would
// silently understate the guaranteed-profit floor if a spike-and-reversal
// happened between two checks. Falls back to the position's current
// peak_price if candles are unavailable this cycle.
export async function historicalPeakSinceEntry(pos: Position): Promise<number> {
  try {
    const candles = await fetchOHLC(pos.pair, "1h");
    const entryTs = Math.floor(new Date(pos.opened_at).getTime() / 1000);
    return peakFromCandles(candles, entryTs, pos.peak_price);
  } catch {
    return pos.peak_price;
  }
}

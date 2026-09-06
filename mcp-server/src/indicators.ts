import type { Candle, OrderBook } from "./types.js";

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

// Wilder's RSI, aligned to the input closes (returns one value per close
// once enough history exists; first `period` values have no RSI).
export function rsi(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const out: number[] = [];
  const rsiFrom = (ag: number, al: number) => {
    if (al === 0) return 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  };
  out.push(rsiFrom(avgGain, avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out.push(rsiFrom(avgGain, avgLoss));
  }
  return out;
}

export interface SmaCrossoverResult {
  fast_period: number;
  slow_period: number;
  fast_value: number;
  slow_value: number;
  state: "fast_above_slow" | "fast_below_slow";
  crossed_this_candle: boolean;
  crossover_direction: "bullish" | "bearish" | null;
}

export function smaCrossover(closes: number[], fastPeriod = 20, slowPeriod = 50): SmaCrossoverResult | null {
  const fastSeries = sma(closes, fastPeriod);
  const slowSeries = sma(closes, slowPeriod);
  if (fastSeries.length < 2 || slowSeries.length < 2) return null;

  // Align both series to the same end point (closes.length).
  const fastNow = fastSeries[fastSeries.length - 1];
  const slowNow = slowSeries[slowSeries.length - 1];
  const fastPrev = fastSeries[fastSeries.length - 2];
  const slowPrev = slowSeries[slowSeries.length - 2];

  const nowAbove = fastNow > slowNow;
  const prevAbove = fastPrev > slowPrev;
  const crossed = nowAbove !== prevAbove;

  return {
    fast_period: fastPeriod,
    slow_period: slowPeriod,
    fast_value: fastNow,
    slow_value: slowNow,
    state: nowAbove ? "fast_above_slow" : "fast_below_slow",
    crossed_this_candle: crossed,
    crossover_direction: crossed ? (nowAbove ? "bullish" : "bearish") : null,
  };
}

export interface VolumeSignal {
  last_24h_volume: number;
  avg_prior_7d_daily_volume: number;
  ratio: number;
  flag_above_2x: boolean;
}

// dailyCandles should be closed daily candles, oldest first, with at least
// 8 entries: the last one is "last 24h", the 7 before it are the trailing
// week used for the average.
export function volumeVs7dAvg(dailyCandles: Candle[]): VolumeSignal | null {
  if (dailyCandles.length < 8) return null;
  const last = dailyCandles[dailyCandles.length - 1];
  const prior7 = dailyCandles.slice(-8, -1);
  const avg = prior7.reduce((a, c) => a + c.volume, 0) / prior7.length;
  const ratio = avg === 0 ? 0 : last.volume / avg;
  return {
    last_24h_volume: last.volume,
    avg_prior_7d_daily_volume: avg,
    ratio,
    flag_above_2x: ratio > 2,
  };
}

export interface PriceActionSummary {
  candles_used: number;
  window_hours: number;
  first_close: number;
  last_close: number;
  pct_change: number;
  period_high: number;
  period_low: number;
}

export function priceAction(candles: Candle[], windowHours: number): PriceActionSummary {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const pctChange = ((last.close - first.close) / first.close) * 100;
  return {
    candles_used: candles.length,
    window_hours: windowHours,
    first_close: first.close,
    last_close: last.close,
    pct_change: pctChange,
    period_high: Math.max(...candles.map((c) => c.high)),
    period_low: Math.min(...candles.map((c) => c.low)),
  };
}

export interface OrderBookImbalance {
  levels: number;
  bid_volume: number;
  ask_volume: number;
  imbalance: number; // -1 (all ask) .. +1 (all bid)
}

export function orderBookImbalance(book: OrderBook, levels = 10): OrderBookImbalance {
  const bids = book.bids.slice(0, levels);
  const asks = book.asks.slice(0, levels);
  const bidVolume = bids.reduce((a, l) => a + l.volume, 0);
  const askVolume = asks.reduce((a, l) => a + l.volume, 0);
  const total = bidVolume + askVolume;
  return {
    levels,
    bid_volume: bidVolume,
    ask_volume: askVolume,
    imbalance: total === 0 ? 0 : (bidVolume - askVolume) / total,
  };
}

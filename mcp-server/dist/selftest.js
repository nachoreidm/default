import { fetchOHLC, fetchTicker, fetchDepth, closedCandles } from "./kraken.js";
import { rsi, sma, smaCrossover, volumeVs7dAvg, orderBookImbalance, priceAction } from "./indicators.js";
import { computeSignals } from "./signals.js";
import { hasReachedOneR, effectiveTrailingStop } from "./portfolio.js";
import { ALLOWED_PAIRS } from "./types.js";
function assert(cond, msg) {
    if (!cond)
        throw new Error(`ASSERTION FAILED: ${msg}`);
    console.log(`ok: ${msg}`);
}
async function main() {
    // --- Indicator math sanity checks against known values ---
    // Classic RSI textbook example (Wilder), 15 closes -> 1 RSI value.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const r = rsi(closes, 14);
    assert(r.length === 1, "rsi returns one value for 15 closes at period 14");
    assert(Math.abs(r[0] - 70.53) < 0.5, `rsi ~70.5 (got ${r[0].toFixed(2)})`);
    const smaVals = sma([1, 2, 3, 4, 5], 3);
    assert(JSON.stringify(smaVals) === JSON.stringify([2, 3, 4]), `sma period 3 over [1..5] -> [2,3,4] (got ${smaVals})`);
    const cross = smaCrossover([1, 1, 1, 1, 1, 5, 5, 5, 5, 5], 3, 5);
    assert(cross !== null, "smaCrossover returns a result with enough history");
    const vol = volumeVs7dAvg([
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 10, count: 0 },
        { time: 0, open: 0, high: 0, low: 0, close: 0, vwap: 0, volume: 25, count: 0 },
    ]);
    assert(vol !== null && Math.abs(vol.ratio - 2.5) < 0.001, `volume ratio 2.5x flags above-2x (got ${vol?.ratio})`);
    assert(vol.flag_above_2x === true, "volume flag_above_2x true for 2.5x");
    const imb = orderBookImbalance({
        pair: "BTC/USD",
        bids: [{ price: 100, volume: 10 }],
        asks: [{ price: 101, volume: 5 }],
    }, 10);
    assert(Math.abs(imb.imbalance - (5 / 15)) < 0.001, `order book imbalance skews toward bids (got ${imb.imbalance})`);
    // --- Breakeven/trailing-stop exit-logic math (pure, no network) ---
    assert(hasReachedOneR(100, 90, 109.9) === false, "hasReachedOneR false just below entry+1R (100/90/109.9)");
    assert(hasReachedOneR(100, 90, 110) === true, "hasReachedOneR true exactly at entry+1R (100/90/110)");
    assert(hasReachedOneR(100, 90, 150) === true, "hasReachedOneR true well past entry+1R (100/90/150)");
    assert(hasReachedOneR(100, 100, 200) === false, "hasReachedOneR false for zero risk (entry == initial stop)");
    // effectiveTrailingStop(entryPrice, peakPrice, currentStopLoss, sma20).
    // entry=100, peakPrice=110 (peak gain=10, equivalent to a trade that
    // just barely reached +1R with a $10 original risk) -> 0.3x peak-gain
    // lock = 103, fee-floor (ROUND_TRIP_COST_PCT=0.9%) = 100.9 -> lock (103) wins.
    assert(effectiveTrailingStop(100, 110, 90, null) === 103, "effectiveTrailingStop floors at 0.3x peak gain with no SMA data (got not 103)");
    assert(effectiveTrailingStop(100, 110, 90, 101) === 103, "effectiveTrailingStop floors at the peak-gain lock when SMA is still below it (101 < 103)");
    assert(effectiveTrailingStop(100, 110, 90, 110) === 110, "effectiveTrailingStop trails up to a rising SMA above the lock floor (110 > 103)");
    assert(effectiveTrailingStop(100, 110, 108, 105) === 108, "effectiveTrailingStop never moves the stop down (108 already above candidate 103/105)");
    // entry=100, peakPrice=101 (peak gain=1, a very small gain so far) ->
    // 0.3x peak gain = 100.3, fee-floor = 100.9 -> fee-floor wins here,
    // proving the max() defensive term works.
    assert(effectiveTrailingStop(100, 101, 95, null) === 100.9, "effectiveTrailingStop falls back to the fee/slippage floor when 0.3x peak gain is too small (got not 100.9)");
    // The core new behavior: the lock RATCHETS UP as the peak extends
    // further, rather than staying pinned at the gain reached when +1R
    // first triggered. entry=100, a rally to peak=130 (peak gain=30, e.g.
    // +3R on a $10 original risk) locks 0.3*30=9 -> floor=109, clearly
    // higher than the 103 floor a peak of only 110 (+1R) would produce.
    assert(effectiveTrailingStop(100, 130, 90, null) === 109, "effectiveTrailingStop locks more profit for a bigger peak (130 -> 109) than a smaller one (110 -> 103)");
    // --- Live Kraken API smoke test (public endpoints, no auth) ---
    const ticker = await fetchTicker("BTC/USD");
    assert(ticker.last > 0, `live BTC/USD ticker last price > 0 (got ${ticker.last})`);
    assert(ticker.ask >= ticker.bid, "ask >= bid");
    // Every allowed pair (including the newly added ADA/LINK/DOGE and the
    // Kraken-internal XDG code for DOGE) must resolve to a real, tradeable
    // Kraken ticker - catches a wrong PAIR_CODE mapping immediately.
    for (const pair of ALLOWED_PAIRS) {
        const t = await fetchTicker(pair);
        assert(t.last > 0, `live ${pair} ticker last price > 0 (got ${t.last})`);
    }
    const candles1h = closedCandles(await fetchOHLC("BTC/USD", "1h"));
    assert(candles1h.length > 48, `enough 1h candles for 48h window (got ${candles1h.length})`);
    const pa = priceAction(candles1h.slice(-48), 48);
    assert(pa.candles_used === 48, "priceAction uses the 48 candles given");
    const book = await fetchDepth("BTC/USD", 10);
    assert(book.bids.length > 0 && book.asks.length > 0, "order book has bids and asks");
    const signals = await computeSignals("BTC/USD");
    assert(signals.current_price > 0, "compute_signals returns a current price");
    console.log("\nFull signal report for BTC/USD:\n", JSON.stringify(signals, null, 2));
    console.log("\nALL SELF-TESTS PASSED");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});

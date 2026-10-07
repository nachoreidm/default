import { fetchOHLC, fetchTicker, fetchDepth, closedCandles } from "./kraken.js";
import { rsi, sma, smaCrossover, volumeVs7dAvg, orderBookImbalance, priceAction } from "./indicators.js";
import { computeSignals } from "./signals.js";
import { hasReachedOneR, effectiveTrailingStop, peakFromCandles, invalidationCheck, fastInvalidationFromCloses, fastInvalidationCheck } from "./trailing-math.js";
import { computePositionSizePct } from "./portfolio-live.js";
import { ALLOWED_PAIRS } from "./types.js";
function candle(time, high) {
    return { time, open: high, high, low: high, close: high, vwap: high, volume: 0, count: 0 };
}
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
        pair: "BTC/EUR",
        bids: [{ price: 100, volume: 10 }],
        asks: [{ price: 101, volume: 5 }],
    }, 10);
    assert(Math.abs(imb.imbalance - (5 / 15)) < 0.001, `order book imbalance skews toward bids (got ${imb.imbalance})`);
    // --- Breakeven/trailing-stop exit-logic math (pure, no network) ---
    assert(hasReachedOneR(100, 90, 109.9) === false, "hasReachedOneR false just below entry+1R (100/90/109.9)");
    assert(hasReachedOneR(100, 90, 110) === true, "hasReachedOneR true exactly at entry+1R (100/90/110)");
    assert(hasReachedOneR(100, 90, 150) === true, "hasReachedOneR true well past entry+1R (100/90/150)");
    assert(hasReachedOneR(100, 100, 200) === false, "hasReachedOneR false for zero risk (entry == initial stop)");
    // effectiveTrailingStop(entryPrice, initialStopLoss, peakPrice, currentStopLoss, sma20).
    // entry=100, initialStop=90 (R=10), peakPrice=110 (peak gain=10, exactly
    // +1R) -> tier 1 (0.5x peak gain, raised from 0.4 on 2026-10-06 - see
    // CLAUDE.md's "Trailing-stop profit-lock asymmetry" entry) = 105,
    // fee-floor (ROUND_TRIP_COST_PCT=1.3%) = 101.3 -> lock (105) wins.
    assert(effectiveTrailingStop(100, 90, 110, 90, null) === 105, "effectiveTrailingStop floors at tier-1 (0.5x) peak gain with no SMA data (got not 105)");
    assert(effectiveTrailingStop(100, 90, 110, 90, 101) === 105, "effectiveTrailingStop floors at the peak-gain lock when SMA is still below it (101 < 105)");
    assert(effectiveTrailingStop(100, 90, 110, 90, 106) === 106, "effectiveTrailingStop trails up to a rising SMA above the lock floor (106 > 105)");
    assert(effectiveTrailingStop(100, 90, 110, 108, 106) === 108, "effectiveTrailingStop never moves the stop down (108 already above candidate 105/106)");
    // entry=100, initialStop=90, peakPrice=101 (peak gain=1, a very small
    // gain so far, R-multiple 0.1) -> tier-1 fraction still applies as the
    // pre-+1R default (0.5x1=0.5), fee-floor = 101.3 -> fee-floor wins either
    // way (0.5 and the old 0.4 both lose to the 1.3 fee floor), proving the
    // max() defensive term still works after the fraction change.
    assert(effectiveTrailingStop(100, 90, 101, 95, null) === 101.3, "effectiveTrailingStop falls back to the fee/slippage floor when tier-1 peak gain is too small (got not 101.3)");
    // Tiered PEAK_PROFIT_LOCK_TIERS (tier-1 raised 0.4->0.5 on 2026-10-06,
    // see CLAUDE.md): tier 1 and tier 2 are now BOTH 0.5, so there's no
    // longer a visible fraction jump at the old +2R boundary - only the peak
    // gain itself grows the floor between R=1.9 and R=2.0. The one remaining
    // real step up is tier 3 (0.6x) at +3R. entry=100, initialStop=90 (R=10):
    // just below the +2R boundary (peak=119, R-multiple 1.9) uses the shared
    // tier 1/2 fraction 0.5 -> floor = 100 + 0.5*19 = 109.5.
    assert(effectiveTrailingStop(100, 90, 119, 90, null) === 109.5, "effectiveTrailingStop at R=1.9 uses the now-unified 0.5x fraction (got not 109.5)");
    // Exactly +2R (peak=120, R-multiple 2.0) - same 0.5x fraction as tier 1
    // now, so this is continued peak-gain growth, not a fraction boundary ->
    // floor = 100 + 0.5*20 = 110.
    assert(effectiveTrailingStop(100, 90, 120, 90, null) === 110, "effectiveTrailingStop at exactly +2R stays 0.5x since tiers 1 and 2 are now equal (got not 110)");
    // Exactly +3R (peak=130, R-multiple 3.0) crosses into tier 3 (0.6x) ->
    // floor = 100 + 0.6*30 = 118 - the one remaining real step up, vs the
    // +1R case's 105.
    assert(effectiveTrailingStop(100, 90, 130, 90, null) === 118, "effectiveTrailingStop locks tier-3 (0.6x) profit for a peak at +3R (got not 118)");
    // peakFromCandles(candles, entryTs, currentPeak) - the fix for
    // point-sampling ticker.last: a spike-and-reversal between two checks
    // must still be captured via candle highs, not missed entirely.
    const candles = [
        candle(1000, 105), // before entry - must be excluded
        candle(2000, 108), // at/after entry - counts
        candle(3000, 112), // the spike that would be missed by point-sampling
        candle(4000, 106), // price already reversed back down by "now"
    ];
    assert(peakFromCandles(candles, 2000, 100) === 112, "peakFromCandles catches an intra-window spike that already reversed (got not 112)");
    assert(peakFromCandles(candles, 2000, 115) === 115, "peakFromCandles never regresses below the currently-stored peak (115 > 112)");
    assert(peakFromCandles([], 2000, 100) === 100, "peakFromCandles falls back to currentPeak when no candles qualify");
    assert(peakFromCandles([candle(500, 999)], 2000, 100) === 100, "peakFromCandles ignores candles before entryTs even if their high is huge");
    // fastInvalidationFromCloses (2026-09-30 fast-invalidation feature) - pure
    // confirmation logic, no network needed. 20 flat closes at 100 (SMA~100),
    // then the last 2 dip to 90/89 - both below their own SMA(20) at that
    // point, so this should breach (the 2-candle confirmation requirement is
    // satisfied).
    const dipBoth = [...Array(20).fill(100), 90, 89];
    const dipBothResult = fastInvalidationFromCloses(dipBoth);
    assert(dipBothResult.breached === true, `fastInvalidationFromCloses breaches when the last 2 closes are both below their SMA (got ${JSON.stringify(dipBothResult)})`);
    // Same setup but only the LAST candle dips (100, then 89) - the
    // second-to-last close (100) sits exactly AT its own SMA (not below it),
    // so the 2-candle confirmation requirement is NOT met. Proves a single
    // dipping candle alone can't trigger this - the whole reason it requires
    // FAST_INVALIDATION_CONFIRM_CANDLES consecutive closes, unlike the 4h
    // check's single-candle rule.
    const dipOne = [...Array(20).fill(100), 100, 89];
    const dipOneResult = fastInvalidationFromCloses(dipOne);
    assert(dipOneResult.breached === false, `fastInvalidationFromCloses does NOT breach on a single dipping candle - confirmation requires ${dipOneResult ? 2 : "?"} consecutive closes (got ${JSON.stringify(dipOneResult)})`);
    // Too little history for even one SMA(20) value - fails safe, not a crash.
    const tooShort = fastInvalidationFromCloses([1, 2, 3]);
    assert(tooShort.breached === false && tooShort.lastCloses === null, `fastInvalidationFromCloses fails safe with too little history (got ${JSON.stringify(tooShort)})`);
    // computePositionSizePct (2026-10-03 risk-based sizing, targets halved
    // 2026-10-07: medium 0.25%->0.125%, high 0.4%->0.2%, see CLAUDE.md) -
    // pure, no network. Caps unchanged: medium<=5%, high<=8% (also the
    // global RISK_LIMITS.MAX_POSITION_PCT=8%).
    assert(computePositionSizePct("medium", 2.5) === 5, `computePositionSizePct medium at 2.5% stop distance hits the 5% cap exactly (got ${computePositionSizePct("medium", 2.5)})`);
    assert(computePositionSizePct("medium", 10) === 1.25, `computePositionSizePct medium at 10% stop distance -> 1.25% (got ${computePositionSizePct("medium", 10)})`);
    assert(computePositionSizePct("high", 2.5) === 8, `computePositionSizePct high at 2.5% stop distance hits the 8% cap exactly (got ${computePositionSizePct("high", 2.5)})`);
    assert(computePositionSizePct("high", 40) === 0.5, `computePositionSizePct high at 40% stop distance -> 0.5% (got ${computePositionSizePct("high", 40)}) - below MIN_POSITION_PCT, would be rejected by openPosition's separate check, but the pure sizing function itself doesn't clamp to that floor`);
    assert(computePositionSizePct("low", 5) === 0, `computePositionSizePct returns 0 for "low" confidence regardless of stop distance (got ${computePositionSizePct("low", 5)})`);
    assert(computePositionSizePct("medium", 0) === 0, "computePositionSizePct fails safe (0) for a zero/invalid stop distance");
    // --- Live Kraken API smoke test (public endpoints, no auth) ---
    const ticker = await fetchTicker("BTC/EUR");
    assert(ticker.last > 0, `live BTC/EUR ticker last price > 0 (got ${ticker.last})`);
    assert(ticker.ask >= ticker.bid, "ask >= bid");
    // Every allowed pair (the EUR-re-screened live lineup, including SUI's
    // pair code) must resolve to a real, tradeable Kraken ticker - catches a
    // wrong PAIR_CODE mapping immediately.
    for (const pair of ALLOWED_PAIRS) {
        const t = await fetchTicker(pair);
        assert(t.last > 0, `live ${pair} ticker last price > 0 (got ${t.last})`);
    }
    const candles1h = closedCandles(await fetchOHLC("BTC/EUR", "1h"));
    assert(candles1h.length > 48, `enough 1h candles for 48h window (got ${candles1h.length})`);
    const pa = priceAction(candles1h.slice(-48), 48);
    assert(pa.candles_used === 48, "priceAction uses the 48 candles given");
    const book = await fetchDepth("BTC/EUR", 10);
    assert(book.bids.length > 0 && book.asks.length > 0, "order book has bids and asks");
    const signals = await computeSignals("BTC/EUR");
    assert(signals.current_price > 0, "compute_signals returns a current price");
    console.log("\nFull signal report for BTC/EUR:\n", JSON.stringify(signals, null, 2));
    // invalidationCheck (2026-09-26 early-close feature) - live smoke test,
    // no fixed expected outcome (breached depends on real current market
    // state) but must return real, self-consistent numbers, never the
    // fails-safe null/false default, for a liquid pair with ample history.
    const inv = await invalidationCheck("BTC/EUR");
    assert(inv.lastClose !== null && inv.sma20 !== null, `invalidationCheck returns real lastClose/sma20 for BTC/EUR (got ${JSON.stringify(inv)})`);
    assert(inv.breached === (inv.lastClose < inv.sma20), "invalidationCheck's breached flag matches lastClose < sma20");
    // fastInvalidationCheck (2026-09-30) - live smoke test, same style as
    // invalidationCheck above: no fixed expected outcome, but must return
    // real (non-null) data for a liquid pair with ample 1h history.
    const fastInv = await fastInvalidationCheck("BTC/EUR");
    assert(fastInv.lastCloses !== null && fastInv.lastSmas !== null, `fastInvalidationCheck returns real lastCloses/lastSmas for BTC/EUR (got ${JSON.stringify(fastInv)})`);
    assert(fastInv.breached === fastInv.lastCloses.every((c, i) => c < fastInv.lastSmas[i]), "fastInvalidationCheck's breached flag matches the 2-candle confirmation logic");
    console.log("\nALL SELF-TESTS PASSED");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});

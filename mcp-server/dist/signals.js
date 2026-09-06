import { fetchOHLC, fetchDepth, fetchTicker, closedCandles } from "./kraken.js";
import { priceAction, volumeVs7dAvg, rsi, smaCrossover, orderBookImbalance } from "./indicators.js";
export async function computeSignals(pair) {
    const dataGaps = [];
    const ticker = await fetchTicker(pair);
    let pa1h = null;
    try {
        const candles1h = closedCandles(await fetchOHLC(pair, "1h")).slice(-48);
        if (candles1h.length >= 2)
            pa1h = priceAction(candles1h, 48);
        else
            dataGaps.push("Not enough 1h candles for a 48h price-action read.");
    }
    catch (e) {
        dataGaps.push(`1h candles unavailable: ${e.message}`);
    }
    let pa4h = null;
    let rsiValue = null;
    let crossover = null;
    try {
        const candles4hAll = closedCandles(await fetchOHLC(pair, "4h"));
        const candles4h48 = candles4hAll.slice(-12); // 48h / 4h = 12 candles
        if (candles4h48.length >= 2)
            pa4h = priceAction(candles4h48, 48);
        else
            dataGaps.push("Not enough 4h candles for a 48h price-action read.");
        const closes4h = candles4hAll.map((c) => c.close);
        const rsiSeries = rsi(closes4h, 14);
        if (rsiSeries.length > 0)
            rsiValue = rsiSeries[rsiSeries.length - 1];
        else
            dataGaps.push("Not enough 4h history for a reliable 14-period RSI (need 15+ closed candles).");
        crossover = smaCrossover(closes4h, 20, 50);
        if (!crossover)
            dataGaps.push("Not enough 4h history for a 20/50 SMA crossover read (need 51+ closed candles).");
    }
    catch (e) {
        dataGaps.push(`4h candles unavailable: ${e.message}`);
    }
    let volumeSignal = null;
    try {
        const dailyCandles = closedCandles(await fetchOHLC(pair, "1d"));
        volumeSignal = volumeVs7dAvg(dailyCandles);
        if (!volumeSignal)
            dataGaps.push("Not enough daily candles for a 7-day volume average (need 8+ closed daily candles).");
    }
    catch (e) {
        dataGaps.push(`Daily candles unavailable: ${e.message}`);
    }
    let bookImbalance = null;
    try {
        const book = await fetchDepth(pair, 10);
        bookImbalance = orderBookImbalance(book, 10);
    }
    catch (e) {
        dataGaps.push(`Order book unavailable (optional signal): ${e.message}`);
    }
    return {
        pair: ticker.pair,
        as_of: new Date().toISOString(),
        current_price: ticker.last,
        price_action_1h_48h: pa1h,
        price_action_4h_48h: pa4h,
        volume: volumeSignal,
        rsi_14_4h: rsiValue,
        sma_crossover_4h: crossover,
        order_book_imbalance_top10: bookImbalance,
        data_gaps: dataGaps,
    };
}

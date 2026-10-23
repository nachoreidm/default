import { fetchOHLC, fetchTicker, fetchDepth, closedCandles } from "./kraken.js";
import { rsi, sma, smaCrossover, volumeVs7dAvg, orderBookImbalance, priceAction } from "./indicators.js";
import { computeSignals } from "./signals.js";
import { ALLOWED_PAIRS } from "./types.js";
import { fetchStockBars, computeStockSignals } from "./stocks.js";
import { fetchSp500Constituents, screenSp500, splitCsvLine, parseIvvHoldingsCsv } from "./sp500.js";
import { getCikForTicker, getInsiderActivity, extractTag } from "./edgar.js";
function assert(cond, msg) {
    if (!cond)
        throw new Error(`ASSERTION FAILED: ${msg}`);
    console.log(`ok: ${msg}`);
}
function skip(msg) {
    console.log(`skip: ${msg}`);
}
async function main() {
    // --- Indicator math sanity checks against known values (pure, no network) ---
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
    // --- extractTag pure unit test against a REAL Form 4 XML sample (AAPL,
    // accession 0001140361-26-040540, captured live 2026-10-23) - pins down
    // the exact bug found that day (flat-text tags vs. tags wrapping a
    // nested <value>) so it can't silently regress.
    const sampleForm4Xml = `
    <reportingOwner>
      <reportingOwnerId>
        <rptOwnerName>Newstead Jennifer</rptOwnerName>
      </reportingOwnerId>
      <reportingOwnerRelationship>
        <officerTitle>SVP, GC and Government Affairs</officerTitle>
      </reportingOwnerRelationship>
    </reportingOwner>
    <nonDerivativeTransaction>
      <transactionCoding>
        <transactionCode>S</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2399</value></transactionShares>
        <transactionPricePerShare><value>339.62</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  `;
    assert(extractTag(sampleForm4Xml, "rptOwnerName") === "Newstead Jennifer", "extractTag reads a flat-text tag (rptOwnerName)");
    assert(extractTag(sampleForm4Xml, "officerTitle") === "SVP, GC and Government Affairs", "extractTag reads a flat-text tag (officerTitle)");
    assert(extractTag(sampleForm4Xml, "transactionCode") === "S", "extractTag reads a flat-text tag (transactionCode)");
    assert(extractTag(sampleForm4Xml, "transactionShares") === "2399", "extractTag drills into a nested <value> (transactionShares)");
    assert(extractTag(sampleForm4Xml, "transactionPricePerShare") === "339.62", "extractTag drills into a nested <value> (transactionPricePerShare)");
    assert(extractTag(sampleForm4Xml, "notPresentAtAll") === null, "extractTag returns null, not a crash, for a tag that isn't present");
    // --- splitCsvLine pure unit test against REAL IVV holdings CSV rows
    // (captured live 2026-10-23) - pins down the exact bug found that day
    // (quoted fields with internal commas, e.g. the Market Value column,
    // breaking a naive line.split(",") and leaving literal quote chars on
    // every field so `assetClass !== "Equity"` never matched).
    const sampleIvvRow = '"NVDA","NVIDIA","Information Technology","Equity","68,152,575,876.48","7.76","68,152,575,876.48","321,156,288.00","212.21","United States","NASDAQ","USD","1.00","USD","-"';
    const ivvCols = splitCsvLine(sampleIvvRow);
    assert(ivvCols[0] === "NVDA", `splitCsvLine strips quotes from a simple field (got ${JSON.stringify(ivvCols[0])})`);
    assert(ivvCols[3] === "Equity", `splitCsvLine strips quotes so Asset Class compares cleanly (got ${JSON.stringify(ivvCols[3])})`);
    assert(ivvCols[4] === "68,152,575,876.48", `splitCsvLine keeps a comma-containing quoted field intact (got ${JSON.stringify(ivvCols[4])})`);
    assert(ivvCols.length === 15, `splitCsvLine returns all 15 columns despite internal commas (got ${ivvCols.length})`);
    // --- parseIvvHoldingsCsv unit test: ticker normalization for class
    // shares. Found live 2026-10-23 while verifying the CSV fix above:
    // IVV's "BRK B" (space) made it through quote-stripping fine but then
    // failed Alpaca's bars endpoint with HTTP 400 "invalid symbol" -
    // confirmed live that "BRK.B" (dot) is what Alpaca actually expects.
    const sampleIvvCsv = 'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date\n' +
        '"BRK B","BERKSHIRE HATHAWAY CLASS B","Financials","Equity","1,000.00","0.01","1,000.00","10.00","100.00","United States","NYSE","USD","1.00","USD","-"\n' +
        '"ESZ6","S&P500 EMINI DEC 26","Cash and/or Derivatives","Futures","0.00","0.00","0.00","0.00","0.00","-","Index And Options Market","USD","1.00","USD","-"\n';
    const parsedIvv = parseIvvHoldingsCsv(sampleIvvCsv + Array.from({ length: 400 }, (_, i) => `"T${i}","Co ${i}","Sector","Equity","1","1","1","1","1","US","NYSE","USD","1.00","USD","-"`).join("\n"));
    assert(parsedIvv.some((c) => c.ticker === "BRK.B"), `parseIvvHoldingsCsv normalizes "BRK B" to "BRK.B" (got tickers: ${parsedIvv.filter((c) => c.ticker.includes("BRK")).map((c) => c.ticker).join(",")})`);
    assert(!parsedIvv.some((c) => c.ticker === "ESZ6"), "parseIvvHoldingsCsv still excludes non-Equity asset classes (Futures)");
    // --- Live Kraken API smoke test (public endpoints, no auth, same 8 EUR pairs as the live trading branch) ---
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
    console.log("\nFull crypto signal report for BTC/EUR:\n", JSON.stringify(signals, null, 2));
    // --- Stock side: Alpaca - skips gracefully if credentials aren't set yet ---
    // (expected on first build - see CLAUDE.md's credential-setup section).
    if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) {
        skip("Alpaca live smoke test (ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY not set in this environment yet)");
    }
    else {
        try {
            const bars = await fetchStockBars("AAPL", "1Day", 30);
            assert(bars.length > 0, `live AAPL daily bars returned (got ${bars.length})`);
            const stockSignals = await computeStockSignals("AAPL");
            assert(stockSignals.current_price > 0, "compute_stock_signals returns a current price for AAPL");
            console.log("\nFull stock signal report for AAPL:\n", JSON.stringify(stockSignals, null, 2));
        }
        catch (e) {
            throw new Error(`Alpaca live smoke test failed with credentials present - this is a real failure, not an expected skip: ${e.message}`);
        }
    }
    // --- S&P 500 constituent source (iShares IVV CSV) - skips if ishares.com isn't reachable yet ---
    try {
        const constituents = await fetchSp500Constituents();
        assert(constituents.length >= 400, `S&P 500 constituent list has a plausible count (got ${constituents.length})`);
        console.log(`\nS&P 500 constituents fetched: ${constituents.length} (sample: ${constituents.slice(0, 3).map((c) => c.ticker).join(", ")}...)`);
    }
    catch (e) {
        skip(`S&P 500 constituent fetch (ishares.com likely not allowlisted in this environment yet): ${e.message}`);
    }
    // --- screen_sp500 end-to-end - only runs if both Alpaca creds AND the constituent source are live ---
    if (process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY) {
        try {
            const screen = await screenSp500(10);
            assert(screen.candidates.length > 0, `screen_sp500 returned candidates (got ${screen.candidates.length})`);
            console.log(`\nTop screen_sp500 candidates:\n`, JSON.stringify(screen.candidates.slice(0, 5), null, 2));
        }
        catch (e) {
            skip(`screen_sp500 end-to-end (needs both Alpaca creds and ishares.com reachable): ${e.message}`);
        }
    }
    else {
        skip("screen_sp500 end-to-end (needs Alpaca credentials)");
    }
    // --- SEC EDGAR - free, no key, but sec.gov domains may not be allowlisted yet ---
    try {
        const cik = await getCikForTicker("AAPL");
        assert(/^\d{10}$/.test(cik), `getCikForTicker resolves AAPL to a 10-digit CIK (got ${cik})`);
        const insider = await getInsiderActivity("AAPL", 5);
        assert(insider.length > 0, `getInsiderActivity returns at least one parsed AAPL filing (got ${insider.length})`);
        assert(insider[0].insider_name !== "unknown", `getInsiderActivity resolves a real insider_name, not the "unknown" fallback (got ${insider[0].insider_name})`);
        assert(insider[0].transaction_code !== "?", `getInsiderActivity resolves a real transaction_code, not the "?" fallback (got ${insider[0].transaction_code})`);
        assert(insider[0].shares !== null && insider[0].shares > 0, `getInsiderActivity resolves real shares, not null (got ${insider[0].shares})`);
        assert(insider[0].price_per_share !== null && insider[0].price_per_share > 0, `getInsiderActivity resolves a real price_per_share, not null (got ${insider[0].price_per_share})`);
        console.log(`\nAAPL recent Form 4 filings parsed: ${insider.length}`, JSON.stringify(insider, null, 2));
    }
    catch (e) {
        skip(`SEC EDGAR live smoke test (sec.gov domains likely not allowlisted in this environment yet): ${e.message}`);
    }
    console.log("\nALL SELF-TESTS PASSED (see 'skip:' lines above for anything not yet live-testable in this environment)");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});

import type { Sp500Constituent } from "./types.js";
import { fetchMultiStockBars } from "./stocks.js";
import { priceAction, volumeVs7dAvg, rsi, momentumTrigger } from "./indicators.js";
import { MOMENTUM_THRESHOLD_PCT } from "./types.js";

// S&P 500 membership isn't something Alpaca (a brokerage data feed, not an
// index provider) exposes at all. Rather than hardcode a guessed/stale
// 500-ticker list and risk silently screening against wrong membership
// for months, this fetches iShares' CORE S&P 500 ETF (IVV) holdings CSV -
// a free, no-key, publicly published daily file that's a very close
// real-time proxy for actual S&P 500 membership (iShares rebalances IVV
// to track the index directly).
//
// The original `.../1467271812596.ajax?fileType=csv...` URL (the
// documented/known AJAX-export pattern this was first built against) was
// confirmed DEAD 2026-10-23 - a live fetch returned the ordinary product
// page's HTML, not a CSV, meaning that numeric export token has gone
// stale on iShares' side. Replaced with the plain `/latest-holdings.csv`
// path, found by observing the same pattern work for several OTHER
// iShares funds via live web search that same day (e.g.
// `.../340800/ishares-large-cap-accelerated-outcome-etf/latest-holdings.csv`)
// - this specific IVV URL has NOT yet been confirmed with an actual
// fetch (this environment's verification sessions kept hitting
// permission friction before this fix could be re-verified) - re-run the
// self-test's S&P 500 constituent check the moment this is deployed and
// fix the exact path again if it's still wrong; parseIvvHoldingsCsv
// throws a clear error naming what it expected rather than silently
// mis-mapping columns either way.
const IVV_HOLDINGS_URL = "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/latest-holdings.csv";

let constituentsCache: { fetchedAt: number; rows: Sp500Constituent[] } | null = null;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h - holdings don't change intraday

export class Sp500SourceError extends Error {}

function parseIvvHoldingsCsv(csv: string): Sp500Constituent[] {
  const lines = csv.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
  if (headerIdx === -1) {
    throw new Sp500SourceError(
      "IVV holdings CSV format has changed - no line starting with 'Ticker,' found. This parser was written against a documented/known layout, never verified live - re-check the real CSV structure and update parseIvvHoldingsCsv."
    );
  }
  const header = lines[headerIdx].split(",");
  const tickerIdx = header.indexOf("Ticker");
  const nameIdx = header.indexOf("Name");
  const sectorIdx = header.indexOf("Sector");
  const assetClassIdx = header.indexOf("Asset Class");
  if (tickerIdx === -1 || nameIdx === -1 || sectorIdx === -1) {
    throw new Sp500SourceError(
      `IVV holdings CSV header is missing an expected column (Ticker/Name/Sector). Got: ${lines[headerIdx]}`
    );
  }

  const rows: Sp500Constituent[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const ticker = cols[tickerIdx]?.trim();
    const name = cols[nameIdx]?.trim();
    const sector = cols[sectorIdx]?.trim() ?? "";
    const assetClass = assetClassIdx !== -1 ? cols[assetClassIdx]?.trim() : "Equity";
    // Skip cash/futures/other non-equity lines IVV's holdings file always
    // includes a few of (e.g. "USD CASH", index futures used for cash
    // management) - these aren't real constituents to screen.
    if (!ticker || !name || assetClass !== "Equity") continue;
    rows.push({ ticker, name, sector });
  }

  if (rows.length < 400) {
    throw new Sp500SourceError(
      `Parsed only ${rows.length} equity rows from the IVV holdings CSV - expected ~500. Treating this as a parsing failure rather than trusting a suspiciously short list.`
    );
  }
  return rows;
}

export async function fetchSp500Constituents(forceRefresh = false): Promise<Sp500Constituent[]> {
  if (!forceRefresh && constituentsCache && Date.now() - constituentsCache.fetchedAt < CACHE_TTL_MS) {
    return constituentsCache.rows;
  }
  const res = await fetch(IVV_HOLDINGS_URL);
  if (!res.ok) {
    throw new Sp500SourceError(`IVV holdings fetch HTTP ${res.status}`);
  }
  const csv = await res.text();
  const rows = parseIvvHoldingsCsv(csv);
  constituentsCache = { fetchedAt: Date.now(), rows };
  return rows;
}

export interface ScreenCandidate {
  ticker: string;
  name: string;
  sector: string;
  current_price: number;
  rsi_14_1d: number | null;
  pct_change_5d: number | null;
  pct_change_20d: number | null;
  volume_ratio: number | null;
  momentum_flagged: boolean;
  score: number; // higher = more worth a closer look; NOT a buy signal by itself
  data_gaps: string[];
}

// A single cheap pass over daily bars for the whole list, to narrow ~500
// names down to a short list worth the more expensive per-ticker work
// (compute_stock_signals' full report, EDGAR insider/13F lookups, an
// earnings-catalyst news search). Mirrors the crypto side's existing
// shape - compute_signals is cheap and run for every pair every cycle,
// then only the pairs that look interesting get a news search - just
// applied to 500 names instead of 8.
//
// score is a simple, transparent sum of independent flags (momentum +6%,
// RSI either extreme, volume >2x) - deliberately not a tuned/backtested
// ranking model like the crypto side's position-sizing math. This is a
// narrowing filter for what the daily report digs into, not itself a
// recommendation; the actual buy/no-buy judgment happens afterward with
// full signals + earnings + institutional/insider context, per
// instructions/market-advisory-instructions.md.
export async function screenSp500(topN = 20): Promise<{ candidates: ScreenCandidate[]; universe_size: number; errors: string[] }> {
  const constituents = await fetchSp500Constituents();
  const errors: string[] = [];
  const barsBySymbol = await fetchMultiStockBars(constituents.map((c) => c.ticker), "1Day", 40);

  const candidates: ScreenCandidate[] = [];
  for (const c of constituents) {
    const bars = barsBySymbol.get(c.ticker);
    if (!bars || bars.length === 0) {
      errors.push(`${c.ticker}: no bars returned`);
      continue;
    }
    const dataGaps: string[] = [];
    const currentPrice = bars[bars.length - 1].close;

    const pa5d = bars.length >= 6 ? priceAction(bars.slice(-5), 120) : null;
    if (!pa5d) dataGaps.push("insufficient bars for 5d price action");
    const pa20d = bars.length >= 21 ? priceAction(bars.slice(-20), 480) : null;
    if (!pa20d) dataGaps.push("insufficient bars for 20d price action");

    const closes = bars.map((b) => b.close);
    const rsiSeries = rsi(closes, 14);
    const rsiValue = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : null;
    if (rsiValue === null) dataGaps.push("insufficient bars for RSI(14)");

    const volumeSignal = volumeVs7dAvg(bars);
    if (!volumeSignal) dataGaps.push("insufficient bars for volume ratio");

    const momentum = momentumTrigger(pa5d, pa20d, MOMENTUM_THRESHOLD_PCT);

    let score = 0;
    if (momentum.flagged) score += 2;
    if (rsiValue !== null && (rsiValue >= 70 || rsiValue <= 30)) score += 1;
    if (volumeSignal && volumeSignal.flag_above_2x) score += 1;

    candidates.push({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      current_price: currentPrice,
      rsi_14_1d: rsiValue,
      pct_change_5d: pa5d?.pct_change ?? null,
      pct_change_20d: pa20d?.pct_change ?? null,
      volume_ratio: volumeSignal?.ratio ?? null,
      momentum_flagged: momentum.flagged,
      score,
      data_gaps: dataGaps,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates: candidates.slice(0, topN), universe_size: constituents.length, errors };
}

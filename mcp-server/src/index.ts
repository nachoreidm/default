import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchOHLC, fetchDepth, fetchTicker, closedCandles, INTERVAL_MINUTES } from "./kraken.js";
import { computeSignals } from "./signals.js";
import { computeStockSignals } from "./stocks.js";
import { screenSp500, fetchSp500Constituents } from "./sp500.js";
import { getInsiderActivity, getInstitutional13FMentions } from "./edgar.js";
import { queryBalance, queryClosedOrders, queryOpenOrders, queryLedgers } from "./kraken-account.js";
import { ALLOWED_PAIRS, MOMENTUM_THRESHOLD_PCT } from "./types.js";

// ADVISORY-ONLY MCP SERVER. There is no portfolio module, no order-
// placement tool, no position state file, and no credential here capable
// of placing a trade - this is a structural property of this codebase,
// not just a rule written in a prompt. Every tool below is read-only
// market data, a computed signal, or (as of the kraken_account_* tools)
// a read-only view of the user's REAL Kraken account via a key that
// Kraken itself refuses to let place or cancel an order or move funds -
// nothing here can touch real money, crypto or stock, by construction
// at both the code layer and the credential's own permission scope.
const server = new McpServer({ name: "market-advisory", version: "0.1.0" });

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
function wrap<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      return ok(await fn());
    } catch (e: any) {
      return err(e?.message ?? String(e));
    }
  };
}

const pairSchema = z.enum(ALLOWED_PAIRS);

// --- Crypto (Kraken public data, EUR pairs - same 8 as the live trading branch) ---

server.tool(
  "kraken_get_ticker",
  `Get the current Kraken ticker (bid/ask/last/24h volume) for an allowed crypto pair. Allowed pairs: ${ALLOWED_PAIRS.join(", ")}.`,
  { pair: pairSchema },
  async ({ pair }) => wrap(() => fetchTicker(pair))()
);

server.tool(
  "kraken_get_ohlc",
  "Get closed (fully formed) OHLC candles for an allowed crypto pair at a given interval. Returns most-recent-last.",
  { pair: pairSchema, interval: z.enum(Object.keys(INTERVAL_MINUTES) as [string, ...string[]]), limit: z.number().int().positive().max(720).optional() },
  async ({ pair, interval, limit }) =>
    wrap(async () => {
      const candles = closedCandles(await fetchOHLC(pair, interval as any));
      return limit ? candles.slice(-limit) : candles;
    })()
);

server.tool(
  "kraken_get_orderbook",
  "Get the current order book (bids/asks) for an allowed crypto pair, top N levels.",
  { pair: pairSchema, count: z.number().int().positive().max(100).optional() },
  async ({ pair, count }) => wrap(() => fetchDepth(pair, count ?? 10))()
);

server.tool(
  "compute_crypto_signals",
  `Compute the full crypto signal set for a pair in one call: 1h/4h price action over the last 48h, 24h volume vs 7-day average, RSI(14) on 4h, 20/50 SMA crossover on 4h, top-10 order book imbalance, and momentum_trigger (flagged when the 1h or 4h price-action window shows a move at or above ${MOMENTUM_THRESHOLD_PCT}% over 48h). Any signal that can't be reliably computed is reported in data_gaps instead of being estimated. Advisory only - this never opens, sizes, or closes anything.`,
  { pair: pairSchema },
  async ({ pair }) => wrap(() => computeSignals(pair))()
);

// --- Stocks (Alpaca market data + SEC EDGAR) ---

server.tool(
  "screen_sp500",
  "Cheap first pass over the full S&P 500 (via iShares IVV holdings as a live membership proxy - Alpaca itself doesn't expose index membership): daily bars for every constituent, ranked by a transparent sum of momentum/RSI-extreme/volume-spike flags. Returns the top N by that score plus the full universe size and any per-ticker fetch errors. This is a NARROWING filter for what the daily report digs into further (full signals + earnings + institutional/insider context) - it is explicitly not itself a buy recommendation.",
  { top_n: z.number().int().positive().max(100).optional() },
  async ({ top_n }) => wrap(() => screenSp500(top_n ?? 20))()
);

server.tool(
  "sp500_constituents",
  "Get the current S&P 500 constituent list (ticker, name, sector) via the IVV-holdings live proxy, for reference/debugging without running the full screen.",
  {},
  async () => wrap(() => fetchSp500Constituents())()
);

server.tool(
  "compute_stock_signals",
  "Compute the full stock signal set for a single ticker: 5-day and 20-day price action, RSI(14) on daily bars, 20/50 SMA crossover, 7-day volume ratio, and the same momentum_trigger logic used for crypto. No order-book imbalance (Alpaca's free tier has no L2 depth - reported as a data_gap). Use this for a candidate narrowed down by screen_sp500, not for scanning the whole index (too slow/call-heavy one ticker at a time).",
  { ticker: z.string().min(1).max(10) },
  async ({ ticker }) => wrap(() => computeStockSignals(ticker.toUpperCase()))()
);

server.tool(
  "get_insider_activity",
  "Get the most recent Form 4 (insider buy/sell) filings for a ticker's issuer from SEC EDGAR - free, no key, near-real-time, filed per-issuer so this is a clean ticker-centric signal (distinct from the noisier 13F proxy below). Returns parsed transaction details (code, shares, price, acquired/disposed) where the filing's XML could be parsed; a filing that couldn't be parsed is simply omitted from the list rather than erroring the whole call.",
  { ticker: z.string().min(1).max(10), limit: z.number().int().positive().max(25).optional() },
  async ({ ticker, limit }) => wrap(() => getInsiderActivity(ticker.toUpperCase(), limit ?? 10))()
);

server.tool(
  "get_institutional_13f_mentions",
  "Search recent 13F-HR filings (institutional 'big investor' holdings reports) for mentions of a company name, via SEC EDGAR's full-text search. IMPORTANT CAVEAT: this is NOT an aggregated net-institutional-buying figure - 13F filings are filed by managers listing all their holdings, not by the company, so there is no clean per-issuer 'who bought how much' endpoint on EDGAR. This only tells you which managers' recent 13F filings mention the name somewhere in the document - a noisy 'who's been filing near this name' proxy, not a buy/sell signal by itself. Also inherently stale: 13F is filed up to 45 days after quarter-end.",
  { company_name: z.string().min(1), limit: z.number().int().positive().max(25).optional() },
  async ({ company_name, limit }) => wrap(() => getInstitutional13FMentions(company_name, limit ?? 10))()
);

// --- Real Kraken account (read-only) - tracks actual outcomes against advisory picks ---
// Requires KRAKEN_READONLY_API_KEY/SECRET, a key scoped to Query Funds /
// Query Open Orders & Trades / Query Closed Orders & Trades / Query
// Ledger Entries ONLY - no order-placement or withdrawal permission
// exists on this key at all, so these tools are read-only by Kraken's
// own enforcement, not just by omission in this code. If the env vars
// aren't set, every call below fails with a clear message rather than a
// silent wrong answer (same fail-safe pattern as the stock/EDGAR tools
// before their credentials existed).

server.tool(
  "kraken_account_get_balance",
  "Get the REAL balance of every asset in the connected Kraken account (read-only key). Zero-balance assets are omitted by Kraken, not reported as 0. Use this to see actual current holdings, not a simulated/advisory position.",
  {},
  async () => wrap(() => queryBalance())()
);

server.tool(
  "kraken_account_get_open_orders",
  "Get the REAL currently-open orders on the connected Kraken account (read-only key) - resting stop-losses, limit orders, etc. that haven't filled or been cancelled yet.",
  {},
  async () => wrap(() => queryOpenOrders())()
);

server.tool(
  "kraken_account_get_closed_orders",
  "Get REAL closed (filled, cancelled, or expired) orders on the connected Kraken account (read-only key) - the actual trade history, with real fill price/fee/volume. Optionally pass a unix timestamp in `start` to only return orders closed at/after that time (useful for 'what happened since I last checked').",
  { start: z.number().int().positive().optional() },
  async ({ start }) => wrap(() => queryClosedOrders(start))()
);

server.tool(
  "kraken_account_get_ledger",
  "Get REAL ledger entries (trades, deposits, withdrawals, transfers, fees) on the connected Kraken account (read-only key) - the most complete real-activity view, including fee/balance-after-entry detail that order history alone doesn't show. Optionally pass a unix timestamp in `start` to only return entries at/after that time.",
  { start: z.number().int().positive().optional() },
  async ({ start }) => wrap(() => queryLedgers(start))()
);

const transport = new StdioServerTransport();
await server.connect(transport);

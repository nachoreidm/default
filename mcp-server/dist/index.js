import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchOHLC, fetchDepth, fetchTicker, closedCandles, INTERVAL_MINUTES } from "./kraken.js";
import { computeSignals } from "./signals.js";
import { getSnapshot, openPosition, closePosition, checkStops, logNoTrade } from "./portfolio.js";
import { ALLOWED_PAIRS, RISK_LIMITS } from "./types.js";
const server = new McpServer({ name: "kraken-paper-trading", version: "0.1.0" });
function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
function wrap(fn) {
    return async () => {
        try {
            return ok(await fn());
        }
        catch (e) {
            return err(e?.message ?? String(e));
        }
    };
}
const pairSchema = z.enum(ALLOWED_PAIRS);
server.tool("kraken_get_ticker", `Get the current Kraken ticker (bid/ask/last/24h volume) for an allowed pair. Allowed pairs: ${ALLOWED_PAIRS.join(", ")}.`, { pair: pairSchema }, async ({ pair }) => wrap(() => fetchTicker(pair))());
server.tool("kraken_get_ohlc", "Get closed (fully formed) OHLC candles for an allowed pair at a given interval. Returns most-recent-last.", { pair: pairSchema, interval: z.enum(Object.keys(INTERVAL_MINUTES)), limit: z.number().int().positive().max(720).optional() }, async ({ pair, interval, limit }) => wrap(async () => {
    const candles = closedCandles(await fetchOHLC(pair, interval));
    return limit ? candles.slice(-limit) : candles;
})());
server.tool("kraken_get_orderbook", "Get the current order book (bids/asks) for an allowed pair, top N levels.", { pair: pairSchema, count: z.number().int().positive().max(100).optional() }, async ({ pair, count }) => wrap(() => fetchDepth(pair, count ?? 10))());
server.tool("compute_signals", "Compute the full authorized signal set for a pair in one call: 1h/4h price action over the last 48h, 24h volume vs 7-day average, RSI(14) on 4h, 20/50 SMA crossover on 4h, and top-10 order book imbalance. Any signal that can't be reliably computed is reported in data_gaps instead of being estimated.", { pair: pairSchema }, async ({ pair }) => wrap(() => computeSignals(pair))());
server.tool("portfolio_get_state", "Get the current paper portfolio snapshot: cash, portfolio value, open positions with live unrealized P&L, total exposure %, open position count, and today's (UTC) realized P&L and halt status.", {}, async () => wrap(() => getSnapshot())());
server.tool("portfolio_open_position", `Open a new paper LONG position (spot only, no margin/short). All risk limits are enforced here in code and will reject the call if violated: max ${RISK_LIMITS.MAX_POSITION_PCT}% of portfolio per trade, max ${RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT}% total exposure, max ${RISK_LIMITS.MAX_OPEN_POSITIONS} open positions, and a same-UTC-day halt once realized paper losses hit ${RISK_LIMITS.MAX_DAILY_LOSS_PCT}% of portfolio value. Fill price is simulated from the live ask plus modeled fee/slippage. Automatically appends a structured entry to trades.md on success.`, {
    pair: pairSchema,
    size_pct: z.number().positive().max(RISK_LIMITS.MAX_POSITION_PCT),
    stop_loss: z.number().positive(),
    invalidation: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
    confidence_reason: z.string().min(1),
    signals_at_entry: z.record(z.any()),
}, async (input) => wrap(() => openPosition(input))());
server.tool("portfolio_close_position", "Close an open paper position at the live bid (minus modeled fee/slippage). Updates the daily realized-loss tracker and appends a structured entry to trades.md.", { position_id: z.string(), reason: z.string().min(1) }, async (input) => wrap(() => closePosition(input))());
server.tool("portfolio_check_stops", "Check every open paper position against its stop-loss using live prices, and auto-close any that have breached their stop. Intended to be called both on demand and from a scheduled monitoring run, so stops are respected even when nobody is actively chatting with the agent.", {}, async () => wrap(() => checkStops())());
server.tool("portfolio_log_no_trade", "Log an explicit 'no trade' decision for a pair to trades.md, with the reasoning and the signal values considered. Use this whenever signals conflict, data is incomplete, or there's nothing worth doing — a logged no-trade is required output, not optional.", { pair: pairSchema, reasoning: z.string().min(1), signals_considered: z.record(z.any()) }, async (input) => wrap(() => logNoTrade(input))());
const transport = new StdioServerTransport();
await server.connect(transport);

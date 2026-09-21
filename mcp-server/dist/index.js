import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchOHLC, fetchDepth, fetchTicker, closedCandles, pairCode, INTERVAL_MINUTES } from "./kraken.js";
import { computeSignals } from "./signals.js";
import { getSnapshot, openPosition, closePosition, checkStops, logNoTrade } from "./portfolio-live.js";
import { queryBalance, addOrder } from "./kraken-private.js";
import { ALLOWED_PAIRS, RISK_LIMITS, CONFIDENCE_MAX_SIZE_PCT, TAKE_PROFIT_RR_MULTIPLE, MOMENTUM_THRESHOLD_PCT, MOMENTUM_ONLY_MAX_CONFIDENCE, TRAIL_SMA_PERIOD, PEAK_PROFIT_LOCK_FRACTION, } from "./types.js";
const server = new McpServer({ name: "kraken-live-trading", version: "0.1.0" });
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
server.tool("compute_signals", `Compute the full authorized signal set for a pair in one call: 1h/4h price action over the last 48h, 24h volume vs 7-day average, RSI(14) on 4h, 20/50 SMA crossover on 4h, top-10 order book imbalance, and momentum_trigger (flagged when the 1h or 4h price-action window shows a move at or above ${MOMENTUM_THRESHOLD_PCT}% over 48h - unlike the other signals this one isn't confirmed by anything else, see portfolio_open_position's momentum_only param). Any signal that can't be reliably computed is reported in data_gaps instead of being estimated.`, { pair: pairSchema }, async ({ pair }) => wrap(() => computeSignals(pair))());
server.tool("kraken_verify_credentials", "Verifies KRAKEN_API_KEY/KRAKEN_API_SECRET actually authenticate against Kraken's private API, WITHOUT placing any real order or risking any money: runs a real (read-only) Balance query, then a validate:true AddOrder call on BTC/EUR (Kraken authenticates and validates the order shape but places nothing - a wrong signature is rejected outright). Run this once after setting new credentials, before trusting any other tool that touches the private API.", {}, async () => wrap(async () => {
    const balance = await queryBalance();
    const validation = await addOrder({
        pair: pairCode("BTC/EUR"),
        type: "buy",
        ordertype: "market",
        volume: "0.0001",
        validate: true,
    });
    return { balance, validate_only_order_check: validation, note: "No real order was placed - validate:true only." };
})());
server.tool("portfolio_get_state", "Get the current LIVE portfolio snapshot: real EUR cash balance (from Kraken), portfolio value, open positions with live unrealized P&L, total exposure %, open position count, and today's (UTC) realized P&L and halt status. Cash always comes from a live Kraken Balance query, never a locally-tracked figure.", {}, async () => wrap(() => getSnapshot())());
server.tool("portfolio_open_position", `THIS PLACES REAL ORDERS WITH REAL MONEY ON KRAKEN. Opens a new LONG position (spot only, no margin/short): a market buy for the computed size, followed immediately by a real resting stop-loss order at your specified level - the position is NOT considered protected until that resting order confirms, and the tool call fails loudly (do not retry blindly) if the stop can't be placed after the entry fills. All risk limits are enforced here in code and will reject the call if violated: max ${RISK_LIMITS.MAX_POSITION_PCT}% of portfolio per trade, max ${RISK_LIMITS.MAX_TOTAL_EXPOSURE_PCT}% total exposure, max ${RISK_LIMITS.MAX_OPEN_POSITIONS} open positions (one per pair - a second position on a pair that already has one open is rejected), a same-UTC-day halt once realized losses hit ${RISK_LIMITS.MAX_DAILY_LOSS_PCT}% of portfolio value, and a confidence-based size cap: low confidence doesn't trade at all (call portfolio_log_no_trade instead), medium caps at ${CONFIDENCE_MAX_SIZE_PCT.medium}%, high can use the full ${CONFIDENCE_MAX_SIZE_PCT.high}%. Entry price/quantity/fee are the REAL values read back from Kraken's fill, not modeled. A take-profit target is computed at ${TAKE_PROFIT_RR_MULTIPLE}:1 risk/reward above entry (fixed at entry, not something you choose) - it is checked by portfolio_check_stops against live price each cycle (not a resting order) until the trade earns +1R, at which point it's superseded by a real trailing stop-loss order instead (see that tool's description). momentum_only: set to true only if compute_signals' momentum_trigger.flagged is the ONLY thing supporting this trade. Momentum alone can't be "high" confidence (rejected in code) - cap at "${MOMENTUM_ONLY_MAX_CONFIDENCE}" or lower. Automatically appends a structured entry to trades.md on success.`, {
    pair: pairSchema,
    size_pct: z.number().positive().max(RISK_LIMITS.MAX_POSITION_PCT),
    stop_loss: z.number().positive(),
    invalidation: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
    confidence_reason: z.string().min(1),
    momentum_only: z.boolean(),
    signals_at_entry: z.record(z.any()),
}, async (input) => wrap(() => openPosition(input))());
server.tool("portfolio_close_position", "MANUAL OVERRIDE - THIS PLACES A REAL MARKET SELL ORDER. Cancels the position's resting stop-loss order (if any) and market-sells the full quantity at the live bid. The resting stop-loss order handles the ordinary exit case on its own; only call this for an explicit manual close (e.g. your own judgment overrides the mechanical exit) or to clean up after something went wrong. Updates the daily realized-loss tracker and appends a structured entry to trades.md with the real fill.", { position_id: z.string(), reason: z.string().min(1) }, async (input) => wrap(() => closePosition(input))());
server.tool("portfolio_check_stops", `Reconciles against Kraken's real order state AND maintains the trailing stop - call this every cycle before anything else. Two things happen: (1) reconciliation - checks whether each open position's resting stop-loss order has already filled on Kraken (it can fire at any moment, not just when this runs) and records the REAL exit price/fee if so; (2) trailing maintenance - for positions still open, refreshes the peak price, and once a position reaches +1R (up by its own entry-to-stop risk amount) moves the REAL resting stop-loss order up to a guaranteed profit floor (locking in ${PEAK_PROFIT_LOCK_FRACTION * 100}% of the peak gain reached so far, or enough to clear round-trip fees, whichever is larger - ratcheting up as the rally extends) and then trails it below the rising ${TRAIL_SMA_PERIOD}-period 4h SMA once that's higher, by cancelling and replacing the resting order - it only ever moves up. The fixed ${TAKE_PROFIT_RR_MULTIPLE}:1 take-profit (checked here against live price, not a resting order) is superseded once trailing begins. If cancelling a stop to raise it succeeds but placing the replacement fails, this throws loudly rather than leaving the position silently unprotected - treat that as urgent. Intended to run on a scheduled hourly cycle so stops, reconciliation, and trailing are all respected even when nobody is actively chatting with the agent.`, {}, async () => wrap(() => checkStops())());
server.tool("portfolio_log_no_trade", "Log an explicit 'no trade' decision for a pair to trades.md, with the reasoning and the signal values considered. Use this whenever signals conflict, data is incomplete, or there's nothing worth doing — a logged no-trade is required output, not optional.", { pair: pairSchema, reasoning: z.string().min(1), signals_considered: z.record(z.any()) }, async (input) => wrap(() => logNoTrade(input))());
const transport = new StdioServerTransport();
await server.connect(transport);

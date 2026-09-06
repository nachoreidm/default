# Kraken Paper-Trading Agent

Read `instructions/kraken-agent-instructions.md` in full before doing any
trading research, recommendation, or portfolio action in this repo — it's
the operating spec (scope, risk limits, required output format) and takes
precedence over improvising.

## Layout

- `instructions/kraken-agent-instructions.md` — the agent's operating rules
- `mcp-server/` — custom MCP server: Kraken public market data, computed
  signals (RSI/SMA/volume/order-book), and the paper-portfolio engine with
  risk limits enforced in code (not just by prompt)
- `.mcp.json` — registers the MCP server for any Claude Code session opened
  in this repo
- `data/portfolio_state.json` — paper portfolio state (cash, open/closed
  positions, daily realized P&L). Source of truth; don't hand-edit except to
  reset for a fresh start.
- `trades.md` — human-readable trade log, appended to automatically by the
  MCP server's portfolio tools (open/close/no-trade). Don't hand-edit; if a
  fix is needed, fix `data/portfolio_state.json` and regenerate, or note a
  correction inline.

## Setup

`.claude/hooks/session-start.sh` builds the MCP server automatically on
every Claude Code on the web / cloud session (`npm install && npm run
build` in `mcp-server/`, skipped if already built and up to date). Locally,
build it yourself once and after any code change:

```
cd mcp-server && npm install && npm run build
```

`npm test` (in `mcp-server/`) runs indicator-math unit checks plus a live
Kraken API smoke test — useful after changing any calculation.

## Network access

This environment's network policy has `api.kraken.com` allowlisted
(Custom network access, set in the environment's settings on claude.ai/code).
Node's built-in `fetch` doesn't honor `HTTPS_PROXY` by default, so
`NODE_USE_ENV_PROXY=1` is set on the MCP server process (in `.mcp.json`)
and in `mcp-server/package.json`'s scripts — without it, calls to Kraken
fail even when the domain is allowlisted. If this is ever run in a
*different* cloud environment, that environment needs the same domain
added before any Kraken tool call will work.

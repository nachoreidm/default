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

The MCP server needs to be built once (and after any code change to it):

```
cd mcp-server && npm install && npm run build
```

`npm test` (in `mcp-server/`) runs indicator-math unit checks plus a live
Kraken API smoke test — useful after changing any calculation.

## Known constraint

`api.kraken.com` is not reachable from Claude Code **on the web / cloud
sessions** by default — it's blocked by the sandbox's organization egress
policy, independent of this code. It works from a local Claude Code CLI
session on a machine with normal internet access. If you want scheduled,
unattended monitoring to run in a cloud environment, `api.kraken.com` needs
to be added to that environment's network policy allowlist first.

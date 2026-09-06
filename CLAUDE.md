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

`mcp-server/dist/` (built output) and `mcp-server/node_modules/`
(production deps only — `@modelcontextprotocol/sdk`, `zod`, and their
transitive deps, ~26MB, no native binaries) are **committed**, not
gitignored. This is deliberate: the harness connects to the MCP server at
session bootstrap, before any `SessionStart` hook gets a chance to run, so
a build step that only happens in a hook is too late — the first
connection attempt hits missing files, fails, and never retries for that
session's lifetime. Committing the built artifacts means the server is
launchable the instant the repo is cloned, no build race possible.

**If you change anything in `mcp-server/src/`, you must rebuild and commit
`dist/` (and `node_modules/` if dependencies changed) before pushing** —
otherwise sessions keep running the old committed code even though the
source has moved on. `.claude/hooks/session-start.sh` only warns about
this drift on cloud sessions; it can't fix it for the current session (see
above), only remind you to fix it for the next one.

```
cd mcp-server && npm install && npm run build   # full install incl. devDeps (typescript, tsx)
npm test                                         # indicator-math unit checks + live Kraken smoke test
rm -rf node_modules && npm install --omit=dev    # prune back to production-only before committing
```

Verify the pruned build still runs before committing — a stray runtime
import from a devDependency won't show up until node_modules is pruned:

```
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | NODE_USE_ENV_PROXY=1 node dist/index.js
```

## Network access

This environment's network policy has `api.kraken.com` allowlisted
(Custom network access, set in the environment's settings on claude.ai/code).
Node's built-in `fetch` doesn't honor `HTTPS_PROXY` by default, so
`NODE_USE_ENV_PROXY=1` is set on the MCP server process (in `.mcp.json`)
and in `mcp-server/package.json`'s scripts — without it, calls to Kraken
fail even when the domain is allowlisted. If this is ever run in a
*different* cloud environment, that environment needs the same domain
added before any Kraken tool call will work.

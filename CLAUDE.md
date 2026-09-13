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

## The hourly routine (trigger) and session cutovers

The hourly monitoring routine is a scheduled trigger bound to a single
persistent Claude Code Remote session — see `mcp__Claude_Code_Remote__list_triggers`.
Whenever the MCP server's `src/` or the instructions doc changes, that
session must be replaced (a persistent session's tool connections and
prompt are fixed at creation; `update_trigger` also refuses to edit the
prompt of a session that isn't the caller's own). The cutover pattern that
works: `create_session` pointed at the branch with the new prompt, verify
it runs a clean cycle, `delete_trigger` + `create_trigger` pointing at the
new session with the same cron/name, then `archive_session` on the old one.

**Notion connector permissions do not carry over on a cutover, and the
failure mode is dangerous, not just cosmetic.** Two things reset every
time:

1. The trigger loses its Notion connector entirely (`create_trigger`'s
   `connectors` param isn't available for this org, and connectors can
   only be passed through from what the calling session already holds,
   which is normally nothing) — reattach it at claude.ai/code/routines on
   the new trigger.
2. Less obvious: even with the connector reattached, a Notion write tool
   (`Update Notion page`, `Create pages in Markdown`, etc.) can start
   prompting for interactive approval again ("Your organization requires
   approval for this tool") despite the account-level Notion connector
   permissions already being set to always-allow. The permission
   always-allow setting appears to be evaluated (and locked in) the
   *first time a given session encounters that tool* - a session created
   before the always-allow setting was applied keeps asking for the rest
   of its life, even after the setting is fixed. A session created *after*
   the setting is in place doesn't ask at all. Confirmed by direct A/B
   test (2026-09-11).

This is a real operational hazard, not just a missing Notion row: an
unanswered approval prompt leaves the session permanently blocked
mid-turn, which prevents the *next* scheduled fire from running cleanly
too (cycles degrade from hourly to every few hours). Stop-loss checks and
the git push both happen before the Notion sync step in the routine's
prompt, so they aren't blocked by this - but a stuck cycle still means
degraded monitoring frequency, which matters a lot more once real money
is involved.

If Notion starts silently prompting again after a cutover: don't just
re-click approve each time. Fix the always-allow setting first (Settings →
Connectors → Notion, per-tool), *then* do one more cutover to a fresh
session so the fix actually takes.

## Planned but not yet built

These are agreed changes for a future version - **don't implement without
the user explicitly asking**, they're recorded here so the decision isn't
lost between sessions:

- **Raise `MAX_OPEN_POSITIONS` to match the pair count (one per pair).**
  Analysis as of 2026-09-13, written when scope was still 5 pairs (so "5"
  appears below) - **recompute against whatever the final pair list is at
  build time**, don't just hardcode 5. If POL is dropped and ADA/LINK/DOGE
  are added per the note below, that's 4 remaining + 3 new = 7 pairs, so
  the cap should be 7, not 5. The reasoning holds regardless of the exact
  number: this doesn't loosen the actual risk ceiling, since
  `MAX_TOTAL_EXPOSURE_PCT` (25%) and the per-trade/confidence size caps are
  the real binding constraints either way - N positions at the medium cap
  (3%) each is 3N% exposure (21% at N=7, still under 25%), and even N
  positions at the max high-confidence size (5%) only becomes a problem
  once N > 5 (5%×7=35%, over the cap) - but that scenario requires 7
  simultaneous high-confidence signals, and the exposure cap would correctly
  block the excess anyway, so it's not a real loosening of risk, just a
  possible source of rejected trades in an already-rare scenario. What the
  position-count raise fixes: right now a genuinely good extra signal gets
  rejected outright just because earlier slots were already filled, even
  when total risk would still be well within bounds - the position-count
  limit shouldn't be what blocks a good trade when the dollar-risk limits
  already do that job. Bundle in an explicit "max one open position per
  pair" check at the same time (not currently enforced anywhere - only
  implicitly true because each pair is evaluated once per cycle), so
  raising the count doesn't accidentally allow stacking two positions on
  the same pair. Revisit when building the live version or the next
  paper-trading iteration - no rush while the account has only ever held
  one open position at a time.
- **No opportunity-cost / position-swap logic.** Separately: even with 5
  slots, once all slots are full the agent still just rejects a new
  opportunity rather than ever closing an existing (weaker) position to
  make room. That's a deliberate absence, not a bug - swapping requires
  comparing trades against each other, which is a meaningfully bigger
  design decision than a fixed threshold. Left as-is for now.
- **Add ADA/USD, LINK/USD, DOGE/USD as three more crypto pairs.** Checked
  live Kraken 24h volume on 2026-09-13 before recommending (current scope
  for comparison: BTC $67.6M, ETH $46.5M, XRP $22.8M, SOL $16.4M, POL only
  $267K - POL is already the thinnest pair in scope). All three candidates
  clear $2.8M+ in daily volume, comfortably above POL and in SOL's range:
  ADA ~$2.86M, LINK ~$2.29M, DOGE ~$3.07M. Picked for real diversification,
  not just more correlated L1s - LINK is oracle/infra (a genuinely
  different sector), DOGE has its own social-sentiment-driven volatility
  character distinct from the others, ADA is a high-volume major currently
  unrepresented. Other candidates checked and rejected for now: NEAR
  (~$3.84M) and UNI (~$3.17M) also cleared the bar and are reasonable
  future adds if more diversification is wanted later; AVAX, BCH, TRX,
  DOT, TON, ATOM, SHIB were all at or below POL's volume and not worth
  adding - SHIB in particular has a misleadingly huge unit-volume number
  (tiny price, meme-coin tokenomics) but is genuinely low-quality for
  clean technical signals. Re-verify volume live again before actually
  adding, rather than trusting these numbers unchanged - crypto volume
  shifts fast and this was a point-in-time check, not a standing fact.
- **Drop POL/USD for the live version.** User's call (2026-09-13), same
  volume reasoning as above - POL's ~$267K 24h volume is the thinnest in
  scope by a wide margin, well below every pair being added and every
  pair already there. Net effect if this and the pair-add above both
  land: BTC, ETH, SOL, XRP (4 existing, POL removed) + ADA, LINK, DOGE (3
  new) = **7 pairs total** - remember to size `MAX_OPEN_POSITIONS` to
  match (see above), not leave it at 5. Also re-verify POL's volume hasn't
  recovered before actually dropping it, same caveat as the adds.

## Network access

This environment's network policy has `api.kraken.com` allowlisted
(Custom network access, set in the environment's settings on claude.ai/code).
Node's built-in `fetch` doesn't honor `HTTPS_PROXY` by default, so
`NODE_USE_ENV_PROXY=1` is set on the MCP server process (in `.mcp.json`)
and in `mcp-server/package.json`'s scripts — without it, calls to Kraken
fail even when the domain is allowlisted. If this is ever run in a
*different* cloud environment, that environment needs the same domain
added before any Kraken tool call will work.

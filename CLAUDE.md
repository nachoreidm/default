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

## Shipped to paper trading (2026-09-17)

Three items that started life in "Planned but not yet built" below were
pulled forward into paper trading now, on the reasoning that paper trading
is the cheap place to shake out bugs/behavior before any of this matters
with real money - user explicitly asked to build these three now and hold
the remaining two ("No opportunity-cost / position-swap logic" and
"Entry-timing review", both still below) for the live version:

- **`MAX_OPEN_POSITIONS` raised from 3 to 7**, matching the new 7-pair
  scope (one per pair). `MAX_TOTAL_EXPOSURE_PCT` (25%) was deliberately
  left unchanged - it's the real aggregate-risk constraint, not position
  count; see the git history on this file for the full original reasoning
  if needed. Bundled in: **`portfolio_open_position` now rejects a second
  open position on a pair that already has one open**, even if the
  position-count cap isn't reached - explicit code enforcement, no longer
  just implicitly true because each pair was evaluated once per cycle.
- **POL/USD dropped, ADA/USD + LINK/USD + DOGE/USD added** - re-verified
  live 24h volume immediately before building (2026-09-17): ADA ~$11.7M,
  LINK ~$4.4M, DOGE ~$6.1M, vs. POL ~$684K (still the thinnest pair by a
  wide margin despite recovering off its 2026-09-13 low of $267K). Kraken's
  internal pair code for Dogecoin is `XDGUSD`, not `DOGEUSD` - confirmed
  live against `/0/public/AssetPairs` before hardcoding it in
  `kraken.ts`'s `PAIR_CODE` map. No open positions existed at build time,
  so no correction/backfill entry was needed in `trades.md` or
  `data/portfolio_state.json`.
- **Breakeven + trailing-stop exit logic**, layered on top of the fixed
  2:1 take-profit (which remains the mechanical baseline for any trade
  that never earns better). `Position` gained two fields: `initial_stop_loss`
  (the stop as originally set at entry, immutable - used to always
  recompute the trade's own risk/R correctly even after `stop_loss`
  itself starts moving) and `trailing_active` (flips true, permanently,
  the first time price reaches entry + 1R). `portfolio_check_stops` now
  does two passes each cycle: first bring every position's trailing state
  up to date and persist it (so a stop advance survives even if nothing
  closes that cycle), then decide closes against that saved state. Once
  `trailing_active` is true, the fixed take-profit is **superseded** - no
  longer checked - and the position is governed purely by `stop_loss`,
  which trails below the rising 20-period 4h SMA (`TRAIL_SMA_PERIOD` in
  `types.ts`) once that climbs high enough, never moving back down. The
  pure math (`hasReachedOneR`, `effectiveTrailingStop` in `portfolio.ts`)
  is exported and unit-tested in `selftest.ts` rather than only exercised
  live, since it can't be validated against production
  `data/portfolio_state.json` without polluting real trade history with
  test entries.
  - **Revised 2026-09-19: floor is a guaranteed +0.3R profit lock, not bare
    breakeven.** User caught a real gap in the original design: a position
    that spiked to +1R and immediately reversed would close at bare
    breakeven price, which - after real round-trip fees/slippage
    (`ROUND_TRIP_COST_PCT`, ~0.9%) - is actually a small guaranteed LOSS,
    not a scratch, defeating the point of having reached +1R at all.
    Fixed by adding `TRAILING_LOCK_R_MULTIPLE = 0.3`: the floor is now
    `entry + max(0.3 * R, entry * ROUND_TRIP_COST_PCT)`, guaranteeing a
    real net profit on any reversal from the moment +1R triggers, while
    still leaving 0.7R of room (the gap between the +1R trigger and the
    +0.3R floor) for an ordinary post-breakout pullback before the trade
    actually closes. The fee-cost term is defensive only - 0.3R alone has
    comfortably cleared it on every trade seen so far (observed stop
    distances of 4.8-7% put 0.3R at roughly 1.5-2.1% of entry, vs. the
    ~0.9% fee floor) - but keeps the guarantee real even for a
    hypothetical future trade with an unusually tight R. The SMA-based
    trailing above that floor is unchanged. Zero trades had reached +1R
    with a subsequent reversal at the time of this change, so this was a
    correctness fix applied proactively, not a response to an observed bad
    outcome.
  - **Revised again 2026-09-19: floor scales with the trade's PEAK gain,
    not just the gain at the moment +1R first triggered.** User's
    follow-up question exposed a second gap in the same day's first fix:
    `TRAILING_LOCK_R_MULTIPLE`'s 0.3R was a flat amount computed once from
    the *original* 1R and never revisited - a trade that ran all the way
    to +3R and then round-tripped back down would still only be guaranteed
    the same 0.3R as one that barely ticked over +1R before reversing. The
    SMA-based trail was the only thing that could improve on that, and the
    SMA lags a fast rally (20 periods of 4h candles = up to ~80h of
    history), so a quick spike-then-reverse could give back most of a big
    run with nothing but the flat floor to show for it. Fixed by adding
    `Position.peak_price` (highest price observed since entry, updated
    every `checkStops` cycle regardless of `trailing_active`) and
    replacing the fixed-R lock with `PEAK_PROFIT_LOCK_FRACTION = 0.3`
    (same 0.3 value, reinterpreted): the floor is now
    `entry + max(0.3 * (peak_price - entry), entry * ROUND_TRIP_COST_PCT)`.
    Since `peak_price` only ever increases, the floor now ratchets up as a
    rally extends - a bigger run locks in more guaranteed profit than a
    small one, matching the intuition that a trade that ran further earned
    a better worst case. At the exact moment of the +1R trigger this
    produces the identical result as the first fix (peak gain == the
    original 1R at that instant), so nothing changed about small,
    single-tick-over-+1R trades - only about what happens if the rally
    keeps going afterward. Two currently-open positions (ADA/USD, SOL/USD)
    were already `trailing_active` under the old flat formula - see the
    2026-09-19 `peak_price` backfill CORRECTION entry in `trades.md` for
    how their historical peak was reconstructed from live Kraken 1h-candle
    data (not approximated from the current price alone) rather than
    guessed; their `stop_loss` itself was left as-is in the backfill since
    the new peak-based floor is provably >= the old flat one once trailing
    is active, so `checkStops`'s existing "only move up" logic corrects it
    automatically on the next cycle with no manual edit needed.

This required a full session cutover per "The hourly routine" section
above (both `mcp-server/src/` and `instructions/kraken-agent-instructions.md`
changed, plus the trigger's own prompt text hardcodes the pair list) -
check `mcp__Claude_Code_Remote__list_triggers` for the currently-bound
session if picking this up later and the cutover isn't done yet.

## Planned but not yet built

These are agreed changes for a future (live) version - **don't implement
without the user explicitly asking**, they're recorded here so the
decision isn't lost between sessions:

- **No opportunity-cost / position-swap logic.** Even with 7 slots, once
  all slots are full the agent still just rejects a new opportunity rather
  than ever closing an existing (weaker) position to make room. That's a
  deliberate absence, not a bug - swapping requires comparing trades
  against each other, which is a meaningfully bigger design decision than
  a fixed threshold. Left as-is for now; revisit once slots are actually
  filling up regularly (the account has held at most 2 positions open at
  once so far).
- **Entry-timing review: consider requiring pullback/confirmation before
  entry, and consider ATR-based stops.** Loss-pattern review 2026-09-15,
  after the first 3 closed trades (POL, ETH, XRP) all hit stop-loss for a
  combined -$30.44 (-0.3% of portfolio) - risk management itself worked
  fine (each capped at medium confidence, sized 2-3%, no blowups, nowhere
  near the 5% daily halt), but n=3 is too small to conclude anything
  statistically; this is a flagged pattern to keep watching, not a
  diagnosed bug. What the three had in common: each entered right at an
  already-extended/euphoric moment rather than on a pullback - ETH's own
  confidence_reason explicitly named "Extreme Greed... contrarian pullback
  risk" as the reason it was capped at medium, and still got traded; XRP's
  momentum-only entry came after price had already run +8.4% in 48h, right
  near the 48h high (chasing a move already made, the exact risk flagged
  when the momentum trigger was designed - its first live test was also
  its first loss, n=1 so far); POL's crossover fired on below-average
  volume (0.27x, unconfirmed) plus a mixed news item. None of the three
  got anywhere near +1R before reversing, so this reads as an entry-timing
  issue, not the (separately shipped, see above) exit-logic gap - the
  breakeven/trailing upgrade wouldn't have changed any of these three
  outcomes either, since none of them got far enough into profit to
  trigger it. Two candidate
  changes for the live version, neither implemented: (1) require a minor
  pullback/confirmation candle before a momentum-only entry specifically,
  rather than buying the extension immediately; (2) size stops off ATR /
  realized volatility rather than purely "just below the nearest SMA or
  support level" - 2.2-2.4% stops on ETH/POL are tight relative to normal
  crypto 4h noise and may be getting shaken out before the thesis plays
  out. Don't act on either until there's a real sample (20-30+ trades) -
  track win rate/expectancy split by signal type (crossover vs.
  momentum-only vs. RSI) as trades accumulate, per the instructions doc's
  existing Review loop section, and revisit this note then.

## Network access

This environment's network policy has `api.kraken.com` allowlisted
(Custom network access, set in the environment's settings on claude.ai/code).
Node's built-in `fetch` doesn't honor `HTTPS_PROXY` by default, so
`NODE_USE_ENV_PROXY=1` is set on the MCP server process (in `.mcp.json`)
and in `mcp-server/package.json`'s scripts — without it, calls to Kraken
fail even when the domain is allowlisted. If this is ever run in a
*different* cloud environment, that environment needs the same domain
added before any Kraken tool call will work.

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

## The hourly routine (trigger)

**2026-09-20: fresh-session-per-firing was tried and reverted within the
same day - it's broken, don't re-attempt without fixing the root cause
first.** The motivating problem was real and remains unsolved (see below),
but the fix attempted did not work.

What was tried: switched the trigger to `create_new_session_on_fire: true`
(`persist_session: false`, no `persistent_session_id`), on the theory that
a brand-new disposable session per hourly firing would keep cost flat
instead of climbing as one persistent session's conversation history
accumulates forever (see "the cost problem" below for the numbers that
motivated this).

What actually happened: the very first real firing under this mode
(`trig_018vYAWycycUJfDwZTvpzzh9`, fired 08:11 UTC) reported
`ROUTINE_RUN_STATUS_SUCCEEDED` but did **nothing** - no git commit, no
trade decisions, nothing pushed. `get_session` on the session it spawned
showed no `sources` field at all (no git repository configured) and no
`post_turn_summary`, with a suspiciously low `cost_usd` (~$0.37) and
`input_tokens` (28). **Root cause: `create_trigger`'s
`create_new_session_on_fire` mode has no parameter to specify a git repo
source at all** (unlike `create_session`, which takes `source_url`/
`source_revision`), and the environment itself has no bound default
repository (checked via `list_environments`). So every fresh session this
mode spawned started completely empty - no repo, no `.mcp.json`, no MCP
tools, nothing to `git pull`, nothing to commit - while the trigger
infrastructure still reported the firing as a bare success. This is a
dangerous failure mode specifically *because* it fails silently: a
real-money version of this bug would look identical (routine reports
"succeeded," nothing actually gets checked or traded) unless someone
happens to notice the missing commit.

**Fix applied same day**: reverted to the persistent-session model.
Deleted the broken trigger, created a verification session via
`create_session` with an explicit `source_url`/`source_revision` (confirmed
this time to have `session_context.sources` populated correctly), had it
run a full cycle to prove the repo + MCP tools work end-to-end, then
recreated the hourly trigger (same name, same `11 * * * *` cron) bound to
that verified session via `persistent_session_id` - i.e., back to exactly
the architecture that was in place before this whole detour, with a fresh
starting session (cost resets to the "cycle 1" baseline from here, but
*will* start climbing again over this session's lifetime - see below).

**The original cost-climb problem is still open and unsolved.** The
persistent session bound to the trigger before this detour had racked up
**$336.31 over ~18 hours** (cost climbing from ~$1/cycle early on toward
$18-19/cycle by the end), purely from conversation-history accumulation,
not from doing more work. That problem is real and will recur on the
current (reverted-to) session too. Ideas not yet tried: a periodic
scheduled cutover (e.g. every 1-2 days, `create_session` fresh + swap the
trigger's `persistent_session_id`) to cap how large any one session's
history gets, rather than fresh-per-firing; or checking whether an
environment can be configured with a bound default repository via the
claude.ai UI (which might make `create_new_session_on_fire` viable after
all, if it stops spawning repo-less sessions). Don't re-attempt
fresh-session-per-firing until one of these is actually verified working
end-to-end on a real firing - not just reasoned through - given today's
silent-failure experience.

**Notion connector reattachment is needed every time the trigger itself is
recreated** (as it just was). Two things to know:

1. `create_trigger`'s `connectors` param can't be set from a session that
   doesn't itself hold the connector (normally true for this session) -
   reattach at claude.ai/code/routines on the new trigger after creating it.
   Confirmed still true on today's recreation: the new trigger's create
   response explicitly warned it stores no MCP connectors.
2. **Historical context, from the original persistent-session model:** a
   Notion write tool could start prompting for interactive approval again
   despite the account-level always-allow setting, because that setting
   appeared to be evaluated and locked in the *first time a given session*
   encountered the tool - a session created before the setting was fixed
   kept asking forever, even after the fix. Confirmed by direct A/B test
   (2026-09-11). The now-current session (created 2026-09-20, after that
   fix) should not hit this, but it hasn't been specifically re-confirmed
   since today's trigger recreation - watch the next couple of firings'
   Notion sync status to be sure.

If Notion does start silently prompting again: don't just re-click approve
each time. Fix the always-allow setting first (Settings → Connectors →
Notion, per-tool), then do a fresh cutover (`create_session` + swap
`persistent_session_id`) so the replacement session picks up the fix from
its first tool call - a session that already hit the bug before the fix
keeps asking forever, per the note above.

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
  - **Revised 2026-09-20: `peak_price` now tracks 1h candle highs since
    entry, not a live point-sample of `ticker.last`.** User asked what
    happens if a trade spikes to a new high and reverses within the hour
    between two `checkStops` runs - traced it and found a real gap: the
    old code only compared `ticker.last` (a single price at the instant of
    each check) against the stored `peak_price`, so a spike-and-reversal
    between checks was never recorded at all. That silently understated
    the guaranteed-profit floor below what the trade actually earned, and
    - separately - meant `hasReachedOneR` could miss that a trade had ever
    reached +1R if price had already pulled back below it by the time a
    given cycle ran. Fixed with `peakFromCandles` (pure, unit-tested) and
    `historicalPeakSinceEntry`: each cycle now fetches 1h candles since
    `opened_at` and takes the highest `high` among them (deliberately
    including the still-forming last candle, whose `high` is a true
    running high-so-far, unlike `close`), combined via `Math.max` with
    `ticker.last` and the existing `peak_price` so the value can only ever
    increase. `hasReachedOneR` is now also evaluated against the refreshed
    `peak_price` rather than a live-only price, so a trade that touched
    +1R and pulled back still correctly earns the trailing treatment. No
    backfill needed - `peak_price` is monotonic, so the very next
    `checkStops` cycle self-corrects any position where the old
    point-sampled value happened to understate the true historical peak.

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
- **Consider a risk-based exposure cap alongside (or instead of) the
  current notional one.** Raised 2026-09-19, after the user questioned why
  `total_exposure_pct` climbs on a rally even though no new money is being
  committed and every position has a stop. Verified live at the time: 7
  open positions, $2,100 notional (21% of the $10,027 portfolio), but the
  actual $ outcome if all 7 hit their *current* stop simultaneously was
  only -$71.91 (-0.72% of portfolio) - two of them (ADA, SOL, already past
  +1R) would have closed at a **guaranteed profit**, not a loss. The
  25%-of-notional cap (`MAX_TOTAL_EXPOSURE_PCT` in `types.ts`) is real and
  intentional as a tail-risk hedge (bounds how much of the account could
  be caught in one correlated crash with real slippage, independent of
  individual stop distances - see the reasoning already on file for why
  it doesn't scale with pair count), but it's a cruder measure than actual
  risk: a $300 position with a tight 2% stop and a $300 position with a
  loose 7% stop count identically toward the 25% notional cap despite
  being very different bets. A risk-based variant would instead cap the
  sum of $-at-risk-given-current-stops (which also improves automatically
  once a position crosses +1R and can no longer lose, unlike notional
  exposure which doesn't know or care about that). Not acted on yet -
  the notional cap has never actually bound trading decisions in a way
  that looked wrong, this is a theoretical refinement flagged for the live
  version. Revisit once there's more data on how often notional and
  risk-based exposure meaningfully diverge in practice (right now: a lot -
  21% notional vs. 0.72% real downside - but that's one snapshot, not a
  trend).
- **Surface the guaranteed-profit-lock status on the Notion sync.**
  Requested 2026-09-19, right after the risk-based-exposure-cap note above
  - user wants to track locked-in profit somewhere they actually look
  day-to-day, not just in `data/portfolio_state.json`. Right now
  `trailing_active`, `stop_loss`, and `peak_price` (see the peak-scaling
  profit-lock upgrade under "Shipped to paper trading" above) are fully
  present in the paper-trading state and in `trades.md`'s close-reason
  text when a trailing stop triggers, but the Notion summary page and
  Trade Log don't surface any of it while a position is still open - a
  trade that's already past +1R and guaranteed profitable looks identical
  in Notion to one still sitting on its original fixed stop. Add either a
  per-position note/line on the summary page, or a column in the Trade Log
  showing each open position's currently locked-in profit ($ and/or % of
  entry) whenever `trailing_active` is true (blank/n/a otherwise - most
  positions most of the time won't have reached +1R). The data needed
  (`trailing_active`, `stop_loss`, `entry_price`, `quantity`) is already
  returned by `portfolio_get_state` per open position; this only needs the
  hourly routine's Notion sync step (step 5 in the trigger prompt) updated
  to compute the derived $/% and write it somewhere in Notion. Not
  implemented - batch this with the risk-based-exposure-cap note above and
  any other Notion-schema changes when picking this up, so a schema tweak
  doesn't force its own one-off session cutover.
- **Use EUR as the live account's base currency, not USD.** Discussed
  2026-09-20 - user's income is in EUR, so this was weighed as EUR vs.
  USD-then-convert, not as a neutral choice. Checked live before
  deciding, not assumed:
  - **Liquidity**: EUR versions of all 7 current pairs are real and
    tradeable but consistently thinner than USD - roughly 11-41% of USD's
    24h volume per pair (DOGE/EUR thinnest at 11%, ADA/EUR least-thin at
    41%). Judged not to bind in practice at this system's ~$300/trade
    size (even DOGE/EUR's ~$1.4M/day is ~350x a single trade) - would
    need re-checking only if position sizes are later scaled up
    substantially.
  - **Funding cost**: EUR SEPA deposits are free for verified Kraken
    users; funding a USD account from a EUR bank requires an
    international wire (~$40/transfer) - a real, avoidable, recurring
    cost if funding or withdrawing more than once.
  - **FX exposure**: holding the account in USD means EUR-denominated net
    worth moves with the EUR/USD rate on top of actual trading
    performance, for as long as the account holds USD - noise uncorrelated
    with strategy skill. Staying in EUR the whole way through (EUR
    deposit, EUR-quoted pairs, EUR withdrawal) avoids this entirely, and
    keeps P&L measured in the currency that actually matters for the
    user's finances.
  - **No hidden EUR markup**: confirmed Kraken's standard maker/taker fee
    schedule is identical regardless of quote currency, as long as
    trading goes through the real order book (Kraken Pro / API - what
    this system already does) rather than the separate "Instant Buy"
    convenience feature, which does carry an undisclosed 0.5-2% spread
    baked into the execution price. A bot placing real orders via the API
    never touches that path in either currency.
  - **API support confirmed live**: all 7 pairs' EUR versions show
    `status: "online"` on Kraken's own `/0/public/AssetPairs` endpoint
    (the same field that gates order placement), and Kraken's official
    AddOrder docs use `ETH/EUR` as their own worked example - EUR-quoted
    trading is fully supported via the same API/pair namespace already
    used for market data, no separate or restricted access tier.
  - **Recommendation: EUR**, on balance - the funding-fee and FX-exposure
    arguments are real and ongoing, while the liquidity gap doesn't
    actually bind at planned trade sizes. Not implemented (paper trading
    stays USD-denominated, matching Kraken's public API default used for
    testing) - this is specifically a live-build decision.
- **Re-screen the live pair list for EUR liquidity specifically before
  finalizing it - don't just carry over the USD-based selection.**
  Follow-up to the EUR-base-currency decision above, 2026-09-20. The
  current 7-pair lineup (BTC/ETH/SOL/XRP/ADA/LINK/DOGE) was screened
  entirely on USD volume (see "Shipped to paper trading" above); a fresh
  live EUR-volume screen of the 7 plus a broader candidate set turned up
  a real discrepancy:
  ```
  BTC $18.5M > XRP $15.5M > ETH $14.9M > SOL $8.3M > AVAX $5.1M >
  ADA $3.6M > SUI $2.8M > NEAR $2.7M > UNI $2.2M > LINK $2.1M >
  AAVE $1.5M > DOGE $1.4M (weakest in lineup)
  ```
  AVAX (not in the current lineup) has more than 3.6x DOGE's EUR volume
  and more than double LINK's - it missed the original USD-based bar but
  would rank 5th in EUR terms, ahead of ADA. SUI, NEAR, and UNI (also not
  in the lineup) all edge out LINK too. Complication: the original
  ADA/LINK/DOGE picks weren't pure volume-ranking - they explicitly
  weighted sector diversity (LINK = oracle/infra, a different category
  from the L1s already in scope; DOGE = distinct social-sentiment
  volatility character) over raw volume. AVAX and SUI are both L1
  smart-contract platforms, the same bucket SOL/ADA already cover, so
  swapping toward them would trade some of that deliberate diversity for
  liquidity. Leaning: DOGE is the more clear-cut candidate to reconsider
  (weakest EUR liquidity in the lineup, and a 3.6x gap against AVAX isn't
  offset by "distinct volatility character" alone); LINK's case is
  murkier since its category diversity was a deliberate choice, not just
  a ranking. Not decided or implemented - this was a live snapshot
  (2026-09-20), re-verify with fresh EUR volume data before actually
  finalizing the live pair list, same re-verify-before-acting caveat as
  every other volume-based pair decision on file.
- **For the live version, replace hourly-polled stop/trailing execution
  with real resting stop orders on Kraken.** Raised 2026-09-20, after the
  user asked what happens if a trailing position (already past +1R, stop
  floored at a guaranteed profit) gaps down through its stop and keeps
  falling within the hour between checks, landing back below entry by the
  time the next hourly `portfolio_check_stops` run catches it. Traced the
  exact mechanics: `checkStops` compares the *live* price at check time
  against the stored `stop_loss`, but `closePosition` fills at whatever
  `ticker.bid` is *at that moment* - not at the recorded `stop_loss`
  level. So the "guaranteed profit" floor only holds if the position is
  actually closed near that level; a severe enough single-hour move can
  gap straight through it and keep falling before the next check, closing
  at an real loss despite having been guaranteed-profitable an hour
  earlier. This is invisible in paper trading (a worse-than-expected fill
  there is just a number) but would be real money slipping past a level
  meant to be a floor once live. Root cause: the current stops aren't real
  orders resting on the exchange - they're soft checks this agent runs
  once an hour, so they can't react to anything that happens between
  checks. Fix for the live version: place genuine resting orders on
  Kraken itself so the exchange's own matching engine owns the trigger
  and reacts continuously as the market moves, rather than this agent's
  hourly poll loop. Not implemented - paper trading has no real order
  book to rest an order on, so this is specifically a live-build item;
  the peak-scaling profit-lock math itself (what level the floor *should*
  be at) doesn't change, only how it gets enforced.
  - **Design decision 2026-09-20: keep the bespoke peak-scaling/SMA logic
    (option 2), don't switch to Kraken's native `trailing-stop` order
    type (option 1).** Two ways to use real resting orders were weighed.
    Kraken's native `trailing-stop` order type would close the gap-risk
    completely (exchange-managed, truly continuous) but only supports a
    fixed trailing distance set at placement - it has no concept of "wait
    for +1R first," "floor at 0.3x peak gain," or "switch to the
    20-period 4h SMA once that's higher." Adopting it would mean
    discarding the exact strategy already built and paper-tested, in
    exchange for simplicity, right as real money enters the picture. User
    chose to keep the existing logic instead: the hourly run keeps
    computing the correct floor exactly as `checkStops` does today, but
    instead of only comparing against a locally-stored `stop_loss` and
    self-triggering a market order, it must now also **actively manage a
    real resting order on Kraken** - cancel and replace it with a fresh
    `stop-loss` (or `stop-loss-limit`) order whenever the computed floor
    moves up. This closes the *execution* gap (a real order sits at the
    last-computed level and fires immediately if touched, rather than
    waiting up to an hour for the next poll to notice) without closing
    the separate, smaller *logic-update* lag (the floor itself still only
    recomputes once an hour) - those are different gaps and this only
    fixes the first one, which is also the one that can turn a guaranteed
    profit into a real loss.
    - **New duty for the live hourly run: reconciliation, not just
      detection.** Once orders rest on Kraken, the exchange can fill one
      at any moment, not just when this agent happens to be checking. So
      each cycle needs to query Kraken's order/trade history first, to
      find out whether any resting order already filled since the last
      run (and at what real price/time), and update
      `data/portfolio_state.json` / `trades.md` to match what Kraken
      actually did - rather than assuming nothing closed just because the
      agent didn't personally trigger it. This is a real architecture
      change from today's checkStops (which is the sole decision-maker)
      to a live version where Kraken's engine can act unilaterally between
      runs and the agent's job is partly to catch up to reality.

## Network access

This environment's network policy has `api.kraken.com` allowlisted
(Custom network access, set in the environment's settings on claude.ai/code).
Node's built-in `fetch` doesn't honor `HTTPS_PROXY` by default, so
`NODE_USE_ENV_PROXY=1` is set on the MCP server process (in `.mcp.json`)
and in `mcp-server/package.json`'s scripts — without it, calls to Kraken
fail even when the domain is allowlisted. If this is ever run in a
*different* cloud environment, that environment needs the same domain
added before any Kraken tool call will work.

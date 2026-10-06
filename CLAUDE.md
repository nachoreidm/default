# Kraken LIVE Trading Agent

> **⚠ This branch trades real money.** €5,000 EUR, real Kraken orders, real
> stop-losses on the exchange. It is NOT the paper-trading system — that
> lives on `claude/ai-crypto-trading-agent-x0w1d3`, unaffected by anything
> here. Read `instructions/kraken-live-agent-instructions.md` in full before
> doing any trading research, recommendation, or portfolio action in this
> repo — it's the operating spec and takes precedence over improvising.

## Note on dollar figures throughout this file (added 2026-10-04)

Every "$X over Y hours" figure cited for an archived session elsewhere in
this document is the platform's internal **API-cost-equivalent** usage
metric (what that session's token usage would cost at standard API
rates) - **not an actual charge against the user's account**, which runs
on a flat subscription (~€20/month), not pay-per-token billing. Read
these figures as a relative usage-intensity indicator (useful for
comparing "this session got heavier than that one," which is what
motivated the cutover architecture in the first place) rather than real
money spent. Existing historical entries are left as-is rather than
rewritten; any new entry should keep this framing in mind rather than
imply real spend.

## How this branch came to exist

Built 2026-09-21 off the paper-trading branch, after ~2 weeks of paper
trading validated the strategy, risk-limit enforcement, and hourly-cycle
architecture. Full history of every decision behind the strategy itself
(signal design, the trailing-stop/profit-lock math, the hourly-trigger and
weekly-cutover architecture, past incidents and fixes) lives in the paper
branch's `CLAUDE.md` — this file only covers what's specific to *live*:
credentials, real order execution, and what's still pending before the
first real trade.

## Cutover playbook and known platform constraints (read before touching any session/trigger)

Added 2026-10-03 after the Notion-prompt incident that day (see that
date's entries further down) turned a same-day fix into several hours of
back-and-forth - almost entirely because the real platform constraints
below were relearned live, under time pressure, with real money on the
line, instead of being known going in. Check this section first for any
future infra-affecting action (a code-change cutover, the weekly cutover,
or anything else touching a session or trigger) rather than reasoning from
scratch about what "should" work.

**Known platform constraints for this account/environment** (each hit
directly, not assumed):
- `delete_trigger` on the live hourly trigger is reliably blocked by the
  platform's own auto-mode classifier ("judged dangerous," rarely with a
  specific reason beyond that). Hit 3 times in a row with an identical
  result on 2026-10-03 - don't retry it blind, and don't try to reach the
  same outcome through `update_trigger` either (changing
  `persistent_session_id` to rebind away from the blocked trigger is the
  same denied outcome through a different door). Go straight to
  **creating a new trigger** instead (see sequence below).
- `create_trigger`'s `connectors` parameter is not available for this
  organization (confirmed via a direct rejection: "the connectors
  parameter is not available for this organization"). Don't rely on it to
  attach Notion declaratively - budget for a manual attach in the
  claude.ai/code routines UI every time a new trigger needs Notion.
- The routines UI as surfaced to the user does not support rebinding an
  existing routine to a different, already-existing session - that
  binding has to be made at trigger-creation time via `create_trigger`
  from a session with API access, not an in-UI edit of an existing one.
- Two routines with the same name are indistinguishable in the user's UI
  (no visible timestamps, session info, or trigger IDs shown there) -
  rename them distinctly the moment two exist side by side (e.g.
  "DISABLE THIS ONE" / "KEEP THIS ONE"), don't wait for confusion to
  surface the need.

**The actual working cutover sequence, given the above** (use this
directly rather than re-deriving it each time):
1. Create a fresh session seeded with the exact current hourly-cycle
   prompt text (doubles as verification and that cycle's real work, so
   nothing is wasted).
2. Verify via the real commit (`git log`/`git show`), not the session's
   own summary.
3. Explicitly ask the user whether a Notion approval prompt appeared - a
   clean completed cycle is never proof by itself (established
   2026-09-25, reconfirmed 2026-09-30 and 2026-10-03).
4. `create_trigger` a brand-new trigger (same name/cron) bound to that
   verified session - don't attempt to touch the old one's binding first.
5. Immediately rename both triggers distinctly (old → "DISABLE THIS
   ONE", new → "KEEP THIS ONE", or similar) the moment both exist, before
   asking the user to act on either.
6. Ask the user to, in the routines UI: disable the old routine, and
   attach the Notion connector to the new one (both manual steps per the
   constraints above - neither is currently reachable via API here).
7. Confirm via `list_triggers` (the old one shows `enabled: false`; the
   new one shows the Notion connector under `mcp_connections`), then
   archive the old session and rename the new trigger back to the plain
   standard name.

This is the mechanical fix for *how* to cut over without wasted cycles.
It does not replace the separate, more important guardrail against
*needing* an unplanned cutover in the first place - see "Hourly cycle
self-initiated an unauthorized session/trigger cutover" further down for
why the hourly cycle must never decide on its own that one is warranted.

## Layout

- `instructions/kraken-live-agent-instructions.md` — the live agent's
  operating rules (paired with this file; read both)
- `mcp-server/` — same structure as paper trading: Kraken market data,
  computed signals, `indicators.ts`/`signals.ts` unchanged. Two things are
  new: `kraken-private.ts` (signed private-API client) and
  `portfolio-live.ts` (real order execution + Kraken reconciliation,
  replacing paper trading's `portfolio.ts`, which was deleted on this
  branch — it has no live counterpart and would only rot as dead code).
  `trailing-math.ts` holds the exchange-agnostic trailing-stop/profit-lock
  math (moved out of `portfolio.ts` before deleting it) - reused verbatim,
  unit-tested in `selftest.ts`.
- `.mcp.json` — registers `kraken-live-trading` (renamed from
  `kraken-paper-trading`), now also declaring `KRAKEN_API_KEY`/
  `KRAKEN_API_SECRET` env vars
- `data/live_portfolio_state.json` — live position tracking (what Kraken
  itself doesn't store: `initial_stop_loss`, `trailing_active`,
  `peak_price`, the resting stop order's txid). Cash/fills are NOT
  authoritative here - `portfolio_get_state` always queries Kraken's real
  balance and real order fills live, this file only holds derived state.
- `data/paper_portfolio_state_archive.json`, `paper-trades-archive.md` —
  the paper-trading history inherited at the branch point, frozen for
  reference. Not touched by anything on this branch.
- `trades.md` — **live-only** trade log, starts clean on this branch (see
  its own header). Real trades, real money, real fills.

## Credential handling — read before touching anything Kraken-auth-related

**Verified 2026-09-21**: ordinary Claude Code Remote environment variables
are readable by the model and anything it runs (confirmed against
Anthropic's own docs - `env`/`printenv` sees them in plain text). The only
protected mechanism ("API Credentials," where the key never reaches the
model) is Pro/Max-plan-only, and even where available almost certainly
can't do what Kraken needs anyway - HMAC-signing a request requires the raw
secret in-process at signing time, which a proxy-injected header can't
provide. **Decision, made with the user knowing this**: store
`KRAKEN_API_KEY`/`KRAKEN_API_SECRET` as ordinary environment variables on a
**dedicated CCR environment** (not the "Default" one paper trading uses -
keeps the credential structurally unreachable from any paper-trading
session). The real backstop is the Kraken API key's own permission scoping,
not secrecy of the credential value:

**Required Kraken API key permissions** (create this at
kraken.com → Settings → API):
- Query Funds
- Query Open Orders & Trades
- Query Closed Orders & Trades
- Query Ledger Entries
- Create & Modify Orders
- Cancel/Close Orders

**Explicitly WITHOUT "Withdraw Funds."** This is the actual safety
boundary given the storage tradeoff above - if the key ever leaked, the
worst case is someone placing/cancelling trades with the account's funds
(bounded, real, but recoverable loss via bad orders/fees), not funds
leaving the account outright. Do not enable the optional API-key
password/2FA requirement either - it would block automated signing
entirely (no human present to supply a live OTP on an hourly cron).

## Kraken private API client (`kraken-private.ts`)

Implements Kraken's standard request-signing scheme (nonce + POST body →
SHA256 → HMAC-SHA512 with the base64-decoded secret → base64 `API-Sign`
header, alongside `API-Key`) - a long-stable, well-known scheme, but **this
environment's network policy only allowlists `api.kraken.com`**, so the
exact spec text couldn't be double-checked against Kraken's own docs page
during the build (`docs.kraken.com` is blocked). The private endpoints
live under the same `api.kraken.com` domain (`/0/private/*`), so no
network-policy change was needed - only the signing logic itself is
unverified against live Kraken until real credentials exist.

**Correctness gate, not yet run**: a `validate: true` `AddOrder` call once
`KRAKEN_API_KEY`/`SECRET` are set. Kraken authenticates the request for
real but places nothing - a wrong signature is rejected outright
("Invalid signature"), so this can't silently pass if the signing code is
wrong. **This must be run before the first real (non-validate) order** -
see "What's left before the first live trade" below.

**One implementation choice made without live verification**, worth
knowing: `openPosition` places the entry and the resting stop-loss as two
separate, explicit orders (not using Kraken's `close[ordertype]`/
`close[price]` contingent-close mechanism attached to the entry order).
The plan going in flagged this as needing verification against a real
`AddOrder` response before relying on it; rather than guess at the
contingent-close behavior without being able to test it, the implementation
uses the simpler, fully deterministic two-step version - each order's txid
comes directly from its own `AddOrder` response, no matching/searching
needed. Tradeoff: a few-second window between entry fill and stop
placement where the position is technically unprotected (vs. Kraken
handling that atomically) - bounded to seconds within the same tool call,
not spanning to the next hourly check, and the tool call fails loudly if
the stop placement doesn't succeed in that window. Revisit only if this
proves to be a real problem in practice, not preemptively.

**Take-profit is deliberately NOT a resting order** - see
`instructions/kraken-live-agent-instructions.md`'s "Order execution"
section for the full reasoning (Kraken only supports one contingent close
per parent order; running stop-loss and take-profit as two independent
resting orders would need manual OCO emulation for a gap - missing a fixed
take-profit by up to an hour - that was never the problem the real-resting-
stop-order design was built to solve; only the stop-loss/trailing-floor gap
was). Take-profit stays a polled check against live price, same mechanism
paper trading always used, until a position reaches +1R and it's
superseded by the real trailing stop.

## Position sizing (raised from paper trading's 5%/3%/25%)

`RISK_LIMITS.MAX_POSITION_PCT: 8`, `CONFIDENCE_MAX_SIZE_PCT.medium: 5`,
`MAX_TOTAL_EXPOSURE_PCT: 40` - see the paper branch's CLAUDE.md
(2026-09-20 entry) for the full reasoning (stop-loss bounds real risk to
`size_pct × stop_distance_pct`, not `size_pct` alone; all three numbers
scaled by the same 8/5=1.6x factor so the exposure cap's *relative*
headroom is unchanged at the new sizes).

## Live pair list (EUR, re-screened 2026-09-21 - not the same as paper's USD list)

BTC/EUR, ETH/EUR, SOL/EUR, XRP/EUR, ADA/EUR, LINK/EUR, **SUI/EUR**.

Re-verified live EUR 24h volume rather than carrying over paper trading's
USD-based screen (BTC $72.3M > ETH $33.0M > SOL $17.3M > XRP $16.5M > SUI
$8.0M > AVAX $7.5M > NEAR $7.4M > ADA $5.8M > UNI/LINK ~$3.0M > DOGE $2.6M
> AAVE $2.0M). DOGE (paper trading's 7th pair) was the clear cut - weakest
in the lineup, ~3x behind the next alternatives - swapped for SUI, the
highest-volume of the three close alternatives (SUI/AVAX/NEAR all within
~8% of each other). Accepted tradeoff: SOL/ADA/SUI are now 3 of 7 pairs in
the same L1-smart-contract-platform bucket, trading away DOGE's distinct
social-sentiment volatility character for better liquidity. All 7 EUR pair
codes confirmed live against Kraken's Ticker endpoint before building
(`kraken.ts`'s `PAIR_CODE` map) - Kraken nests BTC/ETH/XRP under legacy
X/Z-prefixed keys (`XXBTZEUR`, `XETHZEUR`, `XXRPZEUR`) while the rest key
directly; the existing `firstResultKey()` helper already handled this
generically, no special-casing needed.

## Status: LIVE as of 2026-09-22

Everything below happened, in order, on 2026-09-22:

1. Kraken API key created with the exact permissions listed above
   (confirmed without Withdraw Funds).
2. Dedicated CCR environment created (`env_0112pJKVzgfw4uhzex18Ete4`,
   "Kraken live") with `KRAKEN_API_KEY`/`KRAKEN_API_SECRET` set.
3. `validate: true` `AddOrder` smoke test run via the `kraken_verify_credentials`
   tool - signing implementation confirmed correct against live Kraken
   (no signature error).
4. Real Balance query confirmed working - EUR under `ZEUR`, as assumed.
   (Also caught and fixed a bug the same day: `liveCashEur()` threw
   instead of returning 0 when the account was genuinely empty, since
   Kraken's Balance endpoint omits zero-balance assets entirely rather
   than returning them as `"0"` - fixed before it could matter.)
5. Session created + verified against this branch and the new environment
   (`session_01LRiaYGGANTDzxrg7qQQRTm`) - repo, MCP tools, and Kraken auth
   all confirmed working before it ran anything real.
6. **User funded the account with €5,000** (confirmed via real Balance
   query: €5,000.0000 under `ZEUR`).
7. That same verified session ran the **first live cycle** immediately
   after funding - see "First live cycle" below - then became the
   persistent session bound to two triggers: **hourly monitoring**
   (`trig_012ddfbAjirGwKWLkvYtpt1m`, cron `41 * * * *` - offset from
   paper trading's `:11`, though paper trading's triggers are currently
   disabled anyway, see below) and **weekly cutover**
   (`trig_01U9hjsV4GHewJ4ie3q334xm`, Sundays 10:00 UTC, mirroring the
   paper branch's cost-climb mitigation - same per-cycle cost growth
   applies to any persistent session regardless of what it's trading).
8. Live-specific Notion page/log created 2026-09-22, separate from the
   paper ones: summary page "Kraken Live Trading Agent"
   (page_id `3e378a93-63b8-8107-a22d-f3599a28de9f`) with an embedded Trade
   Log database (`collection://a3ed2931-8ba7-424a-8e26-41ec2fa97b3a`,
   same schema as paper's but EUR-formatted - "P&L EUR" not "P&L USD").
   Backfilled with the first cycle's 7 rows. The hourly trigger's prompt
   (step 5) now syncs both automatically each cycle, mirroring paper's
   step 5. **Note**: `update_trigger` can't change a trigger's prompt text
   from a different session/thread than the one it's bound to - updating
   the hourly trigger's prompt to add this step required delete +
   recreate rather than an in-place edit (same trigger name/cron/session,
   trigger id `trig_013Cztzc1zs23bLzB4Gx8Eo6`) - a real constraint, not a
   one-off issue, if this needs touching again. The
   "surface guaranteed-profit-lock status in Notion" item from the paper
   branch's decision log is still open and can be batched with any future
   schema change here. **Closed 2026-09-25** - see "Open Positions table
   added to Notion" below.
   - **Bug found on the very next cycle (14:44 UTC) and fixed same day**:
     the original step-5 wording ("update the summary page... with fresh
     numbers... and a fresh Last synced timestamp") didn't specify which
     Notion tool/command to use. The agent used something append-like
     (not `replace_content`), leaving the summary page with a stale
     "Last synced" line plus a duplicated, garbled `<database>` embed
     fragment appended after it - and the Trade Log got **zero** of that
     cycle's 7 rows (verified via `notion-query-data-sources`: only the
     first cycle's backfilled rows were present). Not a Notion
     connector/access problem - this session, in a completely different
     CCR environment, could read/write the same Notion resources without
     issue, proving access was never the constraint; execution
     instructions were. Fixed: (1) manually rewrote the summary page via
     `notion-update-page` `command: "replace_content"` with correct
     figures; (2) manually backfilled the missing 7 Trade Log rows via
     `notion-create-pages`; (3) replaced the trigger with trigger id
     `trig_015b4LnQ7sRY5qtpXfGAMrRA` (same name/cron/session), whose
     step 5 is now explicit: mandates `notion-update-page` with
     `command: "replace_content"` (spelling out NOT `insert_content`, NOT
     `update_content`), gives the exact page sections to rewrite each
     time (Portfolio Summary heading, Last synced line, metrics table,
     REAL MONEY paragraph, Links, routine description, ending with the
     Trade Log `<database>` embed), gives the exact `notion-create-pages`
     schema/property-omission rules for Trade Log rows, and adds a new
     step 5d - query the Trade Log after writing to confirm the rows
     actually landed, mirroring the "verify the git push, don't trust the
     summary" discipline already used elsewhere in this project.
9. First cycle watched directly (see below) before the recurring triggers
   were created - confirmed clean before leaving it unattended.

**Paper trading's hourly and weekly-cutover triggers were disabled
2026-09-22** (not deleted - a one-line `enabled: true` away from resuming)
at the user's request, to stop spending on a comparison run now that live
is active. The paper branch, its data, and its code are untouched.

### First live cycle (2026-09-22 14:26 UTC)

Opened three real positions, all medium confidence, all sized at 4%
(€200 each, €600/12% of the €5,000 account committed, well under the 40%
exposure cap):

| Pair | Entry | Stop-loss | Take-profit |
|---|---|---|---|
| BTC/EUR | €74,971.00 | €71,800.00 | €81,313.00 |
| SOL/EUR | €101.68 | €96.50 | €112.04 |
| LINK/EUR | €11.29 | €10.75 | €12.37 |

Each has a real resting stop-loss order confirmed on Kraken (see
`trades.md` for the order IDs). Passed on ETH/XRP/ADA/SUI despite momentum
flagging on all four - unconfirmed volume, adverse order-book skew, or (SUI)
no news catalyst proportionate to the size of the move. Verified directly
against the commit and `trades.md`, not just the session's own summary,
which had a small inaccuracy (misnamed one of the three pairs) - a reminder
that a session's `post_turn_summary` is a convenience, not ground truth,
especially for anything involving real money; the weekly-cutover trigger's
prompt now explicitly says to cross-check against the actual commit for
this reason.

### Second live cycle (2026-09-22 14:44 UTC)

Reconciliation and trailing checks on the three existing positions came
back clean (no fills, no +1R trailing trigger yet). BTC/SOL/LINK logged
no-trade (existing position, one-per-pair rule). ETH/XRP/ADA logged
no-trade (still volume-unconfirmed / order-book concerns, same pattern as
cycle one). A fourth position was opened:

| Pair | Entry | Stop-loss | Take-profit | Size |
|---|---|---|---|---|
| SUI/EUR | €0.87 | €0.78 | €1.05 | 3% (€149.81) |

Momentum-only (medium confidence, capped below the 5% medium ceiling given
extension risk) - unlike cycle one, this cycle's news search surfaced a
concrete, proportionate catalyst for SUI specifically: CME Group launched
SUI futures and Grayscale created a Grayscale SUI Trust, both genuine
institutional-access events. Order book had flipped negative in the last
15 minutes before entry (real near-term selling pressure), flagged
explicitly in the trade's own reasoning rather than ignored. Real resting
stop-loss order confirmed on Kraken (order `OCN5SW-F2BWT-PAHRUP`; entry
order `OWJ4ES-2JMUW-YAYFFC`) - see `trades.md` for full detail. This is
also the cycle that surfaced the Notion-sync bug documented above.

Total after this cycle: 4 open positions (BTC, SOL, LINK, SUI), ~€749.61
committed (~15% of the €5,000 account), well under the 40% exposure cap.

## Fee constant corrected (2026-09-22)

`TAKER_FEE_PCT` in `types.ts` was `0.4` (paper trading's estimate, dated
2025 by its own comment) - stale against Kraken's current published fee
schedule. Verified live 2026-09-22: entry tier is 0.40%/0.80% maker/taker
below $2,500 in 30-day volume *or* assets-on-platform (AoP, whichever is
better - Kraken switched to this "whichever" model 2026-07-09); above
$2,500 it drops to 0.30%/0.60%. This account's ~€5,000 AoP alone clears
that threshold even at zero trading volume, so **0.60% is the correct
taker rate for this account right now** - corrected to `TAKER_FEE_PCT =
0.6`. This matters more here than it would elsewhere: every order this
system places (market entry, triggered stop-loss, market take-profit
close) is a taker fill by design - real resting orders execute as market
once triggered, there's no maker-fee path at all - so ~1.2% round-trip
fee cost (`ROUND_TRIP_COST_PCT`, now 1.3% after the fix) applies to every
completed trade, win or loss. The fix flows through the trailing stop's
profit-lock safety floor (`effectiveTrailingStop` in `trailing-math.ts`)
which was previously under-protecting by roughly half against a real
round-trip cost. `selftest.ts`'s two assertions that hard-coded the old
0.9%-derived floor value (100.9) were updated to the new 101.3 accordingly
- both still pass, along with the rest of the self-test suite and a
pruned-build MCP smoke test.

**Left open, not yet decided**: the fixed 2:1 `TAKE_PROFIT_RR_MULTIPLE`
take-profit target itself is still computed gross, not net of the ~1.2%
round-trip fee - a trade that closes exactly at the nominal 2R target
nets less than "2R" after fees. Fixing the stale constant was a clear,
low-risk correctness fix (it's just the current fee rate, verified against
Kraken's schedule). Making the take-profit target itself fee-aware would
be a real strategy change - it would raise the target on every trade,
changing win rate relative to paper trading's historical numbers - so
that's being thought through separately rather than folded into this fix.
If crossed later, update the threshold logic here and the corresponding
note in `TAKE_PROFIT_RR_MULTIPLE`'s comment in `types.ts`.

## SOL/EUR precision-bug incident, manual cutover, and fresh-session switch (2026-09-25)

**The incident**: `portfolio_check_stops` tried to move SOL/EUR's trailing
stop (just past +1R) and Kraken rejected the replacement price - *"SOL/EUR
price can only be specified up to 2 decimals."* Root cause: `formatPrice`/
`formatVolume` in `portfolio-live.ts` did a blind `toFixed(8)` for every
pair, assuming 8 decimals was safe everywhere. It isn't - Kraken's real
per-pair tick sizes vary (BTC/EUR price=1 decimal, SOL/EUR price=2,
SUI/EUR volume=5 not 8, etc.), confirmed live via `api.kraken.com/0/public/
AssetPairs`. Since the tool cancels the old stop before placing the new
one, the failed replacement left SOL/EUR with **no resting stop at all**.
The agent caught this itself, not from the error alone - it noticed 3
consecutive `portfolio_check_stops` calls where `peak_price` kept rising
but `stop_loss`/`stop_order_txid` never changed, which is only consistent
with a cancelled-and-never-replaced stop. No tool exists to inspect
Kraken's raw open orders directly, so rather than guess, it closed the
position manually via `portfolio_close_position` - a real market sell,
**+€6.85 realized** (price had risen, so this was a gain, just smaller
than the trailing stop would have eventually captured).

**The fix** (commit `aee10a8`): added `fetchPairPrecision()` to
`kraken.ts`, reading each pair's real `pair_decimals`/`lot_decimals` from
Kraken's public `AssetPairs` endpoint and caching per process. `formatPrice`/
`formatVolume` are now pair-aware - volume floors (a sell/stop order can
never request more than the position holds), price uses standard rounding
(fine either direction for a stop trigger). Verified against live Kraken
data and the self-test suite; reviewed the diff directly rather than
trusting the incident session's own commit message.

**The deployment gap, and why a manual cutover happened same-day**: the
fix was committed, but the hourly trigger was still bound to the *same
persistent session* that hit the bug - its MCP server process was already
running with the old code in memory, and a `git pull` doesn't reload an
already-imported Node module. The next scheduled firing (weekly cutover)
wasn't until Sunday, and the identical failure could have recurred on
BTC/LINK/SUI's next trailing update in the meantime. Ran the documented
weekly-cutover procedure manually, same-day: created a fresh session on
the fixed branch, verified it completed one real clean cycle (confirmed
via `git diff` on the actual commit showing zero unexpected state
changes, not just the session's self-summary - which, true to form,
overstated what happened that cycle by describing SUI's *already-existing*
trailing stop as if newly triggered), then swapped the hourly trigger onto
it and archived the old session.

**Also surfaced by archiving the old session**: its lifetime cost was
**$2,189.93 over ~69.5 hours** (2026-09-22 14:25 to 2026-09-25 11:52) -
the same cost-climb problem paper trading hit on 2026-09-20 ($336.31 over
18h), which motivated paper trading's switch to a fresh-session-per-firing
model back then. Live trading had never gotten that same fix - it kept
the older persistent-session-plus-weekly-cutover architecture, and a
weekly cutover clearly isn't frequent enough to bound this (cost climbs
with accumulated conversation history; $2,189.93 against a €5,000 account
in under 3 days dwarfs the actual trading P&L, which was net -€4.22
realized at the time). **Fixed the same day**: deleted the persistent-
session trigger and recreated it with `create_new_session_on_fire: true`
(new trigger id `trig_01R2Skdx6VvUEdmBgvJ77UDu`) - every hourly firing now
gets a brand-new, disposable session, resetting cost to baseline every
cycle, mirroring paper trading's existing fix exactly.

**Notion connector note**: `create_trigger`'s `connectors` param can only
pass through what the calling session itself already holds (normally
nothing), so the fresh-session trigger came up with a warning that fired
sessions would have no MCP connector tools. Kraken trading itself is
unaffected - those tools come from `.mcp.json` in the repo, not an
account-level connector, so they load automatically on every fresh
session. Notion needed one manual reattachment at claude.ai/code/routines
on the new trigger - done same-day, confirmed by the user. Should now be
transparent going forward: paper trading's identical fresh-session switch
(2026-09-20) proved that once the account-level Notion always-allow
setting is correct, every subsequent fresh session inherits it
automatically with no repeated approval prompts or reattachment needed.

### Fresh-session-per-fire reverted same day - it silently failed twice

**The fresh-session architecture above didn't work in practice.** Both of
its first two firings (12:41 UTC scheduled, then a manual `fire_trigger`
at 13:00 UTC to retest) reported `ROUTINE_RUN_STATUS_SUCCEEDED`, but
neither one actually did anything: no new git commit either time, no new
Notion rows either time, and both sessions used ~5,000 output tokens
versus a real cycle's typical 15,000+ - all pointing at the session
stopping very early rather than running the routine. No tool was
available to pull the session's actual transcript to find the exact
failure point; `SUCCEEDED` on the trigger apparently just means the
firing was dispatched, not that the routine's work completed - the same
gap in what a routine's own status can be trusted for that motivated
verifying against the actual commit/Notion state everywhere else in this
project, now generalized to trigger status too, not just session
summaries. Two failures in the same pattern within 20 minutes = a real,
repeatable problem with this architecture in this environment, not a
fluke - reverted to the persistent-session model the same day rather than
investigate blind. **The fresh-session-per-fire approach for this
specific trigger is not currently trusted and shouldn't be re-tried
without first understanding why it silently stopped early** - it's
proven for paper trading's hourly trigger, so this isn't a problem with
the general pattern, just something specific to this trigger/environment
combination that wasn't root-caused before reverting.

Reverted: new persistent session (`session_013JVrHfpZ59QgfKgsfPYHai`),
verified clean (real commit + real Notion rows, not just its own summary)
before binding the trigger back to it.

### Notion approval-prompt bug recurred on the reverted session, then resolved

Right after reverting, the user reported Notion asking for manual
approval again on the new persistent session - the same failure mode
documented on the paper branch (2026-09-11): a Notion write tool can
prompt for interactive approval despite the account-level always-allow
setting, and an *unanswered* prompt can leave a persistent session
blocked mid-turn, degrading future scheduled firings too (though the
trading-critical steps - stops, signals, execution, git push - all
happen *before* the Notion step in this routine, so real trading isn't at
risk from this specific failure mode, only the Notion sync and subsequent
cycle cadence are).

User fixed it by setting every Notion tool to "always allow" directly in
Notion's own connector settings. **First attempt at verifying the fix was
wrong, and worth recording why**: the existing (pre-fix) persistent
session's regularly-scheduled 13:41 UTC firing completed a fully clean
cycle - real commit (`e8bf7fc`), real fresh Notion rows at 13:42 UTC - and
that was initially read as evidence the fix had taken effect on the
already-running session, contradicting the 2026-09-11 precedent. It
hadn't. The 14:41 UTC firing on that same session prompted for Notion
approval *again* - the 13:41 "clean" result only looked clean because the
user was present and clicked approve in real time, not because the
session was actually fixed. A completed cycle is not by itself proof a
prompt didn't happen; only "did the user have to click anything" answers
that, and that's confirmed here as the discipline to apply next time this
comes up, not just "did the commit/Notion state end up correct."

Once that was caught, did the cutover the 2026-09-11 precedent actually
calls for: new session (`session_01FunzjeXToGyBEWjysEjUVn`) created
*after* the settings fix, verified via real commit (`bbc0775`) and real
Notion rows (14:52 UTC) same as always, **and this time explicitly asked
the user whether it had prompted for approval - it hadn't.** Trigger
re-bound to this session (`trig_01WyUaibu44awnu7EZBVR95n`). The
2026-09-11 precedent holds exactly as stated: a session created before an
always-allow fix stays locked into prompting for its whole life; only a
session created after the fix is clean. This is now resolved, not just
theorized.

**Net effect of today's back-and-forth**: hourly trigger is back on the
persistent-session model (same cost-climb exposure this was all trying to
escape - still only a weekly cutover bounding it, see above), now on a
session confirmed to need no Notion approval. The fresh-session-per-fire
failure from earlier today remains not root-caused - revisit if it comes
up again, but don't re-attempt it blind.

## Open Positions table added to Notion (2026-09-25)

Closes the "surface guaranteed-profit-lock status in Notion" item open
since the paper branch's decision log. The summary page's "Open
positions" line used to be one dense inline sentence with no per-position
risk detail. Added a dedicated "## Open Positions" table (Pair | Entry |
Current Stop | Unrealized P&L | If stopped out now) with one row per
position showing:

- **Before +1R** (`trailing_active: false`): "⚠️ Max risk: -€X.XX",
  computed as `(entry_price - stop_loss) * quantity` - what's actually
  lost if the resting stop fills right now, not the nominal stop
  distance.
- **After +1R** (`trailing_active: true`): "✅ Profit locked: +€X.XX",
  computed as `(stop_loss - entry_price) * quantity` - the guaranteed
  floor gain if the (now above-entry) trailing stop fills right now.

Both are computed from `data/live_portfolio_state.json`'s
`entry_price`/`stop_loss`/`quantity`/`trailing_active` fields, already
available from the routine's step-0 git pull - **no live Kraken call
needed**, since this is a floor derived from the resting stop's price,
not current market price (deliberately distinct from "Unrealized P&L" in
the same table, which does need the live price and fluctuates constantly
- the risk/profit-locked figure only changes when the stop itself moves).

Rolled out same-day: manually rewrote the live summary page with the new
table (verified via `notion-fetch`, not assumed), then updated the hourly
trigger's prompt so future cycles rebuild it automatically (delete +
recreate the trigger, same session `session_01FunzjeXToGyBEWjysEjUVn`,
new trigger id `trig_01QzdRYVyTGg3bi5y35d1q54` - same prompt-editing
constraint noted earlier in this file).

## Tiered trailing-stop profit-lock: 0.4/0.5/0.6 by peak R-multiple (2026-09-26)

Prompted by SUI/EUR running to over +2R while still only guaranteeing 30%
of that peak gain under the old flat `PEAK_PROFIT_LOCK_FRACTION`. Replaced
it with `PEAK_PROFIT_LOCK_TIERS` in `types.ts` - the locked *fraction*
itself now grows in steps as the peak's own R-multiple grows, on top of
the already-ratcheting absolute floor:

- **+1R**: 0.4 (up slightly from the original flat 0.3 baseline - a
  deliberate small tightening of the guarantee at the exact moment
  trailing activates, not just for deep winners)
- **+2R**: 0.5 (reuses `TAKE_PROFIT_RR_MULTIPLE` as the threshold - once a
  trade has run as far as its own take-profit target would have taken it)
- **+3R**: 0.6 (a genuinely extended, often fast/parabolic move)

`effectiveTrailingStop` (`trailing-math.ts`) now takes `initialStopLoss`
to compute the peak's R-multiple (`peakGain / (entryPrice -
initialStopLoss)`) and picks the highest tier the peak has cleared;
`trailingStopCandidate` passes `pos.initial_stop_loss` through.
`selftest.ts` got new cases at each tier boundary (just below +2R,
exactly +2R, exactly +3R) alongside updated existing assertions - full
suite and a pruned-build smoke test both passed before pushing (commit
`b6af6af`).

**Deployed same-day via cutover**, same lesson as the SOL precision-bug
incident: a running persistent session's MCP server process doesn't pick
up new code from a `git pull` alone. Created a fresh session
(`session_01J5vnnMUrHQnXnE9UMjbVvQ`), and this time verified the fix
itself took effect, not just that a cycle completed: SUI/EUR's real
resting stop moved from €0.92736 to €0.9676 in that session's very next
cycle (commit `24c015a`) - exactly the tier-2 value predicted (peak
€1.0682 is +2.19R; 0.5 × €0.2012 peak gain = €0.1006 above the €0.867
entry). Confirmed by reading the actual commit diff, not the session's
own summary. That same cycle also opened a new position, ADA/EUR (€0.2273
entry, momentum-only, 4% size) - concrete catalysts (Mastercard Crypto
Program, x402 AI-payments integration, CME futures listing). Trigger
re-bound to this session (`trig_01YJ8vM3c9umJcs3tEKWweKr`); old session
archived (cost $13.17 over its ~9-hour life - unremarkable, confirming
the persistent-session cost-climb problem is really about *duration*
lived, not something inherent to persistence itself).

**Connector mechanics clarification**: the user checked this new
trigger's Notion connector in the claude.ai/code routines UI, found it
unattached, and added it manually. Worth recording precisely what that
does and doesn't mean: for a **persist_session** trigger, Notion access
actually flows from the underlying session's own account-level connector
permissions, not from the trigger's own `mcp_connections` field - that
field was empty on this trigger the whole time, yet the session had
already synced to Notion successfully (the very cycle that moved SUI's
stop and opened ADA, before the manual attach). `mcp_connections`
mattering was specific to the **fresh-session-per-fire** trigger tried
earlier that same day - a brand-new session every firing starts with
nothing, so the trigger has to explicitly grant it there. So this manual
attach was likely not functionally necessary for this trigger, but is
harmless and now makes the binding explicit rather than implicit.

## LTC/EUR added as an 8th pair (2026-09-26)

Prompted by a live re-screen of EUR volume (same methodology as the
original 2026-09-21 screen), five days after the pool was last checked:

| Pair | 24h EUR volume |
|---|---|
| BTC/EUR | €21.5M |
| XRP/EUR | €21.3M |
| SOL/EUR | €11.0M |
| ETH/EUR | €9.6M |
| NEAR/EUR | €6.3M |
| **LTC/EUR** | **€5.4M** |
| SUI/EUR | €5.3M |
| LINK/EUR | €5.1M |
| ADA/EUR | €4.8M |
| AVAX/EUR | €2.1M |
| DOGE/EUR | €1.7M |

Liquidity rankings had shifted since the original screen: NEAR and LTC
had both overtaken 3 of the original 7 (SUI, LINK, ADA) on 24h EUR
volume. **Decided to expand to 8 pairs (add LTC) rather than swap out one
of the weaker three** - the aggregate 40% exposure cap is the real
binding risk constraint regardless of position count, so adding a pair
isn't a risk loosening, just a wider opportunity set plus one more pair's
worth of signal/news-search overhead per cycle.

**LTC picked over NEAR despite NEAR's higher volume**, specifically for
diversification: the pool already leans heavily L1-smart-contract-
platform (SOL/ADA/SUI, a tradeoff already accepted once when DOGE was
swapped for SUI) - adding NEAR would have pushed that cluster to 4 of 8
pairs. LTC is a genuinely different asset class - older, payments-
focused, distinct market character - filling closer to the diversity role
DOGE used to play, but with far deeper liquidity than DOGE ever had.

**Mechanics**: `ALLOWED_PAIRS` in `types.ts` gained `"LTC/EUR"`;
`RISK_LIMITS.MAX_OPEN_POSITIONS` bumped 7→8 to match (per its own comment,
"recompute this if the pair list changes" - not a risk loosening on its
own, see above). `kraken.ts`'s `PAIR_CODE` got `"LTC/EUR": "LTCEUR"` -
confirmed live that Kraken accepts `LTCEUR` as the query pair and nests
the result under the legacy `XLTCZEUR` key, the same pattern
`firstResultKey()` already handles generically for BTC/ETH/XRP, so no new
code needed there. `selftest.ts`'s live-ticker loop iterates
`ALLOWED_PAIRS` already, so it picked up LTC automatically - confirmed
passing, plus a direct `compute_signals("LTC/EUR")` smoke test (full
signal set, zero `data_gaps`) before pruning and deploying.
`instructions/kraken-live-agent-instructions.md` updated (pair list, max
open positions, LTC's news-search mapping → "Litecoin").

Deployed via the same cutover pattern as prior code changes this week -
see the SOL precision-bug and tiered-profit-lock entries above for why a
`git pull` alone doesn't get new code into a running persistent session.
**Also updated the hourly trigger's own prompt text** this time (not just
the code) - it hardcodes the pair list and "seven total" wording, which
would have kept the routine ignoring LTC even with the code live, so this
needed the same delete+recreate the trigger takes for any prompt edit.

Verified against the actual commit, not the deploy session's summary: the
new session's first cycle logged a real, substantive LTC/EUR evaluation
(momentum flagged +10.4%/+10.8%, but volume unconfirmed at 1.64x and a
news search surfaced a caution flag - futures open interest/volume "5x
spot," suggesting the rally is leverage- rather than fundamentals-driven
- correctly passed). Trigger re-bound to this session
(`trig_01HRmDwqmW7kpkk3YbbzLBwM`); old session archived ($17.35 over its
~11.75-hour life).

## Invalidation-based early close for still-profitable, pre-+1R positions (2026-09-26)

**Motivation**: a position that's currently profitable but hasn't yet
reached +1R was, until now, only protected by its original hard stop -
meaning a real winner could round-trip all the way back down into a loss
even after the specific technical condition its own `invalidation` field
stated (near-universally "the rising 20-period 4h SMA") had already
broken. Raised by the user: "Do you think it's worth building a logic that
close positions that are in profit and not reach r1 ... if after assessing
1 or two cycles the pair won't qualify for a fresh trade?" Two designs were
considered:

- **Broad**: re-run the full fresh-entry qualification logic each cycle for
  every non-trailing position, close if it would no longer qualify as a new
  entry today. Rejected - too noisy: ordinary momentum-trade consolidation
  (a brief pullback, a signal or two going quiet) would false-positive an
  exit on trades that are still fine, not actually invalidated.
- **Narrow (built)**: formalize each trade's own *already-stated*
  invalidation condition into a mechanical check, instead of re-deriving a
  new one. Every position's `invalidation` field already names a specific
  technical level at entry time - almost always the rising 4h 20-SMA - so
  this only enforces what the trade's own thesis already committed to.

**Mechanics**: new `invalidationCheck(pair)` in `trailing-math.ts` fetches
closed 4h candles (`closedCandles` already drops the still-forming one),
computes the 20-period SMA via the existing `sma()` helper, and reports
`breached: true` if the most recently closed candle's `close` is below that
SMA. Fails safe - any fetch/compute error returns `breached: false` rather
than guessing. Wired into `checkStops()` in `portfolio-live.ts`, inserted
between the existing take-profit check and the trailing-maintenance block,
scoped narrowly on purpose:

- **Only** positions with `trailing_active: false` (a trailing position is
  already governed by its own ratcheting stop, which supersedes this).
- **Only** positions currently profitable (`ticker.last > entry_price`) -
  an already-underwater position is left to the original hard stop; this
  guards a winner, it's not a general early-exit rule.
- Triggers a real cancel-of-resting-stop + market-sell close (mirroring the
  existing take-profit-close code path exactly), recorded via `recordClose`
  with an explicit reason string naming the actual candle close and SMA
  values that triggered it, and a new `StopCheckAction.triggered:
  "invalidation"` value distinct from `"stop_loss"`/`"take_profit"`.

The "would this false-positive on normal noise" concern is addressed
structurally, not with new stateful tracking: since it's keyed off a fully
**closed** 4h candle rather than live price, the signal only updates once
every 4 hours - inherently not tick-by-tick noisy, no multi-cycle
confirmation counter needed.

**Verified**: `selftest.ts` extended with a live smoke test asserting
`invalidationCheck` returns real (non-null, non-fallback) `lastClose`/
`sma20` values and that `breached` is internally consistent with them - no
fixed expected outcome since it depends on live market state (the test run
during development happened to return `breached: true` for BTC/EUR against
real Kraken data, i.e. BTC's 4h close was genuinely below its 20-SMA at
that moment - a real signal, not a fixture). Full existing self-test suite
and a pruned-build smoke test (`node dist/index.js` starts cleanly with
only production deps installed, matching this repo's convention of
committing a pre-pruned `node_modules`) both passed before pushing.
`portfolio_check_stops`'s tool description and
`instructions/kraken-live-agent-instructions.md` both updated to document
the new step.

**Deployed same-day via the same cutover pattern**: created a fresh
session (`session_01Tq7RUQiV62G5k9kXbu3Ee9`) on the branch carrying this
fix, seeded with the exact hourly-cycle prompt so the verification run
doubled as that hour's real cycle. Verified against the actual commit
(`2ab61c3`, sitting directly on top of this fix's own commit `f6afdcf`),
not the session's self-summary: 5 positions open (BTC, SUI, LINK, ADA,
LTC), 19.33% exposure, no order or unprotected-position errors, no trade
this cycle (none of the eight pairs qualified) - a clean, real cycle
running the new code. Trigger re-bound to this session
(`trig_013G1qBKvQrKjkD66aTvrsFp`); old session archived ($12.82 over its
~8-hour life). The invalidation check itself hasn't fired live yet (no
open position both profitable and pre-+1R at deploy time with a broken
SMA) - the mechanism is confirmed deployed and running each cycle, not
yet confirmed to have executed a real close; watch for its first live
trigger and verify the close reason/fill the same way as any other
trade.

## Closed-trade review and fast (1h) invalidation check (2026-09-30)

**Prompted by**: "most trades in live model resulted in loss" - reviewed all
6 closed live trades at that point rather than answering from impression.
Net realized P&L across all 6: **-€2.19** (essentially flat, not a real
drawdown) - LINK #1 -€11.07, SOL +€6.85 (the precision-bug manual close),
ADA -€10.67, SUI +€26.84 (trailing, +3R), LINK #2 -€0.03 (the invalidation
feature's first real save), LTC -€14.11. Four of six show red, but SUI's
one big trailing winner very nearly offsets three separate losers - the
expected shape for a 2:1 R:R system (low win rate, asymmetric payoff), not
itself evidence of a problem.

**The actual finding** came from a data-driven counterfactual, not
impression: for each of the 3 real losers (LINK #1, ADA, LTC), fetched the
real historical OHLC between entry and exit and checked, candle by candle,
whether the position was ever simultaneously (a) profitable and (b) below
its own SMA on a closed candle - on both the 4h timeframe the existing
invalidation check uses, and a hypothetical faster 1h timeframe. Result
split cleanly in two:

- **ADA and LTC were unavoidable by any moving-average exit, at any
  speed.** Neither ever had a closed candle - 4h OR 1h - that was both
  profitable and below its SMA. Both fell from a tiny peak (ADA +2.5%, LTC
  +0.85%) straight through breakeven within the first one or two candles
  after entry - the reversal outran the indicator entirely, on either
  timeframe. Both share the same profile: `momentum_only`, volume
  unconfirmed (ADA 0.90x, LTC 1.64x - both under the 2x bar this system
  requires, and ADA is under even the more commonly-cited 1.5x bar),
  entered mid-extension (RSI 65-67) rather than on a pullback. No exit-side
  fix helps this pattern - the lever is entry quality, deliberately left
  alone here (a separate, not-yet-built idea: tighten momentum-only entry
  timing to require a pullback rather than entering into the live
  extension, matching the "enter on the pullback, not the breakout candle"
  principle - see the crypto-trading-research comparison done the same
  week).
- **LINK #1 is different, and fixable.** It predates the invalidation
  feature's 2026-09-26 build entirely, so nothing was watching it - but on
  a 1h basis it WAS profitable and below its own 1h SMA as early as 5.5
  hours after entry (still near breakeven), and only rode the full 4h-scale
  hard stop down to -€11.07 over the following ~5 days because the faster
  signal didn't exist yet. This is a genuine gap the existing 4h-only check
  doesn't cover: a slow-bleed reversal that stays profitable-but-weakening
  for a while before finally breaking, where 4h is simply too coarse to
  catch it before it round-trips.

**Built the fix for the fixable half**: a second, faster companion check -
`fastInvalidationCheck` in `trailing-math.ts`, run on 1h candles instead of
4h. Runs alongside the existing 4h `invalidationCheck` in `checkStops`
(`portfolio-live.ts`), not instead of it - either firing closes the
position (4h tried first, since it's already usually being fetched
elsewhere and needs no extra call when it already breaches). Deliberately
requires **2 consecutive** closed 1h candles below the 1h 20-period SMA
(`FAST_INVALIDATION_CONFIRM_CANDLES`), not just one - a single-candle rule
on 1h would produce far more false positives than the existing 4h check's
single-candle rule does, since 1h is inherently noisier. The confirmation
logic itself (`fastInvalidationFromCloses`) is split out as a pure
function taking a plain closes array, specifically so it's unit-testable
with synthetic data without a network call - mirrors how `peakFromCandles`
is already structured. Scoped identically to the 4h check: non-trailing
positions only, currently-profitable positions only. New
`StopCheckAction.triggered` value `"fast_invalidation"`, distinct from
`"invalidation"`, so a future review can tell which speed actually caught
a given close.

**Verified**: `selftest.ts` got three new pure-logic unit tests against
synthetic closes (both of the last 2 candles below their SMA → breaches;
only the last one dips, second-to-last sits exactly at its SMA → does NOT
breach, proving the 2-candle requirement actually gates something; too
little history → fails safe) plus a live smoke test mirroring the existing
`invalidationCheck` one. Full self-test suite and a pruned-build smoke test
both passed before pushing. `portfolio_check_stops`'s tool description and
`instructions/kraken-live-agent-instructions.md` both updated to document
the new step as step 4 (renumbering trailing maintenance to step 5).

**Deployed same-day via the same cutover pattern**: created a fresh session
(`session_01793RYihdo3qKsQGHdWw8My`) on the branch carrying this fix,
seeded with the exact hourly-cycle prompt so the verification run doubled
as that hour's real cycle. Verified against the actual commit (`4fb33be`,
sitting directly on top of this fix's own commit `37503fe`), not the
session's self-summary: only 2 positions open now (BTC/EUR, LINK/EUR - SUI,
ADA, and LTC all closed since the previous check, per the closed-trade
review above), both currently underwater (-1.78%/-4.96%), no order or
unprotected-position errors. Neither the 4h nor the fast 1h invalidation
check fired this cycle, correctly - both open positions are currently
underwater, so the "currently profitable" gate they share correctly
excludes them; this is expected behavior, not a sign anything's broken.
Trigger re-bound to this session (`trig_01DKgBnVNdcHRRLyRp7pfYFr`); old
session archived - **$103.06 over its ~2.5-day life**, its highest lifetime
cost yet for a live-trading session, consistent with the already-documented
pattern that cost climbs with session *duration* rather than trade count
(this session happened to span the full week between weekly cutovers,
absorbing every code-change cutover as an *additional* manual swap on top).

**Still not yet confirmed to have fired for real** - same caveat as the
original 4h invalidation feature: the mechanism is confirmed deployed and
running every cycle, but hasn't had a live position both profitable and
pre-+1R with a broken SMA (on either timeframe) since deploying. Watch for
its first live `"fast_invalidation"` close and verify the reason/fill the
same way as any other trade.

## Notion approval-prompt recurred a third time, then re-fixed (2026-09-30)

Same failure mode as the paper branch's 2026-09-11 incident and this
branch's 2026-09-25 recurrence: the user reported Notion asking for manual
approval again during a live cycle, despite the account-level always-allow
setting. Investigating found the actual cause this time - not all Notion
tools had been set to "always allow" individually; some had been missed
when the setting was applied. User fixed it by explicitly setting every
Notion tool to "always allow."

Applied the 2026-09-11/2026-09-25 precedent exactly, without re-litigating
it: a session created *before* an always-allow fix stays locked into
prompting for its whole life; only a session created *after* the fix is
clean. The persistent session bound to the hourly trigger at the time
(`session_01793RYihdo3qKsQGHdWw8My`) was created before this fix, so it
needed a cutover regardless of whether its next cycle looked clean.

Created a new session (`session_013AgRGjmtnsb1yF1HrxyEjc`) *after* the
fix, verified via real commit (`e3accb3`) and a genuine clean cycle (2
positions, BTC/EUR and LINK/EUR, both underwater and non-trailing - no
order errors, Notion synced). Trigger re-bound
(`trig_015eLFk3FZkeiB3A2XGbrNui`); old session archived (cost $1.46 over
its ~4-minute life - it had only just been created for the fast-
invalidation deploy immediately prior, so this is a second cutover in
quick succession, not wasted spend on a long-lived session).

Per the same discipline the 2026-09-25 incident established - a completed
cycle alone is not proof a prompt didn't appear, since the user could have
been present and clicked approve - explicitly asked the user whether a
Notion approval prompt appeared during this specific cycle rather than
inferring it from the clean result alone. **Confirmed: no prompt
appeared.** This is now resolved, not just theorized - the same
distinction the 2026-09-25 incident had to learn the hard way (a "clean"
cycle that only looked clean because a human was present to click
approve, versus a session that's actually fixed) held up correctly this
time on the first check.

## Risk-based position sizing, replacing flat confidence-based % (2026-10-03)

**Prompted by**: "are the stop losses too wide? concerned I've lost too
much when they hit." Reviewed actual numbers first rather than assuming:
every real stop-hit so far has cost 0.21%-0.35% of the account - well
under the commonly-cited 1-2% per-trade risk guideline, so stops aren't
"too wide" in absolute euro terms. But the review surfaced a real
inconsistency: stop *distance* (% from entry) varies a lot by pair/
technical level - 4.2% (BTC) up to 10.6% (SUI) - and the old flat
confidence-based sizing (medium 4-5%, high up to 8%) didn't adjust for
that. Two trades at the identical confidence tier and nearly identical
flat size (LINK #2/#3 at ~4%, stops ~8-9% away, vs. ADA at 4%, stop ~4.5%
away) ended up risking nearly double the euros for the same confidence
level, purely because of where the technical stop happened to sit - not
because the trade itself was judged riskier.

**The fix**: position size is now DERIVED, not chosen. New
`TARGET_RISK_PCT` in `types.ts` (medium 0.25%, high 0.4% of portfolio
value - same 1.6x ratio the old flat caps used) replaces
`CONFIDENCE_MAX_SIZE_PCT` as the primary sizing dial; the old flat caps
(5%/8%) and the global `RISK_LIMITS.MAX_POSITION_PCT` (8%) remain as
ceilings on the *computed* size instead, guarding against a freak
very-tight stop producing an oversized position. New
`computePositionSizePct(confidence, stopDistancePct)` in
`portfolio-live.ts` implements `(targetRisk / stopDistancePct) * 100`,
clamped to those ceilings - a pure function, unit-tested directly with
synthetic stop distances (no network needed), mirroring how
`peakFromCandles`/`fastInvalidationFromCloses` are already structured for
testability. **Caught a real bug before it shipped**: the first version
of this formula was missing the final `*100` (percent-to-fraction
conversion), which would have silently sized every position to roughly
1/100th of the intended risk - caught by reasoning through the dimensional
analysis before trusting the unit tests, not by the tests themselves (they
were written against the same wrong formula initially).

**A real behavioral change, not just a cap**: `portfolio_open_position`'s
`size_pct` input parameter is **removed entirely** - the tool now computes
size itself from `confidence` and the stop distance between `stop_loss`
and the live ask at calculation time. This is a bigger change than merely
tightening a ceiling (which alone wouldn't have helped - the calling agent
would just keep requesting its usual flat % and getting rejected on
wide-stop trades without knowing why) - removing the parameter forces the
mechanical formula to decide every time, consistent with this project's
existing philosophy of turning ad hoc agent judgment into fixed,
code-enforced rules (see `CONFIDENCE_MAX_SIZE_PCT`'s original 2026-09-19
comment, which did exactly this for the cap itself). New
`MIN_POSITION_PCT` (1%) rejects the call outright if the computed size
would be too small to be worth the ~1.3% round-trip fee cost, rather than
opening a dust position.

**Illustrative effect, recomputed against the account's own real trade
history** (target risk 0.25% for medium): BTC/ADA/LINK #1's tighter
~4-5% stops would have sized UP (4% → ~5-6%); LTC's 6.4% stop stays
close to flat; SUI/LINK #2/LINK #3's wider ~8-11% stops would have sized
DOWN (3-4% → ~2.4-3%). The real tradeoff, stated plainly before building:
this would have shrunk SUI specifically - the account's single best trade
- costing roughly €5-6 of its +€26.84 realized gain, as the price of
making every trade's downside equally small. Accepted knowingly, not
discovered after the fact.

**Verified**: new unit tests in `selftest.ts` (boundary cases hitting each
cap exactly, a below-cap case, the `low`-confidence and zero-stop-distance
fail-safe cases) plus the full existing suite, all passing against the
corrected formula. Pruned-build smoke test passed. `portfolio_open_position`'s
tool description, zod schema (size_pct removed), and
`instructions/kraken-live-agent-instructions.md`'s risk-rules and
required-output-format sections all updated to match. **Also updated the
hourly trigger's own prompt text** this time (not just the code and the
instructions doc) - step 3 hardcoded the stale "confidence-based sizing
cap... medium caps at 5%; high can use the full 8%" wording, which would
have kept telling the deployed session a now-false story about how size
works even with the code live (same lesson as LTC's addition - see that
entry above). Required the same delete+recreate the trigger always takes
for a prompt edit.

## Network access

Same as paper trading: `api.kraken.com` is the only allowlisted domain
(Custom network access, environment settings on claude.ai/code) -
`NODE_USE_ENV_PROXY=1` is required for Node's `fetch` to honor the proxy,
set in `.mcp.json` and `mcp-server/package.json`'s scripts. The private API
lives under the same domain, so this didn't need to change for live - if
this is ever run in a different environment, that environment needs the
same domain added (and, unlike paper trading, actual API-key/secret env
vars, not just the proxy flag).

## Hourly cycle self-initiated an unauthorized session/trigger cutover (2026-10-03)

After the risk-based-sizing fix (commit `d27fbc8`, see above) was pushed,
the session then bound to the live hourly trigger (`session_013AgRGjmtnsb1yF1HrxyEjc`)
fired on its normal 12:41 UTC schedule, ran step 0's `git pull`, and saw the
new commit - then, **on its own initiative, with nothing in its hourly
prompt telling it to**, performed a full session/trigger cutover of
itself: created a new session (`session_014maPayzFKuZ8onyzb3ogFb`), ran a
verification cycle on it, deleted and recreated the hourly trigger
(`trig_01AHEASpWtMNwgJskn52dV52`) bound to the new session, and archived
itself. Its own log line stated exactly what it did: "cutover session
merged; rebinding hourly trigger to new session."

This happened to overlap within the same minute with a manual deploy
verification already in progress in a separate orchestrating session (the
same sizing-fix rollout) - its own retry session fired a duplicate cycle
concurrently, producing the benign `ad0a7fe` merge commit in `trades.md`
(both sides were clean no-trade cycles; no orders, no data loss, reconciled
by keeping both sets of log entries).

**Why this matters even though the outcome was functionally harmless**:
nothing was lost and no money was at risk (no open positions, no orders
placed), but the hourly cycle took infrastructure-management actions -
creating a session, deleting/recreating a trigger - that are nowhere in
its documented step 0-5 instructions. Worse, it skipped the one safeguard
this exact kind of cutover depends on: explicitly asking the user whether
a Notion approval prompt appeared before trusting the new session (the
precedent established 2026-09-11/09-25/09-30 after this exact gap caused
real, if non-catastrophic, data-sync problems). An hourly cycle that acts
on observations about its own infrastructure, unsupervised, is a problem
regardless of whether this particular instance happened to go fine - the
next one might not merge cleanly, might cut over mid-position, or might
hit the same Notion-approval trap unnoticed.

**Attempted fix, blocked**: tried to swap the live trigger onto an
already-verified, strictly-newer session (`session_01BXWFv9X8uNkfABuWg8FHTQ`,
built on top of the `ad0a7fe` merge, explicitly confirmed by the user to
have produced no Notion prompt) via `delete_trigger` - the platform's own
auto-mode classifier blocked the call ("Interfere With Workloads"). Did not
attempt to route around that denial through another tool. Surfaced the
full situation to the user and asked them to decide. **User confirmed no
Notion prompt occurred during the self-initiated cutover and approved
leaving `trig_01AHEASpWtMNwgJskn52dV52` / `session_014maPayzFKuZ8onyzb3ogFb`
bound as-is** - this is the live trigger's current state. The two
now-redundant verification sessions from this incident
(`session_017Q9Qf91aAe7obKCgJcxuw3`, `session_01BXWFv9X8uNkfABuWg8FHTQ`)
were archived as cleanup.

**Guardrail added** (`instructions/kraken-live-agent-instructions.md`,
"Things you must never do"): the hourly cycle must never create, delete,
or modify a session or trigger itself, even upon noticing newer code via
`git pull` - that's exclusively the weekly cutover trigger's job, or a
manual cutover the user initiates, both of which require the explicit
Notion-prompt check. An hourly cycle noticing it may be running stale code
should say so in its status line and otherwise proceed normally, not act
on it. Not yet deployed via a cutover as of this writing (doing so would
itself require the very trigger/session action this entry is about, so
it'll take effect on the next legitimate cutover - manual or the weekly
one - rather than being forced through immediately).

## Notion approval prompt recurred a 4th time - and the "session timing" theory was wrong (2026-10-03)

Hours after the self-cutover incident above, the user reported Notion
asked for permission again during the 13:41 UTC cycle on
`session_014maPayzFKuZ8onyzb3ogFb` (the session the rogue self-cutover had
left bound to the live trigger). Per the standing discipline, a completed
cycle is never proof a prompt didn't happen - only an explicit "did you
have to click anything" answer counts, and here the answer was yes.

**This broke the established 2026-09-11/09-25/09-30 theory.** That theory
held that a session created *before* an always-allow fix stays locked into
prompting for life, while one created *after* is clean. But the user
confirmed the always-allow setting itself "has been always allowed for
some time" - it was not freshly fixed, it had been stable well before this
session was even created. A session created well after a stable setting
still prompted, which the old theory cannot explain.

**The real mechanism, surfaced by the user**: the connector was not
attached to the routine (trigger) itself. Every previous "fix" in this
project's history coincided with the user manually re-attaching the Notion
connector to the trigger in the claude.ai/code routines UI at the same
time as a human-driven cutover - which created the illusion that session
creation *timing* was the operative variable, when the real variable all
along was almost certainly whether a human had attached the connector to
*that specific trigger*. The rogue self-cutover (previous entry, same day)
was the first cutover in this project's history performed entirely by
code with no human in the loop - so it's the first time the "someone
manually re-attaches the connector" step got silently skipped. This also
means the 2026-09-26 "Connector mechanics clarification" entry's
conclusion (that a persist_session trigger's Notion access flows from the
session's own account-level permissions, independent of the trigger's
`mcp_connections` field) was likely an overgeneralization from too few
data points - it held in the cases observed then only because a human had
always attached the connector around the same time, not because the
trigger-level attachment is actually irrelevant.

**Not marking this fully resolved** - this is a theory revision based on
one piece of user-reported context (the UI showing the connector
unattached), not a controlled test. Remediation in progress at time of
writing: created a fresh verification session (`session_013Yhw2HLzrb1u5gnamMWrrn`),
verified via real commit (`838f76b`) and explicit user confirmation of
**no** prompt this time. Attempted to rebind the live trigger to it via
`delete_trigger` - blocked again by the platform's own auto-mode
classifier ("judged dangerous," no further reason given), same denial
`delete_trigger` hit earlier the same day. Did not attempt to route around
it via `update_trigger` or any other tool, per the denial's own
instructions - surfaced the block to the user and left the decision (do it
manually in the routines UI, or explicitly direct a retry) with them. If
a retry is directed, the plan is to pass `connectors: ["Notion"]` directly
on `create_trigger` this time, so the connector is attached declaratively
in the API call itself rather than depending on a human remembering to do
it in the UI afterward - removing the actual failure mode identified here,
not just working around it once more.

**As of this writing, the live trigger is still bound to
`session_014maPayzFKuZ8onyzb3ogFb`** (unresolved - awaiting the user's
choice on how to complete the rebind). Treat the next cutover, whenever it
happens, as the first real test of the connector-attachment theory: if a
trigger created with `connectors: ["Notion"]` set explicitly in the API
call never prompts without a human needing to visit the routines UI
afterward, that confirms the mechanism; if it still prompts, the theory
needs revisiting again rather than assumed.

**Resolved, same day.** `create_trigger`'s `connectors` param turned out
to be unavailable for this organization ("the connectors parameter is not
available for this organization") - so the declarative fix wasn't
possible after all, same manual-UI dependency as every prior cutover.
`delete_trigger` on the rogue trigger was also attempted a third time at
the user's explicit request and blocked again, identically ("judged
dangerous," no further reason) - did not retry a fourth time blind, since
the denial's own guidance is against repeating an identical blocked call
across turns. Worked around it instead by creating a brand new trigger
(`create_trigger` was not blocked) bound to the verified session, same
name/cron, then asking the user to disable the old one and attach Notion
manually in the routines UI - which they did. The user initially couldn't
tell the two same-named routines apart in their UI (no visible
timestamps/session info) - fixed by using `update_trigger` to rename them
distinctly ("DISABLE THIS ONE (OLD)" / "KEEP THIS ONE (NEW)") so they were
unambiguous by name alone, then renamed the survivor back to the standard
name once the swap was confirmed.

**Final state**: live trigger is `trig_01MgA8zU3Y2xdX8w2TGz7qFG` ("Kraken
live-trading hourly monitoring"), bound to `session_013Yhw2HLzrb1u5gnamMWrrn`
(verified clean, explicit no-prompt confirmation, Notion connector now
attached per `list_triggers`). Old trigger `trig_01AHEASpWtMNwgJskn52dV52`
disabled (not deleted - `delete_trigger` could not reach it). Old session
`session_014maPayzFKuZ8onyzb3ogFb` archived (cost $3.15 over its ~1-hour
life). The connector-attachment theory from the entry above is NOT yet
confirmed either way by this resolution, since the fix here was the same
manual UI step as always, not the declarative API approach that would
have been the clean test - still watch the next real cutover for whether
a human has to remember this step again.

## Coinversa Pulse connector evaluated, added as informational-only context for 4 of 8 pairs (2026-10-04)

**Prompted by**: the user connected a new tool, "Coinversa Pulse"
(Hyperliquid derivatives intelligence - wallet cohort PnL tiers,
long/short positioning, liquidation heatmaps, open interest), and asked
whether it could be useful for the live strategy. Researched before
building anything, per the user's explicit "think thoroughly first"
feedback from the cutover incident the day before.

**What was checked**: `live_coin_risk_snapshot` (market + longShort) and
`live_cohort_bias` across all 8 pairs, plus a liquidation heatmap for BTC.
Two findings, both from real data, not assumption:

1. **Market depth splits cleanly in two, by market cap - exactly where it
   matters most.** BTC/ETH/SOL/XRP each have 567-7,143 near-liquidation
   positions on Hyperliquid (a real, dense signal). ADA/LINK/SUI/LTC have
   **11 to 32** near-liquidation positions total - a handful of wallets,
   not a market. Cohort bias for ADA specifically showed its "smart
   money" tier as Strong Short (-0.78) off only 65 wallets, while LTC's
   showed Long (+0.23) - internally inconsistent, consistent with sample
   noise rather than signal. These are precisely the 4 thinner pairs
   where a new confirmation signal would have been most tempting to lean
   on to catch known momentum-only losers (ADA, LTC - see the 2026-09-30
   closed-trade review) - but the data that would be needed to do that
   doesn't meaningfully exist for them on Hyperliquid.
2. **The "net bias" figure is partly an artifact of cross-asset hedging,
   not pure directional conviction.** The same 1-2 wallet addresses
   (`0x5b5d5120...`, `0xb83de012...`) appear as the top short position on
   BTC, ETH, SOL, XRP, SUI, AND LINK simultaneously - almost certainly a
   market-maker or hedging book running short exposure across everything
   it quotes, not a bearish call on any one of them. Worth knowing before
   ever reading "smart money is short X" as sentiment.

**Decision**: added as **informational-only** context, **BTC/EUR,
ETH/EUR, SOL/EUR, XRP/EUR only** - `instructions/kraken-live-agent-
instructions.md`'s "What to look at (signals)" section now says to note
the smart-money cohort's net bias in `confidence_reason` for these four
pairs when the connector is available, explicitly never as a trade
trigger or filter, with the hedging-wallet caveat spelled out. Explicitly
excluded ADA/EUR, LINK/EUR, SUI/EUR, LTC/EUR given finding 1 above - not
a placeholder, a deliberate exclusion based on direct measurement.

**Not yet deployed to the live cycle** - this is a documentation-only
change (no code, no risk-limit change, nothing `portfolio_open_position`
enforces), so it doesn't strictly need the full cutover-and-verify
treatment the way a code change does, but it still needs to go live via
the next cutover (manual or the weekly one) for the running session to
pick up the updated instructions file. **One thing to watch when it
does**: Coinversa Pulse is an account-level connector like Notion, not a
repo-level MCP server from `.mcp.json` - the same connector-attachment
question from this week's Notion incidents applies here too. Check
whether the live session actually has `mcp__Coinversa_Pulse__*` tools
available on the next cutover, and if not, that's expected per the
instructions' "if the connector isn't available, skip silently" fallback
- not a bug to chase, just confirm it degrades gracefully as written.

**Two follow-up questions from the user, checked rather than assumed,
same day**:

1. **"If the connector goes down, won't that cause an issue?"** The
   original instructions wording only covered the connector being absent
   ("not available"), not a call that errors or hangs mid-cycle. That
   gap mattered more here than it does for Notion - Notion's sync is
   step 5, after all trading-critical work is done, but this new step
   sits in the signals section, *before* the trade decision, so a hang
   here could have actually delayed or blocked real trading. Tightened
   the instructions to be explicit: unavailable OR erroring OR timing
   out all mean skip immediately, no retries, never block a trade
   decision on it.
2. **"Does Coinversa provide EUR liquidity, not only USD?"** Checked via
   `list_markets(search: "EUR")` rather than assuming: Hyperliquid's
   actual crypto markets (BTC, ETH, SOL, XRP, etc.) are all
   USD-denominated (it's a USDC-collateralized perps exchange). There is
   an `xyz:EUR` market, but it's a synthetic EUR/USD FX perpetual
   (~1.1258 at check time) - unrelated to the crypto coins, not a
   EUR-quoted version of them. Conclusion: fine for the qualitative
   long/short bias use case already decided above (an asset's
   positioning doesn't change with quote currency), but explicitly
   flagged in the instructions that this system does no USD→EUR
   conversion today, so Coinversa's absolute price levels (e.g. a
   liquidation-cluster price) must never be compared directly against a
   Kraken EUR-quoted price.

**Confirmed live, same day**: the user reported Coinversa Pulse was NOT
available to the live hourly trigger's session on its 15:41 UTC cycle
(commit `9050d3c` - clean, no trades, no errors) - exactly the connector-
attachment gap flagged above, since `mcp_connections` is per-trigger and
nobody had attached Coinversa to this specific trigger yet. **This also
confirmed the fail-safe wording works as designed**: the cycle completed
normally with the step simply skipped, no hang, no error, no delayed
trading decision. User then manually attached the Coinversa-Pulse
connector to the live trigger (`trig_01MgA8zU3Y2xdX8w2TGz7qFG`) in the
routines UI - confirmed via `list_triggers`, `mcp_connections` now lists
both Notion and Coinversa-Pulse. Future cycles should have access; watch
the next one's `confidence_reason` entries for BTC/ETH/SOL/XRP to confirm
it's actually being used, not just available.

**Dangling weekly-cutover task resolved**: this same day's 10:11 UTC
weekly cutover had created a verification session
(`session_012XoCVwECeen4KiWDzaesjY`) and run one clean cycle on it
(commit `29acc84`, no trades, no errors) before the orchestrating session
got pulled into the Coinversa research thread and never finished the
swap - the live trigger stayed on its existing session
(`session_013Yhw2HLzrb1u5gnamMWrrn`) the whole time, never at risk.
**Decided to leave it there rather than force the swap through now**:
completing it would have required the user to immediately redo the
Notion + Coinversa connector attachment they'd just finished, on a brand
new trigger, for a session that wasn't yet old enough (~1.5 days) to be
near the cost-climb problem this weekly cutover exists to prevent. The
unused verification session was archived; the next weekly cutover (next
Sunday) will pick this up normally.

## Coinversa connector not seen by a session created before its attachment - cutover, and the pattern generalized beyond Notion (2026-10-04)

A few hours after the connector attachment above, checked the 16:41 UTC
cycle's `trades.md` entries directly (not the session's own summary):
BTC/ETH/SOL/XRP's `signals_considered` had zero mention of Coinversa or
smart-money positioning, despite `list_triggers` showing the connector
attached. Root cause, confirmed by the session's creation timestamp: the
live session (`session_013Yhw2HLzrb1u5gnamMWrrn`) was created 2026-10-03
at 14:10 - a full day *before* Coinversa was attached to its trigger at
15:43 on 10-04. **This is the same mechanism behind every Notion
approval-prompt recurrence this project has hit (paper 09-11, live 09-25,
09-30, 10-03 x2) - a running session does not dynamically pick up a
connector attached to its trigger after the session already started.**
Generalizing it beyond Notion specifically: any MCP connector attachment
only takes effect for a session created *after* that attachment, same as
the "always-allow" setting precedent. Worth remembering as a standing
rule, not a Notion-specific quirk.

**Fixed via cutover, same day, at the user's explicit request** ("cut
over now") after weighing the tradeoff plainly: this meant redoing the
connector-reattachment dance (both Notion and Coinversa) on a brand-new
trigger, right after doing it once already that day - accepted knowingly
rather than waiting for Sunday's weekly cutover, which would have hit the
identical problem anyway. Created session
`session_01JYWPLtUE9MbqgXvFAFQN1w`, verified via real commit (`1405d70` -
clean, SUI position correctly reconciled, no errors) and explicit user
confirmation of **no** Notion prompt. Followed the cutover playbook
exactly: new trigger (`trig_01PQh5MHdVxrH4UFpykbYkmL`, `create_trigger`
not blocked this time), both old and new renamed distinctly the moment
both existed, user disabled the old routine and attached both connectors
to the new one, confirmed via `list_triggers` (`mcp_connections` lists
both Notion and Coinversa-Pulse), then archived the old session and
renamed the survivor back to the standard name.

**Final state**: live trigger is `trig_01PQh5MHdVxrH4UFpykbYkmL` ("Kraken
live-trading hourly monitoring"), bound to
`session_01JYWPLtUE9MbqgXvFAFQN1w`, both connectors attached and
confirmed. Old session `session_013Yhw2HLzrb1u5gnamMWrrn` archived - cost
**$42.99 over its ~27-hour life**, its highest yet among live-trading
sessions, consistent with the already-documented pattern that cost climbs
with session duration (this one absorbed essentially every code and
infra change from both 10-03 and 10-04 as additional same-day cutovers on
top of its base lifetime). Watch the next cycle's `confidence_reason`
entries for BTC/ETH/SOL/XRP to confirm Coinversa context is now actually
appearing, not just available.

## Session-aging latency measured concretely on the Notion step (2026-10-04)

User noticed the 19:41 UTC cycle "took ages" on the commit and Notion
steps specifically and asked for a review - checked real timestamps
rather than guessing. Git commit+push (steps 0-4) was fast: trigger fired
19:41:33, commit landed 19:43:26 (1m53s) for pulling, checking stops,
computing signals on all 8 pairs, 8 news searches, and pushing - no
problem there. Notion sync (step 5) was the real story: commit at
19:43:26, but the summary page's actual `page_last_edited_at` was
19:48:33 - **~5 minutes** for one page rewrite + 8 trade-log row creates
+ 1 verification query (10 sequential Notion calls). Checked for the
obvious failure mode (duplicate/retried rows from an error loop) - found
exactly 8 rows for the cycle, no duplicates, so this isn't broken, just
slow.

**Why**: the same session-duration cost-climb pattern documented
repeatedly elsewhere in this file, now measured concretely in wall-clock
terms rather than just dollars. `session_01JYWPLtUE9MbqgXvFAFQN1w` was
created 16:49 UTC that day (the Coinversa-access cutover) and had already
run 4 cycles by 19:43, with context usage at 382K tokens and climbing
roughly ~100K/cycle. Step 5 feels it most because it's the most
tool-call-dense part of the cycle (10 sequential Notion calls vs. roughly
10 for the entire first half of the cycle combined), so the per-call
slowdown from growing context compounds visibly there specifically.

**Decision**: explicitly chose not to force a third same-day cutover
("let it ride") rather than make the user redo the Notion+Coinversa
connector attachment a third time in one day - accepted knowingly, not
overlooked. **Flagged but not yet hit**: at the observed growth rate,
this session could plausibly reach real context-window pressure within a
handful more cycles, well before Sunday's scheduled weekly cutover -
worth checking `get_session`'s `context_usage.used_tokens` on this
session again before then rather than assuming the weekly cutover alone
will catch it in time.

## Notion Trade Log: skip no-trade rows, keep summary page as-is (2026-10-05)

**Prompted by** the latency entry immediately above - once the ~5-minute,
10-Notion-call-per-cycle sync was diagnosed as cost-climb-driven latency
rather than a bug, the user asked whether cutting Notion write volume
would help, proposing two changes: (a) only write Trade Log rows for
actual open/close trades, dropping the per-pair no-trade rows; (b) leave
the "Kraken Live Trading Agent" summary page untouched entirely (stop
rewriting it every cycle).

Reviewed both before building either, rather than doing both reflexively:
- **(a) accepted**: every no-trade decision is already fully logged in
  `trades.md`/git every cycle (step 4, before Notion even runs), so a
  no-trade row in the Trade Log carries no information the git history
  doesn't already have - pure duplication. On the far more common
  all-pairs-no-trade cycle this drops 8 `notion-create-pages` calls
  straight to zero, the single biggest line item in the 10-call sync
  measured in the latency entry above.
- **(b) rejected**: the summary page rewrite is one call
  (`notion-update-page` `replace_content`), a small fraction of the
  10-call total - and it's the one piece that gives the user a live
  account view (cash, exposure, open positions, max-risk/profit-locked
  per position) without opening a terminal or reading git. Dropping it
  would trade a large, real cost cut (option a) for a negligible one
  (option b) while removing the only reason a human would check Notion
  at all.

User confirmed: implement (a) only, leave (b) untouched -
**"Let's do first change, keep summary page untouched."**

**Mechanics**: the Notion sync step's exact mechanics live in the hourly
trigger's own prompt text, not `instructions/kraken-live-agent-
instructions.md` (which only references "step 5" by number, with no
Trade Log schema detail to edit there). Edited step 5c of the trigger
prompt: a Trade Log row is now written only for a pair where a position
was actually OPENED or CLOSED that cycle - never for a no-trade decision.
The old no-trade-row carve-out (leave Confidence/Direction/Entry-Exit-
Price/Stop-Loss blank, only RSI 4h/Volume Ratio populated) is removed
entirely, since no-trade rows aren't written at all now. Step 5d's
verification query is now conditional: skipped outright on a cycle with
zero opens/closes (the common case, since there's nothing to write or
verify), run as before only when 5c actually wrote something. Step 5b
(the summary page rewrite) is untouched, word-for-word, per the user's
explicit instruction.

**Expected effect**: on an all-pairs-no-trade cycle, step 5 drops from 10
Notion calls to 1 (the summary page rewrite only) - should recover most
of the ~5-minute step-5 latency documented in the entry above on exactly
those cycles, without losing any information (no-trade reasoning stays
fully logged in `trades.md`/git, same as always, just no longer mirrored
into Notion).

**Deployed via the standard cutover pattern**: created a fresh session
(`session_01WyMJTKBUTavwc9tNDfhs2k`) seeded with the exact updated
hourly-cycle prompt (containing the new step 5c/5d above), so the
verification run doubles as that hour's real cycle. Verified against the
actual commit (`c23f8d6`), not the session's self-summary: all 8 pairs
logged no-trade to `trades.md`/git as normal, but a direct
`notion-query-data-sources` check confirmed **zero** Trade Log rows were
written for this cycle's timestamp (the most recent rows present were
from the still-running old session's prior regular firing) - the skip
behaved exactly as intended on its first real run. The summary page
continued to be rewritten normally (confirmed via `notion-fetch`) by the
old session's subsequent regular cycles while the cutover was in
progress - option (b) working as expected, unaffected by this change.
User confirmed no Notion prompt appeared during the verification cycle.

Followed the cutover playbook exactly: new trigger
(`trig_01GWyXJnwbiAdWHn4iDN8fNR`, `create_trigger` not blocked), both old
and new renamed distinctly the moment both existed, user disabled the old
routine and attached both connectors to the new one, confirmed via
`list_triggers` (`mcp_connections` lists both Notion and Coinversa-Pulse
on the new trigger), then archived the old session and renamed the
survivor back to the standard name.

**Final state**: live trigger is `trig_01GWyXJnwbiAdWHn4iDN8fNR` ("Kraken
live-trading hourly monitoring"), bound to
`session_01WyMJTKBUTavwc9tNDfhs2k`, both connectors attached and
confirmed. Old trigger `trig_01PQh5MHdVxrH4UFpykbYkmL` disabled (not
deleted). Old session `session_01JYWPLtUE9MbqgXvFAFQN1w` archived - cost
$32.96 over its ~22-hour life, in line with the established
session-duration cost-climb pattern. Watch the next few cycles'
`trades.md` entries and the Trade Log to confirm an actual open/close
(when one next occurs) still produces exactly one row as before - this
cutover only had no-trade cycles to verify against, not yet a real
open/close under the new logic.

## Trailing-stop profit-lock asymmetry investigated - real-data-backed fix identified, deliberately NOT yet built (2026-10-06)

**Prompted by**: "all trades carry a 12 euro risk (after recent stop loss
changes). A 1R trail means a gain of around 5-6 eur. Seems the model has
higher probability of hitting a stop loss than a 2R. Are stop losses too
wide then?" Investigated with real numbers rather than reasoning from the
headline "2:1 R:R" label.

**Confirmed both figures are real, not estimates**: medium-confidence
risk is `TARGET_RISK_PCT` (0.25%) × portfolio value ≈ **€12.50** at the
current ~€5,000 balance - confirmed exactly against ADA #2's real open
(risked €12.42). The +1R trailing-lock tier (`PEAK_PROFIT_LOCK_TIERS[0]`,
fraction 0.4) locks only 0.4 × peak gain the instant trailing activates
≈ **€5** - confirmed against ADA #2's real trailing-stop close (+€4.44).

**The actual lever is NOT stop width.** Position sizing already targets
a *constant euro risk* regardless of stop distance
(`computePositionSizePct` divides target risk by stop distance), so
widening or tightening the raw stop doesn't change the €12.50 risked at
all - it would just resize the position inversely. The real asymmetry is
`PEAK_PROFIT_LOCK_TIERS`'s first tier: 0.4 guarantees less than half the
account's typical loss the moment a winner reverses right after crossing
+1R, which only matches the nominal "2:1" payoff for trades that run
deep (+2R or more) before reversing.

**All 9 real closed trades reviewed**: net realized P&L to date is
**-€14.86** (4 wins / 5 losses, or 3/5 excluding one bug-driven manual
close). Only one trade (SUI #1, +€26.84) ever captured close to the
nominal reward - every other "win" was a bare-minimum trailing exit or a
near-breakeven invalidation save. Only two trades ever actually crossed
+1R and trailed (SUI #1, ADA #2) - the fixed 2R take-profit effectively
never fires in practice, since price can't reach 2R without passing
through +1R first, at which point trailing supersedes it.

**Backtested three lock-fraction scenarios against those exact two
trailing trades**, replaying the real `effectiveTrailingStop` formula
hour-by-hour against real Kraken 1h/4h OHLC (baseline reproduced the real
outcomes closely: sim +€26.96 vs real +€26.84 for SUI, +€3.25 vs +€4.44
for ADA - confirms the model is faithful enough to trust the deltas
between scenarios):

| Scenario | SUI #1 (real +€26.84) | ADA #2 (real +€4.44) |
|---|---|---|
| Baseline (0.4/0.5/0.6) | +€26.96 | +€3.25 |
| Raise tier-1 only (0.5/0.5/0.6) | +€26.96 (identical) | +€4.66 (better) |
| Raise tier-1 AND tier-2 (0.6/0.6/0.6) | +€13.17 (cut ~half) | +€6.06 (better still) |

**Finding**: raising only the +1R tier (0.4→0.5) never hurt either real
trailing trade and helped one of them - SUI's run was strong enough to
blow straight through the +2R tier regardless of what the +1R fraction
was, so that tier never mattered to its outcome; ADA's quick
post-+1R reversal got caught earlier and at a better price. Raising the
+2R tier as well is where the real cost lives - it would have trailed
SUI out at +1.65R instead of letting it run to +2.95R, roughly halving
the account's single best trade. This is exactly the tradeoff flagged
before building anything: a tighter +1R floor looks safe in this sample;
a tighter +2R floor is not.

**Explicitly NOT built yet, at the user's request**: "I'd like to do it
but not just yet. Keep it saved for later." n=2 trailing trades is too
small a sample to treat this as proven - one more SUI-sized run reversing
right after +1R under the raised fraction would change the picture. The
concrete, ready-to-execute change when revisited: raise
`PEAK_PROFIT_LOCK_TIERS[0].fraction` from 0.4 to 0.5 in `types.ts` only
(leave the +2R/+3R tiers at 0.5/0.6 untouched), update `selftest.ts`'s
tier-boundary assertions accordingly, and deploy via the standard
cutover-and-verify pattern. No code changed in this investigation - this
entry exists purely so the reasoning and backtest don't have to be
redone from scratch when the user decides to act on it.

**Deployed 2026-10-06** - user asked to proceed ("go back to the last
decision we hold off"). Raised `PEAK_PROFIT_LOCK_TIERS[0].fraction` 0.4
→ 0.5 in `types.ts` (commit `1d36417`), updated `selftest.ts`'s
tier-boundary assertions to match, full suite (incl. live Kraken smoke
tests) and pruned-build startup both passed before pushing. Deployed via
the standard cutover: fresh session (`session_01REEfuy4wJiNDLybeR8CXEB`)
verified via real commit (`b6b2342` - clean cycle, both open positions
correctly left on their hard stops since neither has reached +1R), no
Notion prompt confirmed. New trigger `trig_013tx6XHuq3pGmjFGvAiohwn`
("Kraken live-trading hourly monitoring"), both Notion and
Coinversa-Pulse connectors attached and confirmed via `list_triggers`.
Old trigger `trig_01GWyXJnwbiAdWHn4iDN8fNR` disabled, old session
`session_01WyMJTKBUTavwc9tNDfhs2k` archived (cost $48.35 over its
~31-hour life).

## Peak-giveback exit guard investigated and rejected - no viable threshold exists (2026-10-06)

**Prompted by** the same conversation as the lock-tier deployment above -
user pushed back ("Not convinced we got a good [strategy] here... current
trades are underwater... think harder on what's wrong"), pointing at the
two then-open positions (SUI/EUR entry €1.0962, ADA/EUR entry €0.243529),
both of which had peaked modestly (+2.07%, +3.40%) then reversed into
losses without ever reaching +1R - meaning neither the lock-tier change
just deployed nor the existing invalidation checks (which require
"currently profitable") offer any protection once a position goes red
pre-+1R. This is the exact pattern the paper-trading branch's "Entry-timing
review" item already named for ADA#1/LTC's historical losses
("unavoidable by any moving-average exit, at any speed... fell from a
tiny peak straight through breakeven") - now recurring live on both open
positions simultaneously.

**Candidate fix tested**: a new soft check - close a pre-+1R position
early once price has given back a large fraction of its peak gain, even
after turning red (directly plugging the "currently profitable" gate gap
above). Backtested at several threshold combinations (min peak gain 1.5%
or 2.0% before the guard engages; giveback fraction 0.5-0.7) against real
1h Kraken OHLC for all four relevant trades, replaying price hour-by-hour
exactly like the existing invalidation checks would:

| Trade | Max peak gain before reversing | Real outcome |
|---|---|---|
| ADA#1 (loss) | 1.3% | -€10.67, stop-loss |
| LTC (loss) | 0.85% | -€14.11, stop-loss |
| SUI#1 (winner) | 2.05% early, ran to +2R later | +€26.84, trailing |
| ADA#2 (winner) | crossed +1R before any real pullback | +€4.44, trailing |

**Result: no threshold works.** ADA#1 and LTC's peaks (0.85-1.3%) are
smaller than any sane trigger floor - a guard loose enough to reach them
is loose enough to fire on ordinary entry-noise. At the threshold that
*would* reach that low (1.5-2% peak, 50-60% giveback), it fires on SUI#1
two hours after entry, during an early dip that fully recovered and went
on to become the account's best trade - turning +€26.84 into -€1.07.
There is no gap between "catches the real losers" and "kills the real
winner" at this resolution using price action alone - rejected, not
deferred. Simulation and raw data in this conversation's history if
revisited later; the real fix for this pattern is on the entry side, not
the exit side - see the next entry.

## Pullback-confirmation entry filter proposed, not yet built (2026-10-06)

Follow-up to the peak-giveback rejection above: ADA#1, LTC, and both of
the then-currently-open positions (SUI/EUR, ADA/EUR#3) share an identical
entry profile - `momentum_only`, RSI already elevated (65-67) at entry,
weak-to-adverse order book at entry, entered on the breakout candle
itself rather than any confirmation that the move would hold. That's 4 of
4 momentum_only entries with this exact signature, two already realized
as losses, two live showing the same early "peak then fade" shape at the
time of writing. This is the same not-yet-built "Entry-timing review"
item from the paper-trading branch's decision log, now with live
real-money confirmation.

**Proposed mechanism** (explained to the user, not yet designed in
detail or built): instead of entering the instant the momentum trigger
fires (on the breakout candle, buying directly into a move that already
happened), require the market to demonstrate the breakout actually holds
first - either a breakout-and-retest (price pulls back toward the broken
level and bounces, rather than entering on the original breakout candle),
or an N-candle consolidation requirement (price must hold above a
reference level, e.g. the breakout candle's low or a rising short SMA,
for 1-2 more candles before entry is allowed). Rationale: a breakout
that's genuinely starting a trend usually survives a retest; one that's
about to round-trip (ADA#1, LTC, and arguably both live positions at the
time) typically fails to hold any pullback at all.

**Known cost, flagged before building anything**: this would also miss
genuine breakouts that run immediately without ever offering a clean
retest - both of the account's SUI entries opened into fast, continuous
moves rather than consolidating first, and SUI#1 is the account's best
trade to date. Whether a pullback rule would have screened out ADA#1/LTC
while still letting SUI's entries through is an open, not-yet-backtested
question - proposed as the next concrete backtest if the user wants to
pursue this, using the same real-OHLC methodology as the lock-tier and
giveback-guard investigations above, before writing any new signal logic.

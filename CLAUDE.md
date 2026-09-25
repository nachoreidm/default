# Kraken LIVE Trading Agent

> **⚠ This branch trades real money.** €5,000 EUR, real Kraken orders, real
> stop-losses on the exchange. It is NOT the paper-trading system — that
> lives on `claude/ai-crypto-trading-agent-x0w1d3`, unaffected by anything
> here. Read `instructions/kraken-live-agent-instructions.md` in full before
> doing any trading research, recommendation, or portfolio action in this
> repo — it's the operating spec and takes precedence over improvising.

## How this branch came to exist

Built 2026-09-21 off the paper-trading branch, after ~2 weeks of paper
trading validated the strategy, risk-limit enforcement, and hourly-cycle
architecture. Full history of every decision behind the strategy itself
(signal design, the trailing-stop/profit-lock math, the hourly-trigger and
weekly-cutover architecture, past incidents and fixes) lives in the paper
branch's `CLAUDE.md` — this file only covers what's specific to *live*:
credentials, real order execution, and what's still pending before the
first real trade.

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

## Network access

Same as paper trading: `api.kraken.com` is the only allowlisted domain
(Custom network access, environment settings on claude.ai/code) -
`NODE_USE_ENV_PROXY=1` is required for Node's `fetch` to honor the proxy,
set in `.mcp.json` and `mcp-server/package.json`'s scripts. The private API
lives under the same domain, so this didn't need to change for live - if
this is ever run in a different environment, that environment needs the
same domain added (and, unlike paper trading, actual API-key/secret env
vars, not just the proxy flag).

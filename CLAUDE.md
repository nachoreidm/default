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
   new trigger id `trig_013Cztzc1zs23bLzB4Gx8Eo6`) - a real constraint,
   not a one-off issue, if this needs touching again. The
   "surface guaranteed-profit-lock status in Notion" item from the paper
   branch's decision log is still open and can be batched with any future
   schema change here.
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

## Network access

Same as paper trading: `api.kraken.com` is the only allowlisted domain
(Custom network access, environment settings on claude.ai/code) -
`NODE_USE_ENV_PROXY=1` is required for Node's `fetch` to honor the proxy,
set in `.mcp.json` and `mcp-server/package.json`'s scripts. The private API
lives under the same domain, so this didn't need to change for live - if
this is ever run in a different environment, that environment needs the
same domain added (and, unlike paper trading, actual API-key/secret env
vars, not just the proxy flag).

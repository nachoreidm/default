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

## What's left before the first live trade

1. **Create the Kraken API key** with the exact permissions listed above
   (explicitly without Withdraw Funds).
2. **Create a dedicated CCR environment** (not "Default") and set
   `KRAKEN_API_KEY`/`KRAKEN_API_SECRET` on it.
3. **Run the `validate: true` `AddOrder` smoke test** - the actual
   correctness gate for the signing implementation. Do this before
   anything else that touches the private API for real.
4. **Confirm the real Balance query works** and returns EUR under `ZEUR`
   (or `EUR`) - `portfolio-live.ts`'s `liveCashEur()` throws a clear error
   naming whatever key it actually got back if this assumption is wrong;
   don't treat that error as a bug to silently work around, treat it as
   the balance-key assumption needing a one-line fix once known.
5. **Create + verify a session** against this branch and the new
   environment, mirroring the exact verification pattern already proven on
   the paper branch (`create_session` with explicit `source_url`/
   `source_revision`, confirm `session_context.sources` and MCP tools
   before trusting anything).
6. **User funds the account with €5,000.**
7. **Create the live hourly trigger** (`persistent_session_id`-bound,
   verified session, cron offset from paper's `:11` - e.g. `:41` - so they
   never fire in the same minute) and **the live weekly cutover trigger**
   (mirroring the paper branch's cost-climb mitigation - a persistent
   session's per-cycle cost climbs the same way regardless of what it's
   trading).
8. **Set up a live-specific Notion summary page / trade log** (not the
   existing paper ones) before the first cycle, so live and paper data
   never intermix.
9. **Watch the first cycle directly** before leaving it fully unattended,
   same as was done for paper trading's early runs.

## Network access

Same as paper trading: `api.kraken.com` is the only allowlisted domain
(Custom network access, environment settings on claude.ai/code) -
`NODE_USE_ENV_PROXY=1` is required for Node's `fetch` to honor the proxy,
set in `.mcp.json` and `mcp-server/package.json`'s scripts. The private API
lives under the same domain, so this didn't need to change for live - if
this is ever run in a different environment, that environment needs the
same domain added (and, unlike paper trading, actual API-key/secret env
vars, not just the proxy flag).

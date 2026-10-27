# Market Advisory Agent

> **This agent never trades.** No order-placement tool, no portfolio
> module, no position-state file, and no execution-capable credential
> exist anywhere in this codebase - that's a structural property, not a
> rule to follow. It scans crypto (Kraken public data) and stocks (Alpaca
> + SEC EDGAR), computes the same kind of technical signals the trading
> branches use, and writes a daily recommendation report. Nothing here
> can touch real money. Read
> `instructions/market-advisory-instructions.md` in full before running a
> cycle - it's the operating spec and takes precedence over improvising.

## How this branch came to exist (2026-10-23)

Split off from `claude/ai-crypto-trading-agent-x0w1d3` (the paper-trading
branch - chosen as the base specifically because it's clean, read-only
signal code with none of the live branch's real-credential/execution
baggage; `portfolio.ts` and all paper-trading state were deleted
entirely, not just disabled).

**Prompted by**: the user asked to pause the live Kraken trading agent
and turn the idea into an "advisory" role - scan crypto and stocks daily,
report what looks good to buy, using similar technical metrics to the
crypto side plus earnings/institutional-investor signals for stocks.
Asked clarifying questions before building anything (per the user's own
explicit request to "ask questions first"), covering:

1. **New agent vs. converting the live branch in place** → new, separate
   branch (this one). Keeps the live trading branch's code/history/
   credentials completely untouched and resumable later; keeps "used to
   place real orders" history out of what's now a read-only advisor.
2. **What happens to the live trigger/open positions** → the live
   hourly trigger (`trig_01PUpRvKvis6BaM5D2wo1jhm`, bound to
   `session_01YZbxRuD6bUweQWeKS9xmaB`) was disabled (`enabled: false`,
   not deleted) same day. Any position open on Kraken at the time of
   disabling keeps its real resting stop-loss order on the exchange
   itself, so it's still protected - but nothing will manage trailing
   stops, invalidation checks, or open new trades until a human
   re-enables it. See the live branch's own `CLAUDE.md` for that
   trigger's full history; this branch doesn't touch it further.
3. **Stock data source** → user will set up Alpaca (free market-data
   tier). Alpaca covers quotes/bars but explicitly does NOT cover
   earnings calendars, fundamentals, or 13F/insider data - those gaps are
   covered separately (see below), not silently left unaddressed.
4. **"Big investor" signal** → the user specifically meant 13F
   institutional holdings changes AND Form 4 insider buying/selling.
   Both covered via free, no-key SEC EDGAR endpoints - no new paid
   account needed for this part. See the EDGAR section below for a real,
   load-bearing caveat on the 13F half specifically.
5. **Delivery & cadence** → daily digest, written to a Notion page
   (mirroring the live trading branch's summary-page pattern), not
   hourly - advisory output has no reason to be as time-sensitive as a
   system that was placing real orders.
6. **Stock universe** → S&P 500 / large-cap screen (not a fixed
   watchlist) - scan the whole index cheaply, narrow to a short list
   worth deeper analysis each day.
7. **Crypto universe** → kept the same 8 EUR pairs the live trading
   branch uses (BTC/ETH/SOL/XRP/ADA/LINK/SUI/LTC), reusing that branch's
   confirmed-live Kraken pair-code mapping verbatim. No reason to widen
   now that there's no position-count or execution-risk limit forcing a
   small list - but these 8 are already proven liquid enough for the
   signals to mean something, so kept as-is rather than guessing at a
   wider list.

## Layout

- `instructions/market-advisory-instructions.md` - the agent's daily
  operating cycle (read this, not just this file, before running)
- `mcp-server/` - the MCP server. Reused verbatim from the paper-trading
  branch: `indicators.ts` (RSI/SMA/volume/price-action/momentum - fully
  generic over `Candle[]`, not Kraken-specific, so it's reused as-is for
  stocks too - "similar metrics to crypto" falls out directly rather than
  being a second implementation to keep in sync) and `signals.ts`
  (crypto-specific orchestration, unchanged). `kraken.ts` ported from the
  live branch's EUR pair-code mapping (not the paper branch's USD one) -
  see "Crypto universe" above. Three new files: `stocks.ts` (Alpaca
  client + stock signal computation), `sp500.ts` (S&P 500 membership via
  a live proxy + the cheap screening pass), `edgar.ts` (SEC EDGAR insider/
  institutional lookups). `portfolio.ts` was deleted entirely, not kept
  as dead code or disabled - this agent has no concept of a position.
- `.mcp.json` - registers `market-advisory`, declaring
  `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` env vars (see credential
  setup below)
- `recommendations.md` - this agent's audit-trail log, parallel to the
  trading branches' `trades.md` but for recommendations, not trades.
  Starts clean - nothing to inherit from either trading branch's trade
  history.
- No `data/` directory - unlike both trading branches, there is no
  position state to persist between cycles. The S&P 500 constituent list
  is live-fetched and cached per-process (12h TTL), not stored in the
  repo - see `sp500.ts`.

## Credential & environment setup - DONE and fully live-verified (2026-10-23)

A dedicated CCR environment ("Market Advisory", `env_01SahdmY86diSRmDJJTJiL28`)
was created by the user with `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`
set and `api.kraken.com`, `data.alpaca.markets`, `www.sec.gov`,
`data.sec.gov`, `efts.sec.gov`, and `www.ishares.com` allowlisted - same
credential-isolation discipline the live trading branch's CLAUDE.md
documents (separate from "Default" and "Kraken live").

Getting here took several real rounds of live verification, not a
single clean pass - worth recording the actual bugs found, since they're
the kind of thing that look fine in code review and only break against
real data:

1. **Alpaca bars defaulted to today-only.** `limit=30` with no `start`
   param returned exactly 1 bar, not 30 - Alpaca's bars endpoint doesn't
   backfill history from `limit` alone. Fixed by adding an explicit
   `start` param sized generously for the requested window
   (`stocks.ts`).
2. **Form 4 XML path was wrong.** EDGAR submissions.json's
   `primaryDocument` field (e.g. `"xslF345X06/form4.xml"`) is the
   XSLT-rendered HTML viewer for the filing, not the raw ownershipDocument
   XML, despite the `.xml` name - fetching it returned HTML with none of
   the expected tags, so every field fell back to null/"unknown". Fixed
   by stripping the directory component to reach the real raw XML at the
   accession root, confirmed against 3 real AAPL filings (`edgar.ts`).
3. **IVV holdings CSV parsing returned 0 rows, for two separate reasons.**
   First the original `.ajax?fileType=csv...` URL had gone dead (returned
   the product page's HTML) - replaced with the `/latest-holdings.csv`
   path. Then, once real CSV came back, a naive `line.split(",")` broke
   on quoted fields with internal commas (e.g. `"68,152,575,876.48"`),
   leaving literal quote characters on every value so the Asset Class
   filter never matched - fixed with a proper quote-aware CSV line
   splitter (`sp500.ts`). Also found while verifying this: IVV's ticker
   column uses a space for class shares (`"BRK B"`), which Alpaca's bars
   endpoint rejects outright (HTTP 400) - normalized to the dot form
   (`"BRK.B"`) Alpaca actually expects, at the parse source so every
   downstream caller gets the correct symbol.
4. **Alpaca rate-limited the full ~500-ticker scan (HTTP 429)** once the
   bugs above stopped silently truncating the real request - two fixes,
   not one, since the first wasn't sufficient on its own:
   - A pacing delay between batch/pagination requests plus retry-with-
     backoff on 429 (honors `Retry-After` when sent, exponential backoff
     otherwise) - a reasonable defensive measure, but the 429 persisted
     after this alone.
   - The actual root cause, found in a later verification pass:
     Alpaca's multi-symbol bars endpoint treats `limit` as a cap on the
     TOTAL bars per page across every symbol in the request, not a
     per-symbol count the way this codebase's own `limit` parameter
     (bars wanted per symbol) assumed. Passing the per-symbol count
     straight through made a 100-symbol batch paginate roughly one
     symbol at a time - confirmed live, a 20-symbol/40-bars-each request
     needed ~150 pages instead of 1 - burning through the rate limit
     long before a full scan could finish no matter how the pacing/
     backoff above was tuned. Fixed by scaling the request-level `limit`
     by batch size (capped at Alpaca's documented 10,000-row max);
     confirmed live afterward that the same 20-symbol batch returns
     everything in a single page.

All fixes were diagnosed against real responses (not guessed) across
several verification sessions in the Market Advisory environment, and
the full self-test suite - including a genuine end-to-end `screen_sp500`
run across the real ~500-ticker universe - passed with exit 0 against
live Kraken, Alpaca, EDGAR, and iShares calls on the final pass. Nothing
in this agent's data pipeline is unverified anymore.

**A process note worth keeping**: verification sessions created fresh in
this environment, without the real repo attached and given a prompt that
claimed cross-session authority and told them not to verify anything,
correctly refused to proceed - that's indistinguishable from a prompt-
injection pattern to a session with no way to confirm the claim, and the
refusal was the right call, not a bug to route around. What worked
instead: attach the real repo (so the session can ground its own
judgment in actual git history and this file), describe the task
honestly without claiming special authority, and let it decide for
itself that the work is legitimate. Also worth noting: one such session
accidentally committed full `devDependencies` into the tracked
`node_modules` (should only ever hold production deps - see "Layout"
above) while chasing a build error; caught by diffing the push and fixed
forward in the next commit. Re-check `node_modules` size (~26MB) after
any session does a build/test cycle, not just that tests passed.

## Known data-source caveats - read before trusting a 13F-mentions result

**13F "mentions" is a noisy proxy, not aggregated institutional flow.**
13F-HR filings are filed BY institutional managers listing ALL their
holdings - not by the company itself - so there is no clean per-issuer
"who bought how much of this stock" endpoint on EDGAR the way there is
for Form 4. `get_institutional_13f_mentions` uses EDGAR's full-text
search across recent 13F-HR filings for a company name match - it tells
you which managers' filings mention the name somewhere in the document,
not a parsed, aggregated net-buy/net-sell figure. Getting a real
aggregated number would mean fetching and parsing every matched manager's
full holdings table (hundreds of XML rows each) to find the specific
CUSIP and diff it quarter-over-quarter - deliberately not attempted in
this first build. Also inherently laggy regardless: 13F is filed up to
45 days after quarter-end. `instructions/market-advisory-
instructions.md` mandates carrying this caveat into every report that
uses this tool - never present it as a clean signal.

**Form 4 insider activity is the cleaner half of the "big investor"
ask.** Filed per-issuer, near-real-time, structurally straightforward to
look up by ticker. Weight this more heavily than the 13F proxy above.

**Alpaca's free/IEX tier has no L2 order-book depth** - `compute_stock_
signals` always reports this as a `data_gaps` entry rather than silently
omitting the crypto side's order-book-imbalance signal. If a paid Alpaca
tier is ever added specifically for this, revisit - not needed to ship a
useful first version.

**No crypto-equivalent of 13F/Form 4** - there's no regulatory filing
regime for crypto holdings the way there is for US equities, so the
crypto side's "big investor" context stays whatever the trading branches
already used (news-catalyst WebSearch), not an EDGAR-style structured
lookup. Not a gap to fix, just a real asymmetry between the two asset
classes worth being explicit about rather than pretending symmetry.

## Daily trigger cadence - 8:00am ET, weekdays (decided 2026-10-24)

User asked specifically about timing relative to earnings: before open,
halfway through the day, or after close. Worked through the real
constraint first rather than just picking one: the stock-side technical
signals are all daily-bar-based, so they're identical regardless of what
time of day the cycle runs (the most recent *complete* bar is always
"yesterday's close" until the market actually closes) - timing only
matters for the earnings-catalyst WebSearch step, not the math. Earnings
cluster at two windows: before market open (BMO, ~6:00-8:30am ET) or
after close (AMC, ~4:00-5:30pm ET) - "halfway through the day" doesn't
actually buy anything over either edge.

Chose **before open, 8:00am ET** over after-close: this agent exists to
inform same-day decisions, and running before open gives the whole
trading day to act on anything flagged, reading like a standard morning
research note (overnight + BMO-earnings digest, technical picture going
into the session). The tradeoff, accepted knowingly: that same evening's
AMC earnings aren't captured until the next day's cycle - a one-cycle
delay, not a permanently missed signal (the next morning's run picks
them up fully digested). Crypto is 24/7 either way, so this choice is
purely about the stock side. Notion page created same day: page_id
`40378a93-63b8-81f0-891f-d23b7012219f` ("Market Advisory Agent").

## First real cycle (2026-10-24) found and fixed a genuine data bug

Ran the actual daily-digest prompt for real (not a test) to verify the
whole pipeline end to end: 8 crypto pairs (no momentum trigger that day,
broad quiet weakness), a real `screen_sp500` pass (504 constituents, top
20 deepened to 5: CCI/AMT/LMT/NOW/IBM), news/insider/13F context pulled
for each, logged to `recommendations.md`, pushed, and synced to the
Notion page. The cycle correctly refused to trust its own picks when it
noticed something wrong, rather than reporting them at face value - the
5 deepened stock candidates got capped at low confidence because
`screen_sp500`'s numbers and `compute_stock_signals`'s numbers disagreed
for the same ticker/day, badly enough that LMT and IBM's 5-day % change
flipped sign between the two.

**Root-caused and fixed same day**: `fetchStockBars` (single-symbol,
used by `compute_stock_signals`) requested `limit=40` with no `sort`
param. Alpaca's bars endpoint defaults to ascending order from `start`,
so a plain `limit` silently caps the response at the OLDEST 40 bars in
the window - a `next_page_token` was returned but never followed -
instead of the most recent 40. Confirmed live by comparing raw JSON from
both Alpaca endpoints for LMT with identical params: the unsorted
single-symbol call stopped at a 2026-08-24 close ($564.14) while the
correct, current bar was 2026-10-23 ($604.18). `fetchMultiStockBars`
(used by `screen_sp500`) was never the buggy side - its batch-scaled
`limit` plus existing pagination already covers the whole window
regardless, confirmed correct even forced across 17 real pages in a
10-symbol test. Fixed by adding `sort=desc` + reversing the result back
to ascending order (every downstream indicator assumes oldest-first).
Added a `selftest.ts` assertion that cross-checks `current_price` and
5-day `pct_change` between the single- and multi-symbol paths for the
same real ticker (AAPL), so a future regression on either side fails
loudly instead of silently feeding a stale price into a daily digest.
Full self-test suite, including a live `screen_sp500` run, passes with
exit 0 after the fix.

**The actual lesson, worth generalizing**: this is the second real bug
(after the 429/limit-scaling one above) that only surfaced once the
pipeline was run against its real intended use - not the self-test
suite's synthetic/isolated calls, but the full daily-cycle prompt doing
what it'll actually do every morning. Treat the first few real trigger
firings the same way: don't just confirm "it ran without crashing,"
cross-check its numbers against something independent before trusting
them.

## Status: LIVE as of 2026-10-24

Daily trigger: `trig_01BfuesSPFkZWQVyjGamxZ3m` ("Market Advisory daily
digest (v2 - short top layer)"), cron `CRON_TZ=America/New_York 49 7 *
* 1-5` (weekdays, ~8am ET - see "Daily trigger cadence" above), bound to
`session_01JBdr9xEEUZ18hg1Mg9cDn3` - the session that ran the corrected
second cycle, verified via the real pushed commit (`6e370bd`) and the
real Notion page content (not just its own summary), with the user's
explicit confirmation that no Notion approval prompt appeared. (The
original trigger, `trig_01EFUbXzwtpJ6m8TfWW2FT9r`, was disabled same day
when the Notion page structure changed - see "Notion page restructured"
below; `update_trigger` can't change a bound trigger's prompt text from
a different session, so the structure change took a new trigger pointed
at the same already-verified session, not a new verification cycle,
since no code changed. Disabling the old one via `update_trigger` worked
fine from here - only prompt-text edits hit that constraint, not
enabled/disabled toggles.) The trigger's own `mcp_connections` came back
empty on creation; left as-is rather than asking for a manual attach,
since this exact session already demonstrated clean Notion access
without one during verification - if a future cycle ever does hit a
Notion prompt, that's the signal to attach it explicitly in the routines
UI (same mechanism documented at length in
the live trading branch's CLAUDE.md).

## Not yet done

- Nothing structural - the agent is fully live. The two open items below
  are refinements, not blockers.
- `screen_sp500`'s ranking score is a simple, transparent sum of
  independent flags (momentum/RSI-extreme/volume-spike) - explicitly not
  a tuned or backtested model. Treat it as a narrowing filter for what
  the daily report digs into, never as the recommendation itself.
- The Alpaca 429 pacing/backoff values (350ms between requests, 1s/2s/4s
  backoff) are reasonable defaults, not tuned against Alpaca's actual
  published rate-limit numbers - they worked on the one full-scan live
  test run so far; revisit if a 429 ever gets through in practice.

## Notion page restructured - short top layer, detail collapsed (2026-10-24)

Direct user feedback same day: "the report is too long. What am I
supposed to focus on? Feels I need more concrete points." The original
structure ("## Crypto" / "## Stocks" with full per-candidate prose)
dumped every data gap, 13F caveat, and insider-activity sentence right
at the top with nothing scannable above it - fine as an audit trail
(which `recommendations.md` already serves), wrong as the thing a human
actually reads each morning.

Restructured to lead with "## Today's picks" (one-row-per-candidate
table, `Asset | Confidence | Why` - "Why" is one line, not a paragraph)
and "## Watch list" (near-misses, one line each), with everything else -
full crypto table, full per-candidate stock write-ups, data gaps,
methodology - moved into `<toggle>` blocks under "## Full detail",
collapsed by default. Also answered a second question same day: yes,
Nasdaq-listed names are already in scope - S&P 500 membership isn't
exchange-filtered, so the screen already covers both NYSE and Nasdaq
(today's 5 deepened names happened to be NYSE, which is incidental to
that day's results, not a scope gap).

Retrofitted the existing live page to this structure immediately (not
waiting for tomorrow's cycle), and updated `instructions/market-
advisory-instructions.md`'s step 5 to describe it going forward.
Trigger prompt updated to match (same mechanism as every prior prompt
edit on the trading branches - `update_trigger` can't change a prompt
from a different session than the one it's bound to, so this took a
new trigger pointed at the *same* already-verified session, not a full
cutover - no code changed, so no new verification cycle was needed).

## Real Kraken account tracking (read-only) - built, not yet live-verified (2026-10-27)

**Prompted by**: the user acted on an advisory pick in real life (bought
a small crypto position on Kraken based on a report) and asked whether
their actual trades could be tracked automatically, suggesting a
read-only API key themselves. Good idea, worth building - there was no
feedback loop at all before this between what the advisory flags and
what actually happens to real money, which is the only way to tell
later whether a "medium confidence" label is worth anything.

**Credential**: a NEW, separate Kraken API key (`KRAKEN_READONLY_API_KEY`/
`KRAKEN_READONLY_API_SECRET`), scoped to Query Funds / Query Open
Orders & Trades / Query Closed Orders & Trades / Query Ledger Entries
ONLY - explicitly without Create & Modify Orders, Cancel/Close Orders,
or Withdraw Funds. Even more restricted than the live trading branch's
key (which needs order-placement permissions to actually trade) - this
one is read-only by Kraken's own enforcement, not just by omission in
this code. Added to the existing "Market Advisory" environment (user's
choice over a new dedicated one) - no new network allowlist entry
needed, Kraken's private endpoints live under the same `api.kraken.com`
domain already allowlisted for public data.

**Code**: new `kraken-account.ts`, deliberately NOT named or structured
like a general "kraken-private.ts" - ports only the read-only pieces
(Balance, OpenOrders, ClosedOrders, QueryOrders, plus a new Ledgers
function the live branch never needed) from the live trading branch's
already-verified signing implementation (HMAC-SHA512, confirmed correct
against live Kraken via that branch's `validate: true` AddOrder call).
`addOrder`/`cancelOrder` were NOT ported - on purpose, so this agent's
"no execution capability anywhere in this codebase" property stays true
even at the Kraken-account layer, not just the stock side. New tools:
`kraken_account_get_balance`, `kraken_account_get_open_orders`,
`kraken_account_get_closed_orders`, `kraken_account_get_ledger`.

**Not yet live-verified** - the signing logic is reused from code
already proven correct, but the read-only endpoints themselves (and
this specific key, once created) haven't been smoke-tested against
real Kraken yet. `selftest.ts` skips gracefully until
`KRAKEN_READONLY_API_KEY`/`SECRET` exist, same fail-safe pattern as
every other credential-gated test in this file. Live-verify the moment
the key is set, before trusting any balance/order data it returns -
same discipline applied to every other data source on this branch.

**Not yet decided**: how real outcomes get logged against advisory
picks once this works (a new section in `recommendations.md`? a
separate outcomes file? pulled automatically by the daily trigger, or
only on request?) - deliberately left open rather than guessed at
before the data access itself is even verified.

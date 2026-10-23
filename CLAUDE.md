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
   bugs above stopped silently truncating the real request. Added a
   small pacing delay between batch/pagination requests plus a real
   retry-with-backoff on 429 (honors `Retry-After` when sent, exponential
   backoff otherwise).

All four fixes were diagnosed against real responses (not guessed) across
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

## Not yet done

- The daily trigger itself + the advisory Notion page don't exist yet -
  credentials/network/code are all verified now, so this is the next
  real step. Should follow the live trading branch's cutover-and-verify
  discipline where it applies (new trigger, explicit Notion-prompt check,
  etc. - see that branch's "Cutover playbook" section, which generalizes
  beyond Kraken specifically) even though this agent has no real-money
  stakes to protect the way that playbook was originally built for.
- `screen_sp500`'s ranking score is a simple, transparent sum of
  independent flags (momentum/RSI-extreme/volume-spike) - explicitly not
  a tuned or backtested model. Treat it as a narrowing filter for what
  the daily report digs into, never as the recommendation itself.
- The Alpaca 429 pacing/backoff values (350ms between requests, 1s/2s/4s
  backoff) are reasonable defaults, not tuned against Alpaca's actual
  published rate-limit numbers - they worked on the one full-scan live
  test run so far; revisit if a 429 ever gets through in practice.

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

## Credential & environment setup - NOT YET DONE, blocks real operation

This is the one thing that can't be done from inside a session - it
needs the user's own action on claude.ai/code, mirroring exactly how the
live trading branch's Kraken credentials were set up (see that branch's
CLAUDE.md "Credential handling" section for the precedent this follows).

**Needed**:
1. An Alpaca account + a free market-data API key pair
   (`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`). Alpaca's free tier is
   a standalone market-data product - it does not require funding a
   brokerage account to use for data only.
2. A **dedicated CCR environment** for this agent (not the "Default" one
   the paper branch uses, not "Kraken live" either) - same credential-
   isolation discipline the live branch's CLAUDE.md documents and the
   same reasoning: keeps Alpaca's keys structurally unreachable from any
   other branch's session, and vice versa. Lower stakes than Kraken's
   keys (market-data-only, no trading/withdrawal scope exists on
   Alpaca's data API to begin with), but isolating by habit costs
   nothing and avoids a future mix-up.
3. That environment's network policy needs these domains allowlisted
   (this environment currently only allows `api.kraken.com`, inherited
   from the trading branches - confirmed by a live WebFetch/fetch
   failure against both during this build):
   - `data.alpaca.markets` - stock quotes/bars
   - `www.sec.gov`, `data.sec.gov`, `efts.sec.gov` - SEC EDGAR (insider
     Form 4 filings, 13F full-text search, the CIK lookup file)
   - `www.ishares.com` - S&P 500 membership proxy (see `sp500.ts`'s
     header comment for why this specific source was picked; Alpaca
     itself has no index-membership endpoint)

**Until this exists**: `npm run test` (the self-test suite) runs
everything that's live-testable today - all pure indicator math, and a
full live smoke test against Kraken's EUR pairs (confirmed passing,
2026-10-23) - and skips the Alpaca/EDGAR/iShares-dependent tests
explicitly and gracefully (`skip:` lines, not failures) rather than
crashing or hanging. The code for all three was written against each
API's documented/known shape since it can't be live-verified from this
environment yet - **explicitly unverified**, same honesty convention the
live trading branch's CLAUDE.md uses for anything built this way (see
that branch's `kraken-private.ts` entry). Each unverified spot is called
out in a comment at the point it matters (`stocks.ts`'s Alpaca client,
`sp500.ts`'s CSV parser, `edgar.ts`'s Form 4 XML extraction) - re-read
those comments and live-smoke-test immediately once the new environment
and credentials exist, before trusting any of their output.

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

- Credential/environment setup above (blocks everything Alpaca/EDGAR/
  iShares-dependent from running live).
- The daily trigger itself + the advisory Notion page don't exist yet -
  both need the credential setup above done first, then should follow
  the live trading branch's cutover-and-verify discipline where it
  applies (new trigger, explicit Notion-prompt check, etc. - see that
  branch's "Cutover playbook" section, which generalizes beyond Kraken
  specifically) even though this agent has no real-money stakes to
  protect the way that playbook was originally built for.
- `screen_sp500`'s ranking score is a simple, transparent sum of
  independent flags (momentum/RSI-extreme/volume-spike) - explicitly not
  a tuned or backtested model. Treat it as a narrowing filter for what
  the daily report digs into, never as the recommendation itself.

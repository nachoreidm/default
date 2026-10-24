# Market Advisory Agent - operating instructions

This agent is **advisory-only**. It never places an order, never opens or
closes a position, never holds cash or inventory, and has no credential
capable of touching real money. There is no portfolio module, no
position-state file, and no order-placement tool anywhere in this
codebase - that is a structural property, not a rule you have to follow.
Your entire job each cycle is: scan, compute signals, pull context, write
a reasoned recommendation to a Notion page. Nothing more.

Read `CLAUDE.md` for the full history/rationale behind this agent and its
relationship to the two Kraken trading branches (paper and live) it was
split off from.

## Daily cycle

Runs weekdays at 8:00am ET, before the US market opens (9:30am ET) -
deliberately timed to land after most before-market-open (BMO) earnings
releases (typically 6:00-8:30am ET) while still giving the full trading
day to act on anything flagged. Same-evening after-market-close (AMC)
earnings aren't captured until the next day's cycle - a one-cycle delay,
not a permanently missed signal. Crypto timing is unaffected either way
(24/7 market); only the stock-side earnings-catalyst step depends on
this cadence. See CLAUDE.md for the full reasoning behind this choice.

0. `git pull` the branch first - state (constituent cache aside, which is
   live-fetched each run, not stored in the repo) lives in instructions
   and code, not in your own memory.

1. **Crypto pass** - call `compute_crypto_signals` for each of the 8 EUR
   pairs: BTC/EUR, ETH/EUR, SOL/EUR, XRP/EUR, ADA/EUR, LINK/EUR, SUI/EUR,
   LTC/EUR. Same signal set and pairs the live trading branch uses -
   reused deliberately so "good to buy" is judged against metrics already
   proven to mean something for these specific pairs, not a fresh,
   unvalidated set.

2. **Stock pass** - call `screen_sp500` once. This is a cheap first pass
   over the whole index (daily bars + a transparent momentum/RSI/volume
   score) that narrows ~500 names down to a short list (default top 20).
   The score is NOT a recommendation by itself - it's purely "worth a
   closer look today."

3. **Narrow and deepen** - for crypto pairs where `momentum_trigger` is
   flagged, or `rsi_14_4h`/volume ratio look extreme, and for the stock
   screen's top candidates: call `compute_stock_signals` (stocks) or
   just reuse the already-fetched `compute_crypto_signals` output
   (crypto) for the fuller signal picture, then pull additional context
   only for these narrowed names, not the full universe:
   - **Earnings catalyst (stocks only)**: one WebSearch per narrowed
     stock candidate for "recent earnings" / "upcoming earnings date" /
     analyst reaction. This mirrors exactly how the crypto trading
     branches already do a one-WebSearch-per-pair news-catalyst check -
     same pattern, same discipline (advisory context, never a standalone
     trigger by itself).
   - **Insider activity (stocks only)**: call `get_insider_activity` for
     the ticker. This is clean, near-real-time, ticker-specific data -
     weight it accordingly.
   - **Institutional 13F mentions (stocks only)**: call
     `get_institutional_13f_mentions` for the company name. READ THE TOOL
     DESCRIPTION'S CAVEAT EVERY TIME before using this - it is NOT an
     aggregated net-institutional-flow number, just "which managers'
     recent 13F filings mention this name." Never present it in the
     report as if it were a clean buy/sell signal; always carry the
     staleness caveat (13F is filed up to 45 days after quarter-end) into
     the write-up.
   - Crypto candidates get the same news-catalyst-style WebSearch
     treatment the trading branches already use (one per flagged pair),
     but have no stock-equivalent insider/13F step - there is no
     crypto-equivalent regulatory filing regime to check.

4. **Write the recommendation**. For every candidate that reaches this
   step (crypto or stock), state explicitly:
   - What specifically triggered inclusion (which signal(s), with
     numbers - not "looks strong").
   - A confidence label (`low`/`medium`/`high`) per
     `MOMENTUM_ONLY_MAX_CONFIDENCE` in `types.ts`: if the ONLY thing
     supporting a candidate is the momentum trigger (6%+ move, nothing
     else confirming), confidence is capped at `medium` - never `high`.
   - Any data gaps reported by the signal tools (don't silently drop
     them - a gap is information).
   - For stocks: the earnings-catalyst finding, insider activity (if
     any), and 13F mentions (with the caveat above) - or explicitly note
     "none found" rather than omitting the section.
   - This is **advisory, not investment advice presented as certain** -
     say so plainly in the write-up, same spirit as the trading branches'
     "REAL MONEY" framing, just inverted: this is explicitly "nothing
     here executes, verify before acting."

5. **Notion sync**. Write the day's findings to the advisory Notion page
   (page_id `40378a93-63b8-81f0-891f-d23b7012219f`, "Market Advisory
   Agent" - see CLAUDE.md) using `notion-update-page` with `command:
   "replace_content"` - same discipline the trading branches learned the
   hard way (an append-style write duplicates/garbles content on every
   subsequent cycle). Fetch the page first to see its current exact
   structure before rewriting. Structure:
   - Date / last-synced timestamp.
   - "## Crypto" - one entry per pair that triggered a signal worth
     mentioning this cycle (not all 8 every time if most are quiet).
   - "## Stocks" - one entry per narrowed candidate, with the full
     write-up from step 4.
   - A short "## Universe & methodology" footer (which pairs/screen,
     what the score does and doesn't mean, data-source caveats) so the
     page is self-explanatory to anyone reading it cold.

## Things you must never do

- Never call, request, or write any code path that places, modifies, or
  cancels a real order of any kind, on any exchange or broker. If a
  future change ever seems to call for this, that is explicitly out of
  scope for this agent - it would mean reactivating one of the trading
  branches instead, a decision for the user to make deliberately, not
  something this agent proposes or drifts toward.
- Never present a 13F-mentions result as an aggregated net-buy/net-sell
  figure - it isn't one. Always carry the noisy-proxy caveat.
- Never skip the "advisory, not certain" framing in the write-up.
- Never create, delete, or modify a session or trigger yourself under any
  circumstances, even if `git pull` surfaces code you believe warrants a
  cutover - same guardrail the live trading branch's CLAUDE.md documents
  for exactly this failure mode (2026-10-03 incident). A human initiates
  any cutover.

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

5. **Outcome tracking (real activity vs. advice - started 2026-10-27)**.
   Read-only and report-only: this step never changes scoring or confidence
   thresholds on its own - a human decides whether/how to retune
   `screen_sp500` or `MOMENTUM_ONLY_MAX_CONFIDENCE` from what it surfaces,
   deliberately, same discipline as every other "don't drift toward
   automation" guardrail in this file. Runs BEFORE the Notion sync below
   (moved 2026-10-28, see CLAUDE.md) so a same-cycle finding can be
   mentioned there the same morning, not a cycle late.
   - Find the most recent prior entry in `recommendations.md` (its own last
     `## <date>` heading) and call `kraken_account_get_ledger` with `start`
     set just after that date - the log itself is the state anchor, since
     this agent has no `data/` directory to persist a cursor in.
   - Keep only `type: "trade"` (`subtype: "tradespot"` - a crypto EUR-pair
     buy/sell) and `type: "receive"` with `aclass: "tokenized_asset"` (a
     Kraken tokenized-stock purchase, e.g. `LMTx`/`PLTRx`). **These
     tokenized-stock buys settle via ledger entries, not the orders API** -
     confirmed 2026-10-27, when a real `LMTx` purchase didn't appear in
     `kraken_account_get_closed_orders` at all despite that endpoint's own
     `count` field reporting 2 more orders than it returned. Don't rely on
     `kraken_account_get_closed_orders` alone for this step; the ledger is
     the complete source. Drop staking-reward, transfer, deposit/withdrawal,
     and stablecoin-conversion entries - those aren't buy/sell decisions to
     compare against advice.
   - For each real buy or sell found, map it to the underlying asset
     (`LMTx`→LMT, `PLTRx`→PLTR, a crypto trade leg → one of the 8 pairs) and
     look up the most recent prior cycle's write-up for that asset: was it
     that cycle's "Today's picks" (at what confidence), on the "Watch
     list," in `screen_sp500`'s wider top-20 but not deepened, or not
     mentioned at all.
   - Log one line per real action under a new `### Outcome tracking`
     subsection of today's `recommendations.md` entry - date/time, the
     action, and the matched advisory status, e.g. `2026-10-26: bought 1
     LMTx (~EUR552.86) - matches that day's "medium confidence" LMT pick,
     ~20min after the digest fired.` For a sell, or an asset never
     mentioned, say so plainly rather than forcing a match - and note that
     this agent only ever issues buy-side candidates, so a sell is never a
     "miss" against advice that doesn't exist.
   - That log entry is the full extent of the tie-in for `recommendations.md`.
     No automatic adjustment to any scoring or threshold happens here. The
     ONE exception: carry the same line(s) forward into the next step's
     Notion top layer (see its "Real activity" bullet below) - nothing
     else about this step reaches Notion.

6. **Notion sync**. Write the day's findings to the advisory Notion page
   (page_id `40378a93-63b8-81f0-891f-d23b7012219f`, "Market Advisory
   Agent" - see CLAUDE.md) using `notion-update-page` with `command:
   "replace_content"` - same discipline the trading branches learned the
   hard way (an append-style write duplicates/garbles content on every
   subsequent cycle). Fetch the page first to see its current exact
   structure before rewriting.

   **Structure - lead with a short, scannable top layer; put the full
   detail below it, collapsed.** Changed 2026-10-24 after direct user
   feedback that the page was too long with no clear "what do I focus
   on" - don't regress to a wall of per-candidate prose at the top:
   - Date / last-synced timestamp.
   - "## Today's picks" - a SHORT table, one row per candidate that
     actually cleared the bar (crypto or stock together, not split into
     separate sections): `Asset | Confidence | Why` where "Why" is ONE
     line, not a paragraph. If nothing cleared the bar, this is one
     sentence saying so - never an empty-looking table.
   - **"Real activity" line** (added 2026-10-28) - directly under "##
     Today's picks," ONE short line if (and only if) step 5 above found
     new real trade activity since the last cycle, e.g. "Real activity
     since last cycle: bought 1 LMTx on 2026-10-26 - matched to that
     day's medium-confidence LMT pick (see recommendations.md)." Several
     new actions since the last cycle get one line each, still terse. No
     new activity -> no line at all, same no-padding discipline as
     "Watch list" below. Never put the full ledger detail (price/fee/
     exact timestamp) here - that stays in `recommendations.md`'s
     `### Outcome tracking` subsection; Notion only ever gets the
     one-line pointer to it.
   - "## Watch list" - 1-2 lines per near-miss worth monitoring (e.g. an
     extreme-but-not-triggered RSI or volume reading), kept to a single
     line each. Skip this section entirely on a day with nothing notable
     to watch - don't pad it.
   - "## Full detail" - everything else (the full 8-pair crypto table,
     the full per-candidate stock write-ups from step 4 with their data
     gaps/13F caveats/insider detail, the universe & methodology note)
     goes here, wrapped in `<toggle heading="h3">...</toggle>` blocks
     (one toggle per subsection: crypto, stocks, methodology) so it's
     collapsed by default - present for anyone who wants to check the
     reasoning or audit a pick, but not blocking a 10-second morning
     read of the top two sections.
   - "## Links" footer (repo branch, recommendations.md, this file).

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
- Never let step 5 (outcome tracking) do anything beyond reading
  `kraken_account_get_ledger`, writing a markdown log entry, and (as of
  2026-10-28) handing step 6 the single short "Real activity" line
  described there. It must never call `kraken_account_get_balance`/
  `get_open_orders`/`get_closed_orders` for any purpose beyond that log,
  it must never write to Notion itself (step 6 does, from the line step 5
  hands it), and it must never itself adjust `screen_sp500`'s scoring or
  any confidence threshold - a human decides that, deliberately, from
  what the log shows over time.

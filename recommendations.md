# Market Advisory - recommendation log

This is the advisory agent's own audit trail, parallel to the two Kraken
trading branches' `trades.md`. **Nothing in this file is a trade** - this
agent never executes anything. Each entry is a point-in-time scan result
and recommendation, kept here so recommendations are auditable against
what later happened, the same discipline `trades.md` applies to real
fills on the trading branches.

Starts clean on this branch - no history carried over from either trading
branch (they tracked real paper/live trades, not advisory scans; nothing
to inherit).

---

## 2026-10-24 - first real cycle

**Advisory only. Nothing here executes - verify before acting.**

### Crypto - all 8 EUR pairs, no momentum trigger fired

Broad, quiet weakness across the board: every pair down 1-4.5% over the
last 48h, no pair crossed the 6% `momentum_trigger` threshold, no 24h
volume ratio above 2x.

| Pair | 1h/48h chg | 4h/48h chg | RSI(14,4h) | Vol ratio (24h vs 7d avg) | SMA state |
|---|---|---|---|---|---|
| BTC/EUR | -1.84% | -1.18% | 39.7 | 0.86x | fast>slow |
| ETH/EUR | -1.80% | -1.58% | 41.8 | 0.63x | fast>slow |
| SOL/EUR | -1.75% | -1.35% | 39.3 | 0.68x | fast>slow |
| XRP/EUR | -3.30% | -3.33% | 38.8 | **1.81x** | fast>slow |
| ADA/EUR | -2.60% | -2.31% | 37.9 | 0.67x | **fast<slow** |
| LINK/EUR | -2.32% | -2.21% | 41.4 | 1.55x | fast>slow |
| SUI/EUR | -2.97% | -2.48% | 38.9 | 0.98x | fast>slow |
| LTC/EUR | -4.54% | -4.14% | **31.5** | 0.83x | fast>slow |

No candidate reaches even momentum-only inclusion today. Two pairs had
the most notable (not triggered) readings and got a one-off news check:
- **LTC/EUR**: lowest RSI (31.5, nearing oversold) and largest decline
  (-4.5%/-4.1%). WebSearch turned up nothing dated for October 2026 -
  results were price-prediction/evergreen pages and a promotional
  company release (Lite Strategy treasury holding), not verifiable news.
  No catalyst found either way.
- **XRP/EUR**: highest volume ratio (1.81x, below the 2x flag) on a
  -3.3% move. WebSearch found only generic/undated SEO-filler pages
  about the long-running Ripple/SEC case, nothing specific to today.
- **ADA/EUR** is the only pair with a bearish 20/50 SMA state
  (fast below slow) - noted, not searched (not the day's most extreme
  reading).

**Confidence: n/a - no crypto candidate meets the bar for inclusion
today.** Monitor LTC/EUR and XRP/EUR for tomorrow; nothing to act on now.

### Stocks - S&P 500 screen (top 20 of 504) + deep dive on 5 names

`screen_sp500(top_n=20)` returned a universe of 504 names (1 fetch
error: `HOLX: no bars returned`). All 20 returned candidates had
`momentum_flagged: true` with scores of 3-4 (max in today's list: CCI
at 4). Deepened the 5 most extreme by score/metric: **CCI, AMT, LMT,
NOW, IBM**.

**Data-integrity finding - flagging before anything else, this affects
every number below.** For all 5 names deepened, `screen_sp500`'s
numbers and `compute_stock_signals`'s numbers disagree materially for
the *same ticker, same day* despite both hitting Alpaca's
`/v2/stocks/.../bars` endpoint with identical `timeframe=1Day` and
`adjustment=split` params (confirmed by reading `sp500.ts` and
`stocks.ts` - the only code difference is the single-symbol vs
multi-symbol Alpaca endpoint). For LMT and IBM the 5-day price-change
*sign itself flips* between the two tools:

| Ticker | screen_sp500 price / RSI / 5d chg | compute_stock_signals price / RSI / 5d chg |
|---|---|---|
| CCI | $85.97 / 71.8 / +6.06% | $76.40 / 52.2 / +3.20% |
| AMT | $188.97 / 65.7 / +3.25% | $178.39 / 61.1 / +3.52% |
| LMT | $604.18 / 78.0 / **+10.21%** | $564.14 / 47.3 / **-7.09%** |
| NOW | $158.96 / 70.0 / +9.36% | $128.05 / 62.9 / +7.16% |
| IBM | $253.56 / 71.0 / **+7.26%** | $231.04 / 44.0 / **-0.70%** |

This is a pipeline bug, not market noise, and it means **today's S&P
500 screen cannot be trusted at face value** - the ranking that
selected these 5 names as "worth a closer look" may itself be built on
the wrong numbers. Not attempting a code fix in this cycle (out of
scope for a daily run); flagging for the next session to investigate
which of the two Alpaca endpoints (single-symbol vs multi-symbol) is
returning stale/wrong data. Every confidence label below is capped at
**low** specifically because of this, regardless of what the
individual signals otherwise looked like.

Using `compute_stock_signals`' numbers (closer to Alpaca's documented
single-symbol behavior) as the less-suspect of the two:

- **CCI** (Crown Castle, Real Estate): $76.40, RSI 52.2 (not extreme),
  +3.2%/5d, +0.86%/20d, volume 1.07x (not a spike) - the screen's "score
  4" read (RSI 71.8, 28% 20d gain, 3.1x volume) does not hold up under
  the single-ticker tool. Reported Q3 on 2026-10-21 AMC; sources
  disagree on EPS consensus ($0.69-$1.20) but agree revenue fell ~5.9%
  YoY tied to the ~$8.4B fiber/small-cell divestiture that funded >$7B
  of debt paydown. Insider activity: mostly routine RSU/option vesting
  (codes A/M); one small open-market buy by a director (820 sh @
  $90.24, May) and one VP sale (1,500 sh @ $75.89, Aug) - no net signal.
  13F mentions: dominated by DigitalBridge Group filings 2022-2025 and
  one small/obscure filer - stale, not a clean institutional-flow read
  (per the tool's standard caveat).
  **Confidence: low** (data-integrity issue above; underlying signals
  also don't independently support a momentum read once corrected).
- **AMT** (American Tower, Real Estate): $178.39, RSI 61.1, +3.5%/5d,
  +4.0%/20d, volume 0.87x. Next earnings expected ~Oct 27-29 (not yet
  reported); last quarter was a modest beat with raised full-year AFFO
  guidance, though a one-time DISH-related churn weighed on comparable
  growth. Insider: routine director annual stock-purchase-plan buys
  (small, $177-$206/share) and RSU grants; one filing's transaction
  date (2023-04-28) looks like a parsing artifact given its October
  2026 filing date - treat with suspicion, another possible data-gap in
  this tool. 13F mentions: again mostly DigitalBridge and small/obscure
  filers, stale.
  **Confidence: low**.
- **LMT** (Lockheed Martin, Industrials): screen showed +10.2%/5d and
  RSI 78 (extreme); the single-ticker tool shows **-7.09%/5d** and RSI
  47.3 - a direct contradiction, not just a magnitude difference.
  Reported Q3 (date disputed across sources, Oct 20-22) with a strong
  beat (+10% vs consensus last quarter). Insider activity is almost
  entirely routine annual director stock-unit grants (fractional
  shares, $0 price) plus one COO option exercise/sale - no directional
  signal. 13F mentions returned mostly single/duplicate small filers
  (Foresters, Winnow Wealth, Pathway), stale and thin.
  **Confidence: low - and this is the clearest case for not trusting
  the screen's ranking today.**
- **NOW** (ServiceNow, IT): $128.05, RSI 62.9, +7.2%/5d, **+15.8%/20d
  (momentum_trigger flagged true** on the 20d window) vs. screen's
  +9.36%/5d, +20.9%/20d, RSI 70.0 - same direction, different
  magnitude. This is the only one of the 5 where `compute_stock_signals`
  itself independently flags `momentum_trigger`. Next earnings due
  2026-10-28 AMC (not yet reported), consensus ~$0.56 EPS; sources gave
  conflicting prior-quarter results (one shows a miss, one a beat -
  likely a GAAP-vs-adjusted mismatch between sources, unresolved).
  Insider activity: a *cluster* of open-market sales in late Aug/early
  Sept by several senior execs (Fipps, Canney, Chamberlain - $135-148/
  share) following option exercises - worth flagging as a mild caution,
  not a buy signal. 13F mentions: old/thin, including a 2025 Coatue
  Management mention, otherwise small filers.
  **Confidence: low** (data-integrity caveat applies; the one genuinely
  triggered momentum signal is undercut by a concurrent insider-selling
  cluster and an unresolved earnings-reaction data conflict).
- **IBM** (Information Technology): screen showed +7.26%/5d and RSI
  71.0; single-ticker tool shows **-0.70%/5d** and RSI 44.0 - again a
  sign flip, not just a magnitude gap. Reported Q3 on 2026-10-21 AMC;
  consensus ~$2.87-2.90 EPS, strong beat history (7 of last 8 quarters),
  actual result not found in search. Insider activity: a uniform batch
  of routine annual director stock grants (415-489 sh @ $219.93, all
  dated 2026-09-30) - no signal. 13F mentions: old, thin, unrelated
  small filers.
  **Confidence: low.**

### Data gaps carried from the tools (not silently dropped)

- Stocks have no order-book-imbalance signal on any ticker (Alpaca
  free/IEX tier has no L2 depth) - structural, every cycle.
- All 5 deepened tickers: insufficient daily history for a 20/50 SMA
  crossover read via `compute_stock_signals` (`sma_crossover_1d: null`
  on all 5).
- 13F mentions for all 5 names are the known noisy full-text-search
  proxy (which managers' filings *mention* the name, not a net-flow
  figure) and mostly surfaced stale (pre-2025) or obscure filers -
  treat as non-signal today, not a clean read either way.
- **New today**: `screen_sp500` vs `compute_stock_signals` price/RSI/
  pct-change disagreement across all 5 names checked, sign-flipping for
  2 of them (LMT, IBM) - see data-integrity finding above. Needs a
  follow-up investigation session, not fixed in this cycle.

### Bottom line

No high-confidence candidate on either side today. Crypto is uniformly
weak with nothing hitting a trigger. The stock screen flagged 20 names,
but a real data-pipeline disagreement between the screening tool and
the deep-dive tool undermines all 5 deepened candidates enough to cap
them at low confidence until the discrepancy is root-caused. This is
advisory context only, not investment advice presented as certain -
verify independently before acting on anything above.

### Follow-up - 2026-10-24 - data-integrity bug root-caused and fixed

Root cause confirmed by fetching raw JSON from both Alpaca endpoints for
LMT with identical params: `fetchStockBars` (single-symbol, used by
`compute_stock_signals`) requested `limit=40` with no `sort` param.
Alpaca's bars endpoint defaults to ascending order from `start`, so a
plain `limit` caps the response at the OLDEST 40 bars in the
`start..now` window - a `next_page_token` was returned but never
followed - instead of the most recent 40. Live-confirmed: the unsorted
single-symbol call for LMT stopped at a 2026-08-24 close ($564.14,
exactly matching that day's `compute_stock_signals` reading);
`fetchMultiStockBars` (used by `screen_sp500`) was NOT the buggy side -
its batch-scaled `limit` (`limit * batch.length`) plus the existing
full-pagination loop already collects the whole window regardless, so
it correctly reached 2026-10-23's close ($604.18, matching that day's
`screen_sp500` reading) even when forced across 17 real pages in a
10-symbol test batch.

Fix: added `sort=desc` to `fetchStockBars`'s request and reversed the
result back to ascending order (`mcp-server/src/stocks.ts`). Live
re-check after the fix: both `fetchStockBars` and `fetchMultiStockBars`
now return the identical LMT bar (close $604.18, 2026-10-23) for
identical params. Added a selftest.ts assertion that fetches both paths
for the same real ticker (AAPL) and asserts `current_price` and 5-day
`pct_change` agree within a tight tolerance, so a future regression on
either path fails loudly instead of silently feeding a stale price into
a daily digest. Full self-test suite, including a live end-to-end
`screen_sp500` run, passed with exit 0 after the fix.

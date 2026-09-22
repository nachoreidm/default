# Live Trade Log

Real trades on real money, placed via Kraken's authenticated API. This file
starts clean on the `claude/live-kraken-trading-agent` branch — it does
**not** continue the paper-trading trade log. That history (2026-09-06
through the live branch's creation) is preserved at `paper-trades-archive.md`
for reference; nothing in this file is simulated.

Appended to automatically by the live portfolio engine's
open/close/no-trade calls. Don't hand-edit; if a correction is needed, fix
`data/live_portfolio_state.json` and note the correction here inline.

---
### 2026-09-22T14:30:09.349Z — ETH/EUR — NO TRADE

**Reasoning:** Momentum trigger flagged (1h 48h +7.08%, 4h 48h +5.13%) and SMA is bullish (fast>slow), and news is genuinely constructive (ETH broke a descending trendline that had capped every rally since the Aug-2025 peak; Glamsterdam hard fork testnet launches 28 Sep). But two signals conflict with chasing entry right now: (1) volume is NOT confirming the move - only 1.22x the 7-day average, well under the 2x flag that BTC/SUI show for their comparable moves; (2) order book is heavily skewed to the ask side (imbalance -0.47, ~2.75x more resting ask volume than bid volume in the top 10 levels) - real overhead supply sitting just above current price. A trend/news case without volume or book confirmation, right after a multi-day rally with RSI at 69, looks like chasing into resistance rather than confirmed continuation. Passing this cycle; would reconsider on a volume-confirmed breakout or a pullback that resets order book balance.

**Signals considered:**
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 7.0757631662006215,
    "pct_change_4h_48h": 5.133695011826359
  },
  "rsi_14_4h": 69.09264936634757,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 2323.2364999999995,
    "slow_value": 2220.3786
  },
  "volume": {
    "ratio": 1.218113622892478,
    "flag_above_2x": false
  },
  "order_book_imbalance_top10": -0.46590348231423084,
  "news_context": "ETH broke a descending trendline capping rallies since the Aug-2025 $4,958 peak; Glamsterdam hard fork Sepolia testnet launch scheduled 28 Sep 2026; near-term Sept target ~$2,800 per analyst consensus."
}
```

---
### 2026-09-22T14:30:16.429Z — XRP/EUR — NO TRADE

**Reasoning:** Momentum trigger flagged strongly (1h 48h +15.6%, the largest 1h move of any major pair this cycle), SMA bullish, order book mildly positive (+0.11). But the size of the move is not matched by volume: only 1.30x the 7-day average, well below the 2x confirmation threshold - a move this large on unconfirmed volume is more consistent with a thin, fast squeeze than a durable breakout. News corroborates caution: the rally is described as a "rising tide" effect from BTC's breakout rather than an XRP-specific catalyst, coverage flags XRP as testing a critical resistance band with "failure may lead to consolidation," and there are conflicting reports on large-holder behavior (some accumulation, some flagged as moving to exchanges, which would be distributive not accumulative). RSI 73.8 is elevated. Passing - the move looks extended and unconfirmed relative to its size, right into a stated resistance zone.

**Signals considered:**
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 15.598999583159639,
    "pct_change_4h_48h": 10.842826106710076
  },
  "rsi_14_4h": 73.81208231032788,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 1.259036,
    "slow_value": 1.205269
  },
  "volume": {
    "ratio": 1.2985602199881892,
    "flag_above_2x": false
  },
  "order_book_imbalance_top10": 0.11327897092795251,
  "news_context": "Rally attributed to a BTC-breakout 'rising tide' effect rather than an XRP-specific driver; approaching a stated resistance band with risk of rejection/consolidation; mixed reports on whale accumulation vs. exchange inflows."
}
```

---
### 2026-09-22T14:30:22.896Z — ADA/EUR — NO TRADE

**Reasoning:** Momentum trigger flagged (1h 48h +14.97%), SMA bullish, and news has real, specific positive catalysts (Cardano Foundation x Mastercard cross-border/stablecoin partnership announced 15 Sep, x402 SDK integration for instant API payments on 21 Sep) - genuinely stronger news than most pairs this cycle. However the technical picture argues against chasing entry now: volume is the weakest of all seven pairs relative to its own average (1.20x, essentially unconfirmed) despite having one of the largest price moves, and the order book is heavily skewed to asks (-0.41, similar magnitude to ETH's) - real resting supply overhead. A ~15% two-day move with almost no volume expansion and heavy ask-side supply is a classic setup for a pullback into that supply rather than continuation, regardless of the fundamentally good news. Passing this cycle; would reconsider on a volume-confirmed push through the ask overhang.

**Signals considered:**
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 14.974048308074373,
    "pct_change_4h_48h": 9.756521739130424
  },
  "rsi_14_4h": 72.93273231596238,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 0.20273725000000004,
    "slow_value": 0.18822032
  },
  "volume": {
    "ratio": 1.2027276029211935,
    "flag_above_2x": false
  },
  "order_book_imbalance_top10": -0.4092036689014099,
  "news_context": "Cardano Foundation x Mastercard cross-border payments/stablecoin partnership (15 Sep 2026); ADA joined x402 SDK for instant API payments (21 Sep 2026); ADA broke a falling trendline per press coverage."
}
```

---
### 2026-09-22T14:30:32.179Z — SUI/EUR — NO TRADE

**Reasoning:** By far the most extended move of any pair this cycle (1h 48h +24.3%, 4h 48h +20.3% - roughly 2-3x the size of every other pair's move), with strong technical confirmation across the board: volume 3.25x average (flagged), order book heavily bid-skewed (+0.58, the most bullish of all seven), SMA strongly bullish. On pure technicals this is the cleanest-looking setup of the cycle. The problem is the news check found no catalyst proportionate to a 24% two-day move - the only concrete, dated item was a minor GraphQL/API feature announcement (21 Sep), alongside an older (16 Sep) report calling short-term technicals 'decisively bearish' with a risk of breakdown toward $0.55, and a separate note that SUI is trading ~35% above a recent model-based price prediction. That combination - the single largest move in the lineup, on the lowest-liquidity pair of the seven (per the branch's own volume screen), with no identifiable fundamental driver of that magnitude - reads as a momentum/speculative spike at real risk of sharp mean reversion, not a fundamentally supported breakout. RSI 73.8 is elevated. This would only qualify as a momentum-only entry (capped at medium by code), and given the degree of extension I'd rather sit this one out than chase the most extended, least-explained move of the cycle on its first live day.

**Signals considered:**
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 24.259362772498598,
    "pct_change_4h_48h": 20.30443055178037
  },
  "rsi_14_4h": 73.82000965252826,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 0.802755,
    "slow_value": 0.7032839999999999
  },
  "volume": {
    "ratio": 3.247659302391874,
    "flag_above_2x": true
  },
  "order_book_imbalance_top10": 0.5831428714640352,
  "news_context": "No catalyst proportionate to the size of the move found; only concrete item was a minor GraphQL real-time-subscriptions feature announcement (21 Sep 2026); an older (16 Sep) report called short-term technicals bearish with breakdown risk toward $0.55; another source noted price trading ~35% above a recent model prediction."
}
```

---
### 2026-09-22T14:30:54.550Z — BTC/EUR — LONG — OPENED (LIVE)

- Entry price: €74971.00 (real fill, Kraken order OUPGAK-GXDUU-3PT4CX)
- Stop-loss: €71800.00 (real resting order O7BMG4-2M7YV-7KDW33)
- Take-profit target: €81313.00 (2:1 risk/reward, polled - not a resting order, see checkStops)
- Position size: 4% of portfolio (€200.00, qty 0.00266740)
- Entry fee (real): €1.60
- Confidence: medium — Strong volume confirmation (3.34x 7-day avg, flagged) and clear bullish trend (SMA fast well above slow) align with a genuinely supportive news backdrop (ETF-driven rally per press coverage). Held back from high by RSI at 76.2 (most overbought of the majors) and a essentially-flat order book (-0.01, no real bid-side confirmation at current levels) - real trend and volume support, but entering after a 7.4% 2-day move at this RSI carries real pullback risk, so sizing at medium (4% of 5% cap) rather than pushing to high/8%.
- Momentum-only trigger: no
- Invalidation: Thesis invalidated on a 4h close below the rising 20-period 4h SMA (currently ~72,063) - that line is the trend structure this entry depends on, and it's also the level portfolio_check_stops will trail beneath once the position is profitable.
- Signals supporting this trade:
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 7.402921268257927,
    "pct_change_4h_48h": 6.529363384939262
  },
  "rsi_14_4h": 76.18601896791469,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 72063.22,
    "slow_value": 69178.8
  },
  "volume": {
    "ratio": 3.3397948287682517,
    "flag_above_2x": true
  },
  "order_book_imbalance_top10": -0.012151536812008592,
  "current_price": 75187.4,
  "news_context": "Bitcoin rally attributed to ETF inflows (~$3.5B reported for the month); one source flags risk of a 'long flush' pullback after the rapid rise; price recovered sharply from an early-Sept dip (~$76-78k -> ~$85-86k per press reporting)."
}
```
- Position id: 9b1501f0-cd3d-413b-9746-ffd766756903

---
### 2026-09-22T14:31:08.178Z — SOL/EUR — LONG — OPENED (LIVE)

- Entry price: €101.68 (real fill, Kraken order OQHMJJ-LTXEI-RBDQVS)
- Stop-loss: €96.50 (real resting order OFHUSQ-NXEQX-DW3WTN)
- Take-profit target: €112.04 (2:1 risk/reward, polled - not a resting order, see checkStops)
- Position size: 4% of portfolio (€199.93, qty 1.96611752)
- Entry fee (real): €1.60
- Confidence: medium — Bullish trend (SMA fast well above slow), volume close to but under the 2x confirmation threshold (1.83x), and real, pair-specific news catalysts (250ms slot-time network upgrade completed 18 Sep, reported market outperformance/7.2% single-day surge, AI/tokenization narrative interest) rather than pure BTC-correlation. Held back from high by a moderately negative order book (-0.26, more resting asks than bids) and RSI at 69.7 (overbought). Medium sizing reflects real but not maximal conviction given the ask-side overhang.
- Momentum-only trigger: no
- Invalidation: Thesis invalidated on a 4h close below the rising 20-period 4h SMA (currently ~98.38) - matches the level portfolio_check_stops will trail beneath once the position reaches +1R.
- Signals supporting this trade:
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 9.517226712037418,
    "pct_change_4h_48h": 8.079847908745236
  },
  "rsi_14_4h": 69.70423883189324,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 98.38300000000001,
    "slow_value": 92.59
  },
  "volume": {
    "ratio": 1.8268585290752897,
    "flag_above_2x": false
  },
  "order_book_imbalance_top10": -0.2556938381315579,
  "current_price": 102.39,
  "news_context": "SOL cut slot time to 250ms on 18 Sep (network throughput upgrade); reported to have outperformed in a broad altcoin rally on 21 Sep with a 7.2% single-day surge, hitting best price since Jan 2026; cited as an 'AI stock alternative' for tokenized-asset/AI-agent growth narrative."
}
```
- Position id: 87ddf369-9a09-47e8-ac57-0598aa190726

---
### 2026-09-22T14:31:21.301Z — LINK/EUR — LONG — OPENED (LIVE)

- Entry price: €11.29 (real fill, Kraken order OWEOSJ-DWL5P-35ROD3)
- Stop-loss: €10.75 (real resting order OGU72B-VPHA7-ZJ37KJ)
- Take-profit target: €12.37 (2:1 risk/reward, polled - not a resting order, see checkStops)
- Position size: 4% of portfolio (€199.87, qty 17.70897070)
- Entry fee (real): €1.60
- Confidence: medium — Cleanest confluence of the cycle: RSI at 64.8 is the healthiest (least overbought) of all seven pairs, order book is bid-skewed (+0.21, real resting buy support rather than overhead supply), SMA bullish, and news carries multiple concrete, dated institutional catalysts (Coinbase selected LINK as oracle infra for tokenized US stocks on Base; Charles Schwab announced adding LINK alongside SOL/AVAX to its retail platform; Bottomline partnership serving 600+ banks; Chainlink founder scheduled at a Fed Reserve Bank meeting 24 Sep alongside BlackRock/Vanguard). No genuine contradicting signal, unlike ETH/ADA/XRP/SUI this cycle. Held at medium rather than high because volume (1.43x) doesn't clear the 2x confirmation flag.
- Momentum-only trigger: no
- Invalidation: Thesis invalidated on a 4h close below the rising 20-period 4h SMA (currently ~10.98) - matches the level portfolio_check_stops will trail beneath once the position reaches +1R.
- Signals supporting this trade:
```json
{
  "momentum_trigger": {
    "flagged": true,
    "pct_change_1h_48h": 8.230519265454292,
    "pct_change_4h_48h": 5.029700874734618
  },
  "rsi_14_4h": 64.79193149759834,
  "sma_crossover_4h": {
    "state": "fast_above_slow",
    "fast_value": 10.9838535,
    "slow_value": 10.336174000000003
  },
  "volume": {
    "ratio": 1.4274464333301713,
    "flag_above_2x": false
  },
  "order_book_imbalance_top10": 0.21316172217249696,
  "current_price": 11.37315,
  "news_context": "Coinbase selected Chainlink as official oracle infrastructure for tokenized US stocks on Base; Charles Schwab announced adding LINK (with SOL, AVAX) to its retail crypto platform; Bottomline partnership (600+ banks, $16T processed annually) drove a spike to ~$13.64 on 7 Sep; Chainlink founder Sergey Nazarov scheduled at a Federal Reserve Bank meeting 24 Sep alongside BlackRock/Vanguard executives."
}
```
- Position id: 836cb669-d4dd-403d-a562-c69ed336e2bf

---

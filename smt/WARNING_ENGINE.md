# Warning Engine — feasibility study and design

**Date:** 2026-09-16 · **Status:** research complete, **Tier 1 built and shipping** · **Verdict:** built, but not the version that was asked for.

> **What shipped** — see §10 for the file list and §11 for the one bug the live smoke test caught.
> The engine is a *path-and-tail-risk forecaster*. It never gates an entry, because §4.3 measured that doing so halves returns.

---

## 1. What was asked

A warning engine that reads a stock's history, trend and momentum and answers:

1. In what interval does a stock go up, and for what interval does it go down?
2. When is buying heavy and when is selling heavy — institutional buy/sell?
3. After a stock has gone up, in how many days does it come back down?
4. Emit a warning: *"HOLD, do not invest, it is high, it will come down in N days"* — so you stop buying at all-time highs and taking the loss that follows.

## 2. Method — how each claim was checked

Nothing below is quoted from memory or from the literature. Every number was measured on this machine on 2026-09-16.

| # | Check | How | Result |
|---|---|---|---|
| 1 | Is 10 years of daily history reachable? | `query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=10y&interval=1d` | OK — HTTP 200, **2,475 bars**, 2016-09-16 to 2026-09-16, 2,469 with volume, 0 null closes |
| 2 | Is that history split-adjusted? (unadjusted history would corrupt every drawdown stat) | Compared closes across RELIANCE's two 2:1 events (2017-09-07, 2024-10-28) | OK — **adjusted.** 376.11 to 374.01 and 1327.85 to 1334.35, no 50% gap. Confirms the note in `BE/src/services/yahoo.ts` that Yahoo reports an Indian bonus as a split |
| 3 | Per-stock institutional flow from NSE? | `api/historical/bulk-deals`, `block-deals`, `quote-equity`, `securityArchives` | **BLOCKED — 503 / 403**, and still 503/403 after a full cookie handshake against `nseindia.com`. Checked twice |
| 4 | Any NSE host not blocked? | `nsearchives.nseindia.com` | Not blocked — see §5 for exactly what it yields |
| 5 | Does overextension predict a fall? | 89 symbols x 10y = **191,010 observations**, bucketed by extension / RSI / 52w-range / run-up | **NO — the opposite.** §4.1 |
| 6 | Is that just market drift or survivorship? | Re-ran everything as **excess return over ^NSEI**, 188,336 obs | Conclusion unchanged and stronger. §4.1 |
| 7 | Does *anything* here predict negative returns? | Scanned 16 bearish-looking conditions | **None.** §4.4 |
| 8 | Does acting on the warning help? | Simulated buy-now vs wait-for-dip vs wait-or-skip, 5 parameterisations | **No — skipping costs about half the return.** §4.3 |
| 9 | Is *any* of it real? | Tail risk and dip timing by bucket | **Yes.** §4.2 |
| 10 | Is that one event or one regime? | Split into 4 sub-periods plus full sample excluding COVID | Holds in every period. §4.5 |
| 11 | Are per-stock cycle statistics stable enough to forecast with? | First 5y vs second 5y correlation, per symbol | **Only volatility is.** §4.6 — this single result dictates the design |

Universe: the 90 names in `BE/src/services/recommender/universe.ts` (LTIM 404s on Yahoo, so 89 usable). Scripts are in the session scratchpad.

## 3. What the codebase already has

The foundation is unusually good. Most of a warning engine already exists as measurement; what is missing is the judgement layer.

**Already built and reusable as-is:**

- `BE/src/strategies/indicators.ts` — ATR (Wilder), ADX, RSI, EMA/SMA, Bollinger, Donchian, Supertrend, MACD, VWAP.
- `BE/src/services/recommender/metrics.ts` — the strongest asset here. Per-symbol `Metrics` already computes `atrPct`, `volAnnualPct`, `maxDrawdown1yPct`, `pctOf52wRange`, `fromHighPct`, `infoDiscreteness`, `rsi14`, `adx14`, `volumeRatio`, `medianTurnover`, and skip-month momentum over three windows. **This module measures without judging** — exactly the seam a warning layer should attach to.
- `BE/src/services/accumulator/trend.ts` — regime classification with a neutral band and confirmation bars, plus anti-churn rate limiting. Directly reusable for "is this stock in an up-leg".
- `BE/src/services/futurestars/types.ts` — a `RiskFlag { kind, detail, severity, at }` type already exists with a severity scale.
- `BE/src/services/recommender/plan.ts` — `TradePlan.warnings: string[]`, already rendered by the UI at `FE/ismta/app/recommendations/page.tsx:543`.
- `BE/src/services/futurestars/shareholding.ts` — promoter stake change and pledge/encumbrance, with the asymmetry already correct (falling stake is a warning, rising is mild reassurance).
- `BE/src/routes/risk.ts` — a portfolio-level `{ level: 'warning' | 'critical', message }` alert shape.

**The gap:** every existing warning is about *sizing and liquidity* ("the stop is 27% away", "thinly traded"). Nothing warns about *path* — how rough the hold is about to be. And `RecommenderEngine` fetches only `range='2y'`, which is too little history for cycle statistics.

**One thing worth knowing:** `score.ts` currently ranks `pctOf52wRange` as **higher-is-better** — the system actively rewards buying near 52-week highs. That is the direct opposite of the request. §4 says the code is right and the request is wrong, so this should not be changed.

## 4. What the data says

### 4.1 The central premise is false

Buying high does not lose money in this universe. Excess return over NIFTY, 188,336 observations:

| Condition | n | +5d | +21d | +63d |
|---|---|---|---|---|
| **Baseline (everything)** | 188,336 | +0.16% | +0.67% | **+2.05%** |
| At the 52-week high (range >= 0.99) | 1,938 | +0.13% | +0.92% | **+3.45%** |
| RSI(14) > 80 | 1,768 | +0.32% | +2.10% | **+5.57%** |
| 6+ ATR above the 50-day EMA | 811 | −0.31% | +1.74% | **+6.30%** |
| Up >30% in 20 days | 1,336 | +0.78% | +1.87% | **+5.93%** |
| Up >50% in 20 days | 289 | +1.09% | +2.71% | **+11.76%** |
| Up >20% in 20d **and** RSI > 75 | 2,139 | +0.50% | +2.54% | **+7.81%** |

Every "dangerous" condition beat the market by more than the average stock did. This is not survivorship: it is measured *against the index*, and 68 of 89 symbols show positive mean 21-day excess returns individually, so it is broad rather than driven by a handful of winners.

This is the well-documented momentum and 52-week-high effect, and it is the effect `score.ts` is already built on. **A rule that says "it is high, do not buy" would systematically sell the best stocks in the universe.**

### 4.2 What is real: the *path*, not the *destination*

The run-up tells you nothing useful about where the stock ends up. It tells you a great deal about how uncomfortable the journey is.

| Condition | P(−5% dip within 63d) | Median days to it | P(−10% dip) | Median days |
|---|---|---|---|---|
| **Baseline** | 66% | **11 days** | 39% | 22 days |
| Up >20% in 20 days | 70% | 7 days | 43% | 15 days |
| Up >30% in 20 days | 71% | **5 days** | 46% | 12 days |
| Up >50% in 20 days | **82%** | **4 days** | 55% | 12 days |

And tail risk, which is the genuinely actionable part — P(63-day excess return worse than −20%):

| Condition | P(excess < −20%) | vs baseline | 1st percentile |
|---|---|---|---|
| **Baseline** | 4.0% | — | −28.9% |
| Up >30% in 20 days | 10.5% | **2.6x** | −43.4% |
| Up >50% in 20 days | 16.0% | **4.0x** | −48.2% |
| Quarter return > 100% | 9.2% | 2.3x | −52.2% |
| ATR > 5% of price | 13.0% | **3.3x** | −42.8% |
| RSI > 80 | 4.1% | 1.0x | −41.3% |
| 6+ ATR above EMA50 | 3.0% | 0.8x | −33.1% |
| At the 52-week high | 3.5% | 0.9x | −29.4% |

**Read the bottom three rows carefully.** RSI, distance above a moving average, and proximity to the 52-week high — the three things a conventional "overbought" warning fires on — carry *no excess tail risk whatsoever*. Only two things do: **the size of the recent run** and **the stock's absolute volatility**. A warning engine built on RSI would fire constantly and mean nothing.

### 4.3 Acting on the warning would have cost money

Simulated over the same data, 63-day holds, excess return over NIFTY:

| Setup | Buy now | Wait for −1xATR, buy anyway | **Wait, or skip if no dip** |
|---|---|---|---|
| Up >20% in 20d | +5.94% | +5.77% | **+3.49%** |
| Up >30% in 20d | +6.92% | +6.13% | **+3.53%** |
| Up >20% & RSI>75 | +7.80% | +7.56% | **+4.90%** |

Waiting and then buying anyway is a **wash** — within noise across all five parameterisations tested (1.0 / 1.5 / 2.0 ATR x 10 / 21 day windows). Waiting and skipping when no dip comes **halves the return**, because the stocks that never dip are the ones that ran away.

So the engine must never gate an entry. It can only inform one.

### 4.4 Nothing predicts a fall

Sixteen bearish-looking conditions were scanned — below the 200-day average, EMA20 under EMA50, volatility expansion, volume spikes into strength, 30%+ below the 52-week high, parabolic quarters, and combinations. **Every single bucket had a positive mean 63-day excess return.** The weakest was "below the 200-day average and in the bottom fifth of its 52-week range" at +1.38% (median −0.25%).

There is no condition in this feature space that justifies the words "will come down". There are conditions that justify "is likely to be volatile and could fall hard" — which is a different and honest sentence.

### 4.5 It holds across regimes

The tail-risk multiplier for a hot run-up is stable — 3.0x (2017–20), 2.6x (2020–23), 2.7x (full sample excluding COVID). For high absolute volatility: 3.6x, 2.4x, 4.9x, 3.6x. The dip-timing compression (11 days to 5 days) appears in every sub-period.

One exception, and it matters: **during the COVID window, hot stocks were the losers** — up >20% in 20 days returned −1.25% excess. That is the momentum crash the recommender's own disclaimer already warns about. It means an overextension warning is *insurance*: it costs a little most of the time and pays precisely when the market turns over. That is a legitimate reason to build it, but it must be sold as insurance, not as alpha.

### 4.6 The result that dictates the design

Split each stock's decade in half and ask whether the first half predicts the second (n=89):

| Per-stock statistic | Correlation, 1st half vs 2nd half |
|---|---|
| **ATR as % of price (volatility)** | **0.808** |
| Down-leg *duration* | 0.342 |
| Up-leg *duration* | 0.302 |
| Max drawdown | 0.236 |
| **Down-leg *depth*** | **−0.141** |

Volatility persists strongly — this is textbook volatility clustering, confirmed here on this exact universe. **Typical fall depth does not persist at all; the correlation is negative, i.e. pure noise.**

This kills the most intuitive version of the feature. An engine that says *"MARUTI historically falls 14% over 19 days, so expect that again"* is reading tea leaves — that statistic has no predictive content. Every forecast the engine makes must be denominated in **ATR**, the one thing that does persist. Which is what this codebase already does everywhere for stops and sizing.

For description only (not forecast), the swing decomposition across 3,384 up-legs and 3,369 down-legs at an 8% reversal threshold: median up-leg **24 days / +18.7%**, median down-leg **19 days / −13.7%**, about 7 swings per year.

## 5. Institutional buy/sell — mostly not available

| Source | Status | What it gives |
|---|---|---|
| `api/corporate-share-holdings-master` | OK 200 | Promoter %, public %, quarterly, 21 quarters. **Already wired** in `futurestars/shareholding.ts` |
| Shareholding XBRL | OK 200 | Pledge / encumbrance booleans. **Already wired** |
| `api/fiidiiTradeReact` | OK 200 | FII/DII buy/sell **for the whole market**, not per stock |
| `api/historical/bulk-deals` | 503 | Blocked, with and without cookie handshake |
| `api/historical/block-deals` | 503 | Blocked |
| `api/quote-equity` | 403 | Blocked — this is where live delivery % lives |
| `api/historical/securityArchives` | 503 | Blocked |
| `nsearchives/content/equities/bulk.csv` | 200, limited | Bulk deals with named counterparties and BUY/SELL — but **only the latest trading day** (178 rows, one date). No history |
| `nsearchives/.../sec_bhavdata_full_<DDMMYYYY>.csv` | OK 200 | Per-stock `DELIV_QTY` and `DELIV_PER` for the whole market, one file per day, back to at least 2022 (2019 404s) |

**The honest conclusion:** per-stock institutional flow as imagined is *not retrievable as history*. Bulk-deal data can only be accumulated forward from today, one file a day, and would take a year of collection before it could even be tested.

That is probably for the best. Earlier research on this repo already put bulk/block deals on the do-not-build list because the abnormal return happens *before* disclosure — by the time the deal is published, the move has happened. FII/DII flow signals and delivery % were rejected on the same pass (delivery % has no supporting literature, its sign is probably inverted for a liquid universe, and the thresholds drift with margin-rule circulars).

What *is* available and worth using is what is already built: **promoter stake change and promoter pledge**. Those are the best-evidenced ownership warnings for India, and the existing code already fetches both — they are simply not surfaced on `/recommendations`.

## 6. Proposed design

Not a veto engine. A **path forecast** attached to every recommendation and every open position.

### 6.1 The one-sentence spec

> Never tell the user not to buy. Tell them exactly how rough the ride will be, in ATR units, with the historical hit rate attached — and size the position so the ride is survivable.

### 6.2 New module: `BE/src/services/recommender/turbulence.ts`

Pure, no network, mirroring how `metrics.ts` and `score.ts` are split. Input: the `Metrics` object that already exists, plus the raw candles. Output:

```ts
export type WarningKind =
  | 'run-up-extended'      // 20d run-up in the top decile -> tail risk, not direction
  | 'high-volatility'      // ATR% above ~5 -> 3.3x tail risk
  | 'dip-imminent'         // P(-5%) and median days, from the run-up bucket
  | 'thin-liquidity'       // already computed, currently only in plan.warnings
  | 'promoter-selling'     // from shareholding.ts — currently unused here
  | 'promoter-pledged'     // from shareholding.ts — currently unused here
  | 'momentum-crash-risk'; // universe-wide: breadth collapse, the COVID case

export interface Warning {
  kind: WarningKind;
  severity: 'note' | 'caution' | 'serious';  // never 'do not buy'
  headline: string;
  detail: string;
  /** The historical base rate this is calibrated on, always shown. */
  evidence: { condition: string; n: number; stat: string; baseline: string };
}

export interface PathForecast {
  /** Expected drawdown before the thesis plays out, in ATR and in rupees. */
  expectedDipAtr: number;
  expectedDipPct: number;
  /** P(a 5% dip within 63 trading days) and the median days to it. */
  dipProbability: number;
  dipMedianDays: number;
  /** P(63-day excess return < -20%), against the 4.0% baseline. */
  tailRisk: number;
  tailRiskMultiple: number;
}
```

The bucket tables in §4.2 are embedded as constants with the `n` that produced them — so every warning can cite its own evidence on screen, which is the house style in this codebase.

### 6.3 What each warning actually says

Wrong (what was asked for):

> RELIANCE is at an all-time high. Do not invest. It will come down in 8 days.

Right (what the data supports):

> **Expect a bumpy entry.** BEL is up 34% in 20 sessions. Historically, stocks this extended saw a 5% dip within a median of **5 trading days** (71% of the time, n=1,336) — against 11 days for an average stock. Over 63 days they still *beat* the market by 5.9% on average, so this is not a reason to stay out.
>
> **It is a reason to size smaller:** the chance of a 20%+ underperformance is **10.5%, about 2.6x normal**. Consider entering in two tranches, and set the stop at 2.5xATR rather than 1.5x so the expected dip does not take you out.

### 6.4 Wiring

| Step | File | Change |
|---|---|---|
| 1 | `services/recommender/turbulence.ts` | **New.** Pure, roughly 250 lines |
| 2 | `tests/turbulence.test.ts` | **New.** Follows the existing hand-rolled assert pattern; add to the `test` script chain in `package.json` |
| 3 | `RecommenderEngine.ts` | `range: '2y'` to `'10y'` (verified available); call `turbulence()` after `buildPlan`; attach `warnings` and `pathForecast` to `Recommendation` |
| 4 | `recommender/plan.ts` | Widen the stop for `run-up-extended` names so the *expected* dip does not trigger it. This is the one place a warning should change behaviour |
| 5 | `futurestars/shareholding.ts` | No change — just call it from the recommender for shortlisted names only (~15 symbols, same pattern as news) |
| 6 | `FE/ismta/app/recommendations/page.tsx` | Extend the existing warnings block at line 543 into a severity-coloured panel with the path forecast |
| 7 | `routes/risk.ts` | Feed the same warnings for **held** positions — the higher-value half, since the user already owns these |

Roughly 2–3 days of work. No new dependency, no new data source, and no new network call except promoter data on about 15 shortlisted names.

### 6.5 Explicitly excluded, with reasons

- **Any veto or "do not buy" gate.** §4.3 — it halves returns.
- **RSI-based overbought warnings.** §4.2 — RSI>80 carries *baseline* tail risk. It would be noise dressed as a signal.
- **"At the 52-week high" warnings.** §4.1 — that condition *outperforms*. `score.ts` is right to reward it.
- **Per-stock fall-depth forecasts** ("it usually drops 14%"). §4.6 — correlation −0.141, no predictive content.
- **Bulk/block deals, FII/DII flow, delivery %.** §5 — unavailable as history and already rejected on evidence.
- **A "days until it falls" countdown.** The median days figure is a distribution statistic, not a date. Rendering it as a countdown would be the single most misleading thing this feature could do.

## 7. Verification checklist

- [x] 10y daily history reachable — 2,475 bars verified
- [x] History is split/bonus adjusted — verified across two RELIANCE events
- [x] NSE per-stock institutional endpoints — probed twice, blocked
- [x] `nsearchives` alternatives — probed; bulk deals latest-day only
- [x] Overextension vs forward returns — 191,010 obs
- [x] Repeated as excess over NIFTY — 188,336 obs, conclusion unchanged
- [x] Per-symbol breadth check — 68/89 positive, not a few outliers
- [x] Tail-risk measurement — done, the first real finding
- [x] Dip-timing measurement — done, the second real finding
- [x] Strategy simulation (buy now / wait / skip) — 5 parameterisations
- [x] Sub-period stability — 4 periods plus ex-COVID
- [x] Per-stock stability of every proposed statistic — this reshaped the design
- [x] Searched for *any* bearish condition — 16 tested, none found
- [x] Cross-checked against the repo's prior research verdicts — consistent
- [x] Live smoke test against real Yahoo data — `npm run verify:turbulence`, caught the §11 bug
- [x] End-to-end run through `RecommenderEngine` — turbulence attached, invariant holds, JSON serialises
- [x] Full suite after the change — 28 backend suites pass, both projects typecheck
- [ ] Out-of-sample validation on a universe that includes delisted names — **not done**, see §8
- [ ] Forward-collected bulk-deal dataset — **not started**, would take about 12 months

## 8. Honest limitations

1. **Survivorship.** The universe is *today's* large caps. Every one survived. Measuring excess-over-NIFTY removes most of the market drift, and the 2017–2020 sub-period where the average name returned −0.04% excess suggests the bias is not overwhelming — but a stock that went to zero is not in this sample, so the tail-risk figures are, if anything, **understated**.
2. **Overlapping observations.** Daily observations with 63-day forward windows are heavily autocorrelated, so the effective sample is far smaller than 189,000 — closer to 189,000/63, about 3,000 independent blocks. No significance tests are quoted for this reason. The per-symbol breadth check (68/89) and the four-way sub-period split are the robustness evidence instead.
3. **One market, one decade.** 2016–2026 Indian large caps, containing exactly one true crash. The COVID result (§4.5) rests on a single episode.
4. **The engine forecasts a distribution, not an event.** "Median 5 days" means half the time it is sooner and half later, and 29% of the time the dip never comes at all. The UI must carry that, or it will be read as a prediction.

## 9. Recommendation

**Build it — as a path-and-tail-risk forecaster, not a buy/sell gate.**

The highest-value piece is the one not originally asked for: run the same warnings against **positions already held**, where knowing "a 5% dip is likely within a week and it means nothing" is what stops a panic sale. Tier 1 (the pure module, the stop widening, the recommendations panel) is where nearly all the value sits, and is about two days of work.

What should **not** be built is the feature as first described. It was tested properly and it loses money — and the part of the codebase that currently rewards buying near highs is correct.

---

## 10. What was built

Tier 1 is complete: 28 backend suites pass (turbulence contributes 28 assertions), both projects typecheck, and a live smoke test runs against real Yahoo data.

| File | Change |
|---|---|
| `BE/src/services/recommender/turbulence.ts` | **New**, pure. The calibration tables from §4, the warning set, and the two actionable outputs (`requiredStopAtr`, `stageNowFraction`) |
| `BE/src/tests/turbulence.test.ts` | **New**, 28 assertions. Registered in `npm test` |
| `BE/src/scripts/verifyTurbulence.ts` | **New**. Live smoke test — `npm run verify:turbulence` |
| `BE/src/services/recommender/plan.ts` | `buildPlan` takes an optional `requiredStopAtr` floor. Defaults to 0, so every existing caller is unaffected |
| `BE/src/services/RecommenderEngine.ts` | Candles `2y` → `10y`; turbulence attached to each `Recommendation`; new `assessHoldings()` and `judgeDrawdown()` for held positions |
| `BE/src/routes/risk.ts` | New `GET /api/risk/holdings`. Deliberately separate from the cheap pollable snapshot |
| `FE/.../lib/types.ts`, `lib/api.ts` | `Turbulence`, `PathForecast`, `TurbulenceWarning`, `HoldingRisk` + the `holdingRisk()` client |
| `FE/.../recommendations/page.tsx` | `TurbulencePanel` under the plan; a one-line summary on collapsed cards, shown only above `note` severity |
| `FE/.../risk/page.tsx` | "Is this drawdown normal?" panel, loaded on demand |

**Calibration actually used.** Buckets are keyed on **ATR%**, not on the run-up — §4.2's 1-D table made the run-up look causal, but a run-up × volatility grid showed the column dominates and the row only bites inside already-volatile names. A hot month (≥20%) is applied on top as a ×1.4 tail multiplier and a ×0.7 on the days-to-dip.

| Bucket | n | dip (ATR) | P(−5%) | median days | tail risk | mean 63d excess |
|---|---|---|---|---|---|---|
| calm (ATR <2%) | 31,586 | 1.92 | 56% | 17d | 1.45% | +1.30% |
| ordinary (2–3%) | 89,658 | 1.89 | 66% | 12d | 2.69% | +1.31% |
| volatile (3–5%) | 59,530 | 1.58 | 70% | 8d | 5.93% | +2.94% |
| very volatile (≥5%) | 8,848 | 1.18 | 72% | 3d | 13.01% | +6.20% |

The 5–7% and 7%+ buckets were **merged deliberately**: measured separately their tail risk ran 14.2% then 10.4%, non-monotonic, almost certainly because the most extreme ATR readings cluster in the COVID recovery. Splitting them would be fitting one episode.

Note the last column. **Every bucket has a positive mean excess return**, and a test asserts it — if one ever goes negative the no-veto design needs revisiting rather than silently drifting.

### Guardrails encoded as tests

The risk with this feature is not that the arithmetic breaks; it is that it slowly turns back into the version that loses money. So the test file enforces the design rather than just the maths:

- a regex bans "do not buy", "avoid buying", "will fall" and similar from every generated string, across a grid of inputs;
- `stageNowFraction` may never reach 0;
- severity has no level above `serious`;
- past drawdown must **not** change the forecast — guarding the −0.14 persistence result;
- every warning must carry a non-empty baseline;
- a hot month may raise tail risk and pull the timing forward, but may **not** inflate the dip depth.

## 11. The bug the smoke test caught

Worth recording, because no unit test would have found it.

The stop widening was first written as a **multiplier**, calibrated against a 1.5× ATR stop. But the three horizons stop at 1.5×, 2.5× and 4× ATR. Scaling all of them by the same factor widened the long horizon — which already clears the expected dip twice over — and shrank its position for nothing. On live data, ADANIENT's medium-horizon position fell from 9 shares to 6 with no risk-management benefit at all.

The fix was to express it as a **floor** (`requiredStopAtr`) and have `buildPlan` take `max(spec.atrStopMult, floor)`. It now binds on short horizons, where a 1.5× stop genuinely does sit inside a 1.92× ordinary dip, and is a no-op on medium and long. Verified live:

```
IDEA   floor 1.82xATR   short  1.5xATR  13.61 -> 13.47  FLOOR BOUND  OK
                        medium 2.5xATR  12.96 -> 12.96  unchanged    OK
                        long   4xATR    12.25 -> 12.25  unchanged    OK
```

Two tests now pin this: one asserts medium and long are untouched, the other that a widened stop never yields a *larger* position.

## 12. Not built, and why

Tier 1 covers the recommendations panel, the stop floor, and held positions. Deliberately left out:

- **Promoter stake and pledge warnings.** `futurestars/shareholding.ts` already fetches both and they are the best-evidenced India-specific ownership warnings. They are not wired into `/recommendations` yet — this is the obvious next step and needs one network call per shortlisted name, following the same pattern as news.
- **`momentum-crash-risk`.** The `WarningKind` union reserves it, but nothing emits it. It needs a universe-wide breadth measure, not a per-stock one, and §4.5 rests on a single COVID episode — too thin to calibrate a live warning on.
- **Everything in §6.5**, unchanged.

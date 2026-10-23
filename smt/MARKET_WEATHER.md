# Market Weather — downturn warning system

**Date:** 2026-10-09 · **Status:** Phases 1–6 BUILT and verified, except the live allocator hook (backtested, OFF, awaiting the user's decision) · **Full report:** the "Market Weather Report" artifact · **Verification:** `VERIFICATION_2026-10-09.md`.

## What was built

| Phase | Files | Verified by |
|---|---|---|
| 1. Data and regime | `BE/src/services/marketWeather/{series,data,breadth,valuation,regime,calibrate,history}.ts`, `calibration.json`, `scripts/calibrateWeather.ts` (`npm run calibrate:weather [-- --check]`) | `tests/marketWeather.test.ts`; `--check` recomputes and fails on drift |
| 2. Odds, analogs, grades, summary | `odds.ts`, `summary.ts` (banned-phrase list) | same test file; every generated string is checked |
| 3. Sector playbook and book exposure | `sectors.ts`, `exposure.ts` | `tests/marketWeatherBook.test.ts` |
| 4. News classifier and event history | `events.ts` (15 labels, 42 dated events, FII/DII parser) | 31 labelled headlines (94% correct) plus the live false positives as regressions |
| 5. API, screen and alerts | `services/MarketWeatherService.ts`, `routes/marketWeather.ts` (`GET /api/market-weather`, `POST /refresh`), `FE/ismta/app/market-weather/page.tsx`, sidebar `g w` | headless Chrome screenshots in light, dark and phone views; the live server answers 401 without a token, so the route is up |
| 5b. Allocator hook | `SimOptions.buyBlock` in `backtest/accumulatorSim.ts`; `npm run sim -- --set X --years N --weather` | backtested only, NOT wired into the live engine; see below |
| 6. Verification | `scripts/verifyWeather.ts` (`npm run verify:weather`), `scripts/backrunWeather.ts` (`npm run backrun:weather`) | all 43 backend suites pass |

### Corrections to the research report, found while building

1. **Look-ahead in the research.** US, Brent and gold closes print after NSE closes. The research read them on the same date. With the previous close, as the engine now reads them, the "hold 50% while the S&P 500 is below its 200-DMA" rule loses its 2nd-half edge (−0.3 pp; the report said +0.7 pp). Only the breadth-divergence rule beats the matched mix in both halves (+1.7 / +2.1 pp).
2. **Breadth from 65 survivors was misleading.** On the full NIFTY 500, breadth today is 38%, not 19%.
   - The closest past states are "<50% above the 200-DMA": 18 episodes, including 2000 and 2008.
   - In those states the 12-month median was **+12%, the same as all days**, not +21%.
   - Another 10% fall within 3 months followed **25%** of those days (all days 21%), not 14%.
3. **Sector table.** On 15 falls since 2003 with full NSE industries, telecom (4 of 15) and IT (7 of 15) did not hold up. The report's 10 of 11 came from Bharti alone and five large IT names.
   - Held up: gold 8/8, healthcare 14/15, FMCG 13/15, oil & gas 12/15.
   - Led rebounds: construction, metals, capital goods, financials.
   - The guidance text is now generated from this table.

### The allocator hook: backtest result (2026-10-09)

The hook withholds buys for 63 sessions after a breadth divergence. Sells and the no-loss floor are untouched.

"Edge" below is the strategy's return minus an exposure-matched mix (same average exposure, rest in cash), in pp/yr.

| Universe | Window | Live edge (pp/yr) | Hook "pause all buys" edge (pp/yr) | Max drawdown, live → hook |
|---|---|---|---|---|
| ETFs | 10y | 4.21 | 3.39 | 7.6% → 3.5% |
| ETFs | 5y | 2.38 | 2.77 | 5.2% → 3.0% |
| Large caps | 10y | −1.18 | +1.31 (both halves ahead) | 26.3% → 7.6% |
| Large caps | 5y | −0.67 | −0.27 | 10.7% → 9.3% |
| Large caps + ETFs | 10y | 4.74 | 4.30 | 13.6% → 5.6% |
| Large caps + ETFs | 5y | 2.90 | 3.39 | 6.7% → 4.9% |

- **Return:** better in 4 of 6 runs.
- **Max drawdown:** lower in all 6.
- **Control:** the below-200-DMA version is worse everywhere.
- **Sample:** only about 5 divergence episodes fall in the 10-year window.

**It did not meet the bar set in advance (ahead in both halves on every universe), so it is not wired into the live engine.** Turning it on is the user's decision.

### What the back-run shows

The back-run uses data truncated at each date; grades come from today's calibration.

- **Hit:** 2018-08-28 read *stormy* (breadth divergence) and advised slowing new buying. The worst point over the next 3 months was −15%.
- **Misses:** the tops of 2010-11, 2015-03, 2020-01 (COVID), 2021-10 and 2024-09 all read *calm*.
- **At the 2020-03-23 bottom** it read *severe*, with guidance to buy in steps. NIFTY then rose 91% in 12 months.

This is the expected behaviour of an honest system: it cannot see most tops.

## Request

A system that predicts when a market downtrend will come, using:

- past market history ("after 3/6/12 months of rise a fall comes")
- wars and international news, and whether that news is positive or negative
- economic factors and government policy
- company data

It should also say which stocks would fall and which would rise.

## Verdict, measured on 1998–2026 data

| Claim | Result |
|---|---|
| A fall follows a 3/6/12-month rally | **False.** Odds of a 10% fall within 3 months are *lower* than normal after 0–50% yearly gains (14–16% vs 21% baseline). They are higher after falls (33%) and after rallies above 50% (35%). |
| Falls come in cycles | **False.** 19 falls of 10% or more since 1998. The gap from one recovery to the next peak ranged from 2 to 461 trading days. |
| Warning signs predict falls | 2 of 16 held in both halves of history: **breadth divergence** (index within 2% of its 52-week high while fewer than 60% of stocks are above their 200-DMA; about 6 independent episodes) and an **India VIX 5-day jump above 30%** (turbulence, not direction). India VIX above 25, oil shock and rupee shock flipped sign between the halves. |
| Acting on warnings pays | Only *S&P 500 below its 200-DMA → hold 50%* and *breadth divergence → hold 50% for 63 days* beat an exposure-matched blend in both halves (+5.4/+0.7pp and +1.7/+0.9pp). Both cut the 2nd-half max drawdown from −38% to −23%. Stacking signs into a composite score made results worse in both halves. |
| News and war events | War: median first day −0.7%, back to the pre-event level in 4 days, higher after 60 days in 65% of events. Wars got worse only when oil stayed high (2022, Oct 2024, 2026). Global financial shocks were worse: median worst point −9%, 15 days to recover. |
| Which sectors fall or hold | **Robust.** Held up during falls: gold (8 of 8), pharma (9 of 11), telecom (10 of 11), IT (10 of 11), FMCG (8 of 11). Led the 6 months after the trough: metals (9 of 11), private banks (9 of 11), capital goods (9 of 11). Down-day betas range from FMCG 0.50 to PSU banks 1.34. |
| Trade sectors on macro data after the fact | **Noise.** Net of each basket's normal drift, sector returns in the 3 months after an oil, rupee or yield shock first shows up are close to a coin flip. The sector move happens on impact day. |

**State on 2026-10-09:**

- NIFTY 22,486: −14.6% from its high, −7.4% vs its 200-DMA.
- Breadth 19%. India VIX 14.6. S&P 500 above its 200-DMA. Brent $103. RBI hiked on 8 Oct.
- PE 19.0 (lowest since the Apr 2021 consolidated-earnings switch); PB 2.73 (bottom 10% since 1999).
- 12 analog episodes since 2003; 10 have a full year of history since. 12 months later: median +21%, higher 86% of the time. Odds of another 10% fall within 3 months: 14% (baseline 21%).

## Guardrails (enforce as tests)

- No dates, price targets or "will fall" text.
- Every probability is shown with its baseline and episode count.
- Never sell at a loss; the most the system can do is slow new buying.
- News only labels an event and recalls its history.
- No composite score.
- Every number comes from `npm run calibrate:weather`.

## Phases

1. **Data + regime engine.** `services/marketWeather/{data,breadth,valuation,regime}.ts` plus `scripts/calibrateWeather.ts`.
   - Valuation endpoint: `POST https://www.niftyindices.com/BackPage/getpepbHistoricaldataDBtoString`, body `{"cinfo":"{'name':'NIFTY 50','startDate':'01-Jan-1999','endDate':'…','indexName':'NIFTY 50'}"}`.
   - Headers: browser User-Agent; no cookie needed.
   - PE breaks on 2021-03-31.
2. **Odds, analogs, evidence grades (A/B/C)** and the plain-language summary with banned-phrase tests.
3. **Sector playbook from NIFTY 500 industries + your-book exposure.** Exposure uses each holding's down-day beta and the book-level "NIFTY −10% → book −X%".
4. **News/event classifier.**
   - Google News RSS feeds the taxonomy and the playbook for the 44 catalogued events.
   - Escalation inputs: Brent days above $90, and FII/DII from `nseindia.com/api/fiidiiTradeReact` (accumulate forward).
   - Optional context: GPR-India from `matteoiacoviello.com/gpr_files/data_gpr_export.xls` (`GPRC_IND`) and India EPU.
5. **`/api/market-weather`, the `/market-weather` page and Notifier alerts.** The optional allocator `weatherMode: 'slow'` stays OFF. It ships only if it beats the matched baseline in both halves of `accumulatorSim`, and only with the user's OK.
6. **Verification.**
   - Full test suite and calibration re-run.
   - Back-run on 2020-01-14, 2020-03-23, 2022-02-24, 2024-09-26, 2026-03-02 and today, listing the misses as well.
   - `VERIFICATION_<date>.md`.

## Data traps found

- Yahoo has no history for NSE sector indices (^CNXFMCG etc. return one bar).
- niftyindices' historical index-data endpoint returned HTML for the request used.
- FRED's high-yield spread is capped at 3 years.
- An India VIX history endpoint on niftyindices was not found. Yahoo `^INDIAVIX` works from 2008.
- The sector baskets here use 65 of today's large caps, which gives survivorship bias. Phase 3 rebuilds them from NIFTY 500 constituents.

Research scripts: session scratchpad `mkt/s1–s9.mjs`, `pe.mjs`.

## Verdict, stock lists and glossary (added 2026-10-09, same day)

The user asked for a clear hold / invest / do-not-invest answer at the top, in plain language, plus stock-wise lists.

- **`verdict.ts`** returns one of three answers:
  - **INVEST AS PLANNED.**
  - **INVEST IN STEPS:** correction or worse, a VIX spike, or a stormy/severe level. The example splits ₹1,00,000 into 4 parts, with NIFTY step levels at −3.5%, −7% and −10.5% from today's close, or one part every two weeks.
  - **HOLD — PAUSE NEW MONEY:** only when a sign in `supportedSignals` is on.
- **There is deliberately no "sell" and no blanket "do not invest" answer.** Both lost money in the tests above. HOLD is the tested form of "don't invest now".
- **`stockCalls.ts`** scores the 89-stock `DEFAULT_UNIVERSE` plus the user's holdings. Every point carries a plain-words reason:
  - down-day beta (±2)
  - 12-1 trend rank within the universe (±2)
  - below its own 200-DMA (+1)
  - sector record in past falls (±1)
  - today's news type, via `events.ts EVENT_IMPACT` (±2, counted ONCE per side however many labels fire)
  - NSE surveillance (+3; such a stock never appears on the holding-up list)
- **The two lists:** "Be careful with these now" (score ≥3) and "Have tended to hold up better" (score ≤−2), with the top 10 of each. Holdings on the careful side are always listed.
- **On 2026-10-09:**
  - Careful: VEDL, RECLTD, CHOLAFIN, BAJFINANCE, TATASTEEL, BAJAJFINSV, JINDALSTEL, ADANIENT, AMBUJACEM, JSWSTEEL.
  - Holding up: TORNTPHARM, AUROPHARMA, DIVISLAB, OIL, ONGC, DRREDDY, MARICO, COALINDIA, SUNPHARMA, APOLLOHOSP.
- **Glossary:** FE `components/WeatherVerdict.tsx` has 16 terms, each explained with today's real numbers.
- **Tests:** in `marketWeatherBook` (19).

## Factor-study items 1–6, built (2026-10-09, same day)

Research: the "Market Weather Factor Study" artifact. Signs now have a **kind**, and each kind is graded on its own test:

- **warning:** a 10%+ fall within 63 sessions.
- **turbulence:** a 5%+ dip within 21 sessions.
- **calm:** the next 63 sessions beat the normal return by ≥1 pt in both halves.

The baseline for each sign is now measured over the days that sign can be read. Signs whose data starts after 2005 split their halves at their own midpoint.

| Item | Built | Result |
|---|---|---|
| 1. 52-week lows ≥10% | `newLowsSpread`; rule `newLowsHalf`; `npm run sim -- --weather` variants | Index rule ahead in both halves, but pausing the accumulator on it was WORSE than the live baseline in 4 of 6 backtests (ETF 10y −2.3 pp, ETF 5y −1.5, mix 10y −1.5, mix 5y −1.5; large caps +1.3 / +0.5). **Not an action sign.** Reclassified as turbulence (dip lift 1.29 / 1.77, A). |
| 2. Information signs | `adDivergence`, `dispersionHigh`, `defensiveRotation` (warning, all A); `volatilityHigh` (turbulence, A) | Shown with odds; they do not change the verdict |
| 3. Next-month panel | `spxMonthDown` (A), `vixSpike` (now turbulence, A), `vrpLow` (C, failed with expanding cut-offs), `newLowsSpread`, `volatilityHigh` | A graded turbulence sign makes the verdict "INVEST IN SMALLER STEPS" (5 × ₹20k at −4/−8/−12/−16%, or every three weeks), and makes the level at least unsettled |
| 4. Fear priced high | `vrpHigh` (calm, A: next 3m +11.5% / +6.8% vs about 3% normal) | Verdict "INVEST IN STEPS — MORE NOW" (₹40k now, then 3 × ₹20k). If turbulence is also on, the standard four steps are used. |
| 5. US curve re-steepening | `curveResteepen` (B, 5 + 3 episodes); new gauge `us3m` = ^IRX | Rule `curveHalf` shown in the table but deliberately NOT mapped to HOLD |
| 6. Recent-era base rate | Analogs `*Recent`; `SignalRead.oddsRecent / baselineRecent` | Summary line "Since 2012 … 9% of all days, 5% of days like today". The FE shows both rates. |

**False-alarm check (new, `calibration.levelAtHighs`, in-sample).** On NIFTY days within 5% of a high:

| Level read | Share of near-high days | Followed by a 10% fall within 3 months |
|---|---|---|
| stormy | 58% | 19.2% (14.4% in 2009–17, 21.6% in 2018–26) |
| calm | 32% | 3.4% |

The summary quotes this near highs and says most stormy readings were not followed by a fall.

**Back-run with the new signs:** the tops that read calm before now read stormy:

- 2010-11 (A/D divergence)
- 2015-03 (A/D divergence + dispersion)
- 2020-01 (curve re-steepening)
- 2021-10 (A/D divergence + dispersion)
- 2024-09 (defensive rotation)

The verdict there is invest in steps, not hold, except 2018-08 (breadth divergence → hold).

**Tests:** `marketWeather` 36, `marketWeatherBook` 21. All 43 suites pass.

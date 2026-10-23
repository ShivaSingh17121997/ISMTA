# Foreign Stocks recommender — build checklist and verification

**Built and verified:** 2026-10-09
**Page:** `/foreign-stocks` (sidebar "Foreign Stocks", `g f`)
**API:** `GET /api/foreign-stocks`, `POST /api/foreign-stocks/refresh`

**What it is:** a ranking of US-listed companies an Indian investor can buy through LRS:

- the S&P 500 (503), plus
- 28 large foreign companies listed in the US (TSMC, ASML, Novo Nordisk, Toyota and others).

It reuses the Indian recommender's medium-horizon scorer: `recommender/metrics.measure` and `recommender/score.scoreHorizon`.

Every item was checked on this machine on 2026-10-09. Evidence types:

- **T** = a named test in `BE/src/tests/foreignRecs.test.ts`
- **L** = the live run `npm run verify:foreign`
- **B** = the point-in-time backtest
- **S** = headless-Chrome screenshots

## Code analysis — what was reused, and what had to change

| Existing piece | Reused as is? | Change needed |
|---|---|---|
| `measure()`: volatility-adjusted 12-1 / 6-1 momentum, 200-day, ATR, turnover | Yes | Given 320 bars ending at the date, never later (`measureAt`) |
| `scoreHorizon('medium')`: sector-relative percentile ranking, illiquid/downtrend veto | Yes | GICS sectors instead of NSE industries; dollar eligibility (price ≥ $5, median turnover ≥ $20m/day) |
| `vetoReason()` text | No | It says "₹2 crore"; foreign rows get dollar wording (`usdVetoReason`) |
| NSE sector cap (25%) | Idea reused | `pickTop`: at most 4 of 20 picks per sector, shared by the live page and the backtest |
| `yahooSymbol()` | No | It turns `AAPL` into `AAPL.NS`; foreign bars are fetched raw (`foreign/candles.ts`) |
| Yahoo fundamentals | Not usable (dead, per earlier research) | SEC XBRL frames API (free, about 85 requests for 15 years) |

## Checklist

### Data

| # | Check | Result | Evidence |
|---|---|---|---|
| C1 | Universe loads: S&P 500 list plus ADRs | ✅ 531 companies (503 + 28), 502 of 503 S&P members matched to SEC filings | L |
| C2 | Price history for every company | ✅ 531 of 531, 0 failed. 527 have the 280+ bars needed to score (4 recent listings do not) | L |
| C3 | Share classes map to Yahoo form (BRK.B → BRK-B); quoted CSV fields parse | ✅ | T `C3` |
| C4 | Prices split-adjusted; dividends not included | ✅ Yahoo close is split-adjusted (checked on NSE data 2026-09-16). Dividends are excluded and stated on the page | page note |
| C5 | Fundamentals are point in time: a fiscal year is used only 120 days after it ends | ✅ | T `C5` |
| C6 | Quality directions: higher profit and cash are better; accruals, debt and profit instability are worse; leverage is skipped for financials | ✅ | T `C6` |

### Method

| # | Check | Result | Evidence |
|---|---|---|---|
| C7 | Weak finances: veto or flag decided by the test, not by taste | ✅ The veto **failed** (see C13), so weak finances are a ⚑ flag. The exclusion path stays tested for the comparison. | T `C7`, B |
| C8 | Measuring at a date never reads a later bar | ✅ | T `C8` |
| C9 | The backtest cannot profit from information it did not have | ✅ Rank at month t, earn month t+1 (jump test). **A stock enters the universe only from the date it joined the S&P 500.** Without this, momentum looked far better (21.0% vs 14.6% a year) because companies join after big runs. | T `C9`, B |
| C10 | All reasons are in dollars, never rupees or crores | ✅ The live run throws if "₹" or "crore" appears in a reason | T `C10`, L |
| C11 | No more than 4 of 20 picks from one sector, applied identically in the backtest and live | ✅ On 2026-10-09 it held Energy to 3 and IT to 4 (uncapped, the top 20 had 9 IT names) | T `C11`, L |
| C12 | Downtrend and liquidity vetoes apply | ✅ 276 of 527 are in a downtrend today and cannot be picked; famous names among them (Broadcom, Caterpillar, Costco, Netflix, Oracle, Tesla, Walmart) appear under "not now" with the reason | L |

### Evidence

All backtest figures in this section are in USD, monthly, Feb 2012–Oct 2026 (177 months), split at May 2019.

| # | Check | Result | Evidence |
|---|---|---|---|
| C13 | What the page recommends beat holding everything equally, in both halves | ✅ **Top 20, max 4 per sector: 14.5%/yr vs 12.8%.** Edge +0.9 / +2.6 points per year; worst fall −21% vs −25%. | B |
| C14 | The weak-finances veto, tested the same way | ❌ as an exclusion. The junk basket returned 14.8%/yr (more than the rest) but fell harder (−31% worst). With the veto, the list returned 14.4% with a −17% worst fall. Decision: flag, not exclude. | B |
| C15 | Costs in the test | ✅ 0.1% per switch. The one-off 1.5–2.5% rupee-to-dollar conversion is shown on the page; every alternative pays it too. | B, page |
| C16 | Rupee view | ✅ USD/INR 96.76; dollar +10.0% vs the rupee in 12 months, added to rupee returns | L |

### Investor safety

| # | Check | Result | Evidence |
|---|---|---|---|
| C17 | How to buy: LRS route, position size (≤5% per stock), buy in steps, review monthly | ✅ | page |
| C18 | Tax, TCS, Schedule FA and US estate-tax facts (FY2026-27) | ✅ Shared with Global Markets (`global/access.ts`, researched 2026-10-09) | page |
| C19 | Survivorship stated | ✅ Companies that left the index after collapsing are missing; the page says this flatters every line, the junk basket most | page |
| C20 | Not advice | ✅ SEBI disclaimer on the page | page |

### Delivery

| # | Check | Result | Evidence |
|---|---|---|---|
| C21 | Page renders: desktop light and dark, phone 400px; no console errors; no horizontal scroll | ✅ After fixing two bugs the screenshots caught: unkeyed fragments in the picks table, and the Next/SWC dropped-space-after-`</b>` bug (11 places) | S |
| C22 | Whole backend suite passes | ✅ 45 of 45 suites, including `foreignRecs` (9) | `npm test` |
| C23 | Typecheck and lint clean | ✅ BE and FE `tsc --noEmit`, FE `eslint` on the new files | – |
| C24 | Live server serves the route | ✅ `GET /api/foreign-stocks` answers 401 without a token, so the route is registered; the service starts 90s after boot and refreshes every 12h | curl |

## The list on 2026-10-09 (top 10 of 20)

| # | Company | 1 year ($) | Note |
|---|---|---|---|
| 1 | Marathon Petroleum | +146% | |
| 2 | Phillips 66 | +114% | ⚑ weak finances |
| 3 | Valero | +173% | |
| 4 | Dell | +249% | |
| 5 | Expeditors International | +60% | |
| 6 | Hewlett Packard Enterprise | +172% | ⚑ weak finances |
| 7 | Fortinet | +119% | |
| 8 | AMD | +163% | |
| 9 | Illumina | +171% | |
| 10 | Humana | +30% | ⚑ weak finances |

- The other ten include Moderna (⚑), MetLife (⚑), Mitsubishi UFJ (Japan) and Target.
- **Read this list with today's context.** Three US refiners lead because Brent is at $104 (an oil-war rally). The momentum edge is about +1–3 points a year on average, and a list like this can change quickly.

## Known gaps, not built

- **No news or earnings-date veto** for US stocks. Google News works for them, but this has not been tested.
- **No SEC finance flag for 57 companies:** the ADRs file 20-F, not 10-K, plus a few other filers.
- **Mild look-ahead from restatements:** SEC frames carry the latest reported values.
- **Survivorship from removals:** dropped companies are missing from the backtest (C19).
- **No order placement:** this is research only. Zerodha has no LRS execution, so buying is manual on an LRS platform.

## Files

- **Backend services:** `BE/src/services/foreign/{universe,candles,fundamentals,score,backtest}.ts` and `services/ForeignRecsService.ts`
- **Route:** `routes/foreignStocks.ts`
- **Script:** `npm run verify:foreign [-- --dump f] [-- --rebuild-backtest]`
- **Tests:** `tests/foreignRecs.test.ts`
- **Frontend:** `FE/ismta/app/foreign-stocks/page.tsx`
- **Cache:** `BE/.cache/foreign/`
  - `bars/`: about 530 files
  - `sec/`: about 85 frame files
  - `backtest.json`: refreshed weekly

---

# v2: plans, reasons, bouncing back, news (built and verified 2026-10-14)

**Plan:** `FOREIGN_RECS_PLAN_V2.md`

**What v2 adds to the page.** The page now has three tabs:

- **Top picks:** the v1 list, unchanged. Each stock gains:
  - a plan: buy zone, review level and 6-month range;
  - graded reasons (A/B/C);
  - the analysts' consensus;
  - its next results date;
  - headlines and SEC 8-K events.
- **Bouncing back:** stocks 20–75% below their high that have turned up.
- **News & events:** sector moves, market headlines, a "read before buying" list, and headline tone per company.

**Evidence keys:**

- **T** = test in `BE/src/tests/foreignV2.test.ts` (26)
- **L** = `npm run verify:foreign`
- **B** = point-in-time backtest (`foreign/bounceBacktest.ts`)
- **S** = screenshots (scratchpad harness: snapshot served in place of the API, so the live server is never touched)
- **M** = manual check against the source

## Data

| # | Check | Result | Evidence |
|---|---|---|---|
| D1 | Nasdaq targets, surprises, revisions and earnings calendar answer for S&P names and ADRs | ✅ The analyst target was present on 35 of 35 listed names | L |
| D2 | SEC submissions carry 8-K item codes | ✅ | L, T `N4` |
| D3 | Quarterly coverage | ✅ Of 503 S&P companies, 97.0% have a latest-quarter revenue and 95.4% a year-ago match. Financials: 66 of 76. A third revenue tag was added because Valero had none without it. | L |
| D4 | Year-ago quarter matched by date (±45 days), never by row count; year-to-date facts ignored | ✅ | T `D4` ×4 |
| D5 | Estimate-revision coverage ≥ 50% | ✅ 22 of 35 names (63%), so the line stays | L |
| D6 | A failed or empty response leaves a blank card and never throws; disk cache with a stale fallback; one request per host every 0.5–0.7s | ✅ | T `D6` |
| D7 | Spot-check against the source | ✅ Marathon's quarter revenue matches SEC companyconcept exactly: $51.994B vs $33.799B, +53.8%. ❌ **Insider "open market buys" failed:** Nasdaq gave Nvidia 23 and MetLife 86 in a year, which includes plan or grant acquisitions, and every pick showed "insiders bought". **Removed.** | M |

## Method

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Main ranking unchanged by v2 | ✅ The same 20 tickers, order and scores as the baseline captured before any change (checked after each round of fixes) | L |
| R2 | Bounce price gates; a deeper fall never scores higher; falls of 40% or more are badged "higher risk" | ✅ | T `R2` ×2 |
| R3 | Rejections carry their reason. Business problems are flags; a red 8-K or the news veto rejects. | ✅ Live: 40 shown rejections ("still falling" 31, "not turned yet" 9) | T `R3`, L |
| R4 | A stock appears once: main picks are excluded from the bounce list | ✅ | code |
| R5 | Reasons are in dollars; no "will go up" or "guarantee" (the live run throws if either appears) | ✅ | T, L |

## Targets and plan

| # | Check | Result | Evidence |
|---|---|---|---|
| T1 | Analyst upside may be negative and is shown as such | ✅ Live: 10 of the 20 momentum picks are already above their consensus target | T, L |
| T2 | Review level is below the price and at most 25% away; a 200-day average above the price is never used | ✅ | T `T2` |
| T3 | The 6-month ±1σ range is calibrated | ✅ **69.8%** of 21,671 outcomes landed inside (aim ≈ 68%): 20.6% above, 9.6% below. The skew is upward drift plus survivorship. | B |
| T4 | Analyst-target track record | ❌ **Not measurable from free data.** Nasdaq's `historicalConsensus[].y` is the stock PRICE that month, not the target. The audit exposed this by reporting "median promised upside 0.0%". The feature was removed, and a test guards against reading `y` as a target. | L, T |
| T5 | Earnings within 7 days produce "wait until after results" | ✅ Live: Travelers (16 Oct), Intuitive Surgical (20 Oct), SAP (21 Oct) | T, L |

## Bouncing back: evidence (B)

This is a monthly test, 2012-01 to 2026-10, split at May 2019. A stock enters only after its S&P "Date added". Costs are 0.1% per switch.

| Line | Return / yr | 1st half | 2nd half | Worst fall | Avg names |
|---|---|---|---|---|---|
| Every stock, equally | 12.8% | 13.1% | 12.5% | −25% | 385 |
| Any stock 20–75% below its high | 13.7% | 13.8% | 13.7% | −36% | 79 |
| **Fallen and turned up (price rules only)** | **20.5%** | 23.9% | 17.2% | −36% | 10 (18 empty months) |
| …plus profitable and finances not weak | 14.9% | 16.5% | 13.4% | −36% | 6 |
| …top 5 by finances | 15.0% | 18.1% | 12.1% | −38% | 3 |

| # | Check | Result |
|---|---|---|
| B1 | Price-only rule beats equal weight in both halves | ✅ +10.8 / +4.7 points |
| B2 | Survivorship stated with the same-bias comparator | ✅ On the page. Delisted companies such as SVB and First Republic have no free price history. |
| B3 | **Ship gate:** the business-gated rule beats BOTH comparators in both halves | ❌ **13.4% vs 13.7%** for the fallen basket in the 2nd half. Per the plan, the section ships as a **watch-list with no money plan**. Business problems are ⚑ flags (the same decision as v1 C14), and clean businesses are listed first. The price-only rule passes both comparators (`pricePassed`). |
| B4 | Year-by-year table shown | ✅ The price rule lost to the market in 6 of 15 years: 2015, 2017, 2019, 2020, 2021 and 2022 |

## News and events (N)

| # | Check | Result | Evidence |
|---|---|---|---|
| N1 | Google News US edition works per company | ✅ | L |
| N2 | US phrases score correctly, and Indian scoring is byte-for-byte unchanged | ✅ Phrases covered: guidance cut/raised, Chapter 11, beats expectations, short seller, all-time high, downgraded | T `N2` ×2 |
| N3 | Wrong-company headlines are dropped | ✅ Live finds fixed: "Coca-Cola Consolidated" (a different company) and "PNB MetLife" (an Indian joint venture). Tested: "Apple Hospitality", "price target" ≠ Target Corp, "IT" ≠ Gartner, "American Express" ≠ American Airlines. Duplicate titles count once. | T `N3`, M |
| N4 | 8-K items translated. Red items withhold money: 1.03 bankruptcy, 2.04 debt acceleration, 3.01 delisting notice, 4.02 non-reliance. | ✅ | T `N4` |
| N5 | News never changes rank | ✅ Same as R1 | L |
| — | The "read before buying" list excludes routine items | ✅ Officer changes (5.02) flagged nearly every name, so the count was 19; the list now uses red items and 1.02, 1.05, 2.05, 2.06, 3.02, 4.01 and 5.01, which gives 5. Stock-picking listicles are kept out of market headlines. | S, T |

## Delivery (X)

| # | Check | Result |
|---|---|---|
| X1 | Backend suite, typechecks and lint | ✅ All 47 backend suites pass. BE and FE `tsc --noEmit` clean. FE `eslint` clean on the changed files. |
| X2 | Page renders: desktop light and dark (1440), phone (400), on all 3 tabs | ✅ 0 overflow, raw-float, NaN or page errors. **Fixed after looking at the screenshots:** the phone detail card was clipped inside the sideways-scrolling table (now pinned); "−0.0%" and red-coloured zeros; "better than 100% of stocks"; a fall shown as 27% in the reason vs 26% in the table (two different highs). |
| X3 | No promise wording | ✅ Guarded in the live run |
| X4 | Not-advice disclaimer | ✅ Includes "No list can say a stock will go up." |
| X5 | Live server safety | ✅ Built after NSE close (16:43 IST). Every live check ran outside the server or against a recorded snapshot. |

## v2 files

- **New backend files:** `BE/src/services/foreign/{http,quarterly,nasdaq,secEvents,usNews,plan,bounce,bounceBacktest}.ts`
- **Changed backend files:**
  - `ForeignRecsService.ts`
  - `scripts/verifyForeign.ts`
  - `recommender/news.ts` (adds the exported `toneWith`; Indian scoring is unchanged)
- **Tests:** `tests/foreignV2.test.ts`
- **New cache entries under `BE/.cache/foreign/`:**
  - `nasdaq/`
  - `news/`
  - `sec/q_*` and `sec/sub_*`
  - `bounce-backtest.json` (weekly)

## v2 known gaps

- **Gates the backtest cannot see:** SEC events and the news veto have no point-in-time history.
- **Live vs backtest profit check:** the backtest's loss rule uses annual accounts; live also checks the latest quarter.
- **ADRs:** they have no 8-K events and no SEC quarterly figures, and the card says so.
- **Analyst targets:** shown as opinion, with no track record (see T4).

---

# v2.1: short, intermediate and long-term targets + "Start here" (2026-10-14)

**Request:** "where are the top recommended stocks to invest in now, and what targets for short-term, intermediate and long-term view".

**Where it is:** Foreign Stocks → Top picks.

- **"Start here" box:** the top 5 picks with nothing to wait for. Each shows its buy zone, 1-month, 6-month and 1-year targets, and its review level.
- **Each pick's "Why & plan" card:** has a "Targets by horizon" table.
- **"Where the targets come from" card:** shows the study behind the targets.

**Method** (`BE/src/services/foreign/horizons.ts`, cached weekly as `.cache/foreign/horizon-study.json`):

1. The live list was rebuilt point in time at every month end since 2012, using the same scorer, sector cap, "Date added" filter and 120-day SEC lag.
2. Each pick's return over the next 21, 126 and 252 trading days was recorded in units of its own volatility (z).
3. The 25th, 50th and 75th percentiles of z, applied to a stock's price and volatility today, give its range and typical outcome.

**Why volatility buckets.** Returns did not grow in proportion to volatility. The median 1-year z was 0.64 for the calmest third of picks, 0.54 for the middle and 0.41 for the wildest. One scale for all would have promised a 120%-volatility stock +87% a year. So:

- the percentiles are fitted per volatility third;
- the drift part uses a volatility capped at the bucket's 90th percentile;
- the spread uses the stock's own volatility.

## Checks

| # | Check | Result | Evidence |
|---|---|---|---|
| H1 | At each horizon, past picks beat the average stock in BOTH halves | ✅ 1 month: +1.3/+1.3% vs +1.0/+0.9%. 6 months: +7.7/+8.2% vs +6.5/+5.9%. 1 year: +14.4/+15.2% vs +12.5/+11.3%. Picks were up 57%, 67% and 70% of the time. | L |
| H2 | Out of sample (fit on 2012–19, tested on 2019–26 with the exact target formula): ~50% inside the range, ~50% above the typical outcome | ⚠️ Inside the range: 46% (1 month), 51% (6 months), **41% (1 year: range too narrow)**. Above the typical outcome: 45%, 46%, 45% (**slightly optimistic**). Before the bucket fix these were 41–44%. Both caveats are printed on the page. | L |
| H3 | Overlapping monthly samples are disclosed | ✅ On the page | page |
| H4 | Targets only where the study applies | ✅ Bounce-backs get no horizon targets, and the card says why | T, S |
| H5 | "Start here" skips picks with results due within 7 days, money held back, or weak finances, and keeps rank order | ✅ Live: MPC, VLO, EXPD, DELL, FTNT. Skipped: PSX (weak finances). | T, L |
| H6 | The main ranking is still unchanged | ✅ Identical to the baseline | L |
| H7 | Tests, typecheck, lint, screenshots | ✅ `foreignV2` 32 tests pass; all 47 backend suites pass; BE and FE `tsc` clean; `eslint` clean; 12 screenshots with 0 problems. Fixed after looking at them: two different 6-month ranges in one card (the old ±1σ line is now hidden where horizon targets exist), and a "0%" coloured red. | T, S |

---

# v2.2: "Start here" shows 20+ with View more, and the case for each stock (2026-10-14)

**Request:** "show at least 20 with a view-more option, and give the reason it is suggested and why it will continue to grow".

**What changed:**

- **More names.** The top 20 alone had only about 15 ready names, so a **second tier (ranks 21–40)** was added. It is built by `pickNextTier`, the same scorer and 4-per-sector cap, applied to the stocks left after the top 20.
- **Its own evidence.** The horizon study measures the second tier separately (`stats2`), and its targets come from its own fit.
- **"Start here" layout.** It shows 20 by default. **View more** reveals the rest (32 on 2026-10-14). Names left out are listed with the reason.
- **"Why?" on every row** opens three columns:
  - **Why it is suggested:** rank, the strongest signals, and the trend.
  - **Why it may keep rising:** each line graded.
    - **A:** the measured 1-year history of stocks at that rank.
    - **B:** sales growth with rising margins; strong finances.
    - **C:** analysts raising forecasts; earnings beats.
  - **What could go wrong:** always at least one line. It can include weak finances, shrinking margins, losses, price above the analysts' target, forecast cuts, results due, high swings, several names in one sector, and the reversal rate.

  The same panel also sits at the top of each pick's "Why & plan" card.

| # | Check | Result | Evidence |
|---|---|---|---|
| S1 | The second tier never overlaps the top 20 and keeps its own sector cap | ✅ | T |
| S2 | The second tier has a measured edge of its own | ✅ It beat the average stock in both halves at all horizons, but by less than the top 20. 1 year: tier 2 +13.2/+13.2%, top 20 +14.4/+15.2%, all stocks +12.5/+11.3%. Up a year later: 69% vs 70%. The order (top 20 > tier 2 > all) is itself a check that the ranking works. | L |
| S3 | Wording never promises ("will", "guarantee"), and every outlook has at least one risk | ✅ Tested, and the live run throws on either | T, L |
| S4 | The top 20 is still unchanged | ✅ Identical to the baseline | L |
| S5 | Default 20 rows; View more shows all ready names; the "Why?" panel stays readable on a phone | ✅ 20 → 32 rows, desktop and 400px phone, 0 page errors, 12 screenshots with 0 problems. Fixed: "Already **+7%** above target" now reads "7% above". | S |
| S6 | Suites | ✅ `foreignV2` 35 tests; all 47 backend suites pass; BE and FE `tsc` and `eslint` clean | T |

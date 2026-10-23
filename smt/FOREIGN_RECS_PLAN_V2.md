# Foreign Stocks v2: implementation plan

**Written:** 2026-10-14
**Status:** BUILT 2026-10-14. Results for every check, and the three places the build departed from this plan, are in `FOREIGN_RECS_CHECKLIST.md` under "v2". The departures:

1. The bounce-back business gates became ⚑ flags, because check B3 failed.
2. The insider line was dropped, because the data failed check D7.
3. The analyst-target track record (T4) was dropped, because Nasdaq's history holds prices, not targets.

**Extends:** `/foreign-stocks`. The v1 build and its 24 verified checks are in `FOREIGN_RECS_CHECKLIST.md`.

**What you asked for:**

1. Recommended stocks, each with targets.
2. A list of stocks that are bouncing back.
3. The reasons each one could go up, including the fundamentals behind it.
4. US and foreign news analysis.
5. A checklist for all of it, verified.

## 0. Research already done, with results

Every source below was fetched from this machine on 2026-10-14. Nothing is assumed.

### Data sources

| Need | Source | Result |
|---|---|---|
| Analyst price targets (low / mean / high, buy / hold / sell counts) | `api.nasdaq.com/api/analyst/{T}/targetprice` | ✅ Works for S&P names and ADRs (AAPL $338 mean, TSM $553). Needs a browser User-Agent. Gives **12 months** of monthly consensus history, so it **cannot** be backtested over years. |
| Next earnings date | `api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` | ✅ One call per day returns every company reporting that day |
| Earnings surprise (last 4 quarters) | `api.nasdaq.com/api/company/{T}/earnings-surprise` | ✅ NVDA: +6.2%, +10%, … |
| Estimate revisions (up/down, last 4 weeks) | `api.nasdaq.com/api/analyst/{T}/earnings-forecast` | ✅ Works, but NVDA showed 0 up / 0 down, so coverage may be thin. Check before scoring on it. |
| Insider buys/sells | `api.nasdaq.com/api/company/{T}/insider-trades` | ✅ Counts for 3 and 12 months |
| Company events (8-K item codes) | `data.sec.gov/submissions/CIK##########.json` → `filings.recent.items` | ✅ NVDA: `2.02` results, `5.02` officer change, `1.01` material agreement. Structured, so no text guessing. |
| Quarterly revenue and EPS for every filer | SEC frames, `CY2026Q2` | ✅ 4,224 companies in one call for diluted EPS |
| Headlines per stock | Google News RSS, `hl=en-US&gl=US` | ✅ Real Reuters/Barron's headlines for Nvidia |
| Yahoo fundamentals | `quoteSummary` | ❌ Still "Invalid Crumb". Do not use. |
| Prices for delisted companies (SIVB, FRC) | Yahoo chart | ❌ "No data found". Survivorship **cannot** be fully removed with free data (see B2). |

### Prototype backtest of "bouncing back" rules

- **Universe:** S&P 500 at each date. A stock enters only once its "Date added" has passed.
- **Method:** monthly, 2012-01 to 2026-10, 178 months. Hold for the next month, with a 0.1% switching cost.
- **Script:** `scratchpad/bounce_bt.js`, run against `BE/.cache/foreign`.
- **Columns:** edge 1 and edge 2 are the edge over holding all stocks equally, in each half. The halves split at May 2019.

| Rule | CAGR | Edge, half 1 | Edge, half 2 | Worst fall | Avg names |
|---|---|---|---|---|---|
| All stocks equally (baseline) | 11.9% | — | — | −25% | 385 |
| Near the 52-week high (within 5%) | 10.4% | −1.5 | −1.4 | −22% | 134 |
| 20–75% below the high (any) | 13.5% | +1.7 | +1.5 | −36% | 79 |
| …and still below its 50-day average ("still falling") | 13.7% | +0.8 | +2.9 | −35% | 55 |
| …and above its 50-day average only | 11.0% | −1.6 | −0.1 | −40% | 24 |
| **…above the 50-day, 50-day rising, 3-month return positive** | **20.8%** | **+12.4** | **+5.6** | −36% | 10 |
| …same, plus above the 200-day | 18.1% | +12.6 | +0.3 | −46% | 5 |
| 40–75% below the high, bouncing | 4.0% | −4.4 | −11.2 | −48% | 1 |
| Last month's 10% worst losers | 12.7% | +2.0 | −0.3 | −39% | 38 |

**How to read this, honestly:**

1. **The full bounce rule is the only one with a large edge in both halves.** The year-by-year result is lumpy:
   - It beat the market in 9 of 15 years.
   - 2013, 2014 and 2023 carry most of the gain.
   - It lost to the market in 2017, 2019, 2020, 2021 and 2022.
   - It held about 10 names, and in some months none qualified.
2. **Survivorship inflates every "fallen stock" line.** Companies that fell and were then removed from the index (SVB, First Republic) are missing, and Yahoo no longer has their prices. That is why even "still falling" looks positive here, which contradicts the momentum literature.
   - The fairer comparison is bounce rule vs "20–75% below the high", since both carry the same bias. The bounce rule still wins: about +10 points in half 1 and +4 in half 2.
   - Treat the absolute numbers as an upper bound.
3. **Very deep falls (40–75%) lost money even with survivorship helping.** The live list should keep the 75% cap and treat anything 40%+ down as higher-risk.
4. **Buying near the 52-week high lost slightly here.** The George–Hwang effect did not show up in today's S&P 500.

**Verdict:** build "Bouncing back" as a **separate, smaller, C-graded section**, not mixed into the main picks. It ships only if the in-repo version of this test, with the fundamental gates added, still beats both comparators in both halves (check B3).

### What the evidence says about "targets" and news, so the page doesn't overpromise

- **Analyst consensus targets are optimistic on average.** Studies of 12-month targets find a large share are never reached within the year. **Inference:** show the target as the analysts' view, with its own measured track record (check T4). Never present it as our forecast.
- **Our own targets should be ranges built from the stock's own volatility (ATR):** entry zone, review level and an expected 6-month range. A single price promise is not something any model can stand behind.
- **US post-earnings drift has largely faded in large caps since the 2000s.** Earnings surprises go on the "why" card as evidence, graded B/C, and do not drive the ranking unless a backtest earns it.
- **News headlines carry a small, short-lived effect,** the same finding that shaped the Indian recommender (`smt-recommender` notes: Tetlock).
  - News is used to **withhold** money when bad news arrives, and to **explain** moves. It is never used to rank.
  - Structured SEC events are more reliable than headline wording: accounting non-reliance (`4.02`), bankruptcy (`1.03`), delisting notice (`3.01`), CEO/CFO exit (`5.02`), impairment (`2.06`).

## 1. What will be built

### 1A. "Why it can go up" card, on every pick and every bounce-back name

Each line shows a number, a date and a grade, so you can check it yourself.

| Line | Source | Grade | Role |
|---|---|---|---|
| Trend strength: 6- and 12-month risk-adjusted momentum and sector rank | existing scorer | A | ranks (unchanged) |
| Revenue growth, TTM vs a year ago, **matched by date** | SEC quarterly frames | B | shown, plus a flag if negative |
| Margin direction: net margin now vs a year ago | SEC quarterly frames | B | shown; growth without margin gets a ⚑ (the Jegadeesh–Livnat rule used in Future Stars) |
| Cash-backed profit, ROA, debt | existing quality screen | B | shown; junk ⚑ stays a flag, as decided in v1 C14 |
| Last 4 earnings surprises | Nasdaq | C | shown |
| Estimate revisions (4 weeks) | Nasdaq | C | shown if coverage holds (check D5) |
| Insider buying vs selling | Nasdaq | C | shown; open-market **buys** count, routine sells do not |
| Analyst consensus: rating, target, upside | Nasdaq | display only | with its track record (T4) |

### 1B. Targets and plan per stock

All levels come from the stock's own ATR and averages, so they are the same kind of number for every stock.

- **Buy zone:** last close down to one typical dip (`DIP_ATR = 1.75` × ATR, already in v1). Buy in 2–3 steps.
- **Review level, a soft stop:** the higher of the 200-day average and entry minus 3 × ATR. A close below it means re-check, and for momentum picks it means exit, the same rule that removes names from the list.
- **Expected 6-month range:** price × (1 ± 6-month volatility). Shown as "typical outcome range", not a target. Both ends are printed.
- **Analyst target:** a separate column, labelled as theirs.
- **Earnings warning:** if earnings are within 7 days, "wait until after results" is shown. This is a risk rule, not a prediction.
- **Size:** at most 5% per stock (v1 C17), with the existing LRS cost and tax notes.

### 1C. "Bouncing back" section

These are stocks that fell hard, have stopped falling, and still have a working business. The Indian Turnarounds rules (`smt-turnarounds`) are reused where they apply.

**Every gate must pass:**

1. Price is 20–75% below the 52-week high. This is a filter, never a score, so a deeper fall earns no extra credit.
2. Close is above the 50-day average.
3. The 50-day average is rising (now vs 20 days ago).
4. The 3-month return is positive.
5. The company is profitable on trailing twelve months.
6. Not in the bottom 20% on quality (here junk is a **veto**, because a falling price plus weak finances is distress).
7. No SEC red-flag event (4.02, 1.03, 3.01) in 90 days.
8. No news veto.

**Ranking inside the list:** quality score and revenue/margin direction. Not depth.

**Plan:**
- Entry is a **level**: a daily close above the 50-day average, already true when listed.
- Stop: the 20-day low × 0.96.
- **12-month time stop.**
- The whole section is capped at 15% of the foreign allocation.
- Names 40%+ down carry a "higher risk" badge, per backtest finding 3.

**Rejected names are shown with the reason** ("still falling", "loss-making", "accounting red flag"), the same way v1 shows "not now".

### 1D. News and events, per stock and market-wide

**Per stock (picks and bounce-backs only, about 40 names, so the feeds aren't hit too often):**
- Google News for 7 days, scored with the existing hand-written lexicon and bigram layer.
- The US-wording gaps are fixed first (check N2).
- Broker-call parsing is reused (Jefferies, Morgan Stanley …) as **display only**.
- SEC 8-K events for 90 days, translated to plain words. Red-flag items veto.
- **News veto:** 3 or more strongly negative scored headlines in 7 days, or a red-flag 8-K, means the money is withheld and the reason is shown. This is the same threshold as India and is not retuned.

**Market-wide:**
- A short "what is moving US markets" panel built from the S&P 500 and sector ETF moves, plus top headlines.
- Context only. It never changes a ranking.
- The existing Market Weather work is the model for this.

## 2. Checklist and how each item will be verified

Evidence types:
- **T** = named unit test
- **L** = live run (`npm run verify:foreign`)
- **B** = point-in-time backtest
- **S** = screenshots
- **M** = manual spot-check against the source website

Status: ✅ verified 2026-10-14 · ⏳ to verify during build.

### Data

| # | Check | Status | Evidence |
|---|---|---|---|
| D1 | Nasdaq target, rating, surprise and earnings-date endpoints answer for S&P names and ADRs | ✅ | probe |
| D2 | SEC submissions give 8-K item codes per filing | ✅ | probe (NVDA) |
| D3 | SEC quarterly frames cover the universe (≥ 90% of S&P CIKs have revenue for the last 4 quarters) | ⏳ | L |
| D4 | Year-ago quarter is matched **by date (±45 days)**, not by row count. This trap bit Future Stars twice. | ⏳ | T |
| D5 | Estimate-revision coverage measured. If under 50% of names have non-zero revisions, the line is hidden. | ⏳ | L |
| D6 | Nasdaq rate limit respected: cached 24h, ≤ 2 requests a second, a failure leaves the card blank and never blocks the list | ⏳ | T, L |
| D7 | Five random cards match nasdaq.com and sec.gov by hand | ⏳ | M |

### Method

| # | Check | Status | Evidence |
|---|---|---|---|
| R1 | Main ranking unchanged by v2 (same top 20 as before for the same day's data) | ⏳ | T |
| R2 | Bounce gates each have a test, including "deeper does not score higher" | ⏳ | T |
| R3 | Loss-making, junk, red-flag 8-K and still-falling names are rejected **with the reason shown** | ⏳ | T, L |
| R4 | A stock can't appear in both main picks and bounce-backs, or the plan shows once, under main | ⏳ | T |
| R5 | All levels are in dollars with ₹ equivalents; no "crore" (v1 C10 guard extended) | ⏳ | T |

### Targets

| # | Check | Status | Evidence |
|---|---|---|---|
| T1 | Buy zone < price < analyst target is not assumed. Upside can be negative and is shown as such. | ⏳ | T |
| T2 | Review level is always below the entry and never more than 25% away | ⏳ | T |
| T3 | Expected range calibration: over the backtest, about 68% of 6-month outcomes should land inside a ±1σ range. Report the actual hit rate. | ⏳ | B |
| T4 | Analyst target track record: hit rate of the Oct-2025 consensus by Oct-2026 across the universe. Only 12 months of history exist, so this is one cross-section, labelled as such. | ⏳ | L |
| T5 | Earnings within 7 days → "wait" banner | ⏳ | T |

### Bounce-back evidence

| # | Check | Status | Evidence |
|---|---|---|---|
| B1 | Price-only bounce rule beats equal weight in both halves | ✅ +12.4 / +5.6 (prototype) | B |
| B2 | Survivorship stated on the page, with the "same-bias comparator" result | ✅ researched; ⏳ page copy | B, page |
| B3 | **Gate to ship:** the in-repo backtest, with fundamental gates (profit, quality veto), still beats both equal weight and "20–75% below high" in both halves | ⏳ | B |
| B4 | Year-by-year table shown, so losing years (2017, 2019–2022) are visible | ⏳ | page |

### News

| # | Check | Status | Evidence |
|---|---|---|---|
| N1 | Google News US works per company | ✅ | probe |
| N2 | Lexicon checked on 50 real US headlines; US phrases fixed ("beats estimates", "guidance cut", "downgrade", "Chapter 11") and each fix gets a test | ⏳ | T |
| N3 | Company-name matching: no wrong-company headlines. This was the India broker-call trap, and the US risks are Meta/"meta", Apple Hospitality, Alphabet vs Google. | ⏳ | T, M |
| N4 | 8-K item codes translated; 4.02, 1.03 and 3.01 veto | ⏳ | T |
| N5 | News never changes rank, only veto or display (asserted) | ⏳ | T |

### Delivery and safety

| # | Check | Status | Evidence |
|---|---|---|---|
| X1 | Backend suite, typecheck and lint clean | ⏳ | `npm test`, `tsc` |
| X2 | Page: desktop light and dark, phone 400px, no console errors (watch the SWC `</b>` space bug) | ⏳ | S |
| X3 | Wording never says "will go up" or "guaranteed". Reasons are "why it ranks well" with grades. | ⏳ | review |
| X4 | Not-advice and own-use disclaimer kept (SEBI) | ⏳ | page |
| X5 | No backend edits while the server runs in LIVE mode (ts-node-dev restarts it). Build against a stopped or paper server. | ⏳ | process |

## 3. Build order

Each step ends with its checks green before the next starts.

1. **Data layer** (`BE/src/services/foreign/`):
   - `nasdaq.ts`: targets, ratings, surprise, revisions, earnings calendar, insider trades. Cached 24h.
   - `secEvents.ts`: 8-K items from submissions.
   - Extend `fundamentals.ts` with quarterly revenue, net income and EPS frames.
   - Checks D1–D7.
2. **Why card and targets** (`foreign/plan.ts`, pure), wired into `ForeignRow`. Checks R1, R5, T1–T2, T5.
3. **News** (`foreign/news.ts`): reuse the recommender news and broker-call modules with US settings and the lexicon fixes. Checks N2–N5.
4. **Bounce-back** (`foreign/bounce.ts`), plus its own backtest line in `backtest.ts`. Checks R2–R4 and B3. **If B3 fails, the section ships as a watch-list with no funding plan, and the page says why.**
5. **Frontend:** new tabs on `/foreign-stocks`: *Top picks* · *Bouncing back* · *News & events*, with an expandable why/plan card per row. Check X2.
6. **Calibration and final checks:** T3, T4, B4, X1–X5. Update `FOREIGN_RECS_CHECKLIST.md` with the results.

**Rough size:** about 6 new backend files and 1 page rewrite, similar to v1.

## 4. What this will NOT claim

- That any stock "will go up". The measured edge of the main list is about +1–3 points a year over holding everything equally. The bounce list's edge is larger but lumpy and survivorship-flattered.
- That analyst targets are forecasts we stand behind.
- That news predicts price. It only withholds money or explains.

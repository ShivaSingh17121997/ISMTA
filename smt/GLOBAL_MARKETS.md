# Global Markets — which countries are strongest, in rupees

**Built:** 2026-10-09 · **Page:** `/global-markets` (sidebar "Global Markets", `g o`) · **API:** `GET /api/global-markets`, `POST /api/global-markets/refresh`

## What it does

- **Ranks 25 markets** (24 foreign, plus India for reference) on country momentum: the mean percentile of 12-1 and 6-1 month returns, each divided by volatility. Everything is measured in RUPEES (local index × currency vs USD × USD/INR).
- **Names leading companies** in each market, from about 130 hand-picked large caps ranked inside their own market, and lists the 15 strongest worldwide that are in an uptrend.
- **Shows how to invest from India** for each market (`services/global/access.ts`, researched on 2026-10-09).
- **Shows live premiums** for India-listed international ETFs: NSE price vs AMFI NAV.
- **Runs a monthly backtest** in rupees from 2005, split into halves.

## Findings on 2026-10-09

**Strongest markets (in rupees, last 12 months):**

| Market | 12-month return | Correlation with India |
|---|---|---|
| Taiwan | +90% | 0.19 |
| Singapore | +34% | – |
| South Korea | +113% | 0.16 |
| Canada | +23% | – |
| Japan | +49% | – |
| India (for reference) | −12% | – |

- **Concentration:** the Korea and Taiwan rallies come from a few AI-chip names (SK Hynix +385%, Samsung +233%, MediaTek +267%). The page flags this.

**Chasing momentum did NOT work** (`rankingWorked=false`). Results are against holding all 23 foreign markets equally:

| Strategy | Return/yr | Worst fall | Edge vs equal weight, 1st / 2nd half |
|---|---|---|---|
| Equal weight, all 23 | 10.0% | −46% | – |
| Top 3 by momentum | 9.0% | −63% | −0.2 / −1.9 pp |
| Top 5 by momentum | 8.4% | −62% | −2.7 / −0.7 pp |
| Top 3, uptrend only | – | about −30% | +5.9 / −3.9 pp |

- The uptrend filter cuts the worst fall but its edge flips sign between halves.

**What did hold up is diversification:**

| Mix | Return/yr | Worst fall | 1st half | 2nd half |
|---|---|---|---|---|
| 70% India + 30% S&P 500 | 12.5% | −50% | 13.7% | 11.4% |
| 100% India | 11.6% | −56% | 14.7% | 8.8% |
| 50/50 | 12.9% | −47% | – | – |

- The mix was worse than India during India's 2005–15 boom and better since.

**ETF premiums over NAV (all six above NAV):**

| ETF | Premium |
|---|---|
| HNGSNGBEES | 5% |
| MON100 | 12% |
| MAHKTECH | 34% |
| MAFANG | 57% |
| MASPTOP50 | 65% |
| MONQ50 | 108% |

- The cause is the overseas investment caps plus SEBI's 7 Sep 2026 price-band change.
- A NAV-based band returns on 1 Apr 2027.
- Most international MFs were shut to lump sums on 8 Oct 2026.

## Files

- **Services:** `BE/src/services/global/{universe,data,rank,backtest,access}.ts` and `services/GlobalMarketsService.ts`.
  - Refresh: 6-hourly, with a 45s boot delay.
  - Cache: `.cache/global/`, plus `navall.txt` from AMFI.
- **Route:** `routes/globalMarkets.ts`.
- **Script:** `npm run verify:global [-- --dump f]`.
- **Tests:** `tests/globalMarkets.test.ts` (10).
- **Frontend:** `FE/ismta/app/global-markets/page.tsx`.

## Limits and traps

- Index prices exclude dividends.
- The stock lists are today's giants (survivorship bias).
- Thailand (^SET.BK) and Saudi Arabia (^TASI.SR) are excluded: Yahoo returns a single bar for them.
- `yahooSymbol` turns bare tickers into NSE ones, so `global/data.ts` fetches RAW.
- Yahoo returned null bars on 8 Oct for India ETFs. `parseYahooChart` drops them.
- Tax and LRS facts (FY2026-27) are in `access.ts` `INVESTING_ABROAD_FACTS`.
- Fund availability changes weekly.

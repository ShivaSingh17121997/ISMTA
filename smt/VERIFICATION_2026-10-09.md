# Verification — Market Weather (2026-10-09)

Scope: everything in `MARKET_WEATHER.md` Phases 1–6. Everything below was run on this machine on 2026-10-09.

## Tests

- `npm test` (BE): **all 43 suites pass**. Two are new:
  - `marketWeather`: 30 tests
  - `marketWeatherBook`: 16 tests
- Typecheck: `tsc --noEmit` is clean in BE and FE. `eslint` is clean on the changed FE files.
- `npm run calibrate:weather -- --check`: `calibration.json` matches a fresh recomputation.

## Live checks

- `npm run verify:weather` built a real snapshot in about 10 seconds.
  - Inputs: 9 gauges, 499 of 501 NIFTY 500 histories, live valuation (PE 19.02 / PB 2.73), live FII/DII (8 Oct: FII −₹12,944 cr, DII +₹10,703 cr), 12 news queries with 0 failures.
  - No banned phrases appeared in any live text.
- The running server (port 4000) serves `GET /api/market-weather`. It returns 401 without a token.
- FE `/market-weather` was screenshotted in headless Chrome at 1400px (light and dark) and 400px (light), with the API answered from the live snapshot.
  - No console errors.
  - No horizontal overflow at 400px.

## Bugs found by verification, not by unit tests

1. **`yahooSymbol` sent `BZ=F` as `BZ=F.NS`** (404). Brent, USD/INR and gold were silently missing.
   - Fix: symbols containing `=` now pass through unchanged.
2. **News classifier false positives on the first live run:** 8 active events, most of them false.
   - Examples: a hockey line-up read as India–Pakistan; "TCS shares rise on AI" read as an AI shock; "Dow futures rise" read as a global sell-off.
   - Fix: war labels need a conflict word; shock labels need a damage word and no gain word; oil words must sit near the spike word.
   - Those headlines are now regression tests.
3. **The back-run tripped the banned-phrase guard on 2022-02-24.** The sign label "India VIX jumped 30%+ in 5 days" reads as a forecast window.
   - Fix: past-window labels now say "over the last N days/months".
   - A test now checks every label and detail.
4. **Look-ahead in the research.** US, Brent and gold closes are now read at the previous close. That removed the S&P 500 rule's 2nd-half edge (details in `MARKET_WEATHER.md`).

## Side effect to know about

The backend runs under `ts-node-dev --respawn`, so each saved backend file restarted the running server: 8 restarts between 11:25 and 11:42 IST.

- The Zerodha session had ended at 06:00 IST and was not reconnected, so trading was on paper.
- The audit log shows no orders and no halts in that window. The only order of the day, a SYRMA paper buy, was at 10:26, before the first restart.

## Not built

- The live allocator hook (see the backtest table in `MARKET_WEATHER.md`).
- FII/DII history only builds forward, because NSE serves today only. The 5-session sum appears after 5 recorded days.
- Signal grades come from full-sample calibration. The back-run truncates prices but not grades.

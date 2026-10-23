# System check: 13 Oct 2026 (after market close)

**Verdict: everything is working.** 75 of 75 checks passed. One check was first counted as a failure, but the test was wrong (A1). Two problems were found: a wrong warning text (fixed) and a log message that repeats every minute (not fixed, needs your OK).

**How it was tested without touching the live server or the broker**
- Your database was read with `find()` only; nothing was written.
- The API and pages were tested on a **copy of the app** in a separate process: your real data, a throwaway login secret, no database connection (so it cannot save anything), and no broker keys (so it cannot reach Zerodha). The real frontend was pointed at that copy; any write it attempted was blocked.
- The live server on :4000 was only read: `/health`, plus checking that its books are being saved every minute.

**Account state found:** trading mode is **paper**, and the Zerodha session is **expired**. Both open lots (SYRMA 11 shares, ETERNAL 5 shares) are paper lots. No real money is at risk right now.

## 1. Build and automated tests
- [x] T1 Backend type check: clean
- [x] T2 Backend production build (`npm run build`): exit 0
- [x] T3 Backend test suites: **46 of 46 passed** (incl. the 17 force-sell tests)
- [x] T4 Frontend type check, whole app: clean
- [x] T5 Frontend lint, whole app: clean
- [x] T6 Frontend unit tests: 17 of 17 passed

## 2. Data integrity on your real data (22 books, 91 orders, 6 lots)
- [x] I1 No book is halted
- [x] I2 No sale by the bot booked a loss (4 closed lots, all profitable)
- [x] I3 Every closed lot: P&L = proceeds − cost
- [x] I4 Every open lot sits on an open ladder with its rung marked as bought
- [x] I5 No open ladder without lots
- [x] I6 Cash never negative; every pending (T+1) credit positive
- [x] I7 Lot ids unique
- [x] I8 Every open lot is on its book's venue (paper/live)
- [x] I9 Every filled bot order is recorded in its book (fill audit, 91 orders)
- [x] I10 No order stuck as pending
- [x] I11 Every open lot: buy price < break-even < target
- [x] I12 Switched-on books have money or lots (ETERNAL ₹1,990, SYRMA ₹68,950)

## 3. API (copy of the app, your data)
- [x] A0 A call without login is refused (401)
- [x] 40 GET endpoints: **all succeeded**, none failed. 37 returned 200. Market Weather, Global Markets and Foreign Stocks returned 202, which means "still computing"; that is normal on a cold start.
- [x] A1 Sell preview is exact. ETERNAL 5 × ₹320.45 = ₹1,602.25 − ₹17.59 charges (₹13.50 DP + GST + STT) = ₹1,584.66, the same as the cost model to the paisa. *First counted as a failure because my test assumed charges < 1%; the flat DP charge makes them 1.1% on a ₹1.6k lot. The test was wrong, not the code.*
- [x] A2 Sell after hours: refused (409) with the same reason the preview shows; nothing sold

## 4. Every page in a real browser (copy of the app, your data)
- [x] P1–P17 Dashboard, Accumulator, ETERNAL, SYRMA, Analytics, Audit, Backtest, Foreign Stocks, Global Markets, Market Weather, Recommendations, Risk, Settings, Strategies, System, Tax, Live Trading: **all load, 0 crashes, 0 console errors, 0 server errors**
- [x] P18 Sell button shows on exactly the 2 stocks holding lots
- [x] P19 Sell dialog on real data: lists the lot, estimates, loss warning, "can't sell right now (exchange closed)", confirm button disabled

## 5. Live server (read-only)
- [x] L1 `/health` OK
- [x] L2 The scheduler is running: the switched-on books were saved 41 seconds before the check

## Problems found
| # | Problem | Status |
|---|---|---|
| F1 | On **paper** lots the Sell dialog said "It is real money once sold" | **Fixed**: paper now says no real money moves; live keeps the real-money warning. Checked on screen. |
| F2 | **Audit log flood:** 806 of 819 audit rows in 24h (98%) are one message repeated every minute: "Autopilot wanted scalp but it is uneconomic: SEAMECLTD has no budget". SEAMECLTD is switched off with ₹0, but its Autopilot is on. | **Not fixed, needs your OK.** Quick fix: switch Autopilot off for SEAMECLTD. Code fix: skip Autopilot on switched-off books and log a repeated refusal only once. Harmless to trading, but it buries real events in the audit log. |

## Not tested
- A real sell order: the market is closed and the account is on paper. The full sell path is covered by the automated tests with the paper broker.
- Zerodha itself: the session is expired, and the copy had no keys by design.

# Force sell — checklist

**What it is:** a **Sell** button on each stock that has open lots. You pick one or more lots, see the estimated result at today's price (real charges included), and confirm. The bot then sells those lots **at market, now, even below cost**.

This is a deliberate, user-only override of the no-loss rule. The bot itself still never sells below cost. Only a human pressing this button can.

## Design decisions

| Question | Decision | Why |
|---|---|---|
| Which order path? | The same loop the engine uses (`AccumulatorEngine.executeDecisions`), not a copy | That loop holds every live-money safety: order row before send, save + flush after each fill, partial-fill halt, unknown-state halt, CDSL/IP halts, funds release. A second copy would drift. |
| Order type | MARKET, CNC, `intent: exit` | A user who says "sell now" wants a fill. Zerodha MARKET orders carry `market_protection`. A LIMIT could sit unfilled and halt the book. |
| Does the rung re-arm after a forced sale? | **No** | The forced price is below the lot's cost, so the price is at or below its rung. Re-arming would buy the same rung back on the next tick. |
| Bot buying again afterwards | "Stop new buys" checkbox, **on by default**, engages the kill switch **before** any order | Selling everything closes the ladder, and the next tick could open a new one at once. The allocator never releases a kill switch (AllocatorEngine `candidate`). |
| Concurrency | Waits up to 30s for the book's in-flight step, then holds the same per-book lock | Otherwise the scheduler could sell the same lot in the same minute. |
| Halted book | Refused | A halt means the book may not match the broker. Selling against it could sell shares that aren't there. |
| No-loss switched off | Allowed | Off means "the bot leaves it alone", and a human can still act. |

## Checklist (each item verified by a test or a code read)

### A. Pure core — `accumulator/engine.ts`
- [x] A1 `forceSellLot` closes exactly the named lot at the actual fill price; `pnl` can be negative; `forced: true` is recorded.
- [x] A2 Proceeds go into the T+1 `unsettled` queue, never straight into cash.
- [x] A3 The sold rung is NOT re-armed (`filledLevels` unchanged), even with `rearmSoldRungs` on.
- [x] A4 The epoch closes when its last open lot is force-sold.
- [x] A5 Throws on an unknown lot, a price ≤ 0, or a halted book.
- [x] A6 `sellLot` is unchanged: it still refuses any sale below breakeven (regression).

### B. Service — `AccumulatorEngine.forceSell`
- [x] B1 Refused, with a clear reason and no order sent, when: no lots chosen, an unknown lot, book halted, market closed, the book's lots are on the other venue, broker not connected, live with a simulated feed.
- [x] B2 Waits for an in-flight step and holds the per-book lock while selling.
- [x] B3 Uses the shared order loop: pre-trade gate, order row saved before send, MARKET + CNC + `intent: exit`, tag `accumulator:<lotId>`.
- [x] B4 After a fill the book is saved + flushed (same code as the engine).
- [x] B5 A partial fill halts the book (same code as the engine).
- [x] B6 "Stop new buys" engages the kill switch before the first order; the next engine step buys nothing.
- [x] B7 Works on a book whose no-loss mode is off.
- [x] B8 Logged as a FILL event, so it reaches the audit trail and the alert notifier.
- [x] B9 The scheduler's own step behaves exactly as before (all existing service tests pass).

### C. Read side
- [x] C1 Banked profit and win rate include forced losses honestly.
- [x] C2 The tax ledger books a loss-making forced sale (FIFO).
- [x] C3 The fill audit does NOT flag a forced sale as an unbooked fill.
- [x] C4 A preview endpoint returns per-lot estimated net proceeds and P&L from the real cost model (incl. the DP charge), and places no order.

### D. API — `routes/accumulator.ts`
- [x] D1 `GET /api/accumulator/:symbol/force-sell/preview` returns lots + estimates + whether a sale is possible right now, with the reason if not.
- [x] D2 `POST /api/accumulator/:symbol/force-sell` requires `{ confirm: true, lotIds: [...] }`; returns per-lot outcome. 400 without confirm, 404 unknown book, 409 when refused.

### E. Screen
- [x] E1 A **Sell** button appears in the table row and on the phone card, only when the stock has open lots.
- [x] E2 The dialog lists each lot (qty, buy price, cost, est. proceeds, est. P&L) with checkboxes, all ticked by default.
- [x] E3 It shows the total and warns in red when the sale books a loss; the confirm button names the amount.
- [x] E4 A "Stop new buys on this stock" checkbox, on by default.
- [x] E5 When a sale is impossible right now (e.g. market closed), the dialog says why and the confirm button is disabled.
- [x] E6 The outcome is shown after the sale; the table refreshes.

### F. Build and tests
- [x] F1 BE `tsc --noEmit` clean.
- [x] F2 BE `npm test` all suites pass, incl. a new `forceSell` suite.
- [x] F3 FE `tsc --noEmit` and lint clean for the changed files.
- [x] F4 The dialog renders correctly (screenshot with an intercepted API, so no real order is sent).

## Verification (2026-10-13)

| Items | How verified | Result |
|---|---|---|
| A1–A6 | `src/tests/forceSell.test.ts`: pure booking; A3 contrasts a forced sale (no re-arm) with a bot sale of the same lot (re-arms); A6 shows `sellLot` still throws on the same loss | pass |
| B1–B9 | Same suite, the real `accumulatorEngine.forceSell` + paper broker at a fixed in-session time. B2 holds the step lock for 600 ms and checks nothing sells meanwhile; B5 stubs a partial fill and checks the book halts with the lot still open; B6 runs the next engine step 15% under the high and checks it buys nothing | pass |
| B9 (no regression) | The order loop was MOVED out of `stepLocked` unchanged into `executeDecisions`; `accumulatorService` (21), `accumulator` (42) and `fillAudit` (16) passed right after the move, before any new code was added | pass |
| C1–C3 | Same suite: `reportFor` banks the loss and win rate is 0; `transactionsFromBooks` + `matchFifo` give one match with a negative gain; `findUnbookedFills` finds nothing | pass |
| C4, D1–D2 | Same suite, over HTTP against the real app in-process: preview estimates equal `forceSellEstimate`, no order recorded; 400 / 404 / 409 paths; the 409 text equals the preview's `blocker` | pass |
| E1–E6 | Headless Chrome against the running FE (:3002), every `/api` call answered by fixtures (no request reached the backend): 1 Sell button (stock with lots only), loss warning, button label names the amount, POST body `{confirm:true, lotIds:[…], stopBuying:true}`, outcome shown, disabled with the reason when the market is closed, Escape closes, Sell on the phone card | pass |
| F1–F3 | BE `tsc --noEmit` clean; BE `npm test` **all 46 suites passed**; FE `tsc --noEmit` and eslint clean on the changed files | pass |

## Not done on purpose
- No real order was placed while verifying; every check used the paper broker or fixtures. (On 13 Oct the account turned out to be on PAPER with the Zerodha session expired; see SYSTEM_CHECK_2026-10-13.md.)
- The backend on :4000 runs under `ts-node-dev` (`npm run dev`), which restarts on every save, so it is already running this code. The edits landed after the 15:30 close, so no trading tick was affected. `/health` answered OK afterwards.
- No per-lot Sell button on the stock detail page; the dialog's checkboxes cover choosing single lots.

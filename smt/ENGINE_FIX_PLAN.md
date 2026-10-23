# Engine fix plan

From the 2026-10-06 engine review (artifact "SMT Engine Review"). Six phases, each built on the one before. Phases 1, 2 and 6 change no trading decision. Phases 3–5 do, so each waits for the owner's OK after its backtest.

| Phase | Goal | Changes trading? | Effort |
|---|---|---|---|
| 1. Safety for real money | No double buys after a crash; no stock takes over the portfolio | Only the per-stock cap | 2–3 d |
| 2. Honest backtest | A simulator we can trust before tuning anything | No | 2 d |
| 3. Capital allocation | Index-ETF core, stop stranding capital, portfolio deployment ceiling | Yes | 4–6 d |
| 4. More round trips | Re-arm sold rungs; volatility-spaced rungs (each kept only if the backtest agrees) | Yes | 3–4 d |
| 5. Protection and tax | News-drop + ASM/GSM veto; FIFO tax ledger + March harvesting | Yes | 5–6 d |
| 6. Housekeeping | Daily corporate-action check, quieter audit log, test DB, exits on disabled books, tests for untested services, supervisor | No | 2–3 d |

## Phase 1: Safety for real money

### 1.1 Save the book after every fill
**Problem.** `AccumulatorEngine.stepLocked` books a fill into a local copy and saves once at the end of the step. A restart in between loses the lot while the order row says FILLED, and the next tick buys the same rung again.

**Change.**
- `PersistentMap.flushKey(key)` and `store.flushAccumulatorBook(userId, symbol)`: wait for one key's queued writes to reach Mongo.
- After every booked BUY or SELL: `saveStepped` the book, then await its flush, before the next decision is sent.

### 1.2 Link every lot to the order that made it
**Change.** `Lot.orderId` (the buy order) and `ClosedLot.sellOrderId` (the sell order). Both are optional, so older lots stay valid. `applyBuyFill` takes `orderId` on the fill; `sellLot` takes it as an optional last argument.

### 1.3 Find fills the books never recorded
**Change.** New pure module `services/accumulator/fillAudit.ts`, `findUnbookedFills(orders, books)`.
- Looks at engine orders only (`tag` starts with `accumulator:`) that traded (`filledQuantity > 0`).
- A BUY is booked when a lot (open or closed) carries its `orderId`. Older lots without the link match on epoch + rung + `openedAt === order.createdAt`.
- A SELL is booked when a closed lot carries its `sellOrderId`. Older lots match on the lot id in the tag being closed.
- Orders whose book was removed are reported but never halt anything.

**Wiring.**
- At boot, after `sweepStaleOrders` (so a live order resolved from PENDING to FILLED is seen). Every unbooked fill halts its book, writes an audit row and sends a critical alert.
- In `ReconcileService`, a SURPLUS on a symbol with a live book runs the same audit for that symbol and halts only when it finds an unbooked fill. A surplus with every fill booked stays a report. That surplus is the user's own shares, and halting on it would stop a healthy book.

### 1.4 Per-stock cap in the allocator
**Problem.** `waterFill` has a floor but no ceiling. With one eligible book it got everything (SYRMA: ₹1.19L of ₹1.99L).

**Change.**
- `AllocationParams.maxWeightPct`, default 35.
- A book's total budget (lots + T+1 + new cash) never exceeds 35% of capital. Water-fill pins anyone over their ceiling and re-splits the rest.
- What no book can take stays unallocated. The allocation reason says when a book was capped.

### Tests
- `accumulatorService.test.ts`:
  - a lot carries its order id;
  - a simulated crash (book rolled back to before the fill) is caught by the audit and halts the book;
  - a clean history audits clean.
- New `fillAudit.test.ts`: buy/sell, linked and legacy matching, partial and unfilled orders, removed book.
- `allocator.test.ts`:
  - a single candidate is capped at 35%;
  - the excess is redistributed among several candidates;
  - existing lots count toward the cap;
  - no budget ever exceeds the cap across random inputs.

### Done when
- `npm test` and `tsc` are green.
- The audit run against the live paper data finds no false positives.
- After a BE restart the allocator caps SYRMA.

### Phase 1 status: DONE 2026-10-06
- 1.1–1.3 as designed. The boot audit runs after `sweepStaleOrders` and logs `Fill audit: …`. Against the live paper history (36 orders, 4 engine fills) it found nothing.
- 1.4 as designed, except the water-fill. Pinning caps and floors one at a time overspent the pool on a random case (₹265 over), so `waterFill` now solves one rate λ for Σ clamp(λ·score, lo, hi) = pool.
- Tests: 31 suites green. New: fillAudit (15), accumulatorService +4, allocator +5. Fixture note: the new service tests clear the 10/s order limiter, and fixture books are dated before the fixture session.
- Applied live (paper) through `POST /api/accumulator/allocator/run`: SYRMA ₹1,18,015 → ₹69,015 (capped), ₹49,109 unallocated.
- **Carried into Phase 3:** unallocated cash is not parked by the sweep (it only parks book cash), so the capped remainder sits idle.

### Phase 2 status: DONE 2026-10-06
**Built.**
- `BE/src/services/backtest/accumulatorSim.ts` (pure, tested in `tests/simulator.test.ts`, 20 checks). `npm run sim` was rewritten on top of it.
- Flags: `--set large|books|etf` or `--symbols`, `--years`, `--capital`, `--regime off|regime|auto`, `--sizing equal|allocator`, `--sweep PCT`, `--sweep-unassigned`, `--compare`, `--sens`.

**Fixed against the old script.**
- Exact window length.
- Portfolio drawdown taken from one summed equity curve.
- Real CAGR years.
- Regime and autopilot read daily.
- ETFs priced as ETFs.
- Rung prices via `paramsFor`.
- Allocator and sweep (with real charges) modelled.
- Exposure measured against equity, not starting capital.

**Data problems found and handled.**
- Yahoo `range=max` returns MONTHLY bars. Now `fetchYahooDailyHistory` (period1/period2), and the sim refuses non-daily bars.
- NIFTYBEES and BANKBEES print at 1/10 of their price on 2019-12-19/20. These are now dropped by `dropBadPrints`; before, they gave a fake tenfold ETF profit.
- Splits/bonuses are back-adjusted only when the raw bars jump. Yahoo had already adjusted every one checked.
- NOT handled: demergers (ABFRL's −87% includes the 2025 Aditya Birla Lifestyle demerger). The live corporate-action module does not handle demergers either.

**Regression.** Equal sizing with the regime off reproduces the review exactly: 274 trips, 26.8% at work, 20 open lots, ₹73,823.

**Results** (live-like settings: allocator, regime auto, 6% sweep; ₹2L). Difference is CAGR against the exposure-matched benchmark; "halves" is the difference in each half.

| Universe | Window | Strategy | Matched | Difference | Halves | Max DD (strategy / matched) |
|---|---|---|---|---|---|---|
| Index ETFs | 10y | 12.03% | 7.36% | **+4.7** | +8.3 / +1.2 | 12.9 / 8.8 |
| Index ETFs | 5y | 12.47% | 6.78% | +5.7 | +14.0 / −1.9 | 3.7 / 3.1 |
| Large caps | 10y | 10.40% | 10.44% | 0.0 | −2.0 / +1.7 | 31.9 / 24.1 |
| Large caps | 5y | 5.51% | 6.65% | −1.1 | −0.6 / −1.7 | 12.2 / 9.5 |
| Your books* | 10y | 13.79% | 13.05% | +0.7 | −3.8 / +5.0 | 35.7 / 35.1 |
| Your books* | 5y | 13.40% | 10.98% | +2.4 | −1.4 / +5.7 | 21.3 / 28.3 |

\* Survivorship-biased: today's list, recent listings excluded.

**Verdict for Phase 3.**
- Index ETFs are the only universe that beats the fair benchmark over 10 years in both halves. The margin since about 2021 is small or negative.
- Single stocks under the allocator do not beat holding the same exposure, and carry a deeper drawdown.
- So the ETF core is supported, but it is not a money machine; expect a few points a year at best.

### Phase 3 status: DONE 2026-10-06 (core waits for an ETF book)
**Built.** `AllocationParams` got four settings:
- `corePct`: index-ETF core. Any ETF book is core; new cash tops it up first; exempt from the per-stock cap and `maxBooks`; only active once an ETF book exists.
- `maxDeployPct`: deployment ceiling.
- `rescueRungs`: cash to finish the ladder of a dropped stock with lots and an up trend.
- `countHeldBooks`: dropped stocks holding lots take book slots.

Also:
- `bookCandidateFields()` is shared by the live allocator and the sim.
- `SweepParams.includeUnassigned`: the sweep parks what the allocator left unassigned, read from the latest run, and ignored when older than 4 days.
- `npm run sim -- --set mix|largemix --phase3`.
- Panel: "Core n" / "Rescue" badges, plus a core note.

**Backtest** (allocator + regime auto + 6% sweep). Difference against the exposure-matched benchmark; halves in brackets.

| Variant | Books+ETF 10y | Books+ETF 5y | Large+ETF 10y | Large+ETF 5y |
|---|---|---|---|---|
| baseline | 14.63% DD 33.8 (+2.2) | 12.77% DD 20.7 (+2.2) | 11.01% DD 32.1 (+0.7) | 7.01% DD 11.7 (+0.1) |
| **core 60% + sweep unassigned** | 10.72% DD 12.8 (+1.2; −0.6/+3.1) | 10.77% DD 7.6 (+2.2; +4.6/+0.1) | **13.01% DD 13.6 (+4.5; +3.4/+5.5)** | **9.65% DD 6.8 (+3.0; +5.1/+1.0)** |
| ceiling 85% | worse | worse | worse | worse |
| count held books | worse | worse | worse | worse |
| rescue 1 rung | mixed, deeper DD | mixed | mixed | ≈ |

core 50/60/70 is not monotonic, so the exact share is noise; 60% is the middle.

**Defaults now:**
- `corePct: 60`
- `includeUnassigned: true`
- ceiling, rescue and count-held off

**Applied live (paper):**
- The sweep's idle cash now counts the ₹49,109 unassigned, so the ₹77.8k parked is not churned back.
- The core does nothing until an index-ETF book exists. The user has none.
- 2026-10-06, user approved the core: NIFTYBEES, JUNIORBEES and BANKBEES books added (₹60k starting budget, 3 rungs each).
- Fixed on the way: `POST /api/accumulator` validated new books at the global 12 rungs, so any budget under ₹2.26L was refused. It now uses `rungsForBudget()`, the allocator's own rung formula.
- Allocator run: all three ETFs are in a long-term downtrend (EMA50 < EMA200), so the core funds nothing yet. Because core money waits rather than going to stocks, SYRMA's ₹48k was withdrawn as well. All ₹97,109 is unassigned and swept until the index trend turns up. Open lots still sell at their targets.

### Phase 4 status: DONE 2026-10-06
**Built.**
- `AccumulatorParams.rearmSoldRungs`: on `sellLot`, a deeper rung, never the anchor, leaves `filledLevels`. `nextTrancheSize` then counts open lots plus the sold anchor as spent.
- `AccumulatorParams.volStep {k, minPct, maxPct}` with `book.volPct`: daily σ of 60 log returns. It is refreshed with the regime read, kept through `saveStepped`, and applied in `paramsFor` to new swing ladders only.
- `dailyVolPct` / `volStepPct` in math.ts.
- FE `buildLadder` shows a sold rung as `sold` only while it is still in `filledLevels`; otherwise `waiting`.
- `npm run sim -- --phase4`.
- Tests: engine +8, including 60 random paths for re-arm (no loss; filled rungs always equal open lots); FE ladder +1.

**Backtest** (live defaults after Phase 3). Difference against the exposure-matched benchmark; baseline first, then each variant.

| Variant | Large+ETF 10y | Large+ETF 5y | Books+ETF 10y | Books+ETF 5y | Large 10y | ETF 10y |
|---|---|---|---|---|---|---|
| baseline | +4.5 | +3.0 | +1.2 | +2.2 | +0.1 | +3.7 |
| **re-arm** | **+6.8** | +2.8 | **+4.6*** | +2.2 | +0.9 | **+5.3** |
| vol gap k=1 | +5.2 | +3.9 | +3.5 | +3.0 | −0.8 | +3.4 |

\* After the anchor-sizing fix; +6.2 before it.

- Re-arm is better in all 10-year runs and flat over 5 years. Drawdown is 2–4 points deeper in most runs and lower for large caps alone.
- The volatility gap is mixed, not monotonic in k (0.75/1.0/1.25), and moves by about 1 point or less: noise.

**Defaults now:** `rearmSoldRungs: true`; `volStep` off.

**Live note:** rungs sold before this change (ETERNAL e1 rung 1) are not retroactively re-armed. Re-arm applies to sales from now on.

### Phase 5 status: DONE 2026-10-06
**Built: protection.**
- `accumulator/events.ts` (pure): `entryBlock` from surveillance, results and gap-down, plus `sessionsSince` and `isGapDown`.
- `services/marketEvents.ts`: NSE ASM/GSM/ESM lists, refreshed every 6h, keeping the last good copy on failure; per-book `event-calendar`, every 12h.
- `AccumulatorEngine.step` sets `book.gapDownDay` from the day's first price and `book.entryBlock` before `decide`. `decide` holds entries, never exits, while `entryBlock` is set.
- `AccumulatorParams.eventVeto`.
- `GET /api/market/flags/:symbol`; the FE `useSymbolFlags` is real now (order ticket).
- Stock table "⏸ event block" state; stock page badge.

**Built: tax.**
- `services/tax/ledger.ts` (pure): FIFO per symbol (CBDT 768/1998); short-term ≤12 months at 20%, long-term at 12.5% over ₹1.25L; 4% cess; STT out of cost and added back to proceeds; set-off (a short-term loss covers short- and long-term gains, a long-term loss only long-term) and carry-forward; harvest candidates.
- `GET /api/tax?venue=paper|live`. The sweep's gains are reported as slab-rate income; intraday trades are excluded and the report says so.
- FE `/tax` page plus a sidebar link.
- Harvesting is a PLANNER, not automatic: an automatic loss sale would break the no-loss sell floor. A bot-side harvest action is needed before live use.

**Backtest** (`--phase5`, 5 universes, 733–901 real NSE results days):
- Gap-down block: worse everywhere (−0.2 to −2.5 points a year) at 3/4/5% and 1/2/3 sessions.
- Results block: +0.9 / 0.0 / +2.4 / +0.7 / −0.8 at 1 session, similar at 2 and 3. Inconsistent.

**Defaults now:** surveillance on; results and gap off.

**Live:**
- None of the books is under surveillance on 2026-10-06.
- Paper tax for 2026-27: FIFO gain ₹2,025 against the bot's ₹3,119. Today's ETERNAL sale is −₹439 for tax although the bot booked +₹912. Estimated tax ₹421.

**Also fixed:** the JSX compiler here drops the space after `</strong>` when the text continues onto the next line ("Your amountis", "nextday", "No-lossis"). Explicit `{' '}` in 6 places.

Tests: tax 12, marketEvents 10 (34 suites green).

### Phase 6 status: DONE 2026-10-07
- **Corporate actions:** checked per book at most every 30 min, and only for books that are on or hold lots. The boot pass checks everything. This replaces ~27k Yahoo calls a day.
- **Audit log:** a HOLD is logged only when its reason changes (countdown digits ignored).
- **Live bad-print guard:** `services/barCleaning.ts` `cleanDailyBars` (`dropBadPrints` plus a high clamp at +25% over the previous close) now cleans the start-gate seed, the regime closes and the allocator's strength history.
- **Process:**
  - `unhandledRejection` → log and alert, keep running.
  - `uncaughtException` → log, alert, flush the store, exit(1).
  - `scripts/supervise.js` (`npm run start:supervised`) restarts with 1s→60s backoff.
- **Tests:**
  - `scripts/run-tests.js` runs every suite, continuing after failures, against `smt_trading_test`, and refuses a non-`_test` database. Suite order is in `package.json` `testSuites`; unlisted files still run.
  - New `services.test.ts` (11): order sweep, funds reservations, `enabledAfter`, bar cleaning.
  - 35 suites green.
- **Disabled books:** NOT changed to keep selling. "Off" means hands-off by design, and the kill switch already means "no buys, keep selling". Switching off a book with open lots now asks first and points to the kill switch.
- **OPERATIONS.md:** supervised start in the go-live checklist; a Tests section.
- **Not done:** archiving `closedLots` out of the book document (review item R5). It only grows by a few lots a week at current volume.

## Manual rung count (2026-10-07)

The owner asked for an input to choose, with a hand-set amount, how many rungs (tranches) the money is split into.

### Checklist
**Analysis (how rungs work today)**
- [x] A1. The allocator writes `book.tranches`. Hand-set amount: `manualRungs(newCash)`; automatic: `rungsForBudget(share)`.
- [x] A2. The engine reads it through `paramsFor`. A new ladder: rung = budget × 85% ÷ rungs. An open ladder: `syncLadder` grows or shrinks it, never removing a bought rung; `nextTrancheSize` = (budget × 85% − spent) ÷ rungs still to buy.
- [x] A3. There is no minimum-rung check at buy time (`buildBuy` only needs 1 share), so the input must enforce ₹16,000 per rung.
- [x] A4. Re-arm: a sold deeper rung counts as "to buy" again.
- [x] A5. The daily allocator run must keep the hand-set rungs.
- [x] A6. `saveStepped` must keep the new field through a step.
- [x] A7. Setting the amount back to Auto clears the rungs too.

**Build**
- [x] B1. `book.manualTranches`, passed to the allocator, used for hand-set rows.
- [x] B2. Validation runs the engine's own `syncLadder` + `nextTrancheSize` on the would-be book: at least the rungs already bought, at most 12, each rung still to buy at least ₹16,000. Errors state the most rungs allowed.
- [x] B3. Preview route: rupees per rung, bought / to buy, most rungs allowed.
- [x] B4. `POST /:symbol/budget {amount, rungs}`; `rungs: null` = automatic.
- [x] B5. UI: a rungs input beside the amount, with a live preview line.

**Verify**
- [x] V1. Unit tests: allocation, validation limits, preview maths.
- [x] V2. Integration: after saving, the engine's actual BUY size equals the preview's per-rung amount.
- [x] V3. An allocator re-run keeps the hand-set rungs.
- [x] V4. Live API on paper: preview, save, re-run, clear back to Auto.
- [x] V5. Screenshot of the panel.
- [x] V6. Full test suite, tsc and lint on both projects.

### Verified 2026-10-07 (all 18 items)
- A1–A7: read in code. `buildBuy` has no minimum-rung check, which is why the input enforces ₹16,000.
- V1–V3: `tests/rungPlan.test.ts` (12). The engine's real first BUY equals the preview's rupees per rung to within one share for ₹60k/3, ₹1L/5, ₹2L/10 and ₹30k/1, and on an open ladder. The allocator keeps the hand-set rungs run after run.
- V4, live paper (NHPC is switched off, so nothing could trade):
  - previews: auto 3 × ₹17,000; 4 refused, "at most 3"; 13 refused; 2.5 refused; SYRMA open ladder 3 → 2 to buy × ₹18,817; ETERNAL 1 refused, "choose 2 or more".
  - save 60,000 × 2: allocation 2 rungs, the book stayed switched off, a re-run kept 2.
  - 5 rungs refused (422); rungs without an amount refused; back to Auto cleared both.
- V5: headless screenshots. A valid entry shows the preview and Save; an invalid one shows a red box and the reason, with no Save.
- V6: 36 backend suites, tsc on both projects, FE lint, FE ladder tests.

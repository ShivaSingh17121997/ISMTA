# Verification, 2026-10-08: the switch to live trading

Scope: every feature added or changed today, as the account went live on Zerodha (client YZF742) at 10:49 IST, plus a smoke test of every API route and every page. The owner's account (demo@trader.in) was only read: no orders, no toggles, no budget saves. Anything that had to write ran against an in-memory store or a throwaway account, which was deleted afterwards by `_id`.

## Checklist

### A. Build and automated tests
- [x] A1. Backend `tsc --noEmit` clean
- [x] A2. Backend `npm test`: 41/41 suites pass against `smt_trading_test`, including 3 new suites or cases (venueView 13, liveViewHttp 20, and new cases in allocator, accumulatorService and brokerConnection)
- [x] A3. Backend `npm run build` compiles into `dist/`
- [x] A4. Frontend `tsc --noEmit` clean, and `eslint` clean on the whole app
- [x] A5. Frontend `npm test` (ladder, 17) passes
- [x] A6. No stray control characters in any source file (one slipped into a regex during editing; caught and fixed)
- [x] A7. Mutation check: with the live filter deliberately broken, the HTTP suite fails 4 tests; restored afterwards

### B. Going live (Settings → Zerodha)
- [x] B1. `BROKER_STATIC_IP=122.176.71.56` is in `BE/.env` and matches the public IP
- [x] B2. Two-factor is on; the account no longer uses the demo password
- [x] B3. The live-switch form shows its refusal reason beside the button (it used to show only at the top of the card, out of view)
- [x] B4. Live mode is on and Zerodha is connected; the session ends 9 Oct 06:00 IST
- [ ] B5. **The Kite developer app has no static IP registered.** Zerodha has rejected every order: 28 buys of ETERNAL since 13:00 with "No IPs configured for this app". See finding 1.

### C. Hiding paper data while live (`BE/src/services/venueView.ts`)
- [x] C1. Accumulator list and stock page: banked profit, lots closed and win rate count only lots bought live; the cleared paper lots are hidden
- [x] C2. The stored books are untouched: paper lots are hidden, not deleted
- [x] C3. The NAV curve uses only live snapshots, starts from the live balance and has no −100% day
- [x] C4. Orders, trades, journal and execution quality hide everything from before the switch
- [x] C5. The audit log starts at the switch; `?all=1` shows the whole trail
- [x] C6. Tax opens on the live view while live
- [x] C7. A paper account still sees its whole paper history (checked over HTTP)
- [x] C8. Switching back to paper shows the paper history again

### D. Snapshots and the 15:35 write
- [x] D1. Snapshots are written with a `venue` tag; live realised P&L and charges count only live lots and trades
- [x] D2. The running backend (started 12:51) includes this, so today's 15:35 snapshot is written correctly

### E. Mode switch side effects
- [x] E1. Today's loss count, losing streak and cooldown reset on a switch; the kill switch is kept
- [x] E2. Going live zeroes a leftover paper sweep ledger
- [x] E3. The allocator re-plans against the new venue's cash (seen live: the 12:54 run planned against ₹1,990 of Zerodha cash)

### F. Hand-set budgets: per-stock minimum (`BE/src/services/allocator/rungFloor.ts`)
- [x] F1. The minimum is the fewest shares for which the target clears 1.5× the round-trip cost, plus the 15% reserve. SYRMA ₹2,100, NHPC under ₹1,000.
- [x] F2. Preview and save both refuse ₹2,000 for SYRMA with the per-stock reason, never the old ₹19,000
- [x] F3. Saving ₹2,100 works; Auto hands the stock back to the bot
- [x] F4. Live: ETERNAL is set to ₹1,990 on 1 rung (₹1,692 per rung, 5 shares at about ₹322)
- [x] F5. The allocator panel says "Zerodha capital" while live (it used to say "Paper capital")

### G. Safety and data integrity (live store)
- [x] G1. A buy needs real Zerodha cash: every buy reserves it first (`FundsService.reserve`)
- [x] G2. No-loss: all 4 closed lots have pnl ≥ 0
- [x] G3. No open lots, no PENDING orders, no paper sweep units; risk counters are clean
- [x] G4. Only one other book is stopped: KAYNES has its kill switch on, which was set before today
- [x] G5. A repeated "app not set up" rejection now halts the stock once instead of retrying every minute (test: 1 order, then a halt)

### H. Running system
- [x] H1. All 26 GET routes answer without a 500; an unknown stock gives 404 and no token gives 401
- [x] H2. Per-user isolation: a second account sees none of the owner's books, orders or audit entries
- [x] H3. All 17 frontend pages load from the running dev server with no compile errors
- [ ] H4. Not checked: logged-in pages in a browser as the owner. The browser connection was closed, and the owner's password is not known.

## Findings

1. **Kite developer app has no static IP (open, needs the owner).** Since 13:00 the engine has sent a 5-share ETERNAL buy about once a minute; Zerodha refused all 28. No money moved. Fix: register 122.176.71.56 on the app at developers.kite.trade. Once that is done, the next tick will place a real ₹1,610 buy.
2. **Rejections were retried every minute (fixed in code, needs a restart).** The engine now halts a stock on an app-setup rejection, as it already did for depository rejections, and sends a critical alert. The fix is built into `dist/`; the running process started before it, so it takes effect at the next restart.
3. **The allocator panel said "Paper capital" on a live account (fixed).**
4. **A regex picked up control characters while editing (fixed).** A tree-wide scan found no others.

## Known gaps (not fixed today)
- Deposits are not recorded as cash flows, so money added to Zerodha shows as a gain in the equity change.
- The automatic allocator still wants ₹16,000 rungs (about ₹57,000 per stock), so a small account only trades through hand-set amounts.
- Telegram is not configured, so halts and fills raise no phone alert.
- `accumulatorEngine.recentEvents` is not filtered per user (this predates today).
- The deleted throwaway account remains in the running process's memory until the next restart; it has no data and is gone from the database.

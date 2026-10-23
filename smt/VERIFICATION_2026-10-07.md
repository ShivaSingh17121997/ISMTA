# Full-system verification, 2026-10-07

Scope: everything the app does today: the engine, allocator, sweep, safety, tax, events, sign-up, broker and UI. Read-only on the owner's account (demo@trader.in): no orders, no toggles, no allocator runs, no budget saves. Anything that writes uses a throwaway account, deleted afterwards by `_id`.

## Checklist

### A. Build and automated tests
- [x] A1. Backend `tsc --noEmit` clean
- [x] A2. Backend `npm test`: every suite passes (against `smt_trading_test`)
- [x] A3. Frontend `tsc --noEmit` clean, and `eslint` on the whole app
- [x] A4. Frontend `npm test` (ladder) passes
- [ ] A5. (not run: it shares `.next` with the running dev server; tsc + eslint cover compile errors) Frontend production build (`next build`) compiles

### B. Backend API (every route answers correctly)
- [x] B1. Health, auth (login / me / config / register validation / password / TOTP routes reachable)
- [x] B2. Accumulator: list, one book, allocator GET, budget preview, refusals (bad amount, bad rungs)
- [x] B3. Funds, sweep, tax, market flags, analytics, journal, audit, watchlists, triggers, orders, portfolio, risk, recommendations, strategies, backtest, system
- [x] B4. Per-user isolation: a second account cannot read or change the first one's data
- [x] B5. Error handling: unknown symbol → 404, bad body → 400/422, no token → 401, never a 500

### C. Data integrity (live store)
- [x] C1. No-loss: every closed lot has pnl ≥ 0 and was sold at or above its breakeven
- [x] C2. Each book's filled rungs equal its open lots in the open ladder (allowing rungs sold before re-arm)
- [x] C3. No book is both enabled and halted without a reason; no orphan PENDING orders
- [x] C4. Every filled engine order is booked (fill audit = 0)
- [x] C5. Sweep ledger consistent (units, cashOut, venue)
- [x] C6. Allocator's latest run adds up (assigned + unassigned = free); no book over the 35% cap unless hand-set
- [x] C7. No paper lots or paper sweep units left after the clear; cleared lots are well-formed
- [x] C8. Users: no leftover test accounts; emails unique ignoring case

### D. Running processes
- [x] D1. Backend up; the engine, allocator, sweep, market events and snapshots actually ran recently
- [x] D2. Market events loaded (surveillance lists, calendars)
- [x] D3. Zerodha connection status matches what Settings shows
- [x] D4. The audit log is no longer flooded by HOLD lines

### E. Frontend (every page, desktop + phone width)
- [x] E1. Every sidebar page loads without a crash, an error banner or console errors
- [x] E2. Login, sign-up and logout work; no demo password shown; no auto-login
- [x] E3. Allocator panel: amount and rungs inputs with a live preview
- [x] E4. Tax page, stock page, dashboard, settings (Zerodha card) render real data correctly
- [x] E5. No horizontal overflow at phone width; text not clipped

### F. Code review of everything changed this week
- [x] F1. No logic bugs in the new modules (fill audit, allocator core/manual/rungs, sim, events, tax, paper clear, sign-up)
- [x] F2. Every "default" set from a backtest is what the code actually uses
- [x] F3. Docs (ENGINE_FIX_PLAN, OPERATIONS) match the code

## Results

**Outcome: everything passes, after the fixes below.** Backend 38/38 suites; frontend tsc, eslint and ladder tests (17) all clean; 99 API routes checked; per-user isolation holds; the no-loss rule held on every closed lot; fill audit shows 0 unbooked fills.

### Bugs found and fixed during this run
1. Fill audit ignored cleared paper lots, so ETERNAL and SYRMA were halted falsely after "Clear paper lots". Fixed, tested, halts released.
2. Creating a book with a lowercase symbol could overwrite an existing book. The symbol is now uppercased before the duplicate check.
3. Triggers with `legs:[null]` and strategies with `symbols:[123]` returned 500. Both now return 400.
4. The budget preview skipped the amount checks that saving runs. Fixed (`previewBudget`).
5. The rung count ignored rungs already filled, which could strand money. Fixed (`rungsForBook`).
6. A failed database write was reported as success. Fixed; on a live account the book now halts.
7. The live tax report could include paper lots. Now filtered by each lot's venue.
8. Paper money still settling (T+1) survived the clear. It is now moved into cash.
9. Tax: 29-Feb holding-period edge and 8-year loss carry-forward expiry. Fixed.
10. Sign-up race (two requests with one email). Fixed; email matching is case-insensitive.
11. Tokens of deleted users still worked. Fixed.
12. Order preview with no price. Now returns 422.
13. Looking up one future-stars/turnaround symbol overwrote the saved run. Fixed.
14. Allocator plan stale after a clear. The clear route now re-runs it.
15. Supervisor killed the server on Windows, so it did not shut down cleanly. Fixed.
16. Dashboard: halted books now show as an attention item. Risk page label reworded.
17. Live-switch blockers now include "turn on two-factor sign-in".
18. Phone width: mobile stock cards, toasts and recommendation sector rows overflowed. Fixed. /accumulator was 776px wide because the inputs' hidden `sr-only` labels escaped the table's scroll box. The scroll box is now `relative`. All pages measure 390px at 390px.
19. OPERATIONS.md go-live steps rewritten for per-user Zerodha keys.

### Follow-up fixes (same day, after the report)
20. Clearing paper sweep units now also zeroes the sweep's running income and charges, so paper income never shows as live income. History rows stay, tagged paper. A boot-time repair fixed the owner's already-cleared sweep (verified: realisedGain 0, 3 rows kept).
21. Two-factor secrets (`totpSecret` and `totpPending`) are encrypted at rest with BROKER_CREDENTIALS_KEY (AES-256-GCM, per-user context). Old plaintext values are sealed at boot (verified on the owner's account). A changed key returns a clear 503 instead of "wrong code"; recovery: `npm run totp:reset -- <email>` with the backend stopped. New suite `totpSecrets` (7 tests).
22. Logo: the flag emoji showed as "IN" on Windows. It is now a drawn tricolour (`BrandMark`).
23. Audit noise: 892 of 1,001 audit rows in 24h were one repeated allocator HOLD line. The dedupe lived in memory, and the dev server restarted 56 times. It is now stored on the book (`lastHoldGist`), so restarts do not repeat it.
24. Reconcile: shares at the broker for a book expecting zero ('untracked') now run the unbooked-fill check too; a book's first unbooked fill looked exactly like that.
25. Bar cleaning: a high is clamped only when it is also a lone spike (more than 10% above the bar's open and close). F&O stocks have no circuit band, so a real +30% day keeps its high. Test added.
26. Gap-down veto: a gap is judged only from a first price seen at 09:15–09:30 IST; a late first price is an intraday fall, not an open. (Veto is off by default.) Test added.
27. Backtest "9 runs, 8 rows": not a bug. The label and rows come from the same list; the 9th row is below the table's scroll fold.

All 39 backend suites pass; frontend tsc, eslint and ladder tests clean.

### Before going live (owner's steps)
Static IP + `BROKER_STATIC_IP`, turn on two-factor sign-in, fund the Zerodha account, DDPI, start with `npm run start:supervised`, then flip Live in Settings.

/**
 * Idle-cash sweep: the pure planner, then the real service driven through the
 * paper broker and the real accumulator buy path, offline.
 *
 * The invariants that matter:
 *   - the books' cash on hand is always Σ book.cash − cashOut, so parking and
 *     redeeming move money between two places and never create or lose any;
 *   - a unit bought today is not spent before its second trading day (T1);
 *   - a rung that needs parked cash gets it, through the accumulator's own path.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { accumulatorEngine, createBook } from '../services/AccumulatorEngine';
import { cashSweep, unassignedCash } from '../services/CashSweepService';
import { marketData } from '../services/MarketDataService';
import { isMarketOpen } from '../services/session';
import { recordDayHigh } from '../services/accumulator/engine';
import {
  DEFAULT_SWEEP_PARAMS as SP,
  applyParkFill,
  applyRedeemFill,
  bufferNeed,
  cashOnHand,
  decideScheduled,
  newSweepState,
  planPark,
  planRedeem,
  rungsPerSession,
  totalGain,
  unitsHeld,
  usableUnits,
  type SweepState,
} from '../services/sweep/plan';
import { store } from '../store/memoryStore';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

const HOUR = 3_600_000;
// Mon 5 Jan 2026. 10:30 IST and 15:05 IST (inside the park window).
const MON_1030 = Date.parse('2026-01-05T05:00:00Z');
const MON_1505 = Date.parse('2026-01-05T09:35:00Z');
const TUE_1030 = MON_1030 + 24 * HOUR;
const WED_1030 = MON_1030 + 48 * HOUR;
const WED_START = Date.parse('2026-01-06T18:30:00Z'); // 00:00 IST Wed

function parked(s: SweepState, qty: number, price: number, at: number, usableFrom: number, charges = 0, id = `L${at}`): SweepState {
  return applyParkFill(s, { id, quantity: qty, price, charges, at, boughtOn: '2026-01-05', usableFrom });
}

async function main(): Promise<void> {
  // ── pure planner ───────────────────────────────────────────────────────
  await test('a surplus under the minimum is not parked; above it, whole units under the surplus', () => {
    const s = newSweepState('u', 0);
    assert.equal(planPark({ idle: 30_000, buffer: 10_000, state: s, price: 116 }).quantity, 0);
    const p = planPark({ idle: 100_000, buffer: 20_000, state: s, price: 116 });
    assert.ok(p.quantity > 0 && Number.isInteger(p.quantity));
    assert.ok(p.amount <= 80_000, 'never parks the buffer');
    assert.ok(p.amount > 80_000 - 2 * 116 - 80_000 * (SP.chargePadPct / 100), 'parks nearly all of the surplus');
  });

  await test('the buffer covers one session of rungs per ACTIVE book, capped by its cash, with a floor', () => {
    assert.equal(bufferNeed([{ cash: 50_000, tranche: 10_000, rungs: 1, active: true }]), 10_000);
    assert.equal(bufferNeed([{ cash: 50_000, tranche: 10_000, rungs: 3, active: true }]), 30_000);
    assert.equal(bufferNeed([{ cash: 5_000, tranche: 10_000, rungs: 1, active: true }]), SP.minBufferRs, 'capped at cash, then floored');
    assert.equal(bufferNeed([{ cash: 90_000, tranche: 30_000, rungs: 1, active: false }]), SP.minBufferRs, 'a paused book needs no buffer');
    assert.equal(
      bufferNeed([{ cash: 90_000, tranche: 30_000, rungs: 1, active: true }, { cash: 40_000, tranche: 15_000, rungs: 3, active: true }]),
      70_000,
    );
  });

  await test('a 24h brake fires once a session; a 2h brake three times in 09:20–15:00', () => {
    assert.equal(rungsPerSession(24 * HOUR, 340), 1);
    assert.equal(rungsPerSession(2 * HOUR, 340), 3);
    assert.equal(rungsPerSession(2 * HOUR, 360), 3, 'a rung exactly at the close is not in the window');
    assert.equal(rungsPerSession(2 * HOUR, 361), 4);
  });

  await test('park then full redeem returns every rupee plus the gain, net of charges', () => {
    let s = newSweepState('u', 0);
    s = parked(s, 1_000, 100, 0, 0, 5);
    assert.equal(s.cashOut, 100_005);
    assert.equal(cashOnHand(150_000, s), 49_995);
    s = applyRedeemFill(s, { quantity: 1_000, price: 101, charges: 20, at: 1 });
    assert.equal(unitsHeld(s), 0);
    assert.ok(Math.abs(s.realisedGain - (101_000 - 20 - 100_005)) < 1e-6);
    assert.ok(Math.abs(s.cashOut + s.realisedGain) < 1e-6, 'after a full unwind, cashOut is minus the income');
    assert.ok(Math.abs(totalGain(s, 999) - s.realisedGain) < 1e-6, 'nothing held, so the mark does not matter');
  });

  await test('redemptions consume lots FIFO and split a lot pro rata', () => {
    let s = newSweepState('u', 0);
    s = parked(s, 100, 100, 1, 0, 10, 'old');
    s = parked(s, 100, 110, 2, 0, 10, 'new');
    s = applyRedeemFill(s, { quantity: 150, price: 120, charges: 0, at: 3 });
    assert.equal(s.lots.length, 1);
    assert.equal(s.lots[0].id, 'new', 'the old lot went first');
    assert.equal(s.lots[0].quantity, 50);
    assert.ok(Math.abs(s.lots[0].charges - 5) < 1e-9, 'half the lot keeps half its charges');
    const r = s.realised[0];
    assert.ok(Math.abs(r.cost - (100 * 100 + 10 + 50 * 110 + 5)) < 1e-9);
  });

  await test('selling more units than are held throws rather than inventing them', () => {
    const s = parked(newSweepState('u', 0), 10, 100, 0, 0);
    assert.throws(() => applyRedeemFill(s, { quantity: 11, price: 100, charges: 0, at: 1 }));
  });

  await test('only T1-cleared units can be redeemed; the shortfall is reported', () => {
    let s = newSweepState('u', 0);
    s = parked(s, 100, 100, 0, 1_000, 0, 'cleared');
    s = parked(s, 100, 100, 1, 5_000, 0, 'locked');
    assert.equal(usableUnits(s, 2_000), 100);
    const r = planRedeem({ need: 15_000, state: s, price: 100, now: 2_000 });
    assert.equal(r.quantity, 100);
    assert.ok(r.short > 4_000, 'the locked half is short');
    assert.equal(planRedeem({ need: 5_000, state: s, price: 100, now: 2_000 }).quantity, 51, 'rounded up with the charge pad');
  });

  const at = (min: number) => ({ minutes: min, today: '2026-01-05' });
  await test('parks only inside the window, and once a day', () => {
    const s = { ...newSweepState('u', 0), enabled: true };
    const base = { state: s, idle: 200_000, buffer: 20_000, price: 116, now: 0 };
    assert.equal(decideScheduled({ ...base, ...at(14 * 60) }).kind, 'none');
    assert.equal(decideScheduled({ ...base, ...at(15 * 60 + 5) }).kind, 'park');
    assert.equal(decideScheduled({ ...base, ...at(15 * 60 + 25) }).kind, 'none', 'window closed');
    assert.equal(decideScheduled({ ...base, state: { ...s, lastParkDay: '2026-01-05' }, ...at(15 * 60 + 5) }).kind, 'none');
  });

  await test('tops up a short buffer after the opening spike, from usable units', () => {
    let s: SweepState = { ...newSweepState('u', 0), enabled: true };
    s = parked(s, 1_000, 100, 0, 0);
    const base = { state: s, idle: 110_000, buffer: 30_000, price: 100, now: 10 };
    const a = decideScheduled({ ...base, ...at(9 * 60 + 30) });
    assert.equal(a.kind, 'redeem');
    assert.ok(a.kind === 'redeem' && a.quantity * 100 >= 20_000);
    assert.equal(decideScheduled({ ...base, ...at(9 * 60 + 5) }).kind, 'none', 'not inside the opening spike');
    assert.equal(decideScheduled({ ...base, idle: 128_000, ...at(9 * 60 + 30) }).kind, 'none', 'a shortfall under the minimum waits for a rung');
  });

  await test('returns the excess when more is parked than the books have spare', () => {
    let s: SweepState = { ...newSweepState('u', 0), enabled: true };
    s = parked(s, 1_000, 100, 0, 0);
    // A book was removed: only ₹1,00,000 of idle cash is left, all of it parked.
    const a = decideScheduled({ state: s, idle: 100_000, buffer: 10_000, price: 100, now: 10, ...at(12 * 60) });
    assert.equal(a.kind, 'redeem');
  });

  await test('switched off, it unwinds what T1 allows and nothing else; halted, it does nothing', () => {
    let s: SweepState = newSweepState('u', 0);
    s = parked(s, 100, 100, 0, 0);
    s = parked(s, 100, 100, 1, 1e12);
    const a = decideScheduled({ state: s, idle: 50_000, buffer: 10_000, price: 100, now: 10, ...at(11 * 60) });
    assert.ok(a.kind === 'redeem' && a.quantity === 100);
    const h = decideScheduled({ state: { ...s, enabled: true, haltedReason: 'x' }, idle: 50_000, buffer: 10_000, price: 100, now: 10, ...at(15 * 60 + 5) });
    assert.equal(h.kind, 'none');
  });

  // ── the real service, through the paper broker ─────────────────────────
  const USER = 'sweep-itest';
  const SYM = 'SWEEPTEST';
  await test('fixture times fall inside the session', () => {
    assert.ok(isMarketOpen(MON_1030) && isMarketOpen(MON_1505) && isMarketOpen(WED_1030));
  });

  await test('parks after the close of entries, locks by T1, then funds a rung through the accumulator', async () => {
    marketData.ingestExternal(SP.symbol, 116);
    // A funded book that cannot buy today (paused), so almost all its cash is spare.
    let book = createBook({ userId: USER, symbol: SYM, instrument: 'ETF', budget: 200_000 });
    book = recordDayHigh(book, 100, MON_1030 - 86_400_000);
    book = { ...book, allocatorPaused: true };
    store.saveAccumulatorBook(book);
    cashSweep.setEnabled(USER, true, MON_1030);

    const r = await cashSweep.runFor(USER, MON_1505);
    assert.equal(r.action, 'park', r.reason);
    let s = store.cashSweeps.get(USER)!;
    assert.ok(unitsHeld(s) > 1_600, `parked ${unitsHeld(s)} units`);
    assert.ok(s.cashOut > 180_000 && s.cashOut < 200_000 - SP.minBufferRs + 1);
    assert.equal(s.venue, 'paper');
    assert.equal(s.lots[0].usableFrom, WED_START, 'bought Monday: usable from Wednesday');
    const parkOrder = [...store.orders.values()].find((o) => o.tag === 'sweep:park' && o.userId === USER);
    assert.equal(parkOrder?.status, 'FILLED', 'the park order is in the order ledger');

    // A second pass the same day does not park again.
    assert.equal((await cashSweep.runFor(USER, MON_1505 + 5 * 60_000)).action, 'none');

    // Tuesday: a rung needing the parked cash is refused — the units are T1.
    const tue = await cashSweep.ensureCash(USER, 50_000, undefined, TUE_1030);
    assert.equal(tue.ok, false);
    assert.match(tue.reason ?? '', /T1-locked/);

    // Wednesday: the book is back on and the price has dipped. The rung must fill,
    // funded by selling parked units, through AccumulatorEngine.step.
    book = { ...store.accumulatorBook(USER, SYM)!, allocatorPaused: false };
    store.saveAccumulatorBook(book);
    marketData.ingestExternal(SP.symbol, 116.05);
    marketData.ingestExternal(SYM, 95);
    const before = unitsHeld(store.cashSweeps.get(USER)!);
    const b = await accumulatorEngine.step(book, 95, WED_1030);
    assert.equal(b.openLots.length, 1, 'the rung filled');
    s = store.cashSweeps.get(USER)!;
    assert.ok(unitsHeld(s) < before, 'parked units were sold to fund it');
    const idle = store.accumulatorBooksByUser(USER).reduce((n, x) => n + x.cash, 0);
    assert.ok(cashOnHand(idle, s) >= -0.01, 'the rung never spent cash that was still parked');
    assert.ok(s.realisedGain > -50, `a two-day park costs at most the charges (gain ${s.realisedGain.toFixed(2)})`);
  });

  await test('switching off returns everything once T1 allows; the ledger closes to the income', async () => {
    cashSweep.setEnabled(USER, false, WED_1030 + HOUR);
    marketData.ingestExternal(SP.symbol, 116.1);
    const r = await cashSweep.runFor(USER, WED_1030 + HOUR);
    assert.equal(r.action, 'redeem', r.reason);
    const s = store.cashSweeps.get(USER)!;
    assert.equal(unitsHeld(s), 0);
    assert.ok(Math.abs(s.cashOut + s.realisedGain) < 0.01, 'cashOut is exactly minus the income');
  });

  await test('unassigned cash comes from the latest allocator run, and only while it is recent', () => {
    const U = 'sweep-unassigned-itest';
    const now = Date.parse('2026-03-10T05:00:00Z');
    assert.equal(unassignedCash(U, now), 0, 'no run, nothing unassigned');
    const run = (at: number, unallocated: number) =>
      ({ userId: U, at, tradingDay: new Date(at).toISOString().slice(0, 10), params: {}, plan: { unallocated }, strengths: {} }) as never;
    store.allocatorRuns.set(`${U}:a`, run(now - 2 * 86_400_000, 30_000));
    store.allocatorRuns.set(`${U}:b`, run(now - 86_400_000, 49_000));
    assert.equal(unassignedCash(U, now), 49_000, 'the latest run wins');
    assert.equal(unassignedCash(U, now + 10 * 86_400_000), 0, 'a stale plan parks nothing');
    store.allocatorRuns.delete(`${U}:a`);
    store.allocatorRuns.delete(`${U}:b`);
  });

  if (failures.length) {
    console.error(`✗ sweep: ${failures.length} failed, ${passed} passed`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`✓ sweep: ${passed} passed`);
  process.exit(0);
}

void main();

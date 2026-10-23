/**
 * "Clear paper lots" before going live: the pure clear, the live-switch check
 * for paper sweep units, the tax view, and the sweep's paper unwind.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { clearPaperLots } from '../services/accumulator/paperClear';
import { applyBuyFill, decide, equity, recordDayHigh } from '../services/accumulator/engine';
import { DEFAULT_ACCUMULATOR_PARAMS as P, type AccumulatorBook } from '../services/accumulator/types';
import { liveSwitchBlockers } from '../services/brokerRules';
import { transactionsFromBooks, matchFifo } from '../services/tax/ledger';
import { cashSweep, isClearedPaperLedger } from '../services/CashSweepService';
import { store } from '../store/memoryStore';
import type { BrokerConnection } from '../types';

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

const T0 = Date.parse('2026-01-05T05:00:00Z');
const DAY = 86_400_000;

/** A paper book holding one bought lot. */
function holding(venue?: 'paper' | 'live'): AccumulatorBook {
  let b = {
    id: 'b', userId: 'u', symbol: 'ABC', instrument: 'EQUITY', budget: 60_000, cash: 60_000, tranches: 3,
    unsettled: [], openLots: [], closedLots: [], epochs: [], lotSeq: 0, dayHighs: {}, orderedDays: [],
    enabled: true, killSwitchEngaged: false, createdAt: 0, updatedAt: 0, ...(venue ? { venue } : {}),
  } as AccumulatorBook;
  b = recordDayHigh(b, 100, T0 - DAY);
  const d = decide(b, 95, T0, P).find((x) => x.action === 'BUY')!;
  return applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 95, quantity: d.quantity!, at: T0 }, P);
}

async function main(): Promise<void> {
  await test('clearing moves the lots out, credits their market value, and closes the ladder', () => {
    const b = holding();
    const lot = b.openLots[0];
    const { book, cleared } = clearPaperLots(b, 90, T0 + DAY);
    assert.equal(book.openLots.length, 0);
    assert.equal(cleared.length, 1);
    assert.equal(book.clearedLots?.length, 1);
    assert.equal(book.cash, b.cash + lot.quantity * 90);
    assert.ok(Math.abs(cleared[0].pnl - (lot.quantity * 90 - lot.quoteSpent)) < 1e-9);
    assert.ok(book.epochs.every((e) => e.status === 'CLOSED'));
  });

  await test('the book is worth the same just before and just after clearing', () => {
    const b = holding();
    const { book } = clearPaperLots(b, 90, T0 + DAY);
    assert.ok(Math.abs(equity(book, 90) - equity(b, 90)) < 1e-6);
  });

  await test('clearing is not a trade: closed lots and trade stats are untouched', () => {
    const b = holding();
    assert.equal(clearPaperLots(b, 90, T0 + DAY).book.closedLots.length, b.closedLots.length);
  });

  await test('paper money still settling (T+1) is moved to cash, so none settles in after going live', () => {
    const b = { ...holding(), unsettled: [{ amount: 5_000, fromLotId: 'x', soldAt: T0, settlesAt: T0 + DAY }] };
    const { book } = clearPaperLots(b, 90, T0 + DAY);
    assert.equal(book.unsettled.length, 0);
    assert.ok(Math.abs(equity(book, 90) - equity(b, 90)) < 1e-6, 'value unchanged');
    const noLots = { ...b, openLots: [] };
    assert.equal(clearPaperLots(noLots, 90, T0 + DAY).book.unsettled.length, 0, 'also with no lots left');
  });

  await test('live lots are never cleared', () => {
    assert.throws(() => clearPaperLots(holding('live'), 90, T0 + DAY), /live lots/);
  });

  await test('no price, no clear', () => {
    assert.throws(() => clearPaperLots(holding(), 0, T0 + DAY), /no price/);
  });

  await test('a cleared book can buy again, starting a fresh ladder', () => {
    const { book } = clearPaperLots(holding(), 90, T0 + DAY);
    const d = decide(book, 85, T0 + 3 * DAY, P);
    assert.ok(d.some((x) => x.action === 'BUY' && x.level === 0));
  });

  await test('the live switch lists leftover paper sweep units', () => {
    const conn = { status: 'connected', expiresAt: T0 + DAY } as unknown as BrokerConnection;
    const base = { conn, now: T0, credentialsKeyOk: true, jwtSecretIsDefault: false, envBroker: 'paper', openLotBooks: [], openTrades: 0, simulatedData: false, staticIpSet: true };
    assert.ok(!liveSwitchBlockers(base).some((b) => /cash sweep/.test(b)));
    assert.ok(liveSwitchBlockers({ ...base, paperSweepUnits: 669 }).some((b) => /669 simulated LIQUIDCASE/.test(b)));
    assert.ok(liveSwitchBlockers({ ...base, totpEnabled: false }).some((b) => /two-factor/.test(b)), 'two-factor is listed when off');
    assert.ok(!liveSwitchBlockers({ ...base, totpEnabled: true }).some((b) => /two-factor/.test(b)));
  });

  await test('the tax view counts a cleared lot as a paper disposal, so earlier FIFO matches do not move', () => {
    const b = holding();
    const { book } = clearPaperLots(b, 90, T0 + DAY);
    const { buys, sells } = transactionsFromBooks([book]);
    assert.equal(buys.length, 1);
    assert.equal(sells.length, 1);
    const { holdings } = matchFifo(buys, sells);
    assert.equal(holdings.length, 0, 'nothing is left held');
  });

  await test('the sweep unwinds paper units at the last price and starts a clean ledger', async () => {
    const U = 'paper-clear-itest';
    store.cashSweeps.set(U, {
      userId: U, enabled: true, symbol: 'LIQUIDCASE', venue: 'paper',
      lots: [{ id: 'l1', quantity: 100, price: 110, charges: 5, boughtAt: T0, boughtOn: '2026-01-05', usableFrom: T0 + 2 * DAY }],
      cashOut: 11_005, realisedGain: 0, chargesPaid: 5, realised: [], createdAt: T0, updatedAt: T0,
    });
    const r = await cashSweep.clearPaper(U, T0 + 10 * DAY);
    const s = store.cashSweeps.get(U)!;
    assert.equal(r?.units, 100);
    assert.equal(s.lots.length, 0);
    assert.equal(s.cashOut, 0);
    assert.equal(s.venue, undefined);
    assert.equal(s.realised.length, 1, 'the paper income stays in its history');
    assert.equal(s.realised[0].venue, 'paper', 'tagged paper, so the live tax view leaves it out');
    assert.equal(s.realisedGain, 0, 'paper income is not carried into the live totals');
    assert.equal(s.chargesPaid, 0);
    assert.equal(await cashSweep.clearPaper(U, T0 + 11 * DAY), null, 'nothing left to clear');
    store.cashSweeps.delete(U);
  });

  await test('a sweep cleared before the totals reset is repaired once, and nothing else is', () => {
    const base = { userId: 'x', enabled: true, symbol: 'LIQUIDCASE', lots: [], cashOut: 0, realisedGain: 12.5, chargesPaid: 3, createdAt: T0, updatedAt: T0 };
    const row = { at: T0, quantity: 1, cost: 1, proceeds: 1, gain: 12.5, boughtOn: '2026-01-05' };
    assert.ok(isClearedPaperLedger({ ...base, realised: [{ ...row, venue: 'paper' as const }] }));
    assert.ok(isClearedPaperLedger({ ...base, realised: [row] }), 'rows from before the venue field are paper');
    assert.ok(!isClearedPaperLedger({ ...base, realised: [{ ...row, venue: 'live' as const }] }), 'live income is kept');
    assert.ok(!isClearedPaperLedger({ ...base, venue: 'live', realised: [row] }));
    assert.ok(!isClearedPaperLedger({ ...base, venue: 'paper', realised: [row] }), 'a sweep still on paper is left alone');
    assert.ok(!isClearedPaperLedger({ ...base, cashOut: 500, realised: [row] }), 'money still parked');
    assert.ok(!isClearedPaperLedger({ ...base, realisedGain: 0, chargesPaid: 0, realised: [row] }), 'already clean');
    const U = 'paper-clear-repair-itest';
    store.cashSweeps.set(U, { ...base, userId: U, realised: [row] });
    cashSweep.repairClearedPaperTotals();
    assert.equal(store.cashSweeps.get(U)!.realisedGain, 0);
    assert.equal(store.cashSweeps.get(U)!.realised.length, 1, 'history kept');
    store.cashSweeps.delete(U);
  });

  await test('live sweep units are never touched', async () => {
    const U = 'paper-clear-itest-live';
    store.cashSweeps.set(U, {
      userId: U, enabled: true, symbol: 'LIQUIDCASE', venue: 'live',
      lots: [{ id: 'l1', quantity: 10, price: 110, charges: 1, boughtAt: T0, boughtOn: '2026-01-05', usableFrom: T0 }],
      cashOut: 1_101, realisedGain: 0, chargesPaid: 1, realised: [], createdAt: T0, updatedAt: T0,
    });
    assert.equal(await cashSweep.clearPaper(U, T0 + DAY), null);
    assert.equal(store.cashSweeps.get(U)!.lots.length, 1);
    store.cashSweeps.delete(U);
  });

  if (failures.length) {
    console.error(`✗ paperClear: ${failures.length} failed, ${passed} passed`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`✓ paperClear: ${passed} passed`);
}

void main();

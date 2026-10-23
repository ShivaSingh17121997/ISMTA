/**
 * Start-gate history seeding tests.
 *
 * The start gate compares price to the rolling high over the last N recorded
 * days. These tests pin down that seeding from external bars keeps that index
 * chronological, never lowers a high the engine already saw, and leaves the
 * gate's arithmetic exactly as it was.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  DAY_HIGH_HISTORY_DAYS,
  mergeDayHighs,
  recordDayHigh,
  rollingHigh,
} from '../services/accumulator/engine';
import type { AccumulatorBook } from '../services/accumulator/types';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

const T0 = Date.parse('2026-09-08T04:00:00Z'); // 09:30 IST, Tue 8 Sep 2026

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b', userId: 'u', symbol: 'SYRMA', instrument: 'EQUITY', budget: 69_000, cash: 69_000,
    unsettled: [], openLots: [], closedLots: [], epochs: [], lotSeq: 0,
    dayHighs: {}, orderedDays: [], enabled: true, killSwitchEngaged: false,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

/** `n` trading-day-ish entries ending the day before `endIso`, highs rising by 1 a day. */
function bars(n: number, endIso: string, base = 1000): { day: string; high: number }[] {
  const end = Date.parse(endIso + 'T00:00:00Z');
  const out: { day: string; high: number }[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: d, high: base + (n - i) });
  }
  return out;
}

test('a fresh book has a one-day rolling high; seeding makes it a real lookback', () => {
  const fresh = recordDayHigh(book(), 1658.5, T0);
  assert.equal(fresh.orderedDays.length, 1);
  assert.equal(rollingHigh(fresh, 45), 1658.5);

  const seeded = mergeDayHighs(fresh, [...bars(60, '2026-09-08', 1600), { day: '2026-08-20', high: 1900 }]);
  assert.equal(seeded.orderedDays.length, 61);
  assert.equal(rollingHigh(seeded, 45), 1900, 'the seeded spike inside the window is the high');
});

test('the day index stays chronological however the entries arrive', () => {
  const b = recordDayHigh(book(), 100, T0); // today first
  const seeded = mergeDayHighs(b, bars(10, '2026-09-08').reverse());
  const sorted = [...seeded.orderedDays].sort();
  assert.deepEqual(seeded.orderedDays, sorted);
  assert.equal(seeded.orderedDays[seeded.orderedDays.length - 1], '2026-09-08', 'today stays last');
});

test('seeding never lowers a high the engine already watched', () => {
  const b = recordDayHigh(book(), 1700, T0);
  const seeded = mergeDayHighs(b, [{ day: '2026-09-08', high: 1650 }]);
  assert.equal(seeded.dayHighs['2026-09-08'], 1700);
});

test('a lookback window slices the most recent days, not the first recorded', () => {
  // Without the sort, a book that recorded today BEFORE being seeded would have
  // today at index 0 and slice(-45) would miss it entirely.
  const b = recordDayHigh(book(), 5000, T0);
  const seeded = mergeDayHighs(b, bars(100, '2026-09-08', 1000));
  assert.equal(rollingHigh(seeded, 45), 5000, "today's high is inside the 45-day window");
  assert.equal(rollingHigh(seeded, 1), 5000);
});

test('history is trimmed to the cap, dropping the oldest days', () => {
  const seeded = mergeDayHighs(book(), bars(300, '2026-09-08'));
  assert.equal(seeded.orderedDays.length, DAY_HIGH_HISTORY_DAYS);
  assert.equal(Object.keys(seeded.dayHighs).length, DAY_HIGH_HISTORY_DAYS);
  assert.equal(seeded.orderedDays[0] > '2026-01-01', true, 'oldest kept day is recent');
});

test('junk entries are ignored and an empty merge returns the same object', () => {
  const b = book();
  assert.equal(mergeDayHighs(b, []), b);
  assert.equal(mergeDayHighs(b, [{ day: 'not-a-date', high: 10 }, { day: '2026-09-01', high: 0 }]), b);
});

test('recordDayHigh after seeding keeps working: same day raises the max, new day appends', () => {
  let b = mergeDayHighs(book(), bars(5, '2026-09-08', 100));
  b = recordDayHigh(b, 150, T0);
  assert.equal(b.dayHighs['2026-09-08'], 150);
  assert.equal(b.orderedDays.length, 6);
  b = recordDayHigh(b, 160, T0);
  assert.equal(b.dayHighs['2026-09-08'], 160);
  assert.equal(b.orderedDays.length, 6, 'same day does not duplicate');
});

test('an authoritative refresh replaces a bad recorded high (the RELIANCE 2952 case)', () => {
  const poisoned = mergeDayHighs(book(), [
    { day: '2026-09-08', high: 2952.15 },
    { day: '2026-09-09', high: 1301 },
  ]);
  assert.equal(rollingHigh(poisoned, 45), 2952.15, 'a max-merge can never clear it');
  const fixed = mergeDayHighs(poisoned, [
    { day: '2026-09-08', high: 1310 },
    { day: '2026-09-09', high: 1305 },
    { day: '2026-09-10', high: 1299 },
  ], { authoritative: true });
  assert.equal(fixed.dayHighs['2026-09-08'], 1310);
  assert.equal(rollingHigh(fixed, 45), 1310);
});

test("an authoritative refresh never lowers the source's latest (still trading) day", () => {
  const b = recordDayHigh(book(), 1700, T0);
  const seeded = mergeDayHighs(b, [{ day: '2026-09-07', high: 1600 }, { day: '2026-09-08', high: 1650 }], { authoritative: true });
  assert.equal(seeded.dayHighs['2026-09-08'], 1700);
});

test('recordDayHigh keeps history at the cap on its own', () => {
  let b = mergeDayHighs(book(), bars(DAY_HIGH_HISTORY_DAYS, '2026-09-08'));
  assert.equal(b.orderedDays.length, DAY_HIGH_HISTORY_DAYS);
  b = recordDayHigh(b, 5000, T0);
  b = recordDayHigh(b, 5001, T0 + 86_400_000);
  assert.equal(b.orderedDays.length, DAY_HIGH_HISTORY_DAYS);
  assert.equal(Object.keys(b.dayHighs).length, DAY_HIGH_HISTORY_DAYS);
  assert.equal(b.dayHighs[b.orderedDays[b.orderedDays.length - 1]], 5001);
});

if (failures.length) {
  console.error(`✗ dayHighs: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ dayHighs: ${passed} passed`);

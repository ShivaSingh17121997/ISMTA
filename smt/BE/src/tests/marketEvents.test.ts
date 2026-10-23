/**
 * Entry blocks from market events (accumulator/events.ts) and the NSE
 * payload parsers (services/marketEvents.ts). No network.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { entryBlock, inOpeningWindow, isGapDown, sessionsSince, type EventVetoParams } from '../services/accumulator/events';
import { lastResultsDay, nseDate, parseCalendar, parseSurveillance, upcoming } from '../services/marketEvents';
import { decide } from '../services/accumulator/engine';
import { DEFAULT_ACCUMULATOR_PARAMS, type AccumulatorBook } from '../services/accumulator/types';

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

const IST = 5.5 * 3_600_000;
const at = (d: string, hh = 11) => Date.parse(`${d}T${String(hh).padStart(2, '0')}:00:00Z`) - IST;
const V: EventVetoParams = { surveillance: true, resultsSessions: 2, gapPct: 4, gapSessions: 2 };

test('sessions count trading days only, 0 on the day itself', () => {
  assert.equal(sessionsSince('2026-10-05', at('2026-10-05')), 0);
  assert.equal(sessionsSince('2026-10-05', at('2026-10-06')), 1);
  assert.equal(sessionsSince('2026-10-09', at('2026-10-12')), 1, 'Friday to Monday is one session');
  assert.equal(sessionsSince('2026-10-20', at('2026-10-06')), -1, 'a future day');
});

test('a gap-down is an open at least gapPct under the previous close', () => {
  assert.equal(isGapDown(100, 96, 4), true);
  assert.equal(isGapDown(100, 96.1, 4), false);
  assert.equal(isGapDown(undefined, 50, 4), false);
  assert.equal(isGapDown(100, 50, 0), false, 'off at 0');
});

test('only a first price from the opening minutes counts as the open', () => {
  const ist = (hh: number, mm: number) => Date.parse(`2026-10-06T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
  assert.equal(inOpeningWindow(ist(9, 15)), true);
  assert.equal(inOpeningWindow(ist(9, 30)), true);
  assert.equal(inOpeningWindow(ist(9, 31)), false);
  assert.equal(inOpeningWindow(ist(13, 0)), false, 'a late first price is an intraday fall, not a gap');
  assert.equal(inOpeningWindow(ist(9, 0)), false, 'pre-open');
});

test('surveillance blocks new rungs; the reason names the stage', () => {
  const r = entryBlock({ now: at('2026-10-06'), params: V, surveillance: { asm: 'long-term Stage I' } });
  assert.match(r ?? '', /ASM long-term Stage I/);
  assert.equal(entryBlock({ now: at('2026-10-06'), params: { ...V, surveillance: false }, surveillance: { asm: 'x' } }), null);
});

test('results block the day itself and the next N sessions, then lift', () => {
  const p = { ...V, gapPct: 0 };
  assert.ok(entryBlock({ now: at('2026-10-05'), params: p, lastResultsDay: '2026-10-05' }));
  assert.ok(entryBlock({ now: at('2026-10-07'), params: p, lastResultsDay: '2026-10-05' }));
  assert.equal(entryBlock({ now: at('2026-10-08'), params: p, lastResultsDay: '2026-10-05' }), null);
});

test('buying before results is not blocked', () => {
  assert.equal(entryBlock({ now: at('2026-10-05'), params: V, lastResultsDay: undefined }), null);
});

test('a gap-down blocks for gapSessions sessions', () => {
  assert.ok(entryBlock({ now: at('2026-10-06'), params: V, gapDownDay: '2026-10-05' }));
  assert.equal(entryBlock({ now: at('2026-10-08'), params: V, gapDownDay: '2026-10-05' }), null);
});

test('a blocked book holds new rungs but still sells', () => {
  const book = {
    id: 'b', userId: 'u', symbol: 'X', instrument: 'EQUITY', budget: 100_000, cash: 100_000,
    unsettled: [], closedLots: [], epochs: [], lotSeq: 0, dayHighs: {}, orderedDays: [],
    enabled: true, killSwitchEngaged: false, createdAt: 0, updatedAt: 0,
    openLots: [{ id: 'X-e0-l0-0', epoch: 0, level: 0, fillPrice: 100, quantity: 100, quoteSpent: 10_000, openedAt: 0 }],
    entryBlock: 'On NSE surveillance (ASM Stage I): no new rungs until it is lifted',
  } as unknown as AccumulatorBook;
  const high = decide(book, 120, at('2026-10-06'), DEFAULT_ACCUMULATOR_PARAMS);
  assert.ok(high.some((d) => d.action === 'SELL'), 'the exit still fires');
  const low = decide({ ...book, openLots: [] }, 50, at('2026-10-06'), DEFAULT_ACCUMULATOR_PARAMS);
  assert.ok(low.every((d) => d.action !== 'BUY'));
  assert.match(low.find((d) => d.action === 'HOLD')?.reason ?? '', /surveillance/);
});

// ─── NSE parsers ─────────────────────────────────────────────────────────
test('NSE dates parse, with or without a time', () => {
  assert.equal(nseDate('29-Jul-2026'), '2026-07-29');
  assert.equal(nseDate('6-Oct-2026 08:07:02'), '2026-10-06');
  assert.equal(nseDate('soon'), null);
});

test('the three surveillance payloads merge into one map by symbol', () => {
  const m = parseSurveillance(
    { longterm: { data: [{ symbol: 'AAA', asmSurvIndicator: 'Stage I' }] }, shortterm: { data: [{ symbol: 'BBB', asmSurvIndicator: 'Stage II' }] } },
    [{ symbol: 'AAA', gsmStage: '0' }],
    [{ symbol: 'CCC', esmSurvIndicator: 'Stage I' }],
  );
  assert.deepEqual(m.get('AAA'), { asm: 'long-term Stage I', gsm: '0' });
  assert.deepEqual(m.get('BBB'), { asm: 'short-term Stage II' });
  assert.deepEqual(m.get('CCC'), { esm: 'Stage I' });
  assert.equal(m.get('ZZZ'), undefined);
});

test('the calendar marks results meetings and finds the latest one so far', () => {
  const ev = parseCalendar(
    [
      { symbol: 'SYRMA', purpose: 'Financial results', bm_desc: '', date: '29-Jul-2026' },
      { symbol: 'SYRMA', purpose: 'Fund Raising', bm_desc: 'to raise funds', date: '15-Aug-2026' },
      { symbol: 'SYRMA', purpose: 'Board Meeting', bm_desc: 'to approve the Financial Results for Sep 2026', date: '05-Nov-2026' },
      { symbol: 'OTHER', purpose: 'Financial results', date: '01-Oct-2026' },
    ],
    'SYRMA',
  );
  assert.equal(ev.length, 3);
  assert.equal(lastResultsDay(ev, '2026-10-06'), '2026-07-29');
  assert.deepEqual(upcoming(ev, '2026-10-25').map((e) => e.date), ['2026-11-05']);
});

if (failures.length) {
  console.error(`✗ marketEvents: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ marketEvents: ${passed} passed`);

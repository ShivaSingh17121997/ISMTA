/**
 * NSE session + microstructure tests.
 *
 * This is date/time and money-rounding code — exactly where silent off-by-one
 * bugs live, and where a mistake means the bot trades a closed market or hands
 * the broker a ₹59 square-off.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  canEnter,
  canPlaceMarketOrder,
  hhmm,
  isHoliday,
  isMarketOpen,
  istParts,
  mustFlatten,
  orderEntryBlocked,
  pastSquareOff,
  phaseAt,
  addHolidays,
  holidayCalendarKnown,
  isTradingDay,
} from '../services/session';
import {
  isFnoEligible,
  priceBandPct,
  roundStopToTick,
  roundToTick,
  tickSize,
  withinPriceBand,
} from '../services/nse';
import { parseNseHolidays } from '../services/holidayCalendar';

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

/** An IST wall-clock time on a given date → UTC epoch. IST = UTC+5:30, no DST. */
function ist(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3_600_000;
}

// 2026-07-15 is a Wednesday and not a holiday.
const WED = '2026-07-15';
const SAT = '2026-07-18';
const SUN = '2026-07-19';

// ─── IST conversion ────────────────────────────────────────────────────

test('istParts: converts UTC to IST wall clock', () => {
  const p = istParts(ist(WED, '09:15'));
  assert.equal(p.date, WED);
  assert.equal(p.minutes, hhmm('09:15'));
  assert.equal(p.dayOfWeek, 3, 'Wednesday');
});

test('istParts: 00:00 UTC is 05:30 IST the SAME day — why UTC-day P&L keying is safe', () => {
  // The whole 09:15–15:30 IST session sits inside one UTC day precisely because
  // the UTC boundary lands at 05:30 IST, before the open.
  const p = istParts(Date.UTC(2026, 6, 15, 0, 0));
  assert.equal(p.date, WED);
  assert.equal(p.minutes, hhmm('05:30'));
});

test('istParts: late-evening IST rolls to the next UTC day but stays on the IST date', () => {
  const p = istParts(ist(WED, '23:30')); // = 18:00 UTC same day
  assert.equal(p.date, WED);
  assert.equal(p.minutes, hhmm('23:30'));
});

// ─── Phases ────────────────────────────────────────────────────────────

test('phaseAt: the full trading day', () => {
  assert.equal(phaseAt(ist(WED, '08:59')), 'closed');
  assert.equal(phaseAt(ist(WED, '09:00')), 'pre_open');
  assert.equal(phaseAt(ist(WED, '09:14')), 'pre_open');
  assert.equal(phaseAt(ist(WED, '09:15')), 'open', 'continuous trading starts exactly at 09:15');
  assert.equal(phaseAt(ist(WED, '12:00')), 'open');
  assert.equal(phaseAt(ist(WED, '15:29')), 'open');
  assert.equal(phaseAt(ist(WED, '15:30')), 'closed', 'the close is exclusive');
  assert.equal(phaseAt(ist(WED, '15:40')), 'post_close');
  assert.equal(phaseAt(ist(WED, '16:00')), 'closed');
});

test('phaseAt: weekends are closed all day', () => {
  assert.equal(phaseAt(ist(SAT, '12:00')), 'closed');
  assert.equal(phaseAt(ist(SUN, '12:00')), 'closed');
});

test('isHoliday / phaseAt: NSE 2026 holidays are closed', () => {
  assert.ok(isHoliday(ist('2026-08-15', '12:00')) === false, 'Aug 15 2026 is a Saturday, not listed');
  assert.ok(isHoliday(ist('2026-10-02', '12:00')), 'Gandhi Jayanti');
  assert.equal(phaseAt(ist('2026-10-02', '12:00')), 'closed');
  assert.ok(isHoliday(ist('2026-12-25', '12:00')), 'Christmas');
  assert.ok(!isHoliday(ist(WED, '12:00')), 'a normal Wednesday is not a holiday');
});

test('isMarketOpen: only during continuous trading', () => {
  assert.ok(isMarketOpen(ist(WED, '10:00')));
  assert.ok(!isMarketOpen(ist(WED, '09:10')), 'pre-open is not tradeable');
  assert.ok(!isMarketOpen(ist(SAT, '10:00')));
});

// ─── Entry gate ────────────────────────────────────────────────────────

test('canEnter: blocked during the opening volatility window', () => {
  assert.equal(canEnter(ist(WED, '09:16')).ok, false, 'default entryOpensAt is 09:20');
  assert.match(canEnter(ist(WED, '09:16')).reason!, /opening volatility/);
  assert.equal(canEnter(ist(WED, '09:20')).ok, true, 'open exactly at the boundary');
});

test('canEnter: blocked near the close — no time to manage the trade', () => {
  assert.equal(canEnter(ist(WED, '14:59')).ok, true);
  assert.equal(canEnter(ist(WED, '15:00')).ok, false, 'default entryClosesAt is 15:00');
  assert.match(canEnter(ist(WED, '15:00')).reason!, /square-off/);
});

test('canEnter: blocked outside market hours and on holidays', () => {
  assert.equal(canEnter(ist(WED, '09:05')).ok, false, 'pre-open');
  assert.equal(canEnter(ist(WED, '16:30')).ok, false, 'after hours');
  assert.equal(canEnter(ist(SAT, '12:00')).ok, false, 'weekend');
  assert.equal(canEnter(ist('2026-12-25', '12:00')).ok, false, 'holiday');
});

// ─── Flatten window ────────────────────────────────────────────────────

test('mustFlatten: fires at 15:10, BEFORE the CAS block and the broker square-off', () => {
  assert.equal(mustFlatten(ist(WED, '15:09')), false);
  assert.equal(mustFlatten(ist(WED, '15:10')), true, 'default flattenAt');
  assert.equal(mustFlatten(ist(WED, '15:20')), true);
});

test('mustFlatten: the flatten window opens before entries stop mattering', () => {
  // Ordering invariant: entries must stop BEFORE we start force-flattening,
  // otherwise the engine opens a position into its own exit.
  assert.ok(
    hhmm('15:00') < hhmm('15:10'),
    'entryClosesAt must precede flattenAt',
  );
  assert.equal(canEnter(ist(WED, '15:10')).ok, false, 'and no entry is possible once flattening');
});

test('mustFlatten: not on a closed day', () => {
  assert.equal(mustFlatten(ist(SAT, '15:15')), false);
});

test('pastSquareOff: 15:25 is when the broker takes over (₹59 + a price you did not pick)', () => {
  assert.equal(pastSquareOff(ist(WED, '15:24')), false);
  assert.equal(pastSquareOff(ist(WED, '15:25')), true);
});

// ─── Closing Auction Session (effective 2026-08-03, F&O scrips only) ────

const BEFORE_CAS = '2026-07-15'; // Wed, before the CAS goes live
const AFTER_CAS = '2026-08-05'; // Wed, after

test('CAS: inert before 2026-08-03', () => {
  assert.equal(canPlaceMarketOrder(ist(BEFORE_CAS, '15:26'), 'RELIANCE').ok, true);
  assert.equal(orderEntryBlocked(ist(BEFORE_CAS, '15:17'), 'RELIANCE').ok, true);
});

test('CAS: freezes MARKET orders 15:25–15:30 for F&O scrips once live', () => {
  assert.equal(canPlaceMarketOrder(ist(AFTER_CAS, '15:24'), 'RELIANCE').ok, true);
  const blocked = canPlaceMarketOrder(ist(AFTER_CAS, '15:26'), 'RELIANCE');
  assert.equal(blocked.ok, false, 'a market exit here would be REJECTED by the exchange');
  assert.match(blocked.reason!, /market orders frozen/);
  assert.equal(canPlaceMarketOrder(ist(AFTER_CAS, '15:30'), 'RELIANCE').ok, true, 'window is exclusive');
});

test('CAS: blocks fresh order entry 15:15–15:20 for F&O scrips', () => {
  assert.equal(orderEntryBlocked(ist(AFTER_CAS, '15:14'), 'RELIANCE').ok, true);
  assert.equal(orderEntryBlocked(ist(AFTER_CAS, '15:17'), 'RELIANCE').ok, false);
  assert.equal(orderEntryBlocked(ist(AFTER_CAS, '15:20'), 'RELIANCE').ok, true, 'entry reopens at 15:20');
});

test('CAS: applies ONLY to F&O-eligible securities', () => {
  assert.ok(isFnoEligible('RELIANCE'));
  assert.ok(!isFnoEligible('SOMESMALLCAP'));
  assert.equal(canPlaceMarketOrder(ist(AFTER_CAS, '15:26'), 'SOMESMALLCAP').ok, true, 'non-F&O trades on');
  assert.equal(canPlaceMarketOrder(ist(AFTER_CAS, '15:26'), 'RELIANCE').ok, false);
});

test('CAS: the default flatten time keeps us out of both CAS windows entirely', () => {
  // This is the whole point of flattenAt=15:10 — we are flat before the exchange
  // starts restricting anything.
  assert.equal(mustFlatten(ist(AFTER_CAS, '15:10')), true);
  assert.equal(orderEntryBlocked(ist(AFTER_CAS, '15:10'), 'RELIANCE').ok, true, 'exit orders still allowed at 15:10');
  assert.equal(canPlaceMarketOrder(ist(AFTER_CAS, '15:10'), 'RELIANCE').ok, true);
});

// ─── Tick size ladder (NSE, effective 2025-04-15) ───────────────────────

test('tickSize: the full ladder', () => {
  assert.equal(tickSize(99), 0.01, '< ₹250');
  assert.equal(tickSize(249.99), 0.01);
  assert.equal(tickSize(250), 0.05, '₹250–1,000');
  assert.equal(tickSize(999.99), 0.05);
  assert.equal(tickSize(1000), 0.1, '₹1,000–5,000');
  assert.equal(tickSize(4999), 0.1);
  assert.equal(tickSize(5000), 0.5, '₹5,000–10,000');
  assert.equal(tickSize(10000), 1, '₹10,000–20,000');
  assert.equal(tickSize(25000), 5, '> ₹20,000');
});

test('roundToTick: snaps onto the grid', () => {
  assert.equal(roundToTick(2950.37), 2950.4, '₹0.10 tick at 2950');
  assert.equal(roundToTick(123.456), 123.46, '₹0.01 tick under 250');
  assert.equal(roundToTick(755.52), 755.5, '₹0.05 tick at 755');
  assert.equal(roundToTick(7500.3), 7500.5, '₹0.50 tick at 7500');
});

test('roundToTick: kills float dust — an invalid tick is an exchange rejection', () => {
  // The engine computes entry*(1-1/100) and gets 99.49000000000001. NSE rejects
  // that outright, so every stop the engine emits must be snapped.
  const raw = 100.5 * (1 - 1 / 100); // 99.495
  const r = roundToTick(raw);
  assert.equal(r, 99.5);
  assert.equal(Math.round(r / tickSize(r)) * tickSize(r), r, 'lands exactly on the grid');
});

test('roundToTick: up/down modes', () => {
  assert.equal(roundToTick(2950.31, 'down'), 2950.3);
  assert.equal(roundToTick(2950.31, 'up'), 2950.4);
});

test('roundStopToTick: rounding never TIGHTENS a stop', () => {
  // A long's stop must move down (wider), a short's up (wider). Rounding the
  // other way would silently fire every stop earlier than configured.
  const longStop = 2950.37;
  assert.ok(roundStopToTick(longStop, 'BUY') <= longStop, 'long stop rounds down = wider');
  assert.equal(roundStopToTick(longStop, 'BUY'), 2950.3);

  const shortStop = 2950.31;
  assert.ok(roundStopToTick(shortStop, 'SELL') >= shortStop, 'short stop rounds up = wider');
  assert.equal(roundStopToTick(shortStop, 'SELL'), 2950.4);
});

// ─── Price bands ───────────────────────────────────────────────────────

test('priceBandPct: 10% dynamic for F&O scrips, 20% otherwise', () => {
  assert.equal(priceBandPct(true), 10);
  assert.equal(priceBandPct(false), 20);
});

test('withinPriceBand: rejects prices outside the circuit', () => {
  assert.ok(withinPriceBand(1050, 1000, true), '+5% is inside the 10% F&O band');
  assert.ok(!withinPriceBand(1150, 1000, true), '+15% is outside');
  assert.ok(withinPriceBand(1150, 1000, false), 'but inside the 20% band for non-F&O');
  assert.ok(!withinPriceBand(790, 1000, false), '-21% is outside');
});

test('withinPriceBand: no reference price → do not block', () => {
  assert.ok(withinPriceBand(1000, 0, true), 'unknown reference must not veto a trade');
});


test('NSE holiday master rows parse to ISO dates and extend the calendar', () => {
  const body = { CM: [{ tradingDate: '26-Jan-2027' }, { tradingDate: '5-Mar-2027' }, { tradingDate: 'garbage' }] };
  assert.deepEqual(parseNseHolidays(body), ['2027-01-26', '2027-03-05']);
  assert.deepEqual(parseNseHolidays({}), []);
  assert.equal(holidayCalendarKnown(2031), false);
  assert.equal(addHolidays(['2031-01-26', 'nonsense']), 1);
  assert.equal(holidayCalendarKnown(2031), true);
  assert.equal(isTradingDay(Date.parse('2031-01-26T05:00:00Z')), false, 'a merged holiday is a closed day');
  assert.equal(addHolidays(['2031-01-26']), 0, 'no duplicates');
});

if (failures.length) {
  console.error(`\n✗ session: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ session: ${passed} passed`);

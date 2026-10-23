/**
 * Capital-gains ledger (services/tax/ledger.ts): FIFO matching, holding
 * period, set-off, carry-forward, STT treatment and harvest maths.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  LTCG_EXEMPTION,
  financialYear,
  harvestCandidates,
  isLongTerm,
  matchFifo,
  summarise,
  taxFor,
  transactionsFromBooks,
  type TaxBuy,
  type TaxMatch,
  type TaxSell,
} from '../services/tax/ledger';
import { charges } from '../services/costs';
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

const IST = 5.5 * 3_600_000;
/** Noon IST on a calendar date. */
const at = (d: string) => Date.parse(`${d}T12:00:00Z`) - IST;
const buy = (d: string, quantity: number, cost: number, symbol = 'ABC'): TaxBuy => ({ symbol, at: at(d), quantity, cost });
const sell = (d: string, quantity: number, proceeds: number, symbol = 'ABC'): TaxSell => ({ symbol, at: at(d), quantity, proceeds, enginePnl: 0 });

test('the financial year runs April to March', () => {
  assert.equal(financialYear(at('2026-03-31')), '2025-26');
  assert.equal(financialYear(at('2026-04-01')), '2026-27');
  assert.equal(financialYear(at('2027-01-15')), '2026-27');
});

test('long-term means held MORE than twelve months', () => {
  assert.equal(isLongTerm(at('2025-01-10'), at('2026-01-10')), false, 'exactly 12 months is short-term');
  assert.equal(isLongTerm(at('2025-01-10'), at('2026-01-11')), true);
  assert.equal(isLongTerm(at('2025-01-10'), at('2025-12-31')), false);
});

test('sales match the OLDEST shares first, whichever lot the bot closed', () => {
  // Bot buys 10 @100 then 10 @80, then sells the cheap lot @84 (a profit for the bot).
  const { matches, holdings } = matchFifo(
    [buy('2026-04-10', 10, 1000), buy('2026-05-10', 10, 800)],
    [sell('2026-05-20', 10, 840)],
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].cost, 1000, 'FIFO takes the ₹100 lot');
  assert.equal(matches[0].gain, -160, 'a loss for tax');
  assert.deepEqual(holdings.map((h) => [h.quantity, h.cost]), [[10, 800]]);
});

test('one sale can span several buys, split pro rata', () => {
  const { matches } = matchFifo([buy('2026-04-10', 5, 500), buy('2026-04-20', 10, 900)], [sell('2026-06-01', 8, 880)]);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.quantity), [5, 3]);
  assert.equal(matches[0].proceeds + matches[1].proceeds, 880);
  assert.ok(Math.abs(matches[1].cost - 270) < 1e-9);
});

test('a sale with nothing bought before it is reported, never invented', () => {
  const { matches, unmatched } = matchFifo([buy('2026-06-01', 5, 500)], [sell('2026-05-01', 5, 600)]);
  assert.equal(matches.length, 0);
  assert.equal(unmatched.length, 1);
});

test('symbols are matched separately', () => {
  const { matches } = matchFifo([buy('2026-04-10', 5, 500, 'A'), buy('2026-04-10', 5, 900, 'B')], [sell('2026-05-01', 5, 1000, 'B')]);
  assert.equal(matches[0].symbol, 'B');
  assert.equal(matches[0].gain, 100);
});

test('a short-term loss offsets long-term gains; a long-term loss never offsets short-term', () => {
  const m = (gain: number, longTerm: boolean, fy = '2026-27'): TaxMatch => ({
    symbol: 'X', quantity: 1, boughtAt: 0, soldAt: 0, cost: 0, proceeds: gain, gain, longTerm, fy,
  });
  const [a] = summarise([m(-50_000, false), m(200_000, true)]);
  assert.equal(a.taxableShortTerm, 0);
  assert.equal(a.netLongTerm, 150_000);
  assert.equal(a.taxableLongTerm, 150_000 - LTCG_EXEMPTION);
  const [b] = summarise([m(-50_000, true), m(80_000, false)]);
  assert.equal(b.taxableShortTerm, 80_000, 'LT loss cannot touch ST gains');
  assert.equal(b.carryForward.longTerm, 50_000);
});

test('losses carry forward and are used in a later year', () => {
  const m = (gain: number, fy: string): TaxMatch => ({ symbol: 'X', quantity: 1, boughtAt: 0, soldAt: 0, cost: 0, proceeds: gain, gain, longTerm: false, fy });
  const [y1, y2] = summarise([m(-30_000, '2025-26'), m(50_000, '2026-27')]);
  assert.equal(y1.carryForward.shortTerm, 30_000);
  assert.equal(y1.estimatedTax, 0);
  assert.equal(y2.broughtForwardUsed, 30_000);
  assert.equal(y2.taxableShortTerm, 20_000);
  assert.ok(Math.abs(y2.estimatedTax - 20_000 * 0.2 * 1.04) < 1e-6);
});

test('tax: 20% short-term, 12.5% long-term above ₹1.25 lakh, plus 4% cess', () => {
  assert.ok(Math.abs(taxFor(100_000, 0) - 20_800) < 1e-6);
  assert.equal(taxFor(0, 125_000), 0);
  assert.ok(Math.abs(taxFor(0, 225_000) - 13_000) < 1e-6);
});

test('STT is taken out of cost and added back to proceeds; other charges stay', () => {
  const book = {
    symbol: 'ABC', instrument: 'EQUITY',
    openLots: [],
    closedLots: [{ id: 'l', epoch: 0, level: 0, fillPrice: 100, quantity: 100, quoteSpent: 10_020, openedAt: at('2026-04-10'),
      sellPrice: 105, closedAt: at('2026-05-10'), proceeds: 10_460, pnl: 440, netBreakeven: 100.4 }],
  } as unknown as AccumulatorBook;
  const { buys, sells } = transactionsFromBooks([book]);
  const sttBuy = charges('BUY', 100, 100, { product: 'CNC', instrument: 'EQUITY' }).stt;
  const sttSell = charges('SELL', 105, 100, { product: 'CNC', instrument: 'EQUITY' }).stt;
  assert.ok(sttBuy > 0 && sttSell > 0);
  assert.ok(Math.abs(buys[0].cost - (10_020 - sttBuy)) < 1e-9);
  assert.ok(Math.abs(sells[0].proceeds - (10_460 + sttSell)) < 1e-9);
  assert.equal(sells[0].enginePnl, 440);
});

test('harvesting a loss pays only when there are gains this year to offset', () => {
  const now = at('2027-03-10');
  const holdings = [{ symbol: 'LOSER', boughtAt: at('2026-10-01'), quantity: 100, cost: 50_000 }];
  const prices = { LOSER: 400 }; // ₹10,000 under cost
  const withGains = summarise([{ symbol: 'W', quantity: 1, boughtAt: 0, soldAt: now, cost: 0, proceeds: 30_000, gain: 30_000, longTerm: false, fy: '2026-27' }])[0];
  const [c] = harvestCandidates(holdings, prices, { LOSER: 'EQUITY' }, withGains, now);
  assert.ok(c.shortTerm < -9_000);
  assert.ok(c.taxBefore - c.taxAfter > 2_000, 'about 20.8% of the loss is saved');
  assert.ok(c.netBenefit > 0);
  const [none] = harvestCandidates(holdings, prices, { LOSER: 'EQUITY' }, undefined, now);
  assert.ok(none.netBenefit < 0, 'no gains: the harvest only costs charges');
});

test('a holding in profit is never a harvest candidate', () => {
  const holdings = [{ symbol: 'WIN', boughtAt: at('2026-10-01'), quantity: 10, cost: 1_000 }];
  assert.equal(harvestCandidates(holdings, { WIN: 150 }, { WIN: 'EQUITY' }, undefined, at('2027-03-10')).length, 0);
});

test('29 Feb: twelve months end on 28 Feb, so a sale on 1 Mar next year is long-term', () => {
  assert.equal(isLongTerm(at('2024-02-29'), at('2025-02-28')), false);
  assert.equal(isLongTerm(at('2024-02-29'), at('2025-03-01')), true);
});

test('a carried-forward loss expires after 8 years', () => {
  const m = (gain: number, fy: string): TaxMatch => ({ symbol: 'X', quantity: 1, boughtAt: 0, soldAt: 0, cost: 0, proceeds: gain, gain, longTerm: false, fy });
  const within = summarise([m(-10_000, '2020-21'), m(10_000, '2028-29')]);
  assert.equal(within[1].taxableShortTerm, 0, 'year 8 may still use it');
  const after = summarise([m(-10_000, '2020-21'), m(10_000, '2029-30')]);
  assert.equal(after[1].taxableShortTerm, 10_000, 'year 9 may not');
});

test('a live report counts only lots bought live, even on a book that traded paper first', () => {
  const lotP = { id: 'p', epoch: 0, level: 0, fillPrice: 100, quantity: 10, quoteSpent: 1_000, openedAt: at('2026-04-10'),
    sellPrice: 105, closedAt: at('2026-05-10'), proceeds: 1_045, pnl: 45, netBreakeven: 100.4 };
  const book = {
    symbol: 'ABC', instrument: 'EQUITY', venue: 'live',
    openLots: [{ id: 'l', epoch: 1, level: 0, fillPrice: 90, quantity: 10, quoteSpent: 900, openedAt: at('2026-06-10'), venue: 'live' }],
    closedLots: [lotP],
  } as unknown as AccumulatorBook;
  const live = transactionsFromBooks([book], 'live');
  assert.equal(live.buys.length, 1, 'only the live buy');
  assert.equal(live.sells.length, 0, 'the paper sale stays out');
  const paper = transactionsFromBooks([book], 'paper');
  assert.equal(paper.sells.length, 1);
});

if (failures.length) {
  console.error(`✗ tax: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ tax: ${passed} passed`);

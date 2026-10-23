/**
 * The pre-trade gate: session, instrument, feed health, reference deviation,
 * price band, rate. Each check here was a real hole found on 10 Sep 2026.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { config } from '../config';
import { marketData } from '../services/MarketDataService';
import { parseEtfMaster } from '../services/instruments';
import { preTradeGate, tradability } from '../services/orderGate';
import { OrderRateLimiter, tradingHalt } from '../services/guards';
import { store } from '../store/memoryStore';
import { OrderRequest } from '../types';

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

// Monday 5 Jan 2026 — 10:30 IST is inside the session; 17:14 IST is after it.
const OPEN = Date.parse('2026-01-05T05:00:00Z');
const CLOSED = Date.parse('2026-01-05T11:44:00Z');
const SUNDAY = Date.parse('2026-01-04T05:00:00Z');

const base: OrderRequest = { symbol: 'RELIANCE', side: 'BUY', quantity: 1, orderType: 'MARKET', product: 'MIS', userId: 'u' };
(config.session as { enabled: boolean }).enabled = true;

test('a MARKET order after the close is refused, not filled', () => {
  const v = preTradeGate(base, CLOSED);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'market_closed');
});

test('a weekend is closed too', () => {
  assert.equal(preTradeGate(base, SUNDAY).code, 'market_closed');
});

test('inside the session, with a price, it passes', () => {
  const v = preTradeGate(base, OPEN);
  assert.equal(v.ok, true, v.reason);
});

test('an index cannot be bought in the cash segment', () => {
  const v = preTradeGate({ ...base, symbol: 'NIFTY' }, OPEN);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'not_tradable');
  assert.equal(preTradeGate({ ...base, symbol: 'BANKNIFTY' }, OPEN).code, 'not_tradable');
});

test('a LIMIT order without a price is refused', () => {
  const v = preTradeGate({ ...base, orderType: 'LIMIT' }, OPEN);
  assert.equal(v.code, 'limit_needs_price');
  assert.equal(preTradeGate({ ...base, orderType: 'LIMIT', price: 1200 }, OPEN).ok, true);
});

test('a symbol with no price is refused', () => {
  const v = preTradeGate({ ...base, symbol: 'ZZZNOPRICE' }, OPEN);
  assert.equal(v.code, 'no_quote');
});

test('the live quote must be near the decision price', () => {
  const ltp = marketData.getPrice('RELIANCE');
  const far = preTradeGate({ ...base, referencePrice: ltp * 0.75 }, OPEN);
  assert.equal(far.ok, false);
  assert.equal(far.code, 'reference_deviation');
  const near = preTradeGate({ ...base, referencePrice: ltp * 1.005 }, OPEN);
  assert.equal(near.ok, true, near.reason);
});

test('a print outside the daily band around the previous close is refused', () => {
  const ltp = marketData.getPrice('RELIANCE');
  marketData.setReference('RELIANCE', ltp * 1.5); // previous close 50% above today's print
  try {
    const v = preTradeGate(base, OPEN);
    assert.equal(v.code, 'price_band');
  } finally {
    marketData.setReference('RELIANCE', ltp);
  }
  assert.equal(preTradeGate(base, OPEN).ok, true);
});

test('a stale quote is refused on the real clock; a simulated clock is exempt', () => {
  marketData.ingestTick('RELIANCE', marketData.getPrice('RELIANCE')); // the feed is live, ticked "now"
  (config.session as { enabled: boolean }).enabled = false;
  try {
    // A caller two minutes ahead of the wall clock is still "real"; the tick is
    // then older than the 90 s limit → stale.
    const stale = preTradeGate(base, Date.now() + config.guards.maxQuoteAgeMs + 30_000);
    assert.equal(stale.code, 'stale_quote', stale.reason);
    // A caller weeks away from the wall clock is a simulation → exempt.
    assert.equal(preTradeGate(base, OPEN).ok, true);
  } finally {
    (config.session as { enabled: boolean }).enabled = true;
  }
});

test('a process-wide halt refuses everything, exits included', () => {
  tradingHalt.set('test', 'unit test');
  try {
    const v = preTradeGate({ ...base, intent: 'exit', side: 'SELL' }, OPEN);
    assert.equal(v.code, 'halted');
  } finally {
    tradingHalt.clear('test');
  }
  assert.equal(preTradeGate(base, OPEN).ok, true);
});

test('with the session disabled the clock is ignored', () => {
  (config.session as { enabled: boolean }).enabled = false;
  try {
    assert.equal(preTradeGate(base, CLOSED).ok, true);
  } finally {
    (config.session as { enabled: boolean }).enabled = true;
  }
});

test('tradability consults the master when it is loaded', () => {
  const had = store.instruments.size;
  if (had === 0) {
    store.instruments.set('ABC', { symbol: 'ABC', name: 'ABC Ltd', series: 'EQ', isin: 'X', listedOn: '2020-01-01', faceValue: 1, fetchedAt: 0 });
    store.instruments.set('T2T', { symbol: 'T2T', name: 'T2T Ltd', series: 'BE', isin: 'Y', listedOn: '2020-01-01', faceValue: 1, fetchedAt: 0 });
  }
  try {
    assert.equal(tradability('ABC', 'MIS').ok, true);
    assert.equal(tradability('NOTLISTED', 'MIS').ok, false);
    assert.equal(tradability('T2T', 'MIS').ok, false, 'trade-for-trade has no intraday');
    assert.equal(tradability('T2T', 'CNC').ok, true, 'but delivery is fine');
  } finally {
    if (had === 0) {
      store.instruments.delete('ABC');
      store.instruments.delete('T2T');
    }
  }
});

test('index ETFs trade in the cash segment; the index itself still does not', () => {
  const csv = [
    'Symbol,Underlying Asset,SecurityName,DateofListing,MarketLot,ISINNumber,FaceValue,ETF Underlying,Underlying Key',
    'NIFTYBEES,Nifty 50,NIPINDETFNIFTYBEES,08-Jan-02,1,INF204KB14I2,1,EQUITY,Nifty 50',
    'BANKBEES,Nifty Bank,NIPINDETFBANKBEES,04-Jun-04,1,INF204KB15I9,1,EQUITY,Nifty Bank',
  ].join('\r\n');
  const added = parseEtfMaster(csv).filter((r) => !store.instruments.has(r.symbol));
  const filler = store.instruments.size === 0;
  if (filler) {
    store.instruments.set('ABC', { symbol: 'ABC', name: 'ABC Ltd', series: 'EQ', isin: 'X', listedOn: '2020-01-01', faceValue: 1, fetchedAt: 0 });
  }
  for (const r of added) store.instruments.set(r.symbol, r);
  try {
    assert.equal(tradability('NIFTYBEES', 'CNC').ok, true);
    assert.equal(tradability('BANKBEES', 'MIS').ok, true);
    assert.equal(tradability('NIFTY', 'CNC').code, 'not_tradable');
    assert.equal(tradability('BANKNIFTY', 'CNC').code, 'not_tradable');
  } finally {
    for (const r of added) store.instruments.delete(r.symbol);
    if (filler) store.instruments.delete('ABC');
  }
});

test('rate limiter: 10 in a second is the line', () => {
  const rl = new OrderRateLimiter(10, 400, 5000);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(rl.check(t0 + i).ok, true, `order ${i + 1}`);
    rl.record(t0 + i);
  }
  const eleventh = rl.check(t0 + 10);
  assert.equal(eleventh.ok, false);
  assert.match(eleventh.reason ?? '', /10\/s/);
  assert.equal(rl.check(t0 + 1_001).ok, true, 'a second later the window has moved');
});

test('rate limiter: the per-day cap holds across the day', () => {
  const rl = new OrderRateLimiter(0, 0, 3);
  const t0 = 5_000_000;
  rl.record(t0);
  rl.record(t0 + 3_600_000);
  rl.record(t0 + 7_200_000);
  assert.equal(rl.check(t0 + 10_800_000).ok, false);
  assert.equal(rl.check(t0 + 86_400_001).ok, true, 'the first one has aged out');
});

// ── one symbol, one engine ──────────────────────────────────────────────────
//
// The accumulator and the strategy engine are independent and share one broker
// account. Before this gate, books existed for RELIANCE and TCS while the
// seeded MA Crossover strategy was short both; only the allocator's trend
// filter kept them apart, and the allocator can enable a book on its own.
//
// The accumulator is the system of record and keeps running. The strategy
// yields — but only on ENTRIES, and only on symbols a book actually owns.

/** Put an accumulator book for `u` on the symbol, enabled or not. */
function bookOn(symbol: string, enabled: boolean): void {
  store.accumulatorBooks.set(`u:${symbol}`, {
    id: `bk-${symbol}`, userId: 'u', symbol, enabled, instrument: 'EQUITY',
    budget: 50_000, cash: 50_000, unsettled: [], openLots: [], closedLots: [],
    epochs: [], killSwitchEngaged: false, updatedAt: 0,
  } as never);
}
function clearBooks(): void {
  for (const k of [...store.accumulatorBooks.keys()]) store.accumulatorBooks.delete(k);
}

test('a strategy entry is refused on a symbol the accumulator owns', () => {
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate({ ...base, strategyId: 's1', intent: 'entry' }, OPEN);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'symbol_reserved');
  assert.match(v.reason ?? '', /no-loss mode is on/);
  clearBooks();
});

test('a strategy EXIT is never refused — a short must always be able to close', () => {
  // The one that would be genuinely dangerous to get wrong: trapping an open
  // position is worse than the overlap this gate exists to prevent.
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate({ ...base, strategyId: 's1', intent: 'exit' }, OPEN);
  assert.equal(v.ok, true, v.reason);
  clearBooks();
});

test('a DISABLED book reserves nothing', () => {
  clearBooks();
  bookOn('RELIANCE', false);
  assert.equal(preTradeGate({ ...base, strategyId: 's1', intent: 'entry' }, OPEN).ok, true);
  clearBooks();
});

test('the accumulator itself is never blocked by its own book', () => {
  // It carries a tag, never a strategyId — that is what separates the callers.
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate(
    { ...base, product: 'CNC', tag: 'accumulator:e0l1', intent: 'entry' },
    OPEN,
  );
  assert.equal(v.ok, true, v.reason);
  clearBooks();
});

test('the manual ticket and triggers are not blocked either', () => {
  clearBooks();
  bookOn('RELIANCE', true);
  assert.equal(preTradeGate({ ...base, intent: 'entry' }, OPEN).ok, true);
  clearBooks();
});

test('a strategy DCA add on a reserved symbol is refused too', () => {
  // A safety order ADDS exposure, so it is gated like an entry. The caller
  // already treats a refusal as an expected outcome — `manageTrailing` sets
  // `dcaBlocked` and falls back to the final stop — so this costs the trade
  // its averaging, never its exit.
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate({ ...base, strategyId: 's1', intent: 'dca_add' }, OPEN);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'symbol_reserved');
  clearBooks();
});

test('the 15:10 session flatten is never refused', () => {
  // `flatten()` places with intent 'exit', so the MIS square-off can always
  // run. If this ever fails, a strategy position rides past 15:25 into the
  // broker's auto square-off.
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate(
    { ...base, side: 'SELL', strategyId: 's1', tag: 'flatten', intent: 'exit' },
    OPEN,
  );
  assert.equal(v.ok, true, v.reason);
  clearBooks();
});

test('a strategy entry on an UNRELATED symbol still works', () => {
  clearBooks();
  bookOn('RELIANCE', true);
  const v = preTradeGate({ ...base, symbol: 'TCS', strategyId: 's1', intent: 'entry' }, OPEN);
  assert.equal(v.ok, true, v.reason);
  clearBooks();
});

test('another user’s book does not reserve the symbol', () => {
  clearBooks();
  store.accumulatorBooks.set('other:RELIANCE', {
    id: 'bk-o', userId: 'other', symbol: 'RELIANCE', enabled: true, instrument: 'EQUITY',
    budget: 1, cash: 1, unsettled: [], openLots: [], closedLots: [],
    epochs: [], killSwitchEngaged: false, updatedAt: 0,
  } as never);
  assert.equal(preTradeGate({ ...base, strategyId: 's1', intent: 'entry' }, OPEN).ok, true);
  clearBooks();
});

if (failures.length) {
  console.error(`\n✗ orderGate: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ orderGate: ${passed} passed`);

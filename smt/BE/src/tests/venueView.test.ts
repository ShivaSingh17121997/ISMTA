/**
 * Paper history stays out of a live account's numbers.
 *
 * The bug this pins: on the day a user went live, the NAV curve chained the
 * Zerodha balance (₹0) onto yesterday's ₹2,00,978 of paper equity and showed
 * −100%; the 15:35 snapshot would then have written that ₹0 beside the paper
 * rows, flattening the NAV to zero for good.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { EquitySnapshot } from '../types';
import { buildSeries } from '../services/analytics/nav';
import { bookForView, inLiveWindow, liveCutoff, snapshotsForView, venueOfRecord, venueViewFor, type VenueView } from '../services/venueView';
import { createBook } from '../services/AccumulatorEngine';
import type { ClosedLot } from '../services/accumulator/types';
import { computeEquity } from '../services/SnapshotService';
import { riskManager } from '../services/RiskManager';
import { store } from '../store/memoryStore';

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

const HOUR = 3_600_000;
/** An IST wall-clock time on an IST day. */
const at = (day: string, hourIst = 10) => Date.parse(`${day}T00:00:00Z`) - 5.5 * HOUR + hourIst * HOUR;
const snap = (day: string, equity: number, extra: Partial<EquitySnapshot> = {}): EquitySnapshot => ({
  userId: 'u',
  day,
  at: at(day, 15.6),
  equity,
  cash: equity,
  deployed: 0,
  realisedToDate: 0,
  chargesToDate: 0,
  flow: 0,
  ...extra,
});

const LIVE_SINCE = at('2026-10-08', 10.8);
const LIVE: VenueView = { venue: 'live', liveSince: LIVE_SINCE };
const PAPER: VenueView = { venue: 'paper', liveSince: null };

// Untagged paper rows from before the field, then a tagged live row.
const history = [
  snap('2026-10-06', 200_050),
  snap('2026-10-07', 200_978),
  snap('2026-10-08', 0, { venue: 'live' }),
  snap('2026-10-09', 50_000, { venue: 'live' }),
];

test('a lot with no venue predates the field and was paper', () => {
  assert.equal(venueOfRecord({}), 'paper');
  assert.equal(venueOfRecord({ venue: 'live' }), 'live');
});

test('live view keeps only live snapshots', () => {
  const kept = snapshotsForView(history, LIVE);
  assert.deepEqual(kept.map((s) => s.day), ['2026-10-08', '2026-10-09']);
});

test('paper view keeps only paper snapshots', () => {
  const kept = snapshotsForView(history, PAPER);
  assert.deepEqual(kept.map((s) => s.day), ['2026-10-06', '2026-10-07']);
});

test('an untagged snapshot written after going live counts as live', () => {
  const late = snap('2026-10-08', 0); // no venue, stamped 15:36 the day of the switch
  assert.equal(snapshotsForView([late], LIVE).length, 1);
  assert.equal(snapshotsForView([snap('2026-10-07', 1)], LIVE).length, 0);
});

test('trades are judged by when they opened', () => {
  assert.equal(inLiveWindow(LIVE_SINCE - 1, LIVE), false);
  assert.equal(inLiveWindow(LIVE_SINCE, LIVE), true);
  assert.equal(inLiveWindow(LIVE_SINCE, PAPER), false);
});

test('go-live day: the curve starts at the live balance, not at paper equity', () => {
  // What the route now passes: live snapshots only (none yet), capital = live equity.
  const pts = buildSeries({
    capital: 0,
    snapshots: snapshotsForView(history.slice(0, 2), LIVE),
    events: [],
    exposures: [],
    today: { day: '2026-10-08', equity: 0, deployed: 0 },
    niftyCloses: new Map(),
  });
  assert.ok(pts.every((p) => p.equity === 0), 'no paper equity in the live curve');
  assert.ok(pts.every((p) => p.nav === 1000), 'no −100% day');
});

test('the old behaviour, for contrast: paper rows chained onto a ₹0 balance read as −100%', () => {
  const pts = buildSeries({
    capital: 200_000,
    snapshots: history.slice(0, 2),
    events: [],
    exposures: [],
    today: { day: '2026-10-08', equity: 0, deployed: 0 },
    niftyCloses: new Map(),
  });
  assert.equal(pts[pts.length - 1].nav, 0);
});

test('a deposit after a ₹0 start does not move the NAV from zero equity', () => {
  const live = snapshotsForView(history, LIVE);
  const pts = buildSeries({
    capital: live[0].equity,
    snapshots: live,
    events: [],
    exposures: [],
    today: { day: '2026-10-12', equity: 50_500, deployed: 0 },
    niftyCloses: new Map(),
  });
  assert.ok(pts.every((p) => p.nav > 0), 'NAV never collapses to zero');
});


// ─── books, risk state and live snapshots ─────────────────────────────

const closedLot = (id: string, pnl: number, venue?: 'paper' | 'live', closedAt = at('2026-10-07')): ClosedLot => ({
  id,
  epoch: 0,
  level: 0,
  fillPrice: 100,
  quantity: 10,
  quoteSpent: 1000,
  openedAt: closedAt - 86_400_000,
  sellPrice: 110,
  closedAt,
  proceeds: 1000 + pnl,
  pnl,
  netBreakeven: 101,
  ...(venue ? { venue } : {}),
});

const mixedBook = (userId: string) => ({
  ...createBook({ userId, symbol: 'SYRMA', instrument: 'EQUITY', budget: 0 }),
  closedLots: [closedLot('p1', 636), closedLot('p2', 811), closedLot('l1', 120, 'live', LIVE_SINCE + 3_600_000)],
  clearedLots: [{ id: 'c1', pnl: 12 } as never],
});

test('live book: sold paper lots and cleared lots are left out', () => {
  const b = bookForView(mixedBook('u1'), LIVE);
  assert.deepEqual(b.closedLots.map((l) => l.id), ['l1']);
  assert.deepEqual(b.clearedLots, []);
});

test('paper book: sold live lots are left out, cleared lots kept', () => {
  const b = bookForView(mixedBook('u1'), PAPER);
  assert.deepEqual(b.closedLots.map((l) => l.id), ['p1', 'p2']);
  assert.equal(b.clearedLots?.length, 1);
});

test('liveCutoff: the switch time when live, nothing on paper', () => {
  assert.equal(liveCutoff(LIVE), LIVE_SINCE);
  assert.equal(liveCutoff(PAPER), undefined);
});

test('a venue switch zeroes today’s loss count, streak and cooldown, but keeps the kill switch', () => {
  const u = 'venue-risk-user';
  const now = Date.now();
  store.addDailyPnl(u, -5_000, now);
  store.riskState.set(u, { day: store.utcDay(now), consecutiveLosses: 3, cooldownUntil: now + 60_000, killed: true });
  riskManager.resetForVenueSwitch(u, now);
  assert.equal(store.getDailyPnl(u, now), 0);
  const st = store.riskState.get(u)!;
  assert.equal(st.consecutiveLosses, 0);
  assert.equal(st.cooldownUntil, 0);
  assert.equal(st.killed, true, 'the kill switch is an operator decision');
});

test('live snapshot: realised and charges count only lots bought live', () => {
  const u = 'venue-snap-user';
  store.brokerConnections.set(`${u}:zerodha`, {
    id: `${u}:zerodha`, userId: u, broker: 'zerodha', apiKey: 'k', apiSecretSealed: 's', keyId: 'x',
    plan: 'personal', tradingMode: 'live', status: 'connected', liveSince: LIVE_SINCE, createdAt: 0, updatedAt: 0,
  });
  store.accumulatorBooks.set(`${u}:SYRMA`, mixedBook(u));
  assert.equal(venueViewFor(u).venue, 'live');
  const live = computeEquity(u, { cash: 0, unsettled: 0 }, false);
  assert.equal(live.realisedToDate, 120);
  assert.equal(live.equity, 0, 'equity is the broker balance, never paper profit');
  // The same account on paper still reports its whole paper history.
  const paper = computeEquity(u, { cash: 0, unsettled: 0 }, true);
  assert.equal(paper.realisedToDate, 636 + 811 + 120);
});

console.log(`venueView: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}

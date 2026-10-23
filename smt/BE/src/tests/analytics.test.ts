/**
 * Performance analytics, execution quality and the trade journal.
 *
 * Every number the /analytics page shows is pinned here on a hand-built
 * history: a baseline at capital, reconstruction before the first snapshot,
 * flow-adjusted NAV, drawdown episodes, the monthly table, cost share, trade
 * statistics, slippage/latency percentiles, rejection grouping, R-multiples
 * and the override-vs-system split.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { EquitySnapshot, Order, Trade, AuditEntry, JournalNote } from '../types';
import type { AccumulatorBook, ClosedLot } from '../services/accumulator/types';
import {
  addDays,
  applyRange,
  buildSeries,
  computeNav,
  costSummary,
  daysBetween,
  drawdownEpisodes,
  monthlyTable,
  navStats,
  tradeStats,
  type NavPoint,
  type RealisedEvent,
} from '../services/analytics/nav';
import { computeExecution, percentile, reasonKey, tagFamily } from '../services/analytics/execution';
import { buildJournal, isOverride, lotCharges, rMultiple, tagMatches } from '../services/analytics/journal';

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
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const CAPITAL = 200_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 10:00 IST on an IST day. */
const at = (day: string, hourIst = 10) => Date.parse(`${day}T00:00:00Z`) - 5.5 * HOUR + hourIst * HOUR;

// A two-week history in Jan 2026: Mon 5 Jan … Fri 16 Jan are trading days, with
// weekends in between and no holidays.
const ev = (day: string, pnl: number, charges = 0, holdMs = 2 * HOUR, source: 'lot' | 'trade' = 'trade'): RealisedEvent => ({
  source,
  at: at(day),
  pnl,
  charges,
  holdMs,
});

// ─── day arithmetic ───────────────────────────────────────────────────

test('addDays / daysBetween walk the calendar in UTC-safe form', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-01-05', '2026-01-16'), 11);
});

// ─── the series ───────────────────────────────────────────────────────

test('empty history: baseline at capital the trading day before, then today live', () => {
  const pts = buildSeries({
    capital: CAPITAL,
    snapshots: [],
    events: [],
    exposures: [],
    today: { day: '2026-01-12', equity: 200_500, deployed: 15_000 },
    niftyCloses: new Map(),
  });
  assert.equal(pts.length, 2);
  assert.equal(pts[0].day, '2026-01-09'); // Friday before Monday 12 Jan
  assert.equal(pts[0].source, 'baseline');
  assert.equal(pts[0].equity, CAPITAL);
  assert.equal(pts[0].nav, 1000);
  assert.equal(pts[1].source, 'live');
  near(pts[1].nav, 1002.5, 1e-9, 'live nav');
  assert.equal(pts[1].niftyNav, null);
});

test('reconstruction before the first snapshot: cumulative realised P&L per trading day, weekends skipped', () => {
  const pts = buildSeries({
    capital: CAPITAL,
    snapshots: [],
    events: [ev('2026-01-06', 1_000), ev('2026-01-06', -200), ev('2026-01-08', 500)],
    exposures: [{ openedAt: at('2026-01-06', 9.5), closedAt: at('2026-01-08', 14), notional: 50_000 }],
    today: { day: '2026-01-12', equity: 201_300, deployed: 0 },
    niftyCloses: new Map(),
  });
  assert.deepEqual(
    pts.map((p) => p.day),
    ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12'],
  );
  assert.deepEqual(
    pts.map((p) => p.equity),
    [CAPITAL, 200_800, 200_800, 201_300, 201_300, 201_300],
  );
  assert.deepEqual(pts.map((p) => p.source), ['baseline', 'reconstructed', 'reconstructed', 'reconstructed', 'reconstructed', 'live']);
  // deployed follows the exposure window: open on the 6th and 7th, closed on the 8th
  assert.deepEqual(pts.map((p) => p.deployed), [0, 50_000, 50_000, 0, 0, 0]);
});

test('snapshots are authoritative; a missing day after they start is carried forward', () => {
  const snap = (day: string, equity: number, extra: Partial<EquitySnapshot> = {}): EquitySnapshot => ({
    userId: 'u',
    day,
    at: at(day, 16),
    equity,
    cash: 0,
    deployed: 10_000,
    realisedToDate: 0,
    chargesToDate: 0,
    flow: 0,
    ...extra,
  });
  const pts = buildSeries({
    capital: CAPITAL,
    snapshots: [snap('2026-01-07', 200_900, { nifty: 23_000 }), snap('2026-01-09', 201_400, { nifty: 23_230 })],
    events: [ev('2026-01-06', 800)],
    exposures: [],
    today: { day: '2026-01-12', equity: 201_000, deployed: 0 },
    niftyCloses: new Map([['2026-01-08', 23_115]]),
  });
  const by = Object.fromEntries(pts.map((p) => [p.day, p]));
  assert.equal(by['2026-01-06'].source, 'reconstructed');
  assert.equal(by['2026-01-06'].equity, 200_800);
  assert.equal(by['2026-01-07'].source, 'snapshot');
  assert.equal(by['2026-01-07'].equity, 200_900);
  assert.equal(by['2026-01-08'].source, 'carried');
  assert.equal(by['2026-01-08'].equity, 200_900);
  assert.equal(by['2026-01-08'].deployed, 10_000);
  assert.equal(by['2026-01-09'].source, 'snapshot');
  // benchmark: snapshot close, market close, snapshot close; rebased to 1000 on its first day
  assert.equal(by['2026-01-07'].nifty, 23_000);
  assert.equal(by['2026-01-08'].nifty, 23_115);
  assert.equal(by['2026-01-07'].niftyNav, 1000);
  near(by['2026-01-08'].niftyNav!, 1005, 1e-9, 'nifty nav');
  near(by['2026-01-09'].niftyNav!, 1010, 1e-9, 'nifty nav');
  // today carries the last known close when none is published yet
  assert.equal(by['2026-01-12'].nifty, 23_230);
});

test('a deposit moves equity but not NAV', () => {
  const pts: NavPoint[] = [
    { day: '2026-01-05', equity: 200_000, nav: 0, nifty: null, niftyNav: null, deployed: 0, flow: 0, source: 'baseline' },
    { day: '2026-01-06', equity: 250_000, nav: 0, nifty: null, niftyNav: null, deployed: 0, flow: 50_000, source: 'snapshot' },
    { day: '2026-01-07', equity: 252_500, nav: 0, nifty: null, niftyNav: null, deployed: 0, flow: 0, source: 'snapshot' },
  ];
  const withFlow = buildSeriesFromPoints(pts);
  assert.equal(withFlow[1].nav, 1000);
  near(withFlow[2].nav, 1010, 1e-9, 'nav after the deposit');
});

function buildSeriesFromPoints(pts: NavPoint[]): NavPoint[] {
  const snapshots: EquitySnapshot[] = pts.slice(1).map((p) => ({
    userId: 'u',
    day: p.day,
    at: at(p.day, 16),
    equity: p.equity,
    cash: 0,
    deployed: p.deployed,
    realisedToDate: 0,
    chargesToDate: 0,
    flow: p.flow,
  }));
  return buildSeries({
    capital: pts[0].equity,
    snapshots,
    events: [],
    exposures: [],
    today: { day: '2026-01-08', equity: pts[pts.length - 1].equity, deployed: 0 },
    niftyCloses: new Map(),
  }).filter((p) => p.day <= pts[pts.length - 1].day);
}

test('range 1y trims and rebases both unit prices to 1000 on the first kept day', () => {
  const mk = (day: string, nav: number, niftyNav: number | null): NavPoint => ({
    day,
    equity: nav * 200,
    nav,
    nifty: niftyNav,
    niftyNav,
    deployed: 0,
    flow: 0,
    source: 'snapshot',
  });
  const pts = [mk('2024-01-05', 1000, 1000), mk('2025-06-02', 1100, 1200), mk('2026-01-12', 1210, 1500)];
  const kept = applyRange(pts, '1y', '2026-01-12');
  assert.equal(kept.length, 2);
  assert.equal(kept[0].day, '2025-06-02');
  assert.equal(kept[0].nav, 1000);
  near(kept[1].nav, 1100, 1e-9, 'rebased nav');
  near(kept[1].niftyNav!, 1250, 1e-9, 'rebased nifty');
  assert.equal(applyRange(pts, 'all', '2026-01-12').length, 3);
});

// ─── statistics ───────────────────────────────────────────────────────

const navSeries = (navs: number[], startDay = '2026-01-05'): NavPoint[] => {
  const out: NavPoint[] = [];
  let day = startDay;
  for (const nav of navs) {
    out.push({ day, equity: nav * 200, nav, nifty: null, niftyNav: null, deployed: nav < 1000 ? 1 : 0, flow: 0, source: 'snapshot' });
    day = addDays(day, 1);
  }
  return out;
};

test('drawdown episodes: peak, trough, recovery, depth and duration; deepest first', () => {
  // 1000 → 990 → 1010 (recovered) → 980 → 950 → 990 (still under water)
  const pts = navSeries([1000, 990, 1010, 980, 950, 990]);
  const dds = drawdownEpisodes(pts);
  assert.equal(dds.length, 2);
  assert.equal(dds[0].start, '2026-01-07');
  assert.equal(dds[0].trough, '2026-01-09');
  assert.equal(dds[0].end, null);
  near(dds[0].depthPct, (950 / 1010 - 1) * 100, 0.01, 'deepest depth');
  assert.equal(dds[0].days, 3); // 7th → 10th, unrecovered so measured to the last day
  assert.equal(dds[1].start, '2026-01-05');
  assert.equal(dds[1].trough, '2026-01-06');
  assert.equal(dds[1].end, '2026-01-07');
  assert.equal(dds[1].depthPct, -1);
  assert.equal(dds[1].days, 2);
});

test('navStats: return, CAGR, vol, Sharpe, drawdowns, exposure', () => {
  const pts = navSeries([1000, 990, 1010, 980, 950, 990]);
  const s = navStats(pts);
  assert.equal(s.spanDays, 5);
  assert.equal(s.totalReturnPct, -1);
  near(s.cagrPct, (Math.pow(0.99, 365 / 5) - 1) * 100, 0.01, 'cagr');
  near(s.maxDrawdownPct, (950 / 1010 - 1) * 100, 0.01, 'max dd');
  assert.equal(s.maxDrawdownDays, 3);
  near(s.currentDrawdownPct, (990 / 1010 - 1) * 100, 0.01, 'current dd');
  assert.equal(s.timeInMarketPct, 66.7); // four of six days under 1000 carry deployed=1
  const rets = [990 / 1000 - 1, 1010 / 990 - 1, 980 / 1010 - 1, 950 / 980 - 1, 990 / 950 - 1];
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  near(s.volPct, sd * Math.sqrt(252) * 100, 0.01, 'vol');
  near(s.sharpe, (m / sd) * Math.sqrt(252), 0.01, 'sharpe');
  assert.equal(s.niftyReturnPct, null);
  assert.equal(s.activeReturnPct, null);
});

test('a flat series has zero vol, zero Sharpe and no drawdown', () => {
  const s = navStats(navSeries([1000, 1000, 1000]));
  assert.equal(s.volPct, 0);
  assert.equal(s.sharpe, 0);
  assert.equal(s.maxDrawdownPct, 0);
  assert.equal(s.currentDrawdownPct, 0);
});

test('monthly table: rupee P&L net of flows, unit-price return, NIFTY return', () => {
  const mk = (day: string, equity: number, nav: number, niftyNav: number | null, flow = 0): NavPoint => ({
    day,
    equity,
    nav,
    nifty: niftyNav,
    niftyNav,
    deployed: 0,
    flow,
    source: 'snapshot',
  });
  const pts = [
    mk('2026-01-30', 200_000, 1000, 1000),
    mk('2026-02-02', 202_000, 1010, 1010),
    mk('2026-02-27', 204_020, 1020.1, 1030),
    mk('2026-03-02', 254_020, 1020.1, 1030, 50_000),
    mk('2026-03-31', 251_480, 1009.9, 1020),
  ];
  const rows = monthlyTable(pts);
  assert.deepEqual(rows.map((r) => r.month), ['2026-01', '2026-02', '2026-03']);
  assert.equal(rows[0].pnl, 0);
  assert.equal(rows[1].pnl, 4_020);
  near(rows[1].pct, 2.01, 1e-9, 'feb pct');
  near(rows[1].niftyPct!, 3, 1e-9, 'feb nifty');
  assert.equal(rows[2].pnl, -2_540); // the ₹50,000 deposit is not performance
  near(rows[2].pct, -1, 1e-9, 'mar pct');
  near(rows[2].niftyPct!, (1020 / 1030 - 1) * 100, 0.01, 'mar nifty');
});

test('cost share: charges over gross profit; null when nothing was made', () => {
  const c = costSummary([ev('2026-01-06', 900, 100), ev('2026-01-07', -300, 50)]);
  assert.equal(c.charges, 150);
  assert.equal(c.netProfit, 600);
  assert.equal(c.grossProfit, 750);
  assert.equal(c.costSharePct, 20);
  assert.equal(costSummary([ev('2026-01-06', -100, 20)]).costSharePct, null);
  assert.equal(costSummary([]).costSharePct, null);
});

test('trade stats over lots and trades together', () => {
  const s = tradeStats([
    ev('2026-01-06', 300, 0, 1 * DAY),
    ev('2026-01-06', 100, 0, 3 * DAY),
    ev('2026-01-07', -200, 0, 2 * DAY),
    ev('2026-01-08', 0, 0, 5 * DAY),
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.winRatePct, 50);
  assert.equal(s.avgWin, 200);
  assert.equal(s.avgLoss, -200);
  assert.equal(s.payoff, 1);
  assert.equal(s.expectancy, 50);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.medianHoldDays, 2.5);
  const noLoss = tradeStats([ev('2026-01-06', 10)]);
  assert.equal(noLoss.payoff, null);
  assert.equal(noLoss.profitFactor, null);
});

test('computeNav end to end: 1y window, costs and trade stats filtered to the window, honest note', () => {
  const r = computeNav({
    capital: CAPITAL,
    snapshots: [],
    events: [ev('2026-01-06', 1_000, 40), ev('2026-01-08', -400, 30)],
    exposures: [],
    today: { day: '2026-01-12', equity: 200_600, deployed: 0 },
    niftyCloses: new Map([
      ['2026-01-05', 23_000],
      ['2026-01-12', 23_460],
    ]),
    range: '1y',
  });
  assert.equal(r.points[0].day, '2026-01-05');
  assert.equal(r.points[r.points.length - 1].day, '2026-01-12');
  assert.equal(r.stats.totalReturnPct, 0.3);
  assert.equal(r.stats.niftyReturnPct, 2);
  assert.equal(r.stats.activeReturnPct, -1.7);
  assert.equal(r.costs.charges, 70);
  assert.equal(r.tradeStats.n, 2);
  assert.equal(r.meta.reconstructedDays, 4);
  assert.match(r.meta.note, /No end-of-day snapshots yet/);
  assert.equal(r.monthly.length, 1);
  assert.equal(r.monthly[0].pnl, 600);
});

// ─── execution quality ────────────────────────────────────────────────

test('percentile is nearest-rank', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 90), 0);
});

test('tag families and rejection keys collapse variants', () => {
  assert.equal(tagFamily('accumulator:e0l3'), 'accumulator');
  assert.equal(tagFamily('gtt:target'), 'gtt');
  assert.equal(tagFamily(undefined), 'untagged');
  assert.equal(reasonKey('BUY 10 refused: market closed: the exchange is not in continuous trading'), 'market closed');
  assert.equal(reasonKey('SELL 5 rejected: 3 consecutive losses — halted'), 'consecutive losses');
  assert.equal(reasonKey('SELL 5 rejected: 4 consecutive losses — halted'), 'consecutive losses');
  assert.equal(reasonKey('Max concurrent positions reached (5/5)'), 'max concurrent positions reached');
  assert.equal(reasonKey('post-loss cooldown (30s remaining)'), 'post-loss cooldown');
  assert.equal(reasonKey(''), 'unspecified');
});

test('computeExecution: counts, by day/tag, slippage, latency, grouped reasons, adjusted', () => {
  const now = at('2026-01-12', 15);
  const base = { userId: 'u', orderType: 'MARKET' as const, product: 'MIS' as const, filledQuantity: 0, updatedAt: now };
  const o = (over: Partial<Order> & { id: string; createdAt: number; status: Order['status'] }): Order => ({
    ...base,
    symbol: 'X',
    side: 'BUY',
    quantity: 1,
    ...over,
  });
  const orders: Order[] = [
    o({ id: '1', createdAt: at('2026-01-12'), status: 'FILLED', tag: 'strategy', slippageBps: 2, submittedAt: 100, ackAt: 106 }),
    o({ id: '2', createdAt: at('2026-01-12'), status: 'FILLED', tag: 'accumulator:e0l0', slippageBps: 10, submittedAt: 100, ackAt: 120 }),
    o({ id: '3', createdAt: at('2026-01-09'), status: 'FILLED', tag: 'manual', slippageBps: -4, submittedAt: 100, ackAt: 104 }),
    o({ id: '4', createdAt: at('2026-01-09'), status: 'REJECTED', tag: 'manual', rejectionReason: 'Max concurrent positions reached (5/5)' }),
    o({ id: '5', createdAt: at('2025-11-01'), status: 'REJECTED', tag: 'strategy', rejectionReason: 'Max concurrent positions reached (4/4)' }),
    o({ id: '6', createdAt: at('2026-01-12'), status: 'CANCELLED', tag: 'gtt:stop' }),
    o({ id: '7', createdAt: at('2026-01-12'), status: 'FILLED', tag: 'manual', adjustment: 'trimmed by the risk gate', requestedQuantity: 20, quantity: 10 }),
  ];
  const audit: AuditEntry[] = [
    { id: 'a1', at: at('2026-01-12'), userId: 'u', kind: 'guard', symbol: 'NIFTY', detail: 'BUY 1 refused: NIFTY is an index', data: { code: 'not_tradable' } },
    { id: 'a2', at: at('2026-01-12'), userId: 'u', kind: 'risk', symbol: 'X', detail: 'BUY 1 rejected: 3 consecutive losses — halted' },
    { id: 'a3', at: at('2026-01-11'), userId: 'u', kind: 'risk', symbol: 'X', detail: 'BUY 1 rejected: 4 consecutive losses — halted' },
  ];
  const r = computeExecution(orders, audit, now);
  assert.equal(r.totals.orders, 7);
  assert.equal(r.totals.filled, 4);
  assert.equal(r.totals.rejected, 2);
  assert.equal(r.totals.cancelled, 1);
  assert.equal(r.totals.refused, 3);
  assert.equal(r.totals.adjusted, 1);
  near(r.totals.fillRatePct!, (4 / 9) * 100, 0.1, 'fill rate');
  assert.equal(r.byDay.length, 30);
  assert.equal(r.byDay[29].day, '2026-01-12');
  assert.equal(r.byDay[29].filled, 3);
  assert.equal(r.byDay[29].refused, 2);
  assert.equal(r.byDay[26].day, '2026-01-09');
  assert.equal(r.byDay[26].rejected, 1);
  assert.equal(r.byDay.reduce((s, d) => s + d.rejected, 0), 1); // the November rejection is outside the window
  const manual = r.byTag.find((t) => t.tag === 'manual')!;
  assert.equal(manual.n, 3);
  assert.equal(manual.filled, 2);
  assert.equal(manual.rejected, 1);
  assert.ok(r.byTag.some((t) => t.tag === 'accumulator'));
  assert.equal(r.slippage.n, 3);
  near(r.slippage.meanBps!, 8 / 3, 0.01, 'mean slip');
  assert.equal(r.slippage.medianBps, 2);
  assert.equal(r.slippage.p90Bps, 10);
  assert.equal(r.slippage.worstBps, 10);
  assert.equal(r.latency.n, 3);
  assert.equal(r.latency.meanMs, 10);
  assert.equal(r.latency.p90Ms, 20);
  assert.equal(r.latency.maxMs, 20);
  const positions = r.rejections.find((x) => x.reason === 'max concurrent positions reached')!;
  assert.equal(positions.n, 2);
  assert.equal(positions.fromOrders, 2);
  const losses = r.rejections.find((x) => x.reason === 'consecutive losses')!;
  assert.equal(losses.n, 2);
  assert.equal(losses.fromRisk, 2);
  const guard = r.rejections.find((x) => x.reason === 'not tradable')!;
  assert.equal(guard.fromGuards, 1);
  assert.equal(r.adjusted.length, 1);
  assert.equal(r.adjusted[0].requested, 20);
});

test('computeExecution with nothing to measure reports nulls, not zeros', () => {
  const r = computeExecution([], [], at('2026-01-12'));
  assert.equal(r.totals.fillRatePct, null);
  assert.equal(r.slippage.meanBps, null);
  assert.equal(r.latency.p90Ms, null);
  assert.equal(r.rejections.length, 0);
});

// ─── journal ──────────────────────────────────────────────────────────

const trade = (over: Partial<Trade> & { id: string }): Trade => ({
  userId: 'u',
  symbol: 'X',
  side: 'BUY',
  quantity: 10,
  entryPrice: 100,
  status: 'CLOSED',
  pnl: 0,
  entryOrderId: `o-${over.id}`,
  openedAt: at('2026-01-06', 10),
  closedAt: at('2026-01-06', 14),
  ...over,
});

test('R-multiple needs a stop; overrides are manual or flatten; tag filter matches families', () => {
  assert.equal(rMultiple(200, 100, 98, 10), 10); // risked ₹20, made ₹200
  assert.equal(rMultiple(-30, 100, 98, 10), -1.5);
  assert.equal(rMultiple(200, 100, undefined, 10), null);
  assert.equal(rMultiple(200, 100, 100, 10), null);
  assert.ok(isOverride(['manual']));
  assert.ok(isOverride(['strategy', 'flatten']));
  assert.ok(!isOverride(['strategy', 'strategy:NIFTY MA Crossover']));
  assert.ok(!isOverride(['accumulator']));
  assert.ok(tagMatches('strategy:NIFTY MA Crossover', 'strategy'));
  assert.ok(!tagMatches('strategyx', 'strategy'));
});

test('lot charges are what left the account beyond the shares, both legs', () => {
  const lot: ClosedLot = {
    id: 'X-e0-l0-1',
    epoch: 0,
    level: 0,
    fillPrice: 100,
    quantity: 10,
    quoteSpent: 1_003,
    openedAt: at('2026-01-06'),
    sellPrice: 106,
    closedAt: at('2026-01-09'),
    proceeds: 1_055,
    pnl: 52,
    netBreakeven: 101,
  };
  assert.equal(lotCharges(lot), 8);
});

test('buildJournal: rows from trades and lots, invalid flagged not dropped, by-tag and override split', () => {
  const trades: Trade[] = [
    trade({ id: 't1', tags: ['strategy', 'strategy:MA'], pnl: 200, stopLoss: 98, exitPrice: 121, charges: 10, maePct: -0.5, mfePct: 2.5 }),
    trade({ id: 't2', tags: ['strategy', 'strategy:MA'], pnl: -30, stopLoss: 98, exitPrice: 97, charges: 8 }),
    trade({ id: 't3', tags: ['strategy'], pnl: 4_820, invalid: true, invalidReason: 'synthetic seed candles', exitPrice: 500 }),
    trade({ id: 't4', pnl: -50, exitPrice: 95, closedAt: at('2026-01-07', 14) }), // untagged: entry order says manual
    trade({ id: 't5', tags: ['strategy', 'flatten'], pnl: 40, exitPrice: 104, closedAt: at('2026-01-08', 15) }),
    trade({ id: 't6', tags: ['strategy'], status: 'OPEN', closedAt: undefined, openedAt: at('2026-01-09', 10) }),
  ];
  const lot: ClosedLot = {
    id: 'Y-e0-l0-1',
    epoch: 0,
    level: 0,
    fillPrice: 100,
    quantity: 10,
    quoteSpent: 1_003,
    openedAt: at('2026-01-05'),
    sellPrice: 106,
    closedAt: at('2026-01-09', 11),
    proceeds: 1_055,
    pnl: 52,
    netBreakeven: 101,
  };
  const book = { symbol: 'Y', closedLots: [lot], openLots: [] } as unknown as AccumulatorBook;
  const notes = new Map<string, JournalNote>([
    ['t1', { tradeId: 't1', userId: 'u', setup: 'breakout', updatedAt: 1 }],
    ['lot:Y-e0-l0-1', { tradeId: 'lot:Y-e0-l0-1', userId: 'u', note: 'sold at target', updatedAt: 1 }],
  ]);
  const r = buildJournal({
    trades,
    books: [book],
    noteFor: (id) => notes.get(id),
    entryTagFor: (orderId) => (orderId === 'o-t4' ? 'manual' : 'strategy'),
  });
  assert.equal(r.rows.length, 7);
  assert.equal(r.counts.invalid, 1);
  assert.equal(r.counts.open, 1);
  assert.equal(r.counts.lots, 1);
  // newest first by close (or open, while open)
  assert.equal(r.rows[0].id, 'lot:Y-e0-l0-1');
  const t1 = r.rows.find((x) => x.id === 't1')!;
  assert.equal(t1.rMultiple, 10);
  assert.equal(t1.note?.setup, 'breakout');
  assert.equal(t1.holdMs, 4 * HOUR);
  const t3 = r.rows.find((x) => x.id === 't3')!;
  assert.ok(t3.invalid);
  assert.equal(t3.invalidReason, 'synthetic seed candles');
  const t4 = r.rows.find((x) => x.id === 't4')!;
  assert.deepEqual(t4.tags, ['manual']);
  const t6 = r.rows.find((x) => x.id === 't6')!;
  assert.equal(t6.pnl, null);
  assert.equal(t6.exit, null);
  const lotRow = r.rows.find((x) => x.source === 'lot')!;
  assert.deepEqual(lotRow.tags, ['accumulator']);
  assert.equal(lotRow.entry, 100);
  assert.equal(lotRow.exit, 106);
  assert.equal(lotRow.charges, 8);
  assert.equal(lotRow.note?.note, 'sold at target');
  assert.equal(lotRow.rMultiple, null);

  // by tag: closed & valid only. 'strategy' = t1, t2, t5 (t3 invalid, t6 open)
  const strategy = r.byTag.find((x) => x.tag === 'strategy')!;
  assert.equal(strategy.n, 3);
  assert.equal(strategy.pnl, 210);
  near(strategy.winRatePct, 66.7, 0.01, 'strategy win rate');
  assert.equal(strategy.avgR, 4.25); // (10 + -1.5) / 2 — t5 has no stop
  const acc = r.byTag.find((x) => x.tag === 'accumulator')!;
  assert.equal(acc.n, 1);
  assert.equal(acc.avgR, null);
  assert.equal(acc.avgHoldDays, 4.04); // 5 Jan 10:00 → 9 Jan 11:00

  // overrides: t4 (manual) and t5 (flatten) vs t1, t2, lot
  assert.equal(r.overridesVsSystem.manual.n, 2);
  assert.equal(r.overridesVsSystem.manual.pnl, -10);
  assert.equal(r.overridesVsSystem.manual.winRatePct, 50);
  assert.equal(r.overridesVsSystem.system.n, 3);
  assert.equal(r.overridesVsSystem.system.pnl, 222);
  near(r.overridesVsSystem.system.winRatePct, 66.7, 0.01, 'system win rate');
  assert.deepEqual(r.tags, ['accumulator', 'flatten', 'manual', 'strategy', 'strategy:MA']);
});

test('buildJournal filters: tag narrows the table only, the date window narrows everything', () => {
  const trades: Trade[] = [
    trade({ id: 'a', tags: ['strategy'], pnl: 100, exitPrice: 110 }),
    trade({ id: 'b', tags: ['manual'], pnl: -20, exitPrice: 98, closedAt: at('2026-01-08', 14) }),
  ];
  const args = { trades, books: [], noteFor: () => undefined, entryTagFor: () => undefined };
  const byTag = buildJournal({ ...args, filter: { tag: 'manual' } });
  assert.equal(byTag.rows.length, 1);
  assert.equal(byTag.rows[0].id, 'b');
  assert.equal(byTag.byTag.length, 2); // the by-tag report still covers both
  assert.equal(byTag.overridesVsSystem.system.n, 1);
  const window = buildJournal({ ...args, filter: { from: '2026-01-07', to: '2026-01-08' } });
  assert.equal(window.rows.length, 1);
  assert.equal(window.rows[0].id, 'b');
  assert.equal(window.overridesVsSystem.system.n, 0);
  assert.deepEqual(window.tags, ['manual']);
});

// ─── report ───────────────────────────────────────────────────────────

console.log(`analytics: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}

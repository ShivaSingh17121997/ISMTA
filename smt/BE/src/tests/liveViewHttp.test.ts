/**
 * End to end over HTTP: a live account sees only its live history; a paper
 * account sees its paper history; hand-set budgets take the per-stock floor;
 * a venue switch resets the risk counters.
 *
 * The real app (createApp) runs in this process on an ephemeral port against
 * the in-memory store — Mongo is never connected here — with two seeded users:
 *   LIVE  — went live at T0; holds paper history from before T0 and one live sale after it.
 *   PAPER — the same paper history, never live.
 *
 * Run: npm test
 */
import './_httpTestEnv';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';
import { createBook } from '../services/AccumulatorEngine';
import type { AccumulatorBook, ClosedLot } from '../services/accumulator/types';
import { computeEquity } from '../services/SnapshotService';
import { store } from '../store/memoryStore';
import type { EquitySnapshot, Order, Trade } from '../types';

const results: { name: string; ok: boolean; why?: string }[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: e instanceof Error ? e.message.split('\n')[0] : String(e) });
  }
}

const HOUR = 3_600_000;
const NOW = Date.now();
const T0 = NOW - 2 * HOUR; // the switch to live
const BEFORE = T0 - 5 * 24 * HOUR;
const AFTER = T0 + HOUR;
const LIVE = 'http-live-user';
const PAPER = 'http-paper-user';

// ─── seed ─────────────────────────────────────────────────────────────

const lot = (id: string, pnl: number, closedAt: number, venue?: 'paper' | 'live'): ClosedLot => ({
  id,
  epoch: 0,
  level: 0,
  fillPrice: 1700,
  quantity: 1,
  quoteSpent: 1720,
  openedAt: closedAt - 24 * HOUR,
  sellPrice: 1800,
  closedAt,
  proceeds: 1720 + pnl,
  pnl,
  netBreakeven: 1725,
  ...(venue ? { venue } : {}),
});

function seedUser(id: string): void {
  store.users.set(id, { id, email: `${id}@test.in`, passwordHash: 'x', name: id, role: 'trader', createdAt: BEFORE });
  const book: AccumulatorBook = {
    ...createBook({ userId: id, symbol: 'SYRMA', instrument: 'EQUITY', budget: 0 }),
    lastPrice: 1718.7,
    closedLots: [lot(`${id}-p1`, 636, BEFORE), lot(`${id}-p2`, 811, BEFORE + HOUR)],
    clearedLots: [{ id: `${id}-c1`, pnl: 12 } as never],
  };
  store.saveAccumulatorBook(book);
  // A second, cheap stock so the floor's share count is visible.
  store.saveAccumulatorBook({ ...createBook({ userId: id, symbol: 'NHPC', instrument: 'EQUITY', budget: 0 }), lastPrice: 78 });

  const order = (oid: string, at: number): Order => ({
    id: oid, userId: id, symbol: 'SYRMA', side: 'BUY', quantity: 1, orderType: 'LIMIT', product: 'CNC',
    price: 1700, status: 'FILLED', filledQuantity: 1, filledPrice: 1700, createdAt: at, updatedAt: at,
  }) as Order;
  store.orders.set(`${id}-o-before`, order(`${id}-o-before`, BEFORE));
  store.orders.set(`${id}-o-after`, order(`${id}-o-after`, AFTER));

  const trade = (tid: string, at: number): Trade => ({
    id: tid, userId: id, symbol: 'SYRMA', side: 'BUY', quantity: 1, entryPrice: 1700, exitPrice: 1750,
    status: 'CLOSED', pnl: 50, entryOrderId: 'x', openedAt: at, closedAt: at + HOUR,
  }) as Trade;
  store.trades.set(`${id}-t-before`, trade(`${id}-t-before`, BEFORE));
  store.trades.set(`${id}-t-after`, trade(`${id}-t-after`, AFTER));

  store.audit({ userId: id, kind: 'engine', symbol: 'SYRMA', detail: 'paper fill (before)', at: BEFORE });
  store.audit({ userId: id, kind: 'engine', symbol: 'SYRMA', detail: 'live event (after)', at: AFTER });

  const snap = (day: string, equity: number, at: number): EquitySnapshot => ({
    userId: id, day, at, equity, cash: equity, deployed: 0, realisedToDate: 0, chargesToDate: 0, flow: 0,
  });
  store.equitySnapshots.set(`${id}:2026-10-06`, snap('2026-10-06', 200_050, BEFORE));
  store.equitySnapshots.set(`${id}:2026-10-07`, snap('2026-10-07', 200_978, BEFORE + HOUR));
}

seedUser(LIVE);
seedUser(PAPER);
// LIVE went live at T0 and has sold one lot since.
store.brokerConnections.set(`${LIVE}:zerodha`, {
  id: `${LIVE}:zerodha`, userId: LIVE, broker: 'zerodha', apiKey: 'k', apiSecretSealed: 's', keyId: 'x',
  plan: 'personal', tradingMode: 'live', status: 'connected', liveSince: T0, createdAt: BEFORE, updatedAt: T0,
});
const liveBook = store.accumulatorBook(LIVE, 'SYRMA')!;
store.saveAccumulatorBook({ ...liveBook, closedLots: [...liveBook.closedLots, lot(`${LIVE}-l1`, 120, AFTER, 'live')] });

// ─── run ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (user: string, path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${signToken(user, 'trader')}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };

  // ── accumulator ──
  await test('live: /api/accumulator banked profit is the live sale only (₹120, 1 lot, no cleared paper)', async () => {
    const { status, body } = await call(LIVE, '/api/accumulator');
    assert.equal(status, 200);
    const r = body.books.find((b: any) => b.book.symbol === 'SYRMA');
    assert.equal(r.report.bankedProfit, 120);
    assert.equal(r.report.closedTrades, 1);
    assert.equal(r.report.clearedPnl, 0);
  });
  await test('paper: /api/accumulator still shows the whole paper history (₹1,447, 2 lots)', async () => {
    const { body } = await call(PAPER, '/api/accumulator');
    const r = body.books.find((b: any) => b.book.symbol === 'SYRMA');
    assert.equal(r.report.bankedProfit, 636 + 811);
    assert.equal(r.report.closedTrades, 2);
  });
  await test('live: /api/accumulator/SYRMA lists only the live sale', async () => {
    const { status, body } = await call(LIVE, '/api/accumulator/SYRMA');
    assert.equal(status, 200);
    assert.deepEqual(body.book.closedLots.map((l: any) => l.id), [`${LIVE}-l1`]);
    assert.equal(body.report.bankedProfit, 120);
  });
  await test('the stored book is untouched: paper lots are hidden, not deleted', async () => {
    assert.equal(store.accumulatorBook(LIVE, 'SYRMA')!.closedLots.length, 3);
  });

  // ── NAV ──
  await test('live: /api/analytics/nav has no paper points and no −100% day', async () => {
    const { status, body } = await call(LIVE, '/api/analytics/nav');
    assert.equal(status, 200);
    assert.equal(body.venue, 'live');
    assert.ok(body.points.length >= 1);
    assert.ok(body.points.every((p: any) => p.equity < 200_000), 'no paper equity on the live curve');
    assert.ok(body.points.every((p: any) => p.nav > 0), 'the NAV never collapses to zero');
    assert.ok(body.points.every((p: any) => p.source !== 'snapshot'), 'paper snapshots are not used');
  });
  await test('paper: /api/analytics/nav keeps its paper snapshots at ₹2 lakh capital', async () => {
    const { body } = await call(PAPER, '/api/analytics/nav');
    assert.equal(body.venue, 'paper');
    assert.equal(body.capital, 200_000);
    assert.ok(body.points.some((p: any) => p.source === 'snapshot'));
  });

  // ── orders, trades, journal, execution, audit ──
  await test('live: /api/orders hides orders from before the switch', async () => {
    const { body } = await call(LIVE, '/api/orders');
    assert.deepEqual(body.orders.map((o: any) => o.id), [`${LIVE}-o-after`]);
  });
  await test('paper: /api/orders shows all of them', async () => {
    const { body } = await call(PAPER, '/api/orders');
    assert.equal(body.orders.length, 2);
  });
  await test('live: /api/portfolio/trades hides trades opened before the switch', async () => {
    const { body } = await call(LIVE, '/api/portfolio/trades');
    assert.deepEqual(body.trades.map((t: any) => t.id), [`${LIVE}-t-after`]);
  });
  await test('live: /api/journal has the live trade and the live lot only', async () => {
    const { status, body } = await call(LIVE, '/api/journal');
    assert.equal(status, 200);
    const ids = body.rows.map((r: any) => r.id).sort();
    assert.deepEqual(ids, [`${LIVE}-t-after`, `lot:${LIVE}-l1`].sort());
  });
  await test('live: /api/analytics/execution counts only live orders', async () => {
    const { status, body } = await call(LIVE, '/api/analytics/execution');
    assert.equal(status, 200);
    assert.equal(body.totals.orders, 1);
    const paper = await call(PAPER, '/api/analytics/execution');
    assert.equal(paper.body.totals.orders, 2);
  });
  await test('live: /api/audit starts at the switch; ?all=1 shows the full trail', async () => {
    const cut = await call(LIVE, '/api/audit');
    assert.ok(cut.body.entries.every((e: any) => e.at >= T0));
    assert.ok(cut.body.entries.some((e: any) => e.detail === 'live event (after)'));
    const all = await call(LIVE, '/api/audit?all=1');
    assert.ok(all.body.entries.some((e: any) => e.detail === 'paper fill (before)'));
  });

  // ── hand-set budget floor ──
  await test('/api/accumulator/allocator gives each stock its own minimum (SYRMA ₹2,100; NHPC < ₹1,000)', async () => {
    const { status, body } = await call(PAPER, '/api/accumulator/allocator');
    assert.equal(status, 200);
    assert.equal(body.minManualCashBy.SYRMA.newCash, 2_100);
    assert.ok(body.minManualCashBy.NHPC.newCash < 1_000);
  });
  await test('budget preview: ₹2,000 for SYRMA is refused with the ₹2,100 reason', async () => {
    const { body } = await call(PAPER, '/api/accumulator/SYRMA/budget/preview?amount=2000');
    const msg = JSON.stringify(body);
    assert.match(msg, /2,100/);
    assert.match(msg, /one share costs/);
    assert.doesNotMatch(msg, /19,000/);
  });
  await test('budget save: ₹2,000 refused, ₹2,100 accepted, then handed back to auto', async () => {
    const bad = await call(PAPER, '/api/accumulator/SYRMA/budget', { method: 'POST', body: JSON.stringify({ amount: 2000 }) });
    assert.ok(bad.status >= 400 && bad.status < 500, `₹2,000 → ${bad.status}`);
    const good = await call(PAPER, '/api/accumulator/SYRMA/budget', { method: 'POST', body: JSON.stringify({ amount: 2100 }) });
    assert.equal(good.status, 200, JSON.stringify(good.body).slice(0, 200));
    assert.equal(store.accumulatorBook(PAPER, 'SYRMA')!.manualBudget, 2100);
    const back = await call(PAPER, '/api/accumulator/SYRMA/budget', { method: 'POST', body: JSON.stringify({ amount: null }) });
    assert.equal(back.status, 200);
    assert.equal(store.accumulatorBook(PAPER, 'SYRMA')!.manualBudget, undefined);
  });
  await test('budget preview: NHPC accepts under ₹1,000', async () => {
    const { body } = await call(PAPER, '/api/accumulator/NHPC/budget/preview?amount=1000');
    assert.equal(body.error ?? null, null, JSON.stringify(body).slice(0, 200));
  });

  // ── snapshot figures ──
  await test('live snapshot figures: realised = the live sale only; equity = the broker balance', async () => {
    const live = computeEquity(LIVE, { cash: 0, unsettled: 0 }, false);
    assert.equal(live.realisedToDate, 120 + 50, 'live lot + the trade opened after the switch');
    assert.equal(live.equity, 0);
  });

  // ── venue switch ──
  await test('switching live → paper resets today’s loss count and streak, keeps the kill switch', async () => {
    store.addDailyPnl(LIVE, -9_999);
    store.riskState.set(LIVE, { day: store.utcDay(), consecutiveLosses: 4, cooldownUntil: Date.now() + HOUR, killed: true });
    const { status } = await call(LIVE, '/api/broker/zerodha/mode', { method: 'PATCH', body: JSON.stringify({ mode: 'paper' }) });
    assert.equal(status, 200);
    assert.equal(store.getDailyPnl(LIVE), 0);
    const st = store.riskState.get(LIVE)!;
    assert.equal(st.consecutiveLosses, 0);
    assert.equal(st.cooldownUntil, 0);
    assert.equal(st.killed, true);
  });
  await test('after switching back to paper, the paper history is visible again', async () => {
    const { body } = await call(LIVE, '/api/accumulator/SYRMA');
    assert.equal(body.report.closedTrades, 2, 'the two paper sales; the live one belongs to the live view');
  });

  // ── no 500s on any GET this change touched ──
  await test('every touched GET route answers without a 500', async () => {
    for (const path of ['/api/accumulator', '/api/accumulator/SYRMA', '/api/accumulator/allocator', '/api/analytics/nav',
      '/api/analytics/execution', '/api/journal', '/api/orders', '/api/portfolio', '/api/portfolio/trades', '/api/audit',
      '/api/tax?venue=live', '/api/tax?venue=paper', '/api/risk', '/api/broker/zerodha']) {
      for (const u of [LIVE, PAPER]) {
        const { status } = await call(u, path);
        assert.ok(status < 500, `${path} as ${u} → ${status}`);
      }
    }
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `\n      ${r.why}`}`);
  console.log(`liveViewHttp: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

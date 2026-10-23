/**
 * Performance analytics: the NAV curve against NIFTY 50 and execution quality.
 *
 *   GET /api/analytics/nav?range=1y|all
 *   GET /api/analytics/execution
 *
 * All the arithmetic lives in services/analytics/*; this file only gathers the
 * inputs (store, live equity, benchmark closes) and hands the result back.
 */
import { Router } from 'express';
import { config } from '../config';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { store } from '../store/memoryStore';
import { inLiveWindow, liveCutoff, snapshotsForView, venueOfRecord, venueViewFor } from '../services/venueView';
import { computeEquity } from '../services/SnapshotService';
import { fundsService } from '../services/FundsService';
import { istParts } from '../services/session';
import { computeNav, type Exposure, type NavRange, type RealisedEvent } from '../services/analytics/nav';
import { computeExecution } from '../services/analytics/execution';
import { niftyCacheInfo, niftyDailyCloses } from '../services/analytics/nifty';
import { lotCharges } from '../services/analytics/journal';

const router = Router();
router.use(authenticate);

router.get('/', (_req, res) => {
  res.json({ endpoints: ['/api/analytics/nav?range=1y|all', '/api/analytics/execution'] });
});

router.get('/nav', async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const range: NavRange = req.query.range === 'all' ? 'all' : '1y';
  const now = Date.now();

  // Trading live, the curve is the Zerodha account's alone: paper lots, paper
  // trades and paper snapshots are left out (see services/venueView).
  const view = venueViewFor(userId);
  const ofView = (l: { venue?: 'paper' | 'live' }) => venueOfRecord(l) === view.venue;

  const events: RealisedEvent[] = [];
  const exposures: Exposure[] = [];
  for (const b of store.accumulatorBooksByUser(userId)) {
    for (const l of b.closedLots) {
      if (!ofView(l)) continue;
      events.push({ source: 'lot', at: l.closedAt, pnl: l.pnl, charges: lotCharges(l), holdMs: l.closedAt - l.openedAt });
      exposures.push({ openedAt: l.openedAt, closedAt: l.closedAt, notional: l.quoteSpent });
    }
    for (const l of b.openLots) if (ofView(l)) exposures.push({ openedAt: l.openedAt, notional: l.quoteSpent });
  }
  for (const t of store.tradesByUser(userId)) {
    if (t.invalid) continue;
    // Trades carry no venue; a live view keeps only those opened after the switch.
    if (view.venue === 'live' && !inLiveWindow(t.openedAt, view)) continue;
    if (t.status === 'CLOSED' && t.closedAt) {
      events.push({ source: 'trade', at: t.closedAt, pnl: t.pnl, charges: t.charges ?? 0, holdMs: t.closedAt - t.openedAt });
    }
    exposures.push({ openedAt: t.openedAt, closedAt: t.status === 'CLOSED' ? t.closedAt : undefined, notional: t.entryPrice * t.quantity });
  }

  const [funds, niftyCloses] = await Promise.all([
    fundsService.snapshot(userId).catch(() => null),
    niftyDailyCloses(now).catch(() => new Map<string, number>()),
  ]);
  const live = computeEquity(
    userId,
    { cash: funds?.cash ?? config.risk.capital, unsettled: funds?.unsettled ?? 0 },
    funds?.simulated ?? true,
  );

  // A live account starts from what it held when it went live, not from the
  // paper capital: its first live snapshot, or today's balance before one exists.
  const snapshots = snapshotsForView(store.snapshotsByUser(userId), view);
  const capital = view.venue === 'live' ? (snapshots[0]?.equity ?? live.equity) : config.risk.capital;

  const report = computeNav({
    capital,
    snapshots,
    events,
    exposures,
    today: { day: istParts(now).date, equity: live.equity, deployed: live.deployed },
    niftyCloses,
    range,
  });
  res.json({ ...report, capital, venue: view.venue, live, nifty: niftyCacheInfo() });
});

router.get('/execution', async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  // Trading live, execution quality is the live account's: paper fills cost nothing real.
  const since = liveCutoff(venueViewFor(userId));
  const [guard, risk] = await Promise.all([
    store.auditEntries({ userId, kind: 'guard', since, limit: 2000 }),
    store.auditEntries({ userId, kind: 'risk', since, limit: 2000 }),
  ]);
  const orders = store.ordersByUser(userId).filter((o) => o.createdAt >= (since ?? 0));
  res.json(computeExecution(orders, [...guard, ...risk], Date.now()));
});

export default router;

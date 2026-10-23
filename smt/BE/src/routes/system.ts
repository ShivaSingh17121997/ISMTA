import { Router } from 'express';
import { config } from '../config';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { brokerFor } from '../brokers/registry';
import { brokerConnections } from '../services/BrokerConnectionService';
import { checkStaticIp, orderRateLimiter, tradingHalt } from '../services/guards';
import { kiteService } from '../services/KiteService';
import { notifier } from '../services/Notifier';
import { strategyEngine } from '../services/StrategyEngine';
import { yahooFeed } from '../services/YahooFeed';
import { marketData } from '../services/MarketDataService';
import { describe, isTradingDay, phaseAt } from '../services/session';
import { reconcileService } from '../services/ReconcileService';
import { snapshotService } from '../services/SnapshotService';
import { store } from '../store/memoryStore';

const router = Router();
router.use(authenticate);

/**
 * One screen's worth of "is the system trustworthy right now": halts, rate
 * counters, the static-IP check, the feed, the notifier, the strategy buffers.
 * `broker` is where THIS user's orders go right now.
 */
router.get('/', (req: AuthedRequest, res) => {
  const now = Date.now();
  const feed = config.dataSource === 'yahoo' ? yahooFeed.getStatus() : null;
  const stale = marketData.symbols
    .filter((s) => marketData.getPrice(s) > 0)
    .map((s) => ({ symbol: s, ageMs: marketData.quoteAge(s, now) }))
    .filter((x) => Number.isFinite(x.ageMs) && x.ageMs > config.guards.maxQuoteAgeMs)
    .map((x) => x.symbol);
  const kite = kiteService.status();
  res.json({
    at: now,
    broker: brokerFor(req.userId).name,
    dataSource: config.dataSource,
    brokerConnection: req.userId ? brokerConnections.summary(req.userId) : null,
    kiteFeed: { active: kite.active, streaming: kite.streaming, subscribed: kite.subscribed, lastTickAt: kite.lastTickAt, error: kite.error },
    session: { phase: phaseAt(now), tradingDay: isTradingDay(now), describe: describe(now) },
    halted: tradingHalt.active,
    halts: tradingHalt.list(),
    orderRate: { ...orderRateLimiter.snapshot(now), limits: { perSecond: config.guards.ordersPerSecond, perMinute: config.guards.ordersPerMinute, perDay: config.guards.ordersPerDay } },
    guards: {
      maxQuoteAgeMs: config.guards.maxQuoteAgeMs,
      maxFillDeviationPct: config.guards.maxFillDeviationPct,
      staticIp: config.guards.staticIp || null,
      staleSymbols: stale,
    },
    feed: feed ? { running: feed.running, lastPassAt: feed.lastPassAt, priced: feed.priced, tracked: feed.tracked.length, unpriced: feed.unpriced, marketOpen: feed.marketOpen } : null,
    notifier: notifier.status(),
    reconcile: reconcileService.status(),
    strategyBuffers: strategyEngine.bufferStatus(),
    jwtSecretIsDefault: config.jwt.secretIsDefault,
  });
});

/** Re-run the static-IP check now. */
router.post('/check-ip', async (_req, res) => {
  res.json(await checkStaticIp());
});

/** Process-wide controls act on every user's trading, so only an admin may use them. */
function adminOnly(req: AuthedRequest, res: import('express').Response, next: import('express').NextFunction): void {
  if (req.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  next();
}

/** Engage or release a process-wide halt by hand. Exits are blocked too; use the per-user kill switch to stop only entries. */
router.post('/halt', adminOnly, (req: AuthedRequest, res) => {
  const { engaged, reason } = req.body ?? {};
  if (typeof engaged !== 'boolean') return res.status(400).json({ error: 'engaged must be a boolean' });
  if (engaged) tradingHalt.set('manual', String(reason ?? `halted by ${req.userId}`));
  else tradingHalt.clear('manual');
  store.audit({ userId: req.userId, kind: 'system', detail: engaged ? `manual halt: ${reason ?? ''}` : 'manual halt released' });
  return res.json({ halted: tradingHalt.active, halts: tradingHalt.list() });
});

/** Send a test alert to the configured channel. */
router.post('/test-alert', async (req: AuthedRequest, res) => {
  const ok = await notifier.send(`ISMTA test alert from ${req.userId} at ${describe(Date.now())}`);
  res.json({ sent: ok, notifier: notifier.status() });
});

/** Run a reconciliation pass now. */
router.post('/reconcile', adminOnly, async (_req, res) => {
  res.json(await reconcileService.run('manual'));
});

/** Take today's equity snapshot now. */
router.post('/snapshot', adminOnly, async (_req, res) => {
  res.json({ snapshots: await snapshotService.takeAll(Date.now(), 'manual') });
});

export default router;

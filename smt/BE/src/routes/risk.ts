import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { orderManager } from '../services/OrderManager';
import { recommenderEngine } from '../services/RecommenderEngine';
import { riskManager } from '../services/RiskManager';
import { BASELINE } from '../services/recommender/turbulence';
import { store } from '../store/memoryStore';

const router = Router();
router.use(authenticate);

// Risk dashboard snapshot: margin, daily loss usage, position counts.
router.get('/', (req: AuthedRequest, res) => {
  const snap = riskManager.snapshot(req.userId!);
  const alerts: { level: 'warning' | 'critical'; message: string }[] = [];
  if (snap.killed) {
    alerts.push({ level: 'critical', message: 'Kill switch engaged — no new entries' });
  }
  if (snap.dailyLossUsedPct >= 100) {
    alerts.push({ level: 'critical', message: 'Daily loss limit breached — new entries blocked' });
  } else if (snap.dailyLossUsedPct >= 70) {
    alerts.push({ level: 'warning', message: `Daily loss at ${snap.dailyLossUsedPct.toFixed(0)}% of limit` });
  }
  if (snap.maxConsecutiveLosses > 0 && snap.consecutiveLosses >= snap.maxConsecutiveLosses) {
    alerts.push({
      level: 'critical',
      message: `${snap.consecutiveLosses} consecutive losses — entries halted until the UTC day rolls`,
    });
  }
  if (snap.cooldownUntil > Date.now()) {
    const secs = Math.ceil((snap.cooldownUntil - Date.now()) / 1000);
    alerts.push({ level: 'warning', message: `Post-loss cooldown — ${secs}s remaining` });
  }
  if (snap.openPositions >= snap.maxPositions) {
    alerts.push({ level: 'warning', message: 'Max concurrent positions reached' });
  }
  res.json({ risk: snap, alerts });
});

/**
 * Path forecast for every position currently held.
 *
 * SEPARATE from the snapshot above, and deliberately so: that one is cheap and
 * safe to poll, while this reads up to ten years of daily bars for any symbol
 * the recommender has not already cached. Call it on demand.
 *
 * Nothing here is a sell signal, and the payload says so. Its job is to tell
 * you whether the red number on the screen is ordinary for that stock — which,
 * roughly two thirds of the time, it is.
 *
 * GET /api/risk/holdings
 */
router.get('/holdings', async (req: AuthedRequest, res) => {
  try {
    const holdings = await recommenderEngine.assessHoldings(req.userId!);
    return res.json({
      holdings,
      baseline: {
        dipProbability: BASELINE.prob5,
        dipMedianDays: BASELINE.days5,
        expectedDipAtr: BASELINE.dipAtr,
        n: BASELINE.n,
      },
      note:
        'Context, not advice. A drawdown inside the ordinary range for a stock carries no ' +
        'information about what happens next — measured over ~189,000 observations, no ' +
        'condition tested predicted a negative forward return. Exits are decided by the stop.',
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Kill switch — halt all new entries. Exits are unaffected, by design: a switch
 * that also blocked exits would trap you in the positions you are trying to
 * escape. The gate itself lives in RiskManager.check(); this is its trigger,
 * which previously did not exist, making the control unreachable.
 *
 * POST /api/risk/kill        { "killed": true }
 */
router.post('/kill', (req: AuthedRequest, res) => {
  const { killed } = req.body ?? {};
  if (typeof killed !== 'boolean') {
    return res.status(400).json({ error: 'killed must be a boolean' });
  }
  riskManager.setKilled(req.userId!, killed);
  return res.json({ risk: riskManager.snapshot(req.userId!) });
});

/**
 * Flatten everything at market, then engage the kill switch. The "get me out"
 * button. Exits are never risk-gated, so this works even with the daily-loss
 * limit breached — which is precisely when you would reach for it.
 *
 * POST /api/risk/flatten
 */
router.post('/flatten', async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  riskManager.setKilled(userId, true); // stop new entries racing the exits

  const results: { symbol: string; ok: boolean; reason?: string }[] = [];
  for (const pos of store.positionsByUser(userId)) {
    const r = await orderManager.flatten(userId, pos.symbol);
    results.push({ symbol: pos.symbol, ok: r.ok, reason: r.reason });
  }
  return res.json({ flattened: results, risk: riskManager.snapshot(userId) });
});

export default router;

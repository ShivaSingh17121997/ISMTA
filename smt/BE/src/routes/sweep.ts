import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { cashSweep } from '../services/CashSweepService';

const router = Router();
router.use(authenticate);

/**
 * The idle-cash sweep for THIS user: what is parked, what it has earned, what
 * is locked by the T1 rule, and the recent decisions.
 */
router.get('/', async (req: AuthedRequest, res) => {
  try {
    res.json(await cashSweep.report(req.userId!));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'sweep unavailable' });
  }
});

/** Switch the sweep on or off. Off sells the parked units back as the T1 rule allows. */
router.post('/enable', async (req: AuthedRequest, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '`enabled` must be true or false' });
  cashSweep.setEnabled(req.userId!, enabled);
  res.json(await cashSweep.report(req.userId!));
});

/** Run one pass now instead of waiting for the next minute. Market hours only. */
router.post('/run', async (req: AuthedRequest, res) => {
  try {
    const result = await cashSweep.runFor(req.userId!);
    res.json({ result, sweep: await cashSweep.report(req.userId!) });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'sweep pass failed' });
  }
});

/** Clear a halt after checking the broker. */
router.post('/release-halt', async (req: AuthedRequest, res) => {
  cashSweep.releaseHalt(req.userId!);
  res.json(await cashSweep.report(req.userId!));
});

export default router;

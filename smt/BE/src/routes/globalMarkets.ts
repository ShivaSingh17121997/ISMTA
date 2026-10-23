import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { globalMarkets } from '../services/GlobalMarketsService';

const router = Router();
router.use(authenticate);

/** GET /api/global-markets — the shared snapshot; 202 while the first one builds. */
router.get('/', (_req: AuthedRequest, res) => {
  const snap = globalMarkets.get();
  if (!snap) {
    void globalMarkets.refresh();
    return res.status(202).json({ status: globalMarkets.status() });
  }
  return res.json({ ...snap, status: globalMarkets.status() });
});

/** POST /api/global-markets/refresh — rebuild now (history stays cached unless an admin forces it). */
router.post('/refresh', async (req: AuthedRequest, res) => {
  const snap = await globalMarkets.refresh({ force: req.body?.force === true && req.role === 'admin' });
  if (!snap) return res.status(503).json({ status: globalMarkets.status() });
  return res.json({ computedAt: snap.computedAt, strongest: snap.strongest, status: globalMarkets.status() });
});

export default router;

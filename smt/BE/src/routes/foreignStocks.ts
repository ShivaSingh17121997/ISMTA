import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { foreignRecs } from '../services/ForeignRecsService';

const router = Router();
router.use(authenticate);

/** GET /api/foreign-stocks — the shared snapshot; 202 while the first one builds. */
router.get('/', (_req: AuthedRequest, res) => {
  const snap = foreignRecs.get();
  if (!snap) {
    void foreignRecs.refresh();
    return res.status(202).json({ status: foreignRecs.status() });
  }
  return res.json({ ...snap, status: foreignRecs.status() });
});

/** POST /api/foreign-stocks/refresh — rebuild now (history and the weekly backtest stay cached). */
router.post('/refresh', async (req: AuthedRequest, res) => {
  const snap = await foreignRecs.refresh({ force: req.body?.force === true && req.role === 'admin' });
  if (!snap) return res.status(503).json({ status: foreignRecs.status() });
  return res.json({ computedAt: snap.computedAt, picks: snap.picks.length, status: foreignRecs.status() });
});

export default router;

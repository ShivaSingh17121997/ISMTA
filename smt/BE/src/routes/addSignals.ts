import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { addSignals } from '../services/AddSignalService';

const router = Router();
router.use(authenticate);

/**
 * "Add money now?" lights — green / yellow / red per stock.
 *
 *   GET /api/add-signals/books             every accumulator book
 *   GET /api/add-signals/recommendations   every stock in the latest ranking
 *
 * Cached ten minutes per user; `?refresh=1` recomputes. Read-only: nothing
 * here changes a book or places an order.
 */
for (const kind of ['books', 'recommendations'] as const) {
  router.get(`/${kind}`, async (req: AuthedRequest, res) => {
    try {
      res.json(await addSignals.get(req.userId!, kind, req.query.refresh === '1'));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export default router;

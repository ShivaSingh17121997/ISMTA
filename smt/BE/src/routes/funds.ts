import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { fundsService } from '../services/FundsService';
import { reconcileService } from '../services/ReconcileService';

const router = Router();
router.use(authenticate);

/**
 * What the broker says the account holds — THIS user's account: their own
 * Zerodha when they trade live, otherwise the server's broker.
 *
 * Read-only by design. There is no endpoint here to add money and there cannot
 * be one: funds move into a broking account only through the broker's own app.
 * This exists so the website can SHOW the balance the phone changed, not so it
 * can change it.
 */
router.get('/', async (req: AuthedRequest, res) => {
  try {
    res.json({ funds: await fundsService.snapshot(req.userId) });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'funds unavailable' });
  }
});

/** Force a fresh read, bypassing the cache — for the panel's refresh button. */
router.post('/refresh', async (req: AuthedRequest, res) => {
  try {
    await fundsService.read(req.userId, true);
    res.json({ funds: await fundsService.snapshot(req.userId) });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'funds refresh failed' });
  }
});

/**
 * Compare this user's broker holdings against their live books. A report: it
 * never halts or "corrects" anything (the scheduled pass does the halting).
 *
 * A mismatch is not a display bug. The accumulator's no-loss guarantee is
 * arithmetic over lots with recorded fill prices, so if the shares are not
 * really there then the guarantee is being enforced against a fiction.
 */
router.get('/reconcile', async (req: AuthedRequest, res) => {
  try {
    res.json(await reconcileService.run('manual', req.userId));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'reconcile failed' });
  }
});

export default router;

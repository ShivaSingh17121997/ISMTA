import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { marketWeather } from '../services/MarketWeatherService';

const router = Router();
router.use(authenticate);

/**
 * GET /api/market-weather
 * The shared snapshot plus this user's book exposure. Never triggers a fetch
 * unless no snapshot exists yet; 202 while the first one is being built.
 */
router.get('/', async (req: AuthedRequest, res) => {
  let snap = marketWeather.get();
  if (!snap) {
    void marketWeather.refresh();
    return res.status(202).json({ status: marketWeather.status() });
  }
  try {
    const [exposure, stocks] = await Promise.all([marketWeather.exposureFor(req.userId!), marketWeather.stocksFor(req.userId!)]);
    snap = marketWeather.get() ?? snap;
    return res.json({ ...snap, exposure, stocks, status: marketWeather.status() });
  } catch (e) {
    return res.json({ ...snap, exposure: null, stocks: null, exposureError: e instanceof Error ? e.message : String(e), status: marketWeather.status() });
  }
});

/** POST /api/market-weather/refresh — rebuild now (history stays disk-cached unless { force: true }). */
router.post('/refresh', async (req: AuthedRequest, res) => {
  const force = req.body?.force === true && req.role === 'admin';
  const snap = await marketWeather.refresh({ force });
  if (!snap) return res.status(503).json({ status: marketWeather.status() });
  return res.json({ computedAt: snap.computedAt, headline: snap.summary.headline, status: marketWeather.status() });
});

export default router;

import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { recommenderEngine } from '../services/RecommenderEngine';
import { DEFAULT_SIZING, HORIZONS } from '../services/recommender/plan';
import { DEFAULT_ELIGIBILITY, WEIGHTS } from '../services/recommender/score';
import { DEFAULT_UNIVERSE } from '../services/recommender/universe';

const router = Router();
router.use(authenticate);

/**
 * The last run, or null. Cheap: never triggers a fetch.
 *
 * Separate from the POST because a full run pulls two years of daily bars for
 * roughly a hundred symbols and takes tens of seconds. A page load must not
 * do that, and a page that polls must never do it repeatedly.
 */
router.get('/', (req: AuthedRequest, res) => {
  res.json({
    run: recommenderEngine.lastRun(req.userId!) ?? null,
    settings: {
      sizing: DEFAULT_SIZING,
      eligibility: DEFAULT_ELIGIBILITY,
      horizons: HORIZONS,
      weights: WEIGHTS,
      universeSize: DEFAULT_UNIVERSE.length,
    },
  });
});

/**
 * Run the ranking now.
 *
 * Body is all optional: `{ capital, riskPerTradePct, maxPositionPct, symbols[], withNews }`.
 * Refuses to overlap a run already in progress rather than doubling the load
 * on two unofficial free feeds.
 */
router.post('/run', async (req: AuthedRequest, res) => {
  const { capital, riskPerTradePct, maxPositionPct, symbols, withNews } = req.body ?? {};

  if (capital !== undefined && (typeof capital !== 'number' || !(capital > 0))) {
    return res.status(400).json({ error: 'capital must be a positive number' });
  }
  if (riskPerTradePct !== undefined && (typeof riskPerTradePct !== 'number' || riskPerTradePct <= 0 || riskPerTradePct > 10)) {
    return res.status(400).json({ error: 'riskPerTradePct must be between 0 and 10' });
  }
  if (maxPositionPct !== undefined && (typeof maxPositionPct !== 'number' || maxPositionPct <= 0 || maxPositionPct > 100)) {
    return res.status(400).json({ error: 'maxPositionPct must be between 0 and 100' });
  }
  if (symbols !== undefined && (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string'))) {
    return res.status(400).json({ error: 'symbols must be an array of strings' });
  }

  try {
    const run = await recommenderEngine.run(req.userId!, {
      ...(typeof capital === 'number' ? { capital } : {}),
      ...(symbols?.length ? { symbols } : {}),
      ...(withNews === false ? { withNews: false } : {}),
      sizing: {
        ...(typeof riskPerTradePct === 'number' ? { riskPerTradePct } : {}),
        ...(typeof maxPositionPct === 'number' ? { maxPositionPct } : {}),
      },
    });
    res.json({ run });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;

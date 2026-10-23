import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { futureStarsEngine } from '../services/FutureStarsEngine';
import { DEFAULT_PLAN_PARAMS } from '../services/futurestars/plan';
import { ALL_SCHEMES, POLICY_UNIVERSE } from '../services/futurestars/policy';
import { GATES, WEIGHTS } from '../services/futurestars/score';

const router = Router();
router.use(authenticate);

/**
 * The last run, or null. Never triggers a fetch: a run reads quarterly filings
 * and order announcements for the whole universe and takes minutes.
 */
router.get('/', (req: AuthedRequest, res) => {
  res.json({
    run: futureStarsEngine.lastRun(req.userId!) ?? null,
    settings: {
      plan: DEFAULT_PLAN_PARAMS,
      weights: WEIGHTS,
      gates: GATES,
      schemes: ALL_SCHEMES,
      policyUniverseSize: POLICY_UNIVERSE.length,
      universeSize: futureStarsEngine.universe(req.userId!).length,
    },
  });
});

/**
 * Run the ranking now. Body is optional:
 *   { symbols?: string[], capital?: number, categoryCapPct?, maxPositionPct? }
 */
router.post('/run', async (req: AuthedRequest, res) => {
  const { symbols, capital, categoryCapPct, maxPositionPct } = req.body ?? {};
  const errors: string[] = [];
  if (symbols !== undefined && (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string'))) {
    errors.push('symbols must be an array of strings');
  }
  if (capital !== undefined && (typeof capital !== 'number' || !(capital > 0))) {
    errors.push('capital must be a positive number');
  }
  if (categoryCapPct !== undefined && (typeof categoryCapPct !== 'number' || categoryCapPct <= 0 || categoryCapPct > 60)) {
    errors.push('categoryCapPct must be between 0 and 60 — this category is a satellite, not the core');
  }
  if (maxPositionPct !== undefined && (typeof maxPositionPct !== 'number' || maxPositionPct <= 0 || maxPositionPct > 25)) {
    errors.push('maxPositionPct must be between 0 and 25');
  }
  if (errors.length) return res.status(400).json({ errors });

  try {
    const run = await futureStarsEngine.run(req.userId!, {
      ...(symbols?.length ? { symbols } : {}),
      ...(typeof capital === 'number' ? { capital } : {}),
      params: {
        ...(typeof categoryCapPct === 'number' ? { categoryCapPct } : {}),
        ...(typeof maxPositionPct === 'number' ? { maxPositionPct } : {}),
      },
    });
    return res.json({ run });
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Everything behind one symbol's score, whether or not it qualified. */
router.get('/:symbol', async (req: AuthedRequest, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const run = await futureStarsEngine.run(req.userId!, { symbols: [symbol], persist: false });
    const star = run.stars[0] ?? null;
    return res.json({
      symbol,
      star,
      rejected: run.rejected[0] ?? null,
      skipped: run.skipped[0] ?? null,
      evidence: run.evidence,
    });
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;

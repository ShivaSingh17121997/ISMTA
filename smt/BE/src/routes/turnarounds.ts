import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { turnaroundEngine } from '../services/TurnaroundEngine';
import { DEFAULT_TURN_PARAMS } from '../services/turnaround/plan';
import { BAND, WEIGHTS } from '../services/turnaround/score';

const router = Router();
router.use(authenticate);

/** The last run, or null. Never triggers a fetch. */
router.get('/', (req: AuthedRequest, res) => {
  res.json({
    run: turnaroundEngine.lastRun(req.userId!) ?? null,
    settings: {
      plan: DEFAULT_TURN_PARAMS,
      weights: WEIGHTS,
      band: BAND,
      universeSize: turnaroundEngine.universe(req.userId!).length,
    },
  });
});

/** Run now. Body optional: { symbols?, capital?, categoryCapPct?, riskPerIdeaPct? } */
router.post('/run', async (req: AuthedRequest, res) => {
  const { symbols, capital, categoryCapPct, riskPerIdeaPct } = req.body ?? {};
  const errors: string[] = [];
  if (symbols !== undefined && (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string'))) {
    errors.push('symbols must be an array of strings');
  }
  if (capital !== undefined && (typeof capital !== 'number' || !(capital > 0))) {
    errors.push('capital must be a positive number');
  }
  if (categoryCapPct !== undefined && (typeof categoryCapPct !== 'number' || categoryCapPct <= 0 || categoryCapPct > 50)) {
    errors.push('categoryCapPct must be between 0 and 50 — these are stocks the market has already decided against');
  }
  if (riskPerIdeaPct !== undefined && (typeof riskPerIdeaPct !== 'number' || riskPerIdeaPct <= 0 || riskPerIdeaPct > 5)) {
    errors.push('riskPerIdeaPct must be between 0 and 5');
  }
  if (errors.length) return res.status(400).json({ errors });

  try {
    const run = await turnaroundEngine.run(req.userId!, {
      ...(symbols?.length ? { symbols } : {}),
      ...(typeof capital === 'number' ? { capital } : {}),
      params: {
        ...(typeof categoryCapPct === 'number' ? { categoryCapPct } : {}),
        ...(typeof riskPerIdeaPct === 'number' ? { riskPerIdeaPct } : {}),
      },
    });
    return res.json({ run });
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Everything behind one symbol, whether or not it qualified. */
router.get('/:symbol', async (req: AuthedRequest, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const run = await turnaroundEngine.run(req.userId!, { symbols: [symbol], persist: false });
    return res.json({
      symbol,
      candidate: run.candidates[0] ?? null,
      rejected: run.rejected[0] ?? null,
      skipped: run.skipped[0] ?? null,
      evidence: run.evidence,
    });
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;

import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { store } from '../store/memoryStore';
import { liveCutoff, venueViewFor } from '../services/venueView';

const router = Router();
router.use(authenticate);

/**
 * Trading live, the trail starts at the switch: paper fills and sweep entries
 * from before it are not this account's history. `?all=1` shows everything —
 * nothing is deleted, the trail stays complete.
 */
function sinceFor(userId: string, since: unknown, all: unknown): number | undefined {
  const asked = since ? Number(since) : undefined;
  const cutoff = all === '1' ? undefined : liveCutoff(venueViewFor(userId));
  if (cutoff == null) return asked;
  return asked == null ? cutoff : Math.max(asked, cutoff);
}

/**
 * The audit trail, newest first. `?kind=order|risk|fill|reject|guard|engine|auth|reconcile|system`,
 * `?symbol=`, `?since=<epoch ms>`, `?limit=` (≤ 2000).
 */
router.get('/', async (req: AuthedRequest, res) => {
  const { kind, symbol, since, limit, all } = req.query;
  const entries = await store.auditEntries({
    userId: req.userId,
    kind: typeof kind === 'string' && kind ? kind : undefined,
    symbol: typeof symbol === 'string' && symbol ? symbol : undefined,
    since: sinceFor(req.userId!, since, all),
    limit: limit ? Number(limit) : undefined,
  });
  res.json({ entries });
});

/** CSV export of the same, for a spreadsheet or a post-mortem. */
router.get('/export.csv', async (req: AuthedRequest, res) => {
  const { since, limit, all } = req.query;
  const entries = await store.auditEntries({
    userId: req.userId,
    since: sinceFor(req.userId!, since, all),
    limit: limit ? Number(limit) : 2000,
  });
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['at,iso,kind,symbol,detail,data'];
  for (const e of entries) {
    lines.push([e.at, new Date(e.at).toISOString(), e.kind, e.symbol ?? '', e.detail, e.data ? JSON.stringify(e.data) : ''].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
  res.send(lines.join('\n'));
});

export default router;

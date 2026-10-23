/**
 * Trade journal: every trade and closed lot as one table, with the by-tag
 * report and the override-vs-system comparison, plus notes.
 *
 *   GET   /api/journal?tag=&from=&to=      (from/to are IST days, YYYY-MM-DD)
 *   PATCH /api/journal/:tradeId            { setup?, note?, ruleBreak? }
 *
 * Notes are keyed by the trade id; a lot's note is keyed `lot:<lotId>`. The
 * user check is on both reads and writes — a note is only ever read back to
 * the account that wrote it.
 */
import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { store } from '../store/memoryStore';
import { bookForView, liveCutoff, venueViewFor } from '../services/venueView';
import { JournalNote } from '../types';
import { buildJournal } from '../services/analytics/journal';

const router = Router();
router.use(authenticate);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SETUP_MAX = 200;
const NOTE_MAX = 4000;

function ownsJournalId(userId: string, id: string): boolean {
  if (id.startsWith('lot:')) {
    const lotId = id.slice(4);
    return store
      .accumulatorBooksByUser(userId)
      .some((b) => b.closedLots.some((l) => l.id === lotId) || b.openLots.some((l) => l.id === lotId));
  }
  const t = store.trades.get(id);
  return !!t && t.userId === userId;
}

router.get('/', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const q = (k: string): string | undefined => {
    const v = req.query[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const from = q('from');
  const to = q('to');
  const errors: string[] = [];
  if (from && !DAY_RE.test(from)) errors.push('from must be YYYY-MM-DD');
  if (to && !DAY_RE.test(to)) errors.push('to must be YYYY-MM-DD');
  if (errors.length) {
    res.status(400).json({ errors });
    return;
  }
  // Keyed by the store key rather than `trade.id`: a row persisted without its
  // `id` field would otherwise have no key in the table and could not be annotated.
  // Trading live, paper trades and sold paper lots are left out (services/venueView).
  const view = venueViewFor(userId);
  const since = liveCutoff(view) ?? 0;
  const trades = [...store.trades.entries()]
    .filter(([, t]) => t.userId === userId && t.openedAt >= since)
    .map(([key, t]) => (t.id ? t : { ...t, id: key }));
  const report = buildJournal({
    trades,
    books: store.accumulatorBooksByUser(userId).map((b) => bookForView(b, view)),
    noteFor: (id) => {
      const n = store.journal.get(id);
      return n && n.userId === userId ? n : undefined;
    },
    entryTagFor: (orderId) => store.orders.get(orderId)?.tag,
    filter: { tag: q('tag'), from, to },
  });
  res.json(report);
});

router.patch('/:tradeId', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = String(req.params.tradeId ?? '').trim();
  if (!id || !ownsJournalId(userId, id)) {
    res.status(404).json({ error: 'No such trade or lot in your journal' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (body.setup !== undefined && typeof body.setup !== 'string') errors.push('setup must be a string');
  if (typeof body.setup === 'string' && body.setup.length > SETUP_MAX) errors.push(`setup must be at most ${SETUP_MAX} characters`);
  if (body.note !== undefined && typeof body.note !== 'string') errors.push('note must be a string');
  if (typeof body.note === 'string' && body.note.length > NOTE_MAX) errors.push(`note must be at most ${NOTE_MAX} characters`);
  if (body.ruleBreak !== undefined && typeof body.ruleBreak !== 'boolean') errors.push('ruleBreak must be a boolean');
  if (errors.length) {
    res.status(400).json({ errors });
    return;
  }
  const existing = store.journal.get(id);
  if (existing && existing.userId !== userId) {
    res.status(404).json({ error: 'No such trade or lot in your journal' });
    return;
  }
  const next: JournalNote = {
    tradeId: id,
    userId,
    setup: body.setup !== undefined ? (body.setup as string).trim() || undefined : existing?.setup,
    note: body.note !== undefined ? (body.note as string).trim() || undefined : existing?.note,
    ruleBreak: body.ruleBreak !== undefined ? (body.ruleBreak as boolean) : existing?.ruleBreak,
    updatedAt: Date.now(),
  };
  store.journal.set(id, next);
  store.audit({ userId, kind: 'journal', detail: `journal note on ${id}${next.ruleBreak ? ' (rule break)' : ''}` });
  res.json({ note: next });
});

export default router;

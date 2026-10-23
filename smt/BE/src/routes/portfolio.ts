import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { broker } from '../brokers';
import { store } from '../store/memoryStore';
import { liveCutoff, venueViewFor } from '../services/venueView';

const router = Router();
router.use(authenticate);

// Portfolio summary: positions, P&L, capital.
router.get('/', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const positions = store.positionsByUser(userId).map((p) => {
    const ltp = broker.getLtp(p.symbol) || p.ltp;
    const unrealisedPnl = (ltp - p.avgPrice) * p.quantity;
    return { ...p, ltp, unrealisedPnl: round(unrealisedPnl) };
  });
  const unrealised = positions.reduce((s, p) => s + p.unrealisedPnl, 0);
  const realised = store.getDailyPnl(userId);
  const invested = positions.reduce((s, p) => s + Math.abs(p.quantity) * p.avgPrice, 0);

  res.json({
    positions,
    summary: {
      realisedPnl: round(realised),
      unrealisedPnl: round(unrealised),
      totalPnl: round(realised + unrealised),
      invested: round(invested),
      openPositions: positions.length,
    },
  });
});

// Trade history (round trips). Trading live, paper round trips are left out.
router.get('/trades', (req: AuthedRequest, res) => {
  const since = liveCutoff(venueViewFor(req.userId!)) ?? 0;
  res.json({ trades: store.tradesByUser(req.userId!).filter((t) => t.openedAt >= since) });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;

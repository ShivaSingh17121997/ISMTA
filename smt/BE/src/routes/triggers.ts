import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { broker } from '../brokers';
import { tradability } from '../services/orderGate';
import { triggerService } from '../services/TriggerService';
import { store } from '../store/memoryStore';
import { OrderType, ProductType, TriggerLeg } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', (req: AuthedRequest, res) => {
  res.json({ triggers: store.triggersByUser(req.userId!) });
});

/**
 * Create a standing trigger.
 *
 * Body: { symbol, product: 'CNC'|'MIS', kind: 'single'|'oco',
 *         legs: [{ role: 'single'|'target'|'stop', side, triggerPrice, orderType, price?, quantity }],
 *         trailPct?, expiresAt?, note?, autoCancelWhenFlat? }
 */
router.post('/', (req: AuthedRequest, res) => {
  const { symbol, product, kind, legs, trailPct, expiresAt, note, autoCancelWhenFlat } = req.body ?? {};
  if (typeof symbol !== 'string' || !symbol.trim()) return res.status(400).json({ errors: ['symbol is required'] });
  if (product !== 'CNC' && product !== 'MIS') return res.status(400).json({ errors: ["product must be 'CNC' or 'MIS'"] });
  if (kind !== 'single' && kind !== 'oco') return res.status(400).json({ errors: ["kind must be 'single' or 'oco'"] });
  if (!Array.isArray(legs) || !legs.length) return res.status(400).json({ errors: ['legs[] is required'] });
  if (legs.some((l: unknown) => !l || typeof l !== 'object' || Array.isArray(l))) {
    return res.status(400).json({ errors: ['every leg must be an object: { role, side, triggerPrice, orderType, quantity }'] });
  }
  const sym = symbol.trim().toUpperCase();
  const tradable = tradability(sym, product as ProductType);
  if (!tradable.ok) return res.status(422).json({ errors: [tradable.reason] });

  const parsedLegs: Omit<TriggerLeg, 'fireWhen'>[] = legs.map((l: Record<string, unknown>) => ({
    role: (l.role as TriggerLeg['role']) ?? 'single',
    side: l.side === 'SELL' ? 'SELL' : 'BUY',
    triggerPrice: Number(l.triggerPrice),
    orderType: (l.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET') as OrderType,
    price: l.price != null ? Number(l.price) : undefined,
    quantity: Number(l.quantity),
  }));

  const out = triggerService.create({
    userId: req.userId!,
    symbol: sym,
    product,
    kind,
    legs: parsedLegs,
    trailPct: trailPct != null ? Number(trailPct) : undefined,
    expiresAt: expiresAt != null ? Number(expiresAt) : undefined,
    note: typeof note === 'string' ? note : undefined,
    autoCancelWhenFlat: typeof autoCancelWhenFlat === 'boolean' ? autoCancelWhenFlat : undefined,
    ltp: broker.getLtp(sym),
  });
  if (!out.trigger) return res.status(422).json({ errors: out.errors });
  return res.status(201).json({ trigger: out.trigger });
});

router.post('/:id/cancel', (req: AuthedRequest, res) => {
  const t = triggerService.cancel(req.userId!, req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  return res.json({ trigger: t });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const t = triggerService.cancel(req.userId!, req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  return res.json({ trigger: t });
});

export default router;

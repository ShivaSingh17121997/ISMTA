import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { orderManager } from '../services/OrderManager';
import { charges, CostContext } from '../services/costs';
import { instrumentKind } from '../services/instruments';
import { marketData } from '../services/MarketDataService';
import { tradability } from '../services/orderGate';
import { store } from '../store/memoryStore';
import { liveCutoff, venueViewFor } from '../services/venueView';
import { OrderRequest, ProductType } from '../types';

const router = Router();
router.use(authenticate);

const PRODUCTS: ProductType[] = ['MIS', 'CNC'];

/**
 * Manual order placement (live execution console).
 *
 * Body: symbol, side, quantity, orderType ('MARKET' | 'LIMIT'), product
 * ('MIS' | 'CNC'), price (LIMIT), referencePrice (the LTP the ticket showed),
 * clientOrderId (the ticket's idempotency key). Everything else is decided by
 * the gate and the risk manager; a trimmed quantity comes back with the reason.
 */
router.post('/', async (req: AuthedRequest, res) => {
  const { symbol, side, quantity, orderType, product, price, referencePrice, clientOrderId } = req.body ?? {};
  if (!symbol || !side || !quantity) {
    return res.status(400).json({ error: 'symbol, side, quantity required' });
  }
  if (!['BUY', 'SELL'].includes(side)) return res.status(400).json({ error: 'side must be BUY/SELL' });
  if (product != null && !PRODUCTS.includes(product)) {
    return res.status(400).json({ error: `product must be one of ${PRODUCTS.join('|')}` });
  }
  if (orderType === 'LIMIT' && !(Number(price) > 0)) {
    return res.status(400).json({ error: 'a LIMIT order needs a price' });
  }

  const orderReq: OrderRequest = {
    symbol: String(symbol).toUpperCase(),
    side,
    quantity: Number(quantity),
    orderType: orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
    product: product ?? 'MIS',
    price: price != null ? Number(price) : undefined,
    referencePrice: referencePrice != null ? Number(referencePrice) : undefined,
    clientOrderId: typeof clientOrderId === 'string' && clientOrderId ? clientOrderId : undefined,
    userId: req.userId,
    tag: 'manual',
  };
  const result = await orderManager.place(orderReq);
  if (!result.ok) return res.status(422).json({ error: result.reason, order: result.order });
  return res.status(201).json({ order: result.order, adjustment: result.reason ?? null });
});

/**
 * What an order would cost before it is sent: charges per leg, fee-inclusive
 * breakeven, and whether the instrument is tradable at all. The ticket shows
 * this in its confirm step so nobody sends a market order blind.
 */
router.get('/preview', (req: AuthedRequest, res) => {
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const side = String(req.query.side ?? 'BUY') as 'BUY' | 'SELL';
  const quantity = Number(req.query.quantity ?? 0);
  const product = (String(req.query.product ?? 'MIS') as ProductType) === 'CNC' ? 'CNC' : 'MIS';
  const price = Number(req.query.price ?? 0) || marketData.getPrice(symbol);
  if (!symbol || !(quantity > 0)) return res.status(400).json({ error: 'symbol and quantity required' });
  if (!(price > 0)) {
    return res.status(422).json({ error: `No price for ${symbol}: it is not in the feed and no price was given. Pass ?price= or add it to a watchlist first.` });
  }
  const tradable = tradability(symbol, product);
  const cost: CostContext = { product, instrument: instrumentKind(symbol) };
  const entry = charges(side, price, quantity, cost);
  const exit = charges(side === 'BUY' ? 'SELL' : 'BUY', price, quantity, cost);
  const roundTrip = entry.total + exit.total;
  const notional = price * quantity;
  const breakeven = notional > 0 ? (side === 'BUY' ? price + roundTrip / quantity : price - roundTrip / quantity) : 0;
  const pos = store.positions.get(store.positionKey(req.userId!, symbol));
  res.json({
    symbol,
    side,
    quantity,
    product,
    price,
    notional,
    tradable: tradable.ok,
    tradableReason: tradable.reason ?? null,
    charges: { entry, exit, roundTrip, roundTripPct: notional > 0 ? (roundTrip / notional) * 100 : 0 },
    breakeven,
    existingPosition: pos?.quantity ?? 0,
    reference: marketData.getReference(symbol) || null,
    quoteAgeMs: Number.isFinite(marketData.quoteAge(symbol)) ? marketData.quoteAge(symbol) : null,
  });
});

// Order history. Trading live, orders placed on paper before the switch are left out.
router.get('/', (req: AuthedRequest, res) => {
  const since = liveCutoff(venueViewFor(req.userId!)) ?? 0;
  res.json({ orders: store.ordersByUser(req.userId!).filter((o) => o.createdAt >= since) });
});

export default router;

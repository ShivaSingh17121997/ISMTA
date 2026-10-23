/**
 * Every filled engine order must be booked on its book. Pure.
 *
 * The engine records an order before sending it and books the fill after the
 * broker answers. A restart between the two leaves an order that traded and a
 * book that never heard about it: a BUY whose rung still looks empty (the next
 * tick buys it again), or a SELL whose lot still looks open (the next tick sells
 * shares that are gone). This finds those orders so the book can be halted for
 * a human before either happens.
 *
 * Matching:
 *  - A lot opened by an order carries `orderId`; a lot closed by one carries
 *    `sellOrderId`. That is exact.
 *  - Lots booked before those links existed are matched the way the engine
 *    wrote them: a BUY by epoch + rung + `openedAt === order.createdAt` (both
 *    are the step's `now`), a SELL by the lot id in its tag being closed.
 *  - Orders from before the book was created (a removed and re-added book) are
 *    not the current book's history and are skipped.
 */
import type { Order } from '../../types';
import type { AccumulatorBook } from './types';

export const ENGINE_TAG_PREFIX = 'accumulator:';

export interface UnbookedFill {
  orderId: string;
  userId: string;
  symbol: string;
  side: Order['side'];
  filledQuantity: number;
  filledPrice?: number;
  brokerOrderId?: string;
  createdAt: number;
  /** True when no book exists for the order any more. Reported, never halted. */
  bookMissing: boolean;
  reason: string;
}

type AuditOrder = Pick<
  Order,
  'id' | 'userId' | 'symbol' | 'side' | 'tag' | 'filledQuantity' | 'filledPrice' | 'brokerOrderId' | 'createdAt'
>;

const BUY_TAG = /^e(\d+)l(\d+)$/;

function bookKey(userId: string | undefined, symbol: string): string {
  return `${userId ?? ''}:${symbol.toUpperCase()}`;
}

/** Why this filled order is not on its book, or null when it is. */
function unbookedReason(order: AuditOrder, book: AccumulatorBook): string | null {
  const ref = order.tag!.slice(ENGINE_TAG_PREFIX.length);
  // A lot cleared before going live (paper only) was still bought by its
  // order: leaving `clearedLots` out reported every such buy as unbooked and
  // halted the book on the next boot.
  const lots = [...book.openLots, ...book.closedLots, ...(book.clearedLots ?? [])];

  if (order.side === 'BUY') {
    if (lots.some((l) => l.orderId === order.id)) return null;
    const m = BUY_TAG.exec(ref);
    if (m) {
      const epoch = Number(m[1]);
      const level = Number(m[2]);
      const legacy = lots.some(
        (l) => !l.orderId && l.epoch === epoch && l.level === level && l.openedAt === order.createdAt,
      );
      if (legacy) return null;
    }
    return `BUY ${order.filledQuantity} filled but no lot records it (rung ${ref})`;
  }

  if (book.closedLots.some((l) => l.sellOrderId === order.id)) return null;
  if (book.closedLots.some((l) => !l.sellOrderId && l.id === ref)) return null;
  return book.openLots.some((l) => l.id === ref)
    ? `SELL ${order.filledQuantity} filled but lot ${ref} is still open`
    : `SELL ${order.filledQuantity} filled but no closed lot records it (lot ${ref})`;
}

export function findUnbookedFills(
  orders: Iterable<AuditOrder>,
  books: Iterable<AccumulatorBook>,
): UnbookedFill[] {
  const byKey = new Map<string, AccumulatorBook>();
  for (const b of books) byKey.set(bookKey(b.userId, b.symbol), b);

  const out: UnbookedFill[] = [];
  for (const o of orders) {
    if (!o.tag?.startsWith(ENGINE_TAG_PREFIX) || !(o.filledQuantity > 0)) continue;
    const book = byKey.get(bookKey(o.userId, o.symbol));
    const base = {
      orderId: o.id,
      userId: o.userId ?? '',
      symbol: o.symbol,
      side: o.side,
      filledQuantity: o.filledQuantity,
      ...(o.filledPrice ? { filledPrice: o.filledPrice } : {}),
      ...(o.brokerOrderId ? { brokerOrderId: o.brokerOrderId } : {}),
      createdAt: o.createdAt,
    };
    if (!book) {
      out.push({ ...base, bookMissing: true, reason: `${o.side} filled for a book that no longer exists` });
      continue;
    }
    if (o.createdAt < book.createdAt) continue;
    const reason = unbookedReason(o, book);
    if (reason) out.push({ ...base, bookMissing: false, reason });
  }
  return out;
}

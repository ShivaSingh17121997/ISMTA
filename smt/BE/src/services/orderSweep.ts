/**
 * Boot-time sweep of orders left PENDING by an earlier run.
 *
 * A PENDING order that outlives its process is either dead (paper fills
 * instantly, so any PENDING paper order is an artefact) or genuinely unknown
 * (a live order whose reply was lost). The first kind is closed so it stops
 * looking like an open order; the second is resolved against the broker, and
 * when it cannot be, a human is told rather than the order being guessed at.
 */
import { brokerFor, venueOf } from '../brokers/registry';
import { store } from '../store/memoryStore';
import type { Order } from '../types';
import { logger } from '../utils/logger';
import { notifier } from './Notifier';

/** Younger than this, an order may belong to a step that is still running. */
export const STALE_PENDING_MS = 30 * 60_000;

export type SweepAction = 'close' | 'resolve' | 'alert' | 'keep';

/** What to do with one order. Pure. */
export function sweepActionFor(
  order: Pick<Order, 'status' | 'createdAt' | 'brokerOrderId'>,
  venue: 'paper' | 'live',
  connected: boolean,
  now: number,
): SweepAction {
  if (order.status !== 'PENDING' || now - order.createdAt < STALE_PENDING_MS) return 'keep';
  if (venue === 'paper') return 'close';
  if (order.brokerOrderId && connected) return 'resolve';
  return 'alert';
}

export async function sweepStaleOrders(now = Date.now()): Promise<void> {
  for (const order of [...store.orders.values()]) {
    const brk = brokerFor(order.userId);
    const action = sweepActionFor(order, venueOf(brk), brk.isConnected(), now);
    if (action === 'keep') continue;

    if (action === 'close') {
      store.orders.set(order.id, {
        ...order,
        status: 'CANCELLED',
        rejectionReason: `${order.rejectionReason ? `${order.rejectionReason}; ` : ''}swept at startup: still PENDING on paper, which fills instantly — never executed`,
        updatedAt: now,
      });
      logger.warn(`Order sweep: closed stale paper order ${order.id} (${order.side} ${order.quantity} ${order.symbol})`);
      continue;
    }

    if (action === 'resolve') {
      try {
        const r = await brk.getOrder(order.brokerOrderId!);
        if (r.status !== 'PENDING') {
          store.orders.set(order.id, {
            ...order,
            status: r.status,
            filledQuantity: r.filledQuantity,
            ...(r.filledPrice ? { filledPrice: r.filledPrice } : {}),
            ...(r.rejectionReason ? { rejectionReason: r.rejectionReason } : {}),
            updatedAt: now,
          });
          const msg = `Stale order ${order.brokerOrderId} (${order.side} ${order.quantity} ${order.symbol}) is ${r.status} at the broker`;
          logger.warn(`Order sweep: ${msg}`);
          if (r.filledQuantity > 0) {
            void notifier.alert('critical', `sweep:${order.id}`, `${msg} with ${r.filledQuantity} filled — check the book matches`);
          }
          continue;
        }
      } catch (e) {
        logger.warn(`Order sweep: could not read ${order.brokerOrderId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    const msg =
      `Order ${order.brokerOrderId ?? order.id} (${order.side} ${order.quantity} ${order.symbol}) has been ` +
      `PENDING since ${new Date(order.createdAt).toISOString()} and could not be confirmed. Check it in Kite.`;
    logger.error(`Order sweep: ${msg}`);
    void notifier.alert('critical', `sweep:${order.id}`, msg);
  }
}

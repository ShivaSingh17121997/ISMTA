/**
 * Standing triggers — GTT, OCO and trailing stops — watched by the feed loop.
 *
 * A trigger is a level and an order to send when the price crosses it. Nothing
 * reaches the broker until then, so no funds are blocked and it can stand for
 * months. An OCO pair is a target and a stop on the same position: whichever
 * fires ends the trigger, so the other leg can never fire on top of it. A
 * trailing stop ratchets its level behind the price at a fixed distance and
 * never loosens.
 *
 * Why it exists: Kaminski & Lo (2014) show stop rules subtract return under a
 * random walk and add it under momentum; the strategy engine's exits are
 * per-tick, but a manual position or an accumulator lot the owner wants to
 * protect had nothing. Kite users' most common complaint about GTT trailing
 * stops is that they outlive the position — so a trigger created for a
 * position cancels itself when that position is flat.
 *
 * Pure decision logic is in `evaluateTrigger`; the service only plumbs ticks.
 */
import { v4 as uuid } from 'uuid';
import { store } from '../store/memoryStore';
import { Trigger, TriggerLeg } from '../types';
import { logger } from '../utils/logger';
import { notifier } from './Notifier';
import { orderManager } from './OrderManager';

export interface TriggerDecision {
  /** the trigger as it should now be stored (trail moved, extreme updated) */
  next: Trigger;
  /** the leg to fire, if any */
  fire?: TriggerLeg;
  /** why nothing fired and the trigger should end */
  end?: 'expired' | 'flat';
}

/** Which side of the level fires a leg, from where the price is now. */
export function fireWhenFor(side: 'BUY' | 'SELL', role: TriggerLeg['role'], triggerPrice: number, ltp: number): 'above' | 'below' {
  if (role === 'target') return side === 'SELL' ? 'above' : 'below';
  if (role === 'stop') return side === 'SELL' ? 'below' : 'above';
  return triggerPrice >= ltp ? 'above' : 'below';
}

function crossed(leg: TriggerLeg, ltp: number): boolean {
  return leg.fireWhen === 'above' ? ltp >= leg.triggerPrice : ltp <= leg.triggerPrice;
}

/**
 * Advance a trigger against one price. Pure.
 *
 * @param flat true when the position the trigger protects no longer exists
 */
export function evaluateTrigger(t: Trigger, ltp: number, now: number, flat: boolean): TriggerDecision {
  if (t.status !== 'ACTIVE') return { next: t };
  if (now >= t.expiresAt) return { next: { ...t, status: 'EXPIRED', updatedAt: now }, end: 'expired' };
  if (t.autoCancelWhenFlat && flat) {
    return { next: { ...t, status: 'CANCELLED', failReason: 'position closed', updatedAt: now }, end: 'flat' };
  }

  let next: Trigger = t;
  // Trailing: the stop leg follows the favourable extreme at `trailPct`.
  if (t.trailPct && t.trailPct > 0) {
    const stop = t.legs.find((l) => l.role === 'stop' || l.role === 'single');
    if (stop) {
      const sellStop = stop.side === 'SELL'; // protecting a long: extreme is the high
      const extreme = t.extreme == null ? ltp : sellStop ? Math.max(t.extreme, ltp) : Math.min(t.extreme, ltp);
      const trailed = sellStop ? extreme * (1 - t.trailPct / 100) : extreme * (1 + t.trailPct / 100);
      // Never loosen: a sell-stop only rises, a buy-stop only falls.
      const level = sellStop ? Math.max(stop.triggerPrice, trailed) : Math.min(stop.triggerPrice, trailed);
      if (extreme !== t.extreme || level !== stop.triggerPrice) {
        next = {
          ...t,
          extreme,
          legs: t.legs.map((l) => (l === stop ? { ...l, triggerPrice: Math.round(level * 100) / 100 } : l)),
          updatedAt: now,
        };
      }
    }
  }

  // Stops are checked before targets: a bar that touched both is a stop-out.
  const order = [...next.legs].sort((a, b) => (a.role === 'stop' ? -1 : 0) - (b.role === 'stop' ? -1 : 0));
  const fire = order.find((l) => crossed(l, ltp));
  return { next, fire };
}

export class TriggerService {
  private timer: NodeJS.Timeout | null = null;
  private firing = new Set<string>();

  /** Is the user flat on this symbol (no MIS position and no open accumulator lots)? */
  private isFlat(userId: string, symbol: string): boolean {
    const pos = store.positions.get(store.positionKey(userId, symbol));
    if (pos && pos.quantity !== 0) return false;
    const book = store.accumulatorBook(userId, symbol);
    if (book && book.openLots.length > 0) return false;
    return true;
  }

  async onTick(symbol: string, ltp: number, now: number = Date.now()): Promise<void> {
    const sym = symbol.toUpperCase();
    for (const t of store.activeTriggers()) {
      if (t.symbol !== sym || this.firing.has(t.id)) continue;
      const d = evaluateTrigger(t, ltp, now, this.isFlat(t.userId, sym));
      if (d.next !== t) store.triggers.set(t.id, d.next);
      if (d.end) {
        store.audit({ userId: t.userId, kind: 'engine', symbol: sym, detail: `trigger ${t.id.slice(0, 8)} ${d.next.status.toLowerCase()} (${d.end})` });
        continue;
      }
      if (d.fire) await this.fire(d.next, d.fire, ltp, now);
    }
  }

  private async fire(t: Trigger, leg: TriggerLeg, ltp: number, now: number): Promise<void> {
    this.firing.add(t.id);
    try {
      logger.info(`Trigger ${t.id.slice(0, 8)} ${leg.role} fired on ${t.symbol} @ ${ltp} (level ${leg.triggerPrice})`);
      const res = await orderManager.place({
        symbol: t.symbol,
        side: leg.side,
        quantity: leg.quantity,
        orderType: leg.orderType,
        product: t.product,
        price: leg.orderType === 'LIMIT' ? leg.price : undefined,
        userId: t.userId,
        tag: `gtt:${leg.role}`,
        intent: leg.role === 'single' && leg.side === 'BUY' ? 'entry' : 'exit',
        referencePrice: ltp,
        clientOrderId: `gtt:${t.id}:${leg.role}`,
      });
      const done: Trigger = res.ok
        ? { ...t, status: 'TRIGGERED', triggeredAt: now, firedLeg: leg.role, resultOrderId: res.order?.id, updatedAt: now }
        : { ...t, status: 'FAILED', triggeredAt: now, firedLeg: leg.role, failReason: res.reason, updatedAt: now };
      store.triggers.set(t.id, done);
      store.audit({ userId: t.userId, kind: 'engine', symbol: t.symbol, detail: `trigger ${leg.role} ${res.ok ? 'filled' : 'FAILED'}: ${leg.side} ${leg.quantity} @ ${ltp}${res.ok ? '' : ` — ${res.reason}`}`, data: { triggerId: t.id, orderId: res.order?.id } });
      void notifier.alert(res.ok ? 'info' : 'critical', `gtt:${t.id}`, `${t.symbol} ${leg.role} trigger ${res.ok ? 'filled' : 'FAILED'}: ${leg.side} ${leg.quantity} @ ${ltp}${res.ok ? '' : ` (${res.reason})`}`, 0);
    } finally {
      this.firing.delete(t.id);
    }
  }

  create(input: {
    userId: string;
    symbol: string;
    product: Trigger['product'];
    kind: Trigger['kind'];
    legs: Omit<TriggerLeg, 'fireWhen'>[];
    trailPct?: number;
    expiresAt?: number;
    note?: string;
    autoCancelWhenFlat?: boolean;
    ltp: number;
    now?: number;
  }): { trigger?: Trigger; errors: string[] } {
    const now = input.now ?? Date.now();
    const errors: string[] = [];
    const sym = input.symbol.toUpperCase();
    if (!(input.ltp > 0)) errors.push(`no price for ${sym}`);
    if (input.kind === 'oco' && (input.legs.length !== 2 || !input.legs.some((l) => l.role === 'target') || !input.legs.some((l) => l.role === 'stop'))) {
      errors.push('an OCO needs exactly one target leg and one stop leg');
    }
    if (input.kind === 'single' && input.legs.length !== 1) errors.push('a single trigger has exactly one leg');
    for (const l of input.legs) {
      if (!(l.triggerPrice > 0)) errors.push(`${l.role}: trigger price must be positive`);
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) errors.push(`${l.role}: quantity must be a positive integer`);
      if (l.orderType === 'LIMIT' && !(l.price && l.price > 0)) errors.push(`${l.role}: a LIMIT leg needs a limit price`);
      if (l.role === 'target' && l.side === 'SELL' && l.triggerPrice <= input.ltp) errors.push(`target ${l.triggerPrice} is not above the current price ${input.ltp}`);
      if (l.role === 'stop' && l.side === 'SELL' && l.triggerPrice >= input.ltp) errors.push(`stop ${l.triggerPrice} is not below the current price ${input.ltp}`);
      if (l.role === 'target' && l.side === 'BUY' && l.triggerPrice >= input.ltp) errors.push(`buy target ${l.triggerPrice} is not below the current price ${input.ltp}`);
      if (l.role === 'stop' && l.side === 'BUY' && l.triggerPrice <= input.ltp) errors.push(`buy stop ${l.triggerPrice} is not above the current price ${input.ltp}`);
    }
    if (input.trailPct != null && !(input.trailPct > 0 && input.trailPct < 50)) errors.push('trailPct must be between 0 and 50');
    if (errors.length) return { errors };

    const trigger: Trigger = {
      id: uuid(),
      userId: input.userId,
      symbol: sym,
      product: input.product,
      kind: input.kind,
      legs: input.legs.map((l) => ({ ...l, fireWhen: fireWhenFor(l.side, l.role, l.triggerPrice, input.ltp) })),
      trailPct: input.trailPct,
      extreme: input.trailPct ? input.ltp : undefined,
      autoCancelWhenFlat: input.autoCancelWhenFlat ?? true,
      status: 'ACTIVE',
      note: input.note,
      createdAt: now,
      updatedAt: now,
      // Kite's GTT validity is one year; same here.
      expiresAt: input.expiresAt ?? now + 365 * 86_400_000,
    };
    store.triggers.set(trigger.id, trigger);
    store.audit({ userId: input.userId, kind: 'engine', symbol: sym, detail: `trigger created: ${trigger.kind} ${trigger.legs.map((l) => `${l.role} ${l.side} ${l.quantity} @ ${l.triggerPrice}`).join(', ')}${trigger.trailPct ? ` trail ${trigger.trailPct}%` : ''}`, data: { triggerId: trigger.id } });
    return { trigger, errors: [] };
  }

  cancel(userId: string, id: string, now = Date.now()): Trigger | undefined {
    const t = store.triggers.get(id);
    if (!t || t.userId !== userId) return undefined;
    if (t.status !== 'ACTIVE') return t;
    const next: Trigger = { ...t, status: 'CANCELLED', failReason: 'cancelled by user', updatedAt: now };
    store.triggers.set(id, next);
    store.audit({ userId, kind: 'engine', symbol: t.symbol, detail: `trigger ${id.slice(0, 8)} cancelled by user` });
    return next;
  }

  /** Expiry and flat-position sweep, once a minute, for symbols that are not ticking. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const t of store.activeTriggers()) {
        if (now >= t.expiresAt) {
          store.triggers.set(t.id, { ...t, status: 'EXPIRED', updatedAt: now });
        } else if (t.autoCancelWhenFlat && this.isFlat(t.userId, t.symbol)) {
          store.triggers.set(t.id, { ...t, status: 'CANCELLED', failReason: 'position closed', updatedAt: now });
        }
      }
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const triggerService = new TriggerService();

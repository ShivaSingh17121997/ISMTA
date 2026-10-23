import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { broker } from '../brokers';
import { brokerFor } from '../brokers/registry';
import { config } from '../config';
import { notifier } from './Notifier';
import { store } from '../store/memoryStore';
import {
  ExitReason,
  Order,
  OrderRequest,
  Position,
  Signal,
  StrategyConfig,
  Trade,
} from '../types';
import {
  addSafetyOrder,
  cappedStopFill,
  finalStopPrice,
  openTrailing,
  TrailingPosition,
  updateTrailing,
} from '../strategies/trailingStop';
import { logger } from '../utils/logger';
import { autoSquareOffCharge, charges } from './costs';
import { instrumentKind } from './instruments';
import { roundStopToTick, roundToTick } from './nse';
import { riskManager } from './RiskManager';
import { fundsService } from './FundsService';
import { describe, mustFlatten } from './session';
import { assumeRestingStop, resolveTrailingConfig } from './trailingConfig';
import { orderRateLimiter } from './guards';
import { preTradeGate } from './orderGate';

export interface PlaceResult {
  ok: boolean;
  order?: Order;
  reason?: string;
}

/**
 * Order lifecycle: Signal/Request → Risk check → Broker → Fill → update
 * positions, trades and P&L. Also manages open trades on every tick, via the
 * NTB trailing engine (spec Phase 8) or static SL/TP depending on the
 * strategy's `exitMode`.
 */
export class OrderManager extends EventEmitter {
  async place(req: OrderRequest): Promise<PlaceResult> {
    const userId = req.userId ?? 'system';
    const symbol = req.symbol.toUpperCase();
    const now = Date.now();

    // ── Idempotency. The same client id from the same user is the same order.
    if (req.clientOrderId) {
      const dup = store.orderByClientId(userId, req.clientOrderId);
      if (dup) {
        logger.warn(`Duplicate order ${req.clientOrderId} for ${symbol} — returning the original`);
        store.audit({ userId, kind: 'guard', symbol, detail: `duplicate order id ${req.clientOrderId} refused; original ${dup.id} returned` });
        return dup.status === 'FILLED'
          ? { ok: true, order: dup, reason: 'duplicate: original order returned' }
          : { ok: false, order: dup, reason: dup.rejectionReason ?? 'duplicate of a pending order' };
      }
    }

    // ── The gate every order passes: session, instrument, feed health, rate.
    const gate = preTradeGate({ ...req, symbol }, now);
    if (!gate.ok) {
      logger.warn(`Order refused [${gate.code}] ${req.side} ${req.quantity} ${symbol}: ${gate.reason}`);
      store.audit({ userId, kind: 'guard', symbol, detail: `${req.side} ${req.quantity} refused: ${gate.reason}`, data: { code: gate.code, tag: req.tag, intent: req.intent } });
      this.emit('order:rejected', { req, reason: gate.reason });
      return { ok: false, reason: gate.reason };
    }

    const ltp = broker.getLtp(symbol);

    // ── C1: anything that REDUCES exposure bypasses the risk gate (spec Phase 6).
    //
    // Derived from the actual position, NOT from a caller-supplied `intent`.
    // Trusting the caller is how manual closes stayed gated after the engine's
    // own exits were fixed: routes/orders.ts never set `intent`, so an operator
    // trying to flatten during a breached daily-loss limit got a 422 — the exact
    // bug this was meant to kill, just via the human's path instead of the
    // engine's. Deriving it can't be forgotten by a new call site.
    const pos = store.positions.get(store.positionKey(userId, symbol));
    const signed = req.side === 'BUY' ? req.quantity : -req.quantity;
    const isReducing =
      !!pos && pos.quantity !== 0 && Math.sign(signed) !== Math.sign(pos.quantity);

    const risk = riskManager.check({ ...req, symbol }, ltp, isReducing);
    if (!risk.approved) {
      logger.warn(`Order rejected by risk: ${risk.reason}`);
      store.audit({ userId, kind: 'risk', symbol, detail: `${req.side} ${req.quantity} rejected: ${risk.reason}`, data: { tag: req.tag, intent: req.intent } });
      this.emit('order:rejected', { req, reason: risk.reason });
      return { ok: false, reason: risk.reason };
    }

    // NSE rejects any order whose price is not a valid tick, and the tick is a
    // ladder (₹0.01 under ₹250 … ₹5 above ₹20,000), so a computed stop like
    // entry*(1-1/100) is almost never placeable as-is.
    const finalReq: OrderRequest = {
      ...req,
      symbol,
      quantity: risk.allowedQuantity,
      userId,
      price: req.price != null ? roundToTick(req.price) : undefined,
      simulatedFillPrice:
        req.simulatedFillPrice != null ? roundToTick(req.simulatedFillPrice) : undefined,
    };

    // The risk gate may shrink an order. That is a decision the trader must be
    // able to see: "I asked for 100,000 and got 78" is not the same as "78".
    const adjustment =
      risk.allowedQuantity !== req.quantity
        ? `quantity reduced from ${req.quantity} to ${risk.allowedQuantity} by the ₹${config.risk.maxPositionValue.toLocaleString('en-IN')} position cap`
        : undefined;

    // ── Cash. Until this existed, OrderManager placed orders without ever
    // asking whether the money was there.
    //
    // The accumulator reserves through `FundsService` before every rung and
    // releases in a `finally`; this path did not, so two engines sharing one
    // account could each have an order in flight against the same rupees, and
    // only the broker's margin rejection would catch it — on whichever order
    // happened to arrive second.
    //
    // BUY-TO-OPEN ONLY, and the exclusions are the point:
    //   - a SELL is not gated. Shorting consumes MARGIN, not cash, and this
    //     codebase has no margin model; reserving the full notional would
    //     refuse shorts that are perfectly fundable. Leaving them ungated is
    //     the status quo, not a regression.
    //   - anything REDUCING is not gated, for the same reason exits never are
    //     anywhere else: a position that cannot be closed is worse than one
    //     that should not have been opened.
    //
    // The hold is ephemeral — it covers the in-flight window only and is
    // released the moment the broker answers. It is not a standing claim on
    // the budget, and it does not make the two engines aware of each other;
    // that is what the `symbol_reserved` gate is for.
    const reservationId = `om:${userId}:${symbol}:${now}:${uuid()}`;
    let reserved = false;
    if (finalReq.side === 'BUY' && !isReducing) {
      const px = finalReq.price ?? ltp;
      const cost = finalReq.quantity * (px > 0 ? px : 0);
      if (cost > 0) {
        reserved = await fundsService.reserve(reservationId, symbol, cost, now, userId);
        if (!reserved) {
          const reason =
            `not enough deployable cash for ₹${Math.round(cost).toLocaleString('en-IN')} ` +
            `of ${symbol} — the account is committed elsewhere`;
          logger.warn(`Order refused [funds] ${req.side} ${finalReq.quantity} ${symbol}: ${reason}`);
          store.audit({ userId, kind: 'guard', symbol, detail: `${req.side} ${finalReq.quantity} refused: ${reason}`, data: { code: 'insufficient_funds', tag: req.tag, intent: req.intent } });
          this.emit('order:rejected', { req: finalReq, reason });
          return { ok: false, reason };
        }
      }
    }

    const order: Order = {
      ...finalReq,
      id: uuid(),
      status: 'PENDING',
      filledQuantity: 0,
      requestedQuantity: adjustment ? req.quantity : undefined,
      adjustment,
      referencePrice: req.referencePrice ?? ltp,
      createdAt: now,
      updatedAt: now,
    };
    store.orders.set(order.id, order);
    store.audit({ userId, kind: 'order', symbol, detail: `${order.side} ${order.quantity} ${order.orderType}${order.price ? ` @ ${order.price}` : ''} sent (${order.tag ?? 'untagged'})`, data: { orderId: order.id, intent: order.intent, referencePrice: order.referencePrice, adjustment } });

    // The broker contract only promises a resolved BrokerOrderResult; nothing
    // enforces that an adapter never throws. An un-caught rejection here reaches
    // a `void`-ed caller and takes the process down mid-session, with open
    // positions and no stop monitor running.
    let result;
    order.submittedAt = Date.now();
    orderRateLimiter.record(order.submittedAt);
    try {
      result = await brokerFor(userId).placeOrder(finalReq);
    } catch (e) {
      order.status = 'REJECTED';
      order.rejectionReason = e instanceof Error ? e.message : 'broker threw';
      order.updatedAt = Date.now();
      store.orders.set(order.id, order);
      logger.error(`Broker threw placing ${finalReq.side} ${finalReq.symbol}: ${order.rejectionReason}`);
      store.audit({ userId, kind: 'reject', symbol, detail: `broker threw: ${order.rejectionReason}`, data: { orderId: order.id } });
      this.emit('order:rejected', { req: finalReq, reason: order.rejectionReason });
      return { ok: false, order, reason: order.rejectionReason };
    } finally {
      // Filled, rejected or thrown — the order is no longer in flight, so the
      // cash goes back. `finally` runs even though the catch above returns; a
      // leaked reservation would starve every later buy on this account.
      if (reserved) fundsService.release(reservationId);
    }

    order.ackAt = Date.now();
    order.brokerOrderId = result.brokerOrderId;
    order.status = result.status;
    order.filledQuantity = result.filledQuantity;
    order.filledPrice = result.filledPrice;
    order.rejectionReason = result.rejectionReason;
    order.updatedAt = order.ackAt;
    if (order.filledPrice && order.referencePrice) {
      // Signed against the trader: a BUY above the reference or a SELL below it is positive.
      const dir = order.side === 'BUY' ? 1 : -1;
      order.slippageBps = Math.round(((order.filledPrice - order.referencePrice) / order.referencePrice) * dir * 10_000);
    }
    // Re-persist: PersistentMap.set snapshots the value at call time, so without
    // this the DB keeps the PENDING/0-filled version forever and the order book
    // cannot be reconciled against the position book after a restart.
    store.orders.set(order.id, order);

    if (order.status !== 'FILLED') {
      if (order.status === 'PENDING') {
        // The adapter could not confirm a cancel: this order may still fill with
        // nothing here tracking it. Someone has to look at it in Kite.
        void notifier.alert(
          'critical',
          `order-pending:${order.id}`,
          `${order.side} ${order.quantity} ${symbol} is still working at the broker (order ${order.brokerOrderId || 'unknown'}) and may still fill — check it in Kite`,
        );
      }
      store.audit({ userId, kind: 'reject', symbol, detail: `${order.side} ${order.quantity} ${order.status}: ${order.rejectionReason ?? 'no reason given'}`, data: { orderId: order.id, brokerOrderId: order.brokerOrderId } });
      this.emit('order:rejected', { req: finalReq, reason: order.rejectionReason });
      return { ok: false, order, reason: order.rejectionReason };
    }

    store.audit({ userId, kind: 'fill', symbol, detail: `${order.side} ${order.filledQuantity} filled @ ${order.filledPrice} (${order.slippageBps ?? 0} bps vs reference)`, data: { orderId: order.id, brokerOrderId: order.brokerOrderId, latencyMs: order.ackAt - (order.submittedAt ?? order.ackAt) } });
    this.applyFill(order, finalReq.stopLossTakeProfit);
    this.emit('order:filled', order);
    return { ok: true, order, reason: adjustment };
  }

  /**
   * Session watchdog — flatten every MIS position before the broker does.
   *
   * This is the single most important NSE adaptation. An MIS position still open
   * at 15:25 is force-closed by the broker at an uncontrolled price for ₹50+GST
   * (≈₹59) per order — roughly 3x the brokerage — and the trailing stop never
   * gets to fire. Worse, from 2026-08-03 the Closing Auction Session FREEZES
   * market orders 15:25–15:30 for F&O scrips, so a late scramble is not merely
   * expensive, it is rejected.
   *
   * Default `flattenAt` is 15:10: ahead of the CAS entry block (15:15) and the
   * square-off (15:25), so we always exit on our own terms.
   *
   * Idempotent — once flat there is nothing to close, so calling it on a timer
   * is safe.
   */
  async enforceSessionFlatten(now: number = Date.now()): Promise<void> {
    if (!config.session.enabled || !mustFlatten(now)) return;

    for (const [key, pos] of store.positions.entries()) {
      if (pos.quantity === 0) continue;
      const userId = key.slice(0, key.lastIndexOf(':'));
      if (!userId) continue;
      logger.warn(
        `Session flatten: closing ${pos.quantity} ${pos.symbol} before the ` +
          `${config.session.squareOffAt} square-off (${describe(now)})`,
      );
      try {
        await this.flatten(userId, pos.symbol);
      } catch (e) {
        logger.error(
          `Session flatten failed for ${pos.symbol}: ${e instanceof Error ? e.message : e} — ` +
            `the broker will square this off and charge ₹${autoSquareOffCharge().toFixed(0)}`,
        );
      }
    }
  }

  /**
   * Close every open trade on a symbol at market. Used by the flatten endpoint.
   * Goes through the normal exit path, so it is never risk-gated.
   */
  async flatten(userId: string, symbol: string): Promise<PlaceResult> {
    const open = [...store.trades.values()].filter(
      (t) => t.status === 'OPEN' && t.userId === userId && t.symbol === symbol.toUpperCase(),
    );
    let last: PlaceResult = { ok: true };
    for (const t of open) {
      const live = store.trades.get(t.id);
      if (!live || live.status !== 'OPEN' || live.quantity <= 0) continue;
      await this.exitTrade(live, broker.getLtp(live.symbol), 'manual', false, false);
    }

    // A position can exist without a matching trade (e.g. opened manually), so
    // square off any residual too — otherwise "flatten" would leave it behind.
    const key = store.positionKey(userId, symbol.toUpperCase());
    const pos = store.positions.get(key);
    if (pos && pos.quantity !== 0) {
      last = await this.place({
        symbol: pos.symbol,
        side: pos.quantity > 0 ? 'SELL' : 'BUY',
        quantity: Math.abs(pos.quantity),
        orderType: 'MARKET',
        product: 'MIS',
        userId,
        tag: 'flatten',
        intent: 'exit',
        exitReason: 'manual',
      });
    }
    return last;
  }

  /** Convenience used by the StrategyEngine to act on a Signal. */
  async placeFromSignal(
    signal: Signal,
    userId: string,
    quantity: number,
    strategyId?: string,
    stopPct?: number,
  ) {
    if (signal.action === 'HOLD') return { ok: false, reason: 'HOLD' };
    return this.place({
      symbol: signal.symbol,
      side: signal.action,
      quantity,
      orderType: 'MARKET',
      product: 'MIS',
      userId,
      strategyId,
      tag: 'strategy',
      intent: 'entry',
      stopPct,
      referencePrice: signal.referencePrice,
      // One signal, one order: a re-run of the same bar cannot double the position.
      clientOrderId: strategyId ? `${strategyId}:${signal.symbol}:${signal.timestamp}` : undefined,
      stopLossTakeProfit: {
        sl: signal.stopLoss,
        tp: signal.takeProfit,
        stopPct: signal.stopPct,
        targetPct: signal.targetPct,
      },
    });
  }

  /** Apply a filled order to positions + trades + P&L. */
  private applyFill(order: Order, slTp?: { sl?: number; tp?: number; stopPct?: number; targetPct?: number }): void {
    const userId = order.userId ?? 'system';
    const key = store.positionKey(userId, order.symbol);
    const pos: Position = store.positions.get(key) ?? {
      symbol: order.symbol,
      quantity: 0,
      avgPrice: 0,
      ltp: order.filledPrice ?? 0,
      unrealisedPnl: 0,
      realisedPnl: 0,
    };

    const price = order.filledPrice!;
    const signedQty = order.side === 'BUY' ? order.filledQuantity : -order.filledQuantity;
    const prevQty = pos.quantity;
    const newQty = prevQty + signedQty;
    const fillCharges = charges(order.side, price, order.filledQuantity, {
      product: order.product,
      instrument: instrumentKind(order.symbol),
    }).total;
    order.charges = fillCharges;

    const reducing = prevQty !== 0 && Math.sign(signedQty) !== Math.sign(prevQty);

    if (reducing) {
      const closedQty = Math.min(Math.abs(signedQty), Math.abs(prevQty));
      const direction = Math.sign(prevQty); // +1 was long, -1 was short
      const gross = (price - pos.avgPrice) * closedQty * direction;
      // Spec Phase 10 porting note: NTB's trade.pnl EXCLUDES the entry fee, which
      // biases win rate, profit factor and the daily-loss limit in the SAME
      // direction on every trade — right on the win/loss boundary. Carry the full
      // round trip here instead, and let realised P&L be the net number.
      const realised = gross - fillCharges - this.entryChargesFor(order, closedQty);
      pos.realisedPnl += realised;
      store.addDailyPnl(userId, realised, order.updatedAt);
      this.closeMatchingTrades(userId, order, price, realised, closedQty);
      logger.info(
        `Closed ${closedQty} ${order.symbol} @ ${price} | net ₹${realised.toFixed(2)} (costs ₹${fillCharges.toFixed(2)})`,
      );
    } else if (order.intent === 'dca_add' && order.tradeId) {
      // Spec Phase 9: fold the safety order into the EXISTING trade — recompute
      // the weighted average and re-reference the trailing state. Do NOT open a
      // second trade, which is what the generic "adding" branch would do.
      const trade = store.trades.get(order.tradeId);
      if (trade && trade.status === 'OPEN' && trade.trailing) {
        addSafetyOrder(trade as TrailingPosition, price, order.filledQuantity);
        trade.charges = (trade.charges ?? 0) + fillCharges;
        store.trades.set(trade.id, trade);
        logger.warn(
          `DCA add #${trade.trailing.dcaOrdersUsed} ${order.symbol}: ${order.filledQuantity} @ ${price} → avg ${trade.entryPrice.toFixed(2)}`,
        );
        this.emit('trade:averaged', trade);
      } else {
        logger.error(`DCA add for unknown/closed trade ${order.tradeId} — orphaned fill`);
      }
      const totalCost = pos.avgPrice * Math.abs(prevQty) + price * Math.abs(signedQty);
      pos.avgPrice = totalCost / Math.abs(newQty || 1);
    } else {
      // Opening — recompute weighted average price.
      const totalCost = pos.avgPrice * Math.abs(prevQty) + price * Math.abs(signedQty);
      pos.avgPrice = totalCost / Math.abs(newQty || 1);
      this.openTrade(order, price, slTp, fillCharges);
    }

    pos.quantity = newQty;
    pos.ltp = price;
    if (newQty === 0) pos.avgPrice = 0;
    store.positions.set(key, pos);

    // `order.charges` was set above, AFTER place() persisted the order — and
    // PersistentMap.set snapshots at call time, so without this the field is
    // undefined in Mongo for every order and the order book cannot be reconciled
    // after a restart. (Same hazard the status re-persist in place() exists for.)
    store.orders.set(order.id, order);
  }

  /** Pro-rata share of the entry charges attributable to the quantity being closed. */
  private entryChargesFor(exitOrder: Order, closedQty: number): number {
    const userId = exitOrder.userId ?? 'system';
    const open = store
      .openTradesByUser(userId)
      .filter((t) => t.symbol === exitOrder.symbol && t.side !== exitOrder.side);
    if (!open.length) return 0;
    const totalQty = open.reduce((s, t) => s + t.quantity, 0);
    if (totalQty <= 0) return 0;
    const totalEntryCharges = open.reduce((s, t) => s + (t.charges ?? 0), 0);
    return totalEntryCharges * (Math.min(closedQty, totalQty) / totalQty);
  }

  private openTrade(
    order: Order,
    price: number,
    slTp: { sl?: number; tp?: number; stopPct?: number; targetPct?: number } | undefined,
    entryCharges: number,
  ): void {
    const cfg = order.strategyId ? store.strategies.get(order.strategyId) : undefined;
    const trailingMode = this.exitModeFor(cfg) === 'trailing';

    // Protect the trade relative to the FILL, not the bar close the signal saw.
    // A signal that decided at ₹1,050 and filled at ₹1,388 once carried a stop
    // 23% below its entry; that is not a stop. When the signal gives distances,
    // the levels are recomputed here; absolute levels are only a fallback.
    const dir = order.side === 'BUY' ? 1 : -1;
    const stopLoss =
      slTp?.stopPct && slTp.stopPct > 0
        ? roundStopToTick(price * (1 - (dir * slTp.stopPct) / 100), order.side === 'BUY' ? 'SELL' : 'BUY')
        : slTp?.sl;
    const takeProfit =
      slTp?.targetPct && slTp.targetPct > 0
        ? roundToTick(price * (1 + (dir * slTp.targetPct) / 100))
        : slTp?.tp;

    const trade: Trade = {
      id: uuid(),
      userId: order.userId ?? 'system',
      strategyId: order.strategyId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.filledQuantity,
      entryPrice: price,
      stopLoss,
      takeProfit,
      status: 'OPEN',
      pnl: 0,
      charges: entryCharges,
      entryOrderId: order.id,
      openedAt: Date.now(),
      tags: [order.tag ?? 'manual', ...(order.strategyId ? [`strategy:${cfg?.name ?? order.strategyId}`] : [])],
      maePct: 0,
      mfePct: 0,
    };

    if (trailingMode) {
      // Spec Phase 7: initialise from the EXECUTOR'S ACTUAL FILL PRICE, not the
      // requested price — the executor is the source of truth. `dcaActive` is
      // captured here and frozen for the trade's life.
      const stopPct = order.stopPct && order.stopPct > 0 ? order.stopPct : config.ntb.stopLossPct;
      trade.trailing = openTrailing(price, stopPct, config.ntb.dca.enabled, price * order.filledQuantity);
    }

    store.trades.set(trade.id, trade);
    this.emit('trade:opened', trade);
  }

  private exitModeFor(cfg?: StrategyConfig): 'static' | 'trailing' {
    if (cfg?.exitMode) return cfg.exitMode;
    // NTB models default to the trailing engine; the original 7 keep static SL/TP
    // so nothing regresses for existing strategies.
    return cfg?.type?.startsWith('NTB_') ? 'trailing' : 'static';
  }

  private closeMatchingTrades(
    userId: string,
    order: Order,
    exitPrice: number,
    realised: number,
    closedQty: number,
  ): void {
    // FIFO, and only up to `closedQty`. Previously this blanket-closed EVERY
    // matching trade and stamped each with the FULL position P&L, so two trades
    // exited by one order each reported the whole gain — the trade log and the
    // P&L ledger disagreed, which is the worst failure mode for reconciliation.
    const open = store
      .openTradesByUser(userId)
      .filter((t) => t.symbol === order.symbol && t.side !== order.side)
      .sort((a, b) => a.openedAt - b.openedAt);

    let remaining = closedQty;
    for (const t of open) {
      if (remaining <= 0) break;
      const take = Math.min(t.quantity, remaining);
      const share = closedQty > 0 ? take / closedQty : 0;

      if (take === t.quantity) {
        t.status = 'CLOSED';
        t.exitPrice = exitPrice;
        t.exitOrderId = order.id;
        t.pnl = realised * share;
        // From the order's explicit field, never from the free-text `tag` — tags
        // include 'strategy' and 'dca', which are not ExitReasons, and a cast
        // would persist them into a union the API claims to guarantee.
        t.exitReason = order.exitReason ?? 'manual';
        t.closedAt = Date.now();
        store.trades.set(t.id, t);
        this.emit('trade:closed', t);
        riskManager.recordTrade(t);
      } else {
        // Partial exit: book the closed slice and keep the remainder open.
        t.quantity -= take;
        t.pnl += realised * share;
        store.trades.set(t.id, t);
        this.emit('trade:partial', t);
      }
      remaining -= take;
    }
  }

  /**
   * Called on every market tick (and on each step of a bar's price path in the
   * backtester). Marks positions to market and drives the exit engine.
   *
   * @param candleOpen when known, enables honest gap handling in the stop-fill
   *                   model. Omitted for a live price poll.
   */
  async onTick(symbol: string, ltp: number, candleOpen?: number): Promise<void> {
    // 1. Mark to market. Kept in the RAM cache only — a fluctuating ltp is
    //    ephemeral and does not belong in the DB (it was one upsert per position
    //    per tick, ~432k/day, of data the portfolio route recomputes anyway).
    for (const [, pos] of store.positions.entries()) {
      if (pos.symbol !== symbol || pos.quantity === 0) continue;
      pos.ltp = ltp;
      pos.unrealisedPnl = (ltp - pos.avgPrice) * pos.quantity;
    }

    // 2. Manage each open trade on this symbol.
    const snapshot = [...store.trades.values()].filter(
      (t) => t.status === 'OPEN' && t.symbol === symbol,
    );
    for (const t of snapshot) {
      // Re-read: an earlier iteration's exit may already have closed this trade.
      // Iterating the stale snapshot is how a zero-quantity phantom trade gets
      // created and silently disables the strategy for the process lifetime.
      const live = store.trades.get(t.id);
      if (!live || live.status !== 'OPEN' || live.quantity <= 0) continue;
      // Excursions, for the journal: the worst and best the trade looked while
      // open. RAM only; persisted with the trade when it closes.
      if (live.entryPrice > 0) {
        const move = ((ltp - live.entryPrice) / live.entryPrice) * 100 * (live.side === 'BUY' ? 1 : -1);
        if (move < (live.maePct ?? 0)) live.maePct = Math.round(move * 100) / 100;
        if (move > (live.mfePct ?? 0)) live.mfePct = Math.round(move * 100) / 100;
      }
      try {
        await this.manageTrade(live, ltp, candleOpen);
      } catch (e) {
        logger.error(`Managing ${live.symbol} trade ${live.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private async manageTrade(t: Trade, ltp: number, candleOpen?: number): Promise<void> {
    const cfg = t.strategyId ? store.strategies.get(t.strategyId) : undefined;
    if (this.exitModeFor(cfg) === 'trailing' && t.trailing) {
      return this.manageTrailing(t, ltp, candleOpen);
    }
    return this.manageStatic(t, ltp, candleOpen);
  }

  /** Spec Phase 8: the NTB trailing engine drives the exit. */
  private async manageTrailing(t: Trade, ltp: number, candleOpen?: number): Promise<void> {
    const stratCfg = t.strategyId ? store.strategies.get(t.strategyId) : undefined;
    const cfg = resolveTrailingConfig(stratCfg?.params);

    // Snapshot the durable bits so we only hit Mongo when they actually change.
    // These ratchet, so after the first minutes a new extreme is rare — whereas
    // persisting unconditionally is one upsert per tick per open trade (~86k/day
    // each), the very write amplification we removed from the mark-to-market loop.
    const before = t.trailing
      ? `${t.trailing.peak}|${t.trailing.trough}|${t.trailing.armed}`
      : '';

    const decision = updateTrailing(t as TrailingPosition, ltp, cfg);

    const after = t.trailing ? `${t.trailing.peak}|${t.trailing.trough}|${t.trailing.armed}` : '';
    if (before !== after) store.trades.set(t.id, t);

    if (decision.type === 'HOLD') return;

    if (decision.type === 'ADD') {
      const qty = Math.floor(decision.notional / decision.price);
      // Spec Phase 9: adds pass the SAME risk gate as entries. But a REFUSED add
      // must not leave the position unprotected: dcaOrdersUsed only advances on a
      // fill, so a refusal would never spend the budget and the final stop — the
      // one real loss bound — would never engage. Mark it blocked so the engine
      // falls back to that stop on the next tick.
      const res =
        qty < 1
          ? { ok: false, reason: `sized to 0 shares at ₹${decision.price.toFixed(2)}` }
          : await this.place({
              symbol: t.symbol,
              side: t.side,
              quantity: qty,
              orderType: 'MARKET',
              product: 'MIS',
              userId: t.userId,
              strategyId: t.strategyId,
              tag: 'dca',
              intent: 'dca_add',
              tradeId: t.id,
            });

      if (!res.ok && t.trailing && !t.trailing.dcaBlocked) {
        t.trailing.dcaBlocked = true;
        store.trades.set(t.id, t);
        logger.warn(
          `${t.symbol}: DCA add refused (${res.reason}) — falling back to the final stop ` +
            `at ${finalStopPrice(t as TrailingPosition, cfg).toFixed(2)}. ` +
            `The position is no longer averaging down.`,
        );
      }
      return;
    }

    // EXIT. Only stop-losses are capped to their level; trailing and
    // take-profit exits fill at the observed price (spec Phase 8).
    if (decision.reason === 'stop_loss') {
      const fill = cappedStopFill(
        t.side,
        decision.protectionPrice,
        ltp,
        candleOpen,
        assumeRestingStop(t.userId),
      );
      return this.exitTrade(t, fill.price, decision.reason, fill.gapped, true);
    }
    // Not a modelled price — let the broker fill it like any market order, so
    // paper still charges slippage the way the backtester does.
    return this.exitTrade(t, ltp, decision.reason, false, false);
  }

  /** ISMTA's original static SL/TP exit, retained for exitMode: 'static'. */
  private async manageStatic(t: Trade, ltp: number, candleOpen?: number): Promise<void> {
    // Direction comes from the TRADE, not the net position. Deriving it from the
    // position means a manual order that nets a long negative flips the sign and
    // evaluates a long with short rules — firing its "stop-loss" on a favourable
    // move. `!= null` (not truthiness) so a legitimate stopLoss of 0 isn't skipped.
    const dir = t.side === 'BUY' ? 1 : -1;
    const hitSL = t.stopLoss != null && (dir > 0 ? ltp <= t.stopLoss : ltp >= t.stopLoss);
    const hitTP = t.takeProfit != null && (dir > 0 ? ltp >= t.takeProfit : ltp <= t.takeProfit);
    if (!hitSL && !hitTP) return;

    if (hitSL) {
      const fill = cappedStopFill(t.side, t.stopLoss!, ltp, candleOpen, assumeRestingStop(t.userId));
      return this.exitTrade(t, fill.price, 'stop_loss', fill.gapped, true);
    }
    return this.exitTrade(t, t.takeProfit!, 'take_profit', false, false);
  }

  /**
   * Close one trade at `price`, sized from the TRADE, not the net position.
   *
   * @param modelledFill true only when the ENGINE decided the price (the capped
   *   stop fill). Then the paper broker must honour it verbatim. For any other
   *   exit we pass nothing, so the broker applies slippage like a normal market
   *   order — otherwise paper exits fill better than backtest exits, which would
   *   make paper the more optimistic of the two.
   */
  private async exitTrade(
    t: Trade,
    price: number,
    reason: ExitReason,
    gapped: boolean,
    modelledFill: boolean,
  ): Promise<void> {
    if (gapped) {
      logger.warn(
        `${t.symbol} gapped through its stop — filling at ${price.toFixed(2)}, not the stop level`,
      );
      t.gapped = true;
      store.trades.set(t.id, t);
    }
    logger.info(`Auto-exit ${t.symbol} (${reason}) @ ${price.toFixed(2)}`);

    await this.place({
      symbol: t.symbol,
      side: t.side === 'BUY' ? 'SELL' : 'BUY',
      quantity: t.quantity,
      orderType: 'MARKET',
      product: 'MIS',
      userId: t.userId,
      strategyId: t.strategyId,
      tag: reason,
      intent: 'exit',
      exitReason: reason,
      tradeId: t.id,
      simulatedFillPrice: modelledFill ? price : undefined,
    });
  }
}

export const orderManager = new OrderManager();

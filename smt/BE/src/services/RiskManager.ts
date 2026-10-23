import { config } from '../config';
import { store } from '../store/memoryStore';
import { OrderRequest, Trade, UserRiskState } from '../types';
import { logger } from '../utils/logger';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  /** quantity the risk layer is willing to allow (may be reduced from requested) */
  allowedQuantity: number;
}

export interface RiskSnapshot {
  capital: number;
  dailyPnl: number;
  dailyLossLimit: number;
  dailyLossUsedPct: number;
  openPositions: number;
  maxPositions: number;
  marginUsed: number;
  marginAvailable: number;
  // NTB additions
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  cooldownUntil: number;
  killed: boolean;
}

/**
 * Pre-entry risk gate — spec Phase 6.
 *
 * ⚠️ THE CENTRAL INVARIANT: **exits are never gated.** The risk manager can only
 * refuse to OPEN. This is not a style choice — before this was fixed, a
 * stop-loss exit was routed through the same `check()` as an entry, so once the
 * daily-loss limit tripped the engine REJECTED ITS OWN STOP-LOSS and retried
 * every tick forever while the position rode to zero. The limit designed to cap
 * the loss at ₹5,000 was the exact mechanism that let it run unbounded.
 *
 * Every caller that reduces an existing position MUST pass `isReducing: true`.
 *
 * Gates are evaluated in order; the first failing check wins.
 */
export class RiskManager {
  /**
   * Read-only view. Does NOT allocate — `snapshot()` is served on every
   * authenticated GET /api/risk, and creating an entry per read would grow the
   * map (and the collection) unboundedly.
   */
  private peek(userId: string): UserRiskState {
    return (
      store.riskState.get(userId) ?? {
        day: store.utcDay(),
        consecutiveLosses: 0,
        cooldownUntil: 0,
        killed: false,
      }
    );
  }

  private save(userId: string, st: UserRiskState): void {
    store.riskState.set(userId, st);
  }

  /**
   * Day rolling, derived from TRADE TIMESTAMPS rather than the system clock, so
   * the manager behaves identically in backtest, paper and live. Daily P&L
   * self-expires via its day-keyed bucket in the store; this clears the streak
   * and cooldown, which are day-scoped.
   *
   * Note the kill switch is deliberately NOT cleared by a day roll — it is an
   * operator decision, and only an operator releases it.
   */
  private rollDay(userId: string, time: number): UserRiskState {
    const d = store.utcDay(time);
    const st = this.peek(userId);
    if (st.day !== d) {
      const rolled: UserRiskState = { ...st, day: d, consecutiveLosses: 0, cooldownUntil: 0 };
      this.save(userId, rolled);
      return rolled;
    }
    return st;
  }

  /**
   * @param isReducing true when the order strictly reduces an existing position
   *                   (a stop-loss, take-profit, trailing exit or manual close).
   *                   Such orders bypass every gate.
   */
  check(req: OrderRequest, ltp: number, isReducing = false, time: number = Date.now()): RiskDecision {
    const userId = req.userId ?? 'system';

    // Structural validation applies to everything, entry or exit. Without this a
    // negative quantity sails through the value cap (a negative notional is never
    // "> max") and a BUY silently opens a SHORT.
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      return this.reject(`quantity must be a positive integer (got ${req.quantity})`);
    }

    // ── EXITS BYPASS EVERY GATE. See the class comment. ──
    if (isReducing) {
      return { approved: true, reason: 'exit — risk gates do not apply', allowedQuantity: req.quantity };
    }

    const st = this.rollDay(userId, time);

    // 1. Kill switch.
    if (st.killed) return this.reject('kill-switch engaged');

    const price = req.orderType === 'LIMIT' && req.price ? req.price : ltp;
    if (!(price > 0)) return this.reject('No valid price for risk check');

    // 2. Daily loss limit — absolute (₹) and, if configured, as a % of capital.
    const dailyPnl = store.getDailyPnl(userId, time);
    if (config.risk.dailyLossLimit > 0 && dailyPnl <= -config.risk.dailyLossLimit) {
      return this.reject(
        `Daily loss limit hit (${dailyPnl.toFixed(0)} / -${config.risk.dailyLossLimit})`,
      );
    }
    if (config.ntb.maxDailyLossPct > 0) {
      const pctLimit = (config.risk.capital * config.ntb.maxDailyLossPct) / 100;
      if (dailyPnl <= -pctLimit) {
        return this.reject(
          `Daily loss limit hit (${dailyPnl.toFixed(0)} / -${pctLimit.toFixed(0)} = ${config.ntb.maxDailyLossPct}% of capital)`,
        );
      }
    }

    // 3. Consecutive-loss circuit breaker.
    if (
      config.ntb.maxConsecutiveLosses > 0 &&
      st.consecutiveLosses >= config.ntb.maxConsecutiveLosses
    ) {
      return this.reject(`${st.consecutiveLosses} consecutive losses — halted`);
    }

    // 4. Post-loss cooldown.
    if (st.cooldownUntil > 0 && time < st.cooldownUntil) {
      const secs = Math.ceil((st.cooldownUntil - time) / 1000);
      return this.reject(`post-loss cooldown (${secs}s remaining)`);
    }

    // 5. Max concurrent positions — only for orders that OPEN a new one.
    // Adding to a position you already hold (a DCA safety order, or scaling in)
    // does not increase the position COUNT, and gating it here would make DCA
    // undeployable at the cap and dead on arrival with maxPositions=1.
    const existing = store.positions.get(store.positionKey(userId, req.symbol));
    const opensNewPosition = !existing || existing.quantity === 0;
    if (opensNewPosition) {
      const open = store.positionsByUser(userId).length;
      if (open >= config.risk.maxPositions) {
        return this.reject(`Max concurrent positions reached (${open}/${config.risk.maxPositions})`);
      }
    }

    // 6. Position value cap → may shrink the order rather than reject it.
    let qty = req.quantity;
    const requestedValue = qty * price;
    if (requestedValue > config.risk.maxPositionValue) {
      qty = Math.floor(config.risk.maxPositionValue / price);
      if (qty < 1) return this.reject(`Single share exceeds max position value (${price})`);
      logger.warn(`Risk: trimming qty ${req.quantity}→${qty} for ${req.symbol} (value cap)`);
    }

    return { approved: true, reason: 'ok', allowedQuantity: qty };
  }

  /**
   * Post-trade bookkeeping (spec Phase 6). A WIN clears the cooldown as well as
   * the streak — the cooldown exists to stop tilt after a loss, not to punish a
   * recovery.
   *
   * Note `dailyPnl` is booked by OrderManager at fill time (it is also the ledger
   * the dashboard reads); this only maintains the streak/cooldown state.
   */
  recordTrade(trade: Trade): void {
    const time = trade.closedAt ?? Date.now();
    const st = { ...this.rollDay(trade.userId, time) };

    if (trade.pnl > 0) {
      st.consecutiveLosses = 0;
      st.cooldownUntil = 0;
    } else {
      st.consecutiveLosses += 1;
      if (config.ntb.lossCooldownMs > 0) st.cooldownUntil = time + config.ntb.lossCooldownMs;
      if (
        config.ntb.maxConsecutiveLosses > 0 &&
        st.consecutiveLosses >= config.ntb.maxConsecutiveLosses
      ) {
        logger.warn(
          `${trade.userId}: ${st.consecutiveLosses} consecutive losses — entries halted until the UTC day rolls`,
        );
      }
    }
    this.save(trade.userId, st);
  }

  /**
   * Switching between paper and live: today's loss count, streak and cooldown
   * measured the other venue, so they start again from zero. A paper losing
   * streak must not halt a real account (or the other way round). The kill
   * switch is kept — it is an operator decision, not a measurement.
   */
  resetForVenueSwitch(userId: string, time: number = Date.now()): void {
    store.clearDailyPnl(userId, time);
    this.save(userId, { ...this.peek(userId), day: store.utcDay(time), consecutiveLosses: 0, cooldownUntil: 0 });
  }

  /** Global "stop opening anything" switch. Never blocks an exit. */
  setKilled(userId: string, killed: boolean): void {
    this.save(userId, { ...this.peek(userId), killed });
    logger.warn(`Kill switch ${killed ? 'ENGAGED' : 'released'} for ${userId}`);
  }

  isKilled(userId: string): boolean {
    return this.peek(userId).killed;
  }

  /** Fractional-Kelly position size suggestion (utility for the UI / strategy). */
  kellyQuantity(price: number, winRate: number, winLossRatio: number, fraction = 0.5): number {
    if (price <= 0 || winLossRatio <= 0) return 0;
    const kelly = winRate - (1 - winRate) / winLossRatio;
    const capped = Math.max(0, Math.min(kelly, 1)) * fraction;
    const allocation = config.risk.capital * capped;
    return Math.max(0, Math.floor(allocation / price));
  }

  snapshot(userId: string): RiskSnapshot {
    const positions = store.positionsByUser(userId);
    const marginUsed = positions.reduce((sum, p) => sum + Math.abs(p.quantity) * p.avgPrice, 0);
    const dailyPnl = store.getDailyPnl(userId);
    // Roll first, or the dashboard reports yesterday's streak and cooldown until
    // someone happens to attempt an order.
    const st = this.rollDay(userId, Date.now());
    const limit = config.risk.dailyLossLimit;
    return {
      capital: config.risk.capital,
      dailyPnl,
      dailyLossLimit: limit,
      // Guard the divisor: with the limit disabled (0) this was Infinity → 100%,
      // so the dashboard raised a "new entries blocked" alert while check() was
      // skipping the gate entirely.
      dailyLossUsedPct:
        limit > 0 && dailyPnl < 0 ? Math.min(100, (-dailyPnl / limit) * 100) : 0,
      openPositions: positions.length,
      maxPositions: config.risk.maxPositions,
      marginUsed,
      marginAvailable: Math.max(0, config.risk.capital - marginUsed),
      consecutiveLosses: st.consecutiveLosses,
      maxConsecutiveLosses: config.ntb.maxConsecutiveLosses,
      cooldownUntil: st.cooldownUntil,
      killed: st.killed,
    };
  }

  private reject(reason: string): RiskDecision {
    return { approved: false, reason, allowedQuantity: 0 };
  }
}

export const riskManager = new RiskManager();

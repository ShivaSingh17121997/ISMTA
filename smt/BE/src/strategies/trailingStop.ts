/**
 * NTB trailing-stop engine — spec Phase 8 (position management) and Phase 9 (DCA).
 *
 * PURE. No exchange, no network, no clock, no imports from services/. Feed it a
 * price, it returns a decision. That purity is what lets the identical code run
 * in OrderManager.onTick (live) and BacktestEngine (historical), which is the
 * only reason a backtest here characterises live behaviour at all.
 *
 * Ported from the NTB spec's `strategy/trailingStop.ts`. Vocabulary mapped to
 * ISMTA: NTB `long`/`short` → `BUY`/`SELL`.
 */
import { ExitReason, OrderSide, TrailingState } from '../types';

export interface DcaConfig {
  enabled: boolean;
  /** total safety orders allowed AFTER the first entry — this is the capital budget */
  maxSafetyOrders: number;
  /** drawdown % from the average entry that triggers the first safety order */
  deviationPct: number;
  /** each successive trigger distance is deviationPct * stepScale^n */
  stepScale: number;
  /** k-th safety order notional = baseNotional * volumeScale^k (k is 1-based) */
  volumeScale: number;
  /** the ONE real loss bound once the safety-order budget is spent; 0 → fall back to stopPct */
  finalStopPct: number;
}

export interface TrailingConfig {
  /** profit % before the trailing stop arms */
  activationPct: number;
  /** retrace % from peak/trough that exits, once armed */
  trailPct: number;
  /** fallback hard stop % when the position carries no locked stopPct */
  stopLossPct: number;
  /** hard take-profit cap; 0 = disabled (the spec strongly recommends 0) */
  takeProfitPct: number;
  dca: DcaConfig;
  /**
   * Snap a protection level onto the exchange's tick grid.
   *
   * Injected rather than imported so this module stays pure and testable. NSE
   * rejects orders at invalid ticks, and the tick is a price-dependent ladder —
   * so a level of 99.49000000000001 is not merely ugly, it is un-placeable as a
   * real stop order. Rounding here (not just at the order boundary) keeps the
   * backtest honest about where a real SL-M would actually sit.
   *
   * Omit for a tick-free market. Implementations MUST widen rather than tighten.
   */
  roundStop?: (price: number, side: OrderSide) => number;
}

/** The minimum a position must expose for the engine to manage it. `Trade` satisfies this. */
export interface TrailingPosition {
  side: OrderSide;
  /** weighted average entry — DCA lowers this */
  entryPrice: number;
  quantity: number;
  trailing: TrailingState;
}

export type TrailingDecision =
  | { type: 'HOLD'; protectionPrice: number }
  | { type: 'EXIT'; reason: ExitReason; protectionPrice: number }
  | { type: 'ADD'; price: number; notional: number };

/**
 * Initialise trailing state at entry.
 *
 * `entryPrice` MUST be the executor's actual fill price, not the requested price
 * — the executor is the source of truth (spec Phase 7). `dcaActive` is captured
 * here from live config and frozen: flipping the DCA toggle at runtime must never
 * retroactively change how an already-open position handles its downside.
 */
export function openTrailing(
  entryPrice: number,
  stopPct: number,
  dcaActive: boolean,
  baseNotional: number,
): TrailingState {
  return {
    peak: entryPrice,
    trough: entryPrice,
    armed: false,
    stopPct,
    dcaOrdersUsed: 0,
    dcaActive,
    baseNotional,
  };
}

/** Signed profit %, positive = in profit. Shorts profit as price falls. */
export function profitPct(pos: TrailingPosition, price: number): number {
  if (pos.entryPrice <= 0) return 0;
  const raw = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  return pos.side === 'BUY' ? raw : -raw;
}

/** Snap to the tick grid when the market has one. */
function snap(price: number, side: OrderSide, cfg: TrailingConfig): number {
  return cfg.roundStop ? cfg.roundStop(price, side) : price;
}

/** Trailing level, measured from the ratcheted extreme. */
export function trailingStopPrice(pos: TrailingPosition, cfg: TrailingConfig): number {
  const raw =
    pos.side === 'BUY'
      ? pos.trailing.peak * (1 - cfg.trailPct / 100)
      : pos.trailing.trough * (1 + cfg.trailPct / 100);
  return snap(raw, pos.side, cfg);
}

/** Hard stop level, measured from the (possibly DCA-averaged) entry. */
export function stopLossPrice(pos: TrailingPosition, cfg: TrailingConfig): number {
  const pct = pos.trailing.stopPct || cfg.stopLossPct;
  const raw =
    pos.side === 'BUY' ? pos.entryPrice * (1 - pct / 100) : pos.entryPrice * (1 + pct / 100);
  return snap(raw, pos.side, cfg);
}

function hitStopLoss(pos: TrailingPosition, price: number, cfg: TrailingConfig): boolean {
  const sl = stopLossPrice(pos, cfg);
  return pos.side === 'BUY' ? price <= sl : price >= sl;
}

function hitTrailing(pos: TrailingPosition, price: number, cfg: TrailingConfig): boolean {
  const tp = trailingStopPrice(pos, cfg);
  return pos.side === 'BUY' ? price <= tp : price >= tp;
}

// ─── Phase 9: DCA ──────────────────────────────────────────────────────

/** Trigger distance for the next safety order; widens geometrically with stepScale. */
export function nextDeviationPct(state: TrailingState, dca: DcaConfig): number {
  return dca.deviationPct * Math.pow(dca.stepScale, state.dcaOrdersUsed);
}

/** Notional of the k-th safety order (k is 1-based, matching the spec). */
export function safetyOrderNotional(state: TrailingState, dca: DcaConfig): number {
  const k = state.dcaOrdersUsed + 1;
  return state.baseNotional * Math.pow(dca.volumeScale, k);
}

/** The one real loss bound once the safety-order budget is spent. */
export function finalStopPrice(pos: TrailingPosition, cfg: TrailingConfig): number {
  const pct = cfg.dca.finalStopPct > 0 ? cfg.dca.finalStopPct : pos.trailing.stopPct || cfg.stopLossPct;
  const raw =
    pos.side === 'BUY' ? pos.entryPrice * (1 - pct / 100) : pos.entryPrice * (1 + pct / 100);
  return snap(raw, pos.side, cfg);
}

/**
 * DCA downside handling. Replaces the classic stop entirely while budget remains.
 *
 * ⚠️ Returning `null` with budget left means the position is HOLDING WITH NO
 * DOWNSIDE PROTECTION. That is deliberate and is the strategy's core trade-off.
 * Only `maxSafetyOrders` (a capital budget) and `finalStopPct` bound the worst case.
 */
function updateDca(
  pos: TrailingPosition,
  price: number,
  cfg: TrailingConfig,
  pnl: number,
): TrailingDecision | null {
  const st = pos.trailing;
  const drawdown = -pnl; // positive = underwater on the average

  // `dcaBlocked` is the safety valve: if an add was refused, the budget can never
  // be spent by filling, so without this check the fall-through to finalStopPrice
  // below is unreachable and the position rides down unprotected forever.
  const budgetLeft = !st.dcaBlocked && st.dcaOrdersUsed < cfg.dca.maxSafetyOrders;

  if (budgetLeft) {
    if (drawdown >= nextDeviationPct(st, cfg.dca)) {
      return { type: 'ADD', price, notional: safetyOrderNotional(st, cfg.dca) };
    }
    return null; // intentionally unprotected
  }

  const stop = finalStopPrice(pos, cfg);
  if (pos.side === 'BUY' ? price <= stop : price >= stop) {
    return { type: 'EXIT', reason: 'stop_loss', protectionPrice: stop };
  }
  return null;
}

/**
 * Fold a filled safety order into the position: recompute the weighted average,
 * then RE-REFERENCE the trailing state to it. Peak/trough reset and the trail
 * dis-arms so take-profit measures from the improved average — the position now
 * only needs to recover to the *new* average to break even. This is the only
 * place `armed` ever goes back to false.
 */
export function addSafetyOrder(pos: TrailingPosition, price: number, qty: number): void {
  const totalQty = pos.quantity + qty;
  if (totalQty <= 0) return;
  pos.entryPrice = (pos.entryPrice * pos.quantity + price * qty) / totalQty;
  pos.quantity = totalQty;
  pos.trailing.dcaOrdersUsed += 1;
  pos.trailing.peak = pos.entryPrice;
  pos.trailing.trough = pos.entryPrice;
  pos.trailing.armed = false;
}

// ─── Phase 8: the core ─────────────────────────────────────────────────

/**
 * Evaluate one price against an open position.
 *
 * THE EVALUATION ORDER IS LOAD-BEARING — DO NOT REARRANGE. In particular the
 * stop-loss is checked BEFORE the trailing exit, so a fast adverse move can
 * never be masked by the trailing logic.
 *
 * Mutates `pos.trailing` (extremes, armed latch). Deterministic and I/O-free.
 */
export function updateTrailing(
  pos: TrailingPosition,
  price: number,
  cfg: TrailingConfig,
): TrailingDecision {
  const st = pos.trailing;

  // 1. Extend the extremes with this tick. They ratchet and never retreat —
  //    that is what lets a winner run while locking in the gain.
  if (price > st.peak) st.peak = price;
  if (price < st.trough) st.trough = price;

  const pnl = profitPct(pos, price);

  // 2. Arm once activation profit is reached. One-way latch (except a DCA add).
  if (!st.armed && pnl >= cfg.activationPct) st.armed = true;

  // 3. Downside. DCA mode replaces the classic stop entirely.
  //    Note the gate is `st.dcaActive` (captured at open), NOT cfg.dca.enabled.
  if (st.dcaActive) {
    const d = updateDca(pos, price, cfg, pnl);
    if (d) return d;
    // else fall through to the upside checks — an averaged position still
    // take-profits and trails normally.
  } else if (hitStopLoss(pos, price, cfg)) {
    return { type: 'EXIT', reason: 'stop_loss', protectionPrice: stopLossPrice(pos, cfg) };
  }

  // 4. Optional hard take-profit cap.
  if (cfg.takeProfitPct > 0 && pnl >= cfg.takeProfitPct) {
    return { type: 'EXIT', reason: 'take_profit', protectionPrice: price };
  }

  // 5. Trailing exit — ONLY once armed.
  if (st.armed && hitTrailing(pos, price, cfg)) {
    return { type: 'EXIT', reason: 'trailing', protectionPrice: trailingStopPrice(pos, cfg) };
  }

  // 6. Hold, reporting the currently binding protection level.
  return {
    type: 'HOLD',
    protectionPrice: st.armed ? trailingStopPrice(pos, cfg) : stopLossPrice(pos, cfg),
  };
}

/**
 * A stop must fill at ITS LEVEL, not at whatever adverse price you happened to
 * observe (spec Phase 8). Filling at the observed extreme is what turns a 0.6%
 * stop into a −6% realised loss.
 *
 * With candle context the stop fills at its level UNLESS the bar opened beyond it
 * — a true gap — in which case you fill at the open (worse) and flag the event.
 *
 * @param assumeRestingStop only meaningful without candle context (a live price
 *   poll). TRUE claims a real resting stop order existed and filled at its level.
 *   That is ONLY honest when the broker actually placed one — pass
 *   `config.ntb.useExchangeStop` (or true in paper, where the engine IS the
 *   exchange). When false we fall back to the observed price, which is what a
 *   poll loop really gets, and flag it as a gap. NSE gaps every morning, so this
 *   matters far more here than in the 24/7 crypto market NTB was built for.
 */
export function cappedStopFill(
  side: OrderSide,
  stopPrice: number,
  observed: number,
  candleOpen?: number,
  assumeRestingStop = true,
): { price: number; gapped: boolean } {
  if (candleOpen == null) {
    if (assumeRestingStop) return { price: stopPrice, gapped: false };
    // No resting stop: we only learn the price on the next poll, and it may be
    // well past the level. Booking the stop level here would be a lie.
    const worse = side === 'BUY' ? observed < stopPrice : observed > stopPrice;
    return { price: worse ? observed : stopPrice, gapped: worse };
  }
  const gapped = side === 'BUY' ? candleOpen < stopPrice : candleOpen > stopPrice;
  return { price: gapped ? candleOpen : stopPrice, gapped };
}

/**
 * The bar's price path, ADVERSE EXTREME FIRST (spec Phase 1).
 *
 * Walking `low` before `high` on a long means a bar that touched both the stop
 * and the trailing level is scored as a STOP-OUT, not a win. This is what keeps
 * the backtest honest instead of optimistic.
 */
export function adversePath(side: OrderSide, bar: { open: number; high: number; low: number; close: number }): number[] {
  return side === 'BUY'
    ? [bar.open, bar.low, bar.high, bar.close]
    : [bar.open, bar.high, bar.low, bar.close];
}

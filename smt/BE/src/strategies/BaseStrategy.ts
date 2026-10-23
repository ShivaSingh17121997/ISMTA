import { Candle, Signal } from '../types';

export interface StrategyContext {
  symbol: string;
  candles: Candle[]; // chronological, oldest → newest
  params: Record<string, number>;
}

/**
 * A strategy is a pure function of price history → Signal. Keeping it pure
 * means the exact same code runs in the live StrategyEngine and in the
 * BacktestEngine (walk-forward over historical candles).
 */
export abstract class BaseStrategy {
  abstract readonly type: string;
  abstract readonly defaultParams: Record<string, number>;

  /** Minimum candles required before the strategy can emit a non-HOLD signal. */
  abstract minCandles(params: Record<string, number>): number;

  abstract evaluate(ctx: StrategyContext): Signal;

  protected hold(symbol: string, reason: string): Signal {
    return { action: 'HOLD', symbol, confidence: 0, reason, timestamp: Date.now() };
  }

  /**
   * Build a BUY/SELL signal with SL/TP derived from `stopLossPct`/`takeProfitPct`.
   *
   * A percentage of 0 means DISABLED, not "exit at the entry price". The NTB
   * models default `takeProfitPct: 0` deliberately — a small hard take-profit
   * caps winners below where the trailing exit would have released them, which
   * inverts reward:risk. Without this guard a 0 would produce takeProfit ===
   * price and close every position on the tick it opened.
   *
   * Under `exitMode: 'trailing'` these prices are advisory only: the trailing
   * engine owns the exits and the engine locks its own stop distance at entry
   * (spec Phase 4).
   */
  protected makeSignal(
    ctx: StrategyContext,
    action: 'BUY' | 'SELL',
    price: number,
    confidence: number,
    reason: string,
  ): Signal {
    const slPct = ctx.params.stopLossPct ?? 1.5;
    const tpPct = ctx.params.takeProfitPct ?? 3;
    const sl = slPct / 100;
    const tp = tpPct / 100;
    return {
      action,
      symbol: ctx.symbol,
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
      reason,
      stopLoss:
        slPct > 0 ? (action === 'BUY' ? price * (1 - sl) : price * (1 + sl)) : undefined,
      takeProfit:
        tpPct > 0 ? (action === 'BUY' ? price * (1 + tp) : price * (1 - tp)) : undefined,
      stopPct: slPct > 0 ? slPct : undefined,
      targetPct: tpPct > 0 ? tpPct : undefined,
      referencePrice: price,
      // Bar time, not wall-clock: a backtest signal must carry the bar it belongs
      // to, otherwise every historical signal is stamped with the time the test ran.
      timestamp: ctx.candles[ctx.candles.length - 1]?.timestamp ?? Date.now(),
    };
  }
}

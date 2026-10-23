import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { vwap } from './indicators';

/**
 * VWAP Crossover (intraday).
 * BUY  when price crosses ABOVE the rolling VWAP (institutional support flip).
 * SELL when price crosses BELOW it.
 */
export class VWAPStrategy extends BaseStrategy {
  readonly type = 'VWAP';
  readonly defaultParams = { period: 20, stopLossPct: 1, takeProfitPct: 2 };

  minCandles(params: Record<string, number>): number {
    return (params.period ?? 20) + 2;
  }

  evaluate(ctx: StrategyContext): Signal {
    const period = ctx.params.period ?? this.defaultParams.period;
    const n = ctx.candles.length;
    if (n < period + 1) return this.hold(ctx.symbol, 'insufficient data');

    const v = vwap(ctx.candles, period);
    const prevV = vwap(ctx.candles.slice(0, -1), period);
    if (v == null || prevV == null) return this.hold(ctx.symbol, 'no volume data');

    const price = ctx.candles[n - 1].close;
    const prevPrice = ctx.candles[n - 2].close;
    const conf = Math.min(1, 0.5 + (Math.abs(price - v) / v) * 50);

    if (prevPrice <= prevV && price > v) {
      return this.makeSignal(ctx, 'BUY', price, conf, 'price crossed above VWAP');
    }
    if (prevPrice >= prevV && price < v) {
      return this.makeSignal(ctx, 'SELL', price, conf, 'price crossed below VWAP');
    }
    return this.hold(ctx.symbol, 'no VWAP cross');
  }
}

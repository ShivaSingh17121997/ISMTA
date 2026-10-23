import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { supertrend } from './indicators';

/**
 * Supertrend (ATR-based trend follower).
 * BUY  when the trend flips from down → up.
 * SELL when it flips from up → down.
 */
export class SupertrendStrategy extends BaseStrategy {
  readonly type = 'SUPERTREND';
  readonly defaultParams = { period: 10, multiplier: 3, stopLossPct: 2, takeProfitPct: 4 };

  minCandles(params: Record<string, number>): number {
    return (params.period ?? 10) + 5;
  }

  evaluate(ctx: StrategyContext): Signal {
    const period = ctx.params.period ?? this.defaultParams.period;
    const mult = ctx.params.multiplier ?? this.defaultParams.multiplier;
    const st = supertrend(ctx.candles, period, mult);
    if (!st) return this.hold(ctx.symbol, 'insufficient data');

    const price = ctx.candles[ctx.candles.length - 1].close;
    // Distance of price from the supertrend line scales confidence.
    const conf = Math.min(1, 0.55 + (Math.abs(price - st.value) / price) * 20);

    if (st.prevTrend < 0 && st.trend > 0) {
      return this.makeSignal(ctx, 'BUY', price, conf, 'Supertrend flipped bullish');
    }
    if (st.prevTrend > 0 && st.trend < 0) {
      return this.makeSignal(ctx, 'SELL', price, conf, 'Supertrend flipped bearish');
    }
    return this.hold(ctx.symbol, st.trend > 0 ? 'trend up (holding)' : 'trend down (holding)');
  }
}

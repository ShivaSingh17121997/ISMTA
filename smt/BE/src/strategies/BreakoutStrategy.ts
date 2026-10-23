import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { donchian } from './indicators';

/**
 * Donchian Channel Breakout.
 * BUY  when price closes above the highest high of the prior N bars.
 * SELL when price closes below the lowest low of the prior N bars.
 * Captures the start of new trends / range expansions.
 */
export class BreakoutStrategy extends BaseStrategy {
  readonly type = 'BREAKOUT';
  readonly defaultParams = { period: 20, stopLossPct: 2, takeProfitPct: 5 };

  minCandles(params: Record<string, number>): number {
    return (params.period ?? 20) + 2;
  }

  evaluate(ctx: StrategyContext): Signal {
    const period = ctx.params.period ?? this.defaultParams.period;
    const dc = donchian(ctx.candles, period);
    if (!dc) return this.hold(ctx.symbol, 'insufficient data');

    const price = ctx.candles[ctx.candles.length - 1].close;
    const range = dc.upper - dc.lower || price;

    if (price > dc.upper) {
      const conf = Math.min(1, 0.5 + ((price - dc.upper) / range) * 5);
      return this.makeSignal(ctx, 'BUY', price, conf, `${period}-bar high breakout`);
    }
    if (price < dc.lower) {
      const conf = Math.min(1, 0.5 + ((dc.lower - price) / range) * 5);
      return this.makeSignal(ctx, 'SELL', price, conf, `${period}-bar low breakdown`);
    }
    return this.hold(ctx.symbol, 'inside channel');
  }
}

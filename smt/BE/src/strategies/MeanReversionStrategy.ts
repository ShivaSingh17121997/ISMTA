import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { bollinger, rsi } from './indicators';

/**
 * Mean Reversion (Bollinger Bands + RSI filter).
 * BUY  when price closes below the lower band and RSI is oversold.
 * SELL when price closes above the upper band and RSI is overbought.
 */
export class MeanReversionStrategy extends BaseStrategy {
  readonly type = 'MEAN_REVERSION';
  readonly defaultParams = {
    period: 20,
    mult: 2,
    rsiOversold: 35,
    rsiOverbought: 65,
    stopLossPct: 1.5,
    takeProfitPct: 2.5,
  };

  minCandles(params: Record<string, number>): number {
    return Math.max(params.period ?? 20, 20) + 2;
  }

  evaluate(ctx: StrategyContext): Signal {
    const period = ctx.params.period ?? this.defaultParams.period;
    const mult = ctx.params.mult ?? this.defaultParams.mult;
    const osLevel = ctx.params.rsiOversold ?? this.defaultParams.rsiOversold;
    const obLevel = ctx.params.rsiOverbought ?? this.defaultParams.rsiOverbought;
    const closes = ctx.candles.map((c) => c.close);

    const bb = bollinger(closes, period, mult);
    const r = rsi(closes, 14);
    if (!bb || r == null) return this.hold(ctx.symbol, 'indicators warming up');

    const price = closes[closes.length - 1];
    const bandWidth = (bb.upper - bb.lower) / bb.middle;
    const confidence = Math.min(1, 0.45 + bandWidth * 5);

    if (price < bb.lower && r < osLevel) {
      return this.signal(ctx, 'BUY', price, confidence, `below lower BB, RSI ${r.toFixed(0)}`);
    }
    if (price > bb.upper && r > obLevel) {
      return this.signal(ctx, 'SELL', price, confidence, `above upper BB, RSI ${r.toFixed(0)}`);
    }
    return this.hold(ctx.symbol, 'inside bands');
  }

  private signal(
    ctx: StrategyContext,
    action: 'BUY' | 'SELL',
    price: number,
    confidence: number,
    reason: string,
  ): Signal {
    const sl = (ctx.params.stopLossPct ?? this.defaultParams.stopLossPct) / 100;
    const tp = (ctx.params.takeProfitPct ?? this.defaultParams.takeProfitPct) / 100;
    return {
      action,
      symbol: ctx.symbol,
      confidence: Math.round(confidence * 100) / 100,
      reason,
      stopLoss: action === 'BUY' ? price * (1 - sl) : price * (1 + sl),
      takeProfit: action === 'BUY' ? price * (1 + tp) : price * (1 - tp),
      timestamp: Date.now(),
    };
  }
}

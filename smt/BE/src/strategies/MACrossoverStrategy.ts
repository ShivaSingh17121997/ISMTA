import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { emaSeries } from './indicators';

/**
 * Moving-Average Crossover.
 * BUY  when the fast EMA crosses ABOVE the slow EMA.
 * SELL when the fast EMA crosses BELOW the slow EMA.
 */
export class MACrossoverStrategy extends BaseStrategy {
  readonly type = 'MA_CROSSOVER';
  readonly defaultParams = { fast: 9, slow: 21, stopLossPct: 1.5, takeProfitPct: 3 };

  minCandles(params: Record<string, number>): number {
    return Math.max(params.slow ?? 21, 21) + 2;
  }

  evaluate(ctx: StrategyContext): Signal {
    const fast = ctx.params.fast ?? this.defaultParams.fast;
    const slow = ctx.params.slow ?? this.defaultParams.slow;
    const closes = ctx.candles.map((c) => c.close);
    if (closes.length < slow + 2) return this.hold(ctx.symbol, 'insufficient data');

    const fastE = emaSeries(closes, fast);
    const slowE = emaSeries(closes, slow);
    const i = closes.length - 1;
    const fNow = fastE[i];
    const sNow = slowE[i];
    const fPrev = fastE[i - 1];
    const sPrev = slowE[i - 1];
    if ([fNow, sNow, fPrev, sPrev].some((v) => v == null)) {
      return this.hold(ctx.symbol, 'EMA warming up');
    }

    const price = closes[i];
    const spread = Math.abs(fNow - sNow) / price;
    const confidence = Math.min(1, 0.5 + spread * 40);

    if (fPrev <= sPrev && fNow > sNow) {
      return this.signal(ctx, 'BUY', price, confidence, `${fast}EMA crossed above ${slow}EMA`);
    }
    if (fPrev >= sPrev && fNow < sNow) {
      return this.signal(ctx, 'SELL', price, confidence, `${fast}EMA crossed below ${slow}EMA`);
    }
    return this.hold(ctx.symbol, 'no crossover');
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

import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { macd, roc } from './indicators';

/**
 * Momentum.
 * BUY  when ROC > threshold AND MACD histogram is positive (confirmation).
 * SELL when ROC < -threshold AND MACD histogram is negative.
 */
export class MomentumStrategy extends BaseStrategy {
  readonly type = 'MOMENTUM';
  readonly defaultParams = { rocPeriod: 10, rocThreshold: 2, stopLossPct: 1.5, takeProfitPct: 4 };

  minCandles(params: Record<string, number>): number {
    return Math.max(35, (params.rocPeriod ?? 10) + 2);
  }

  evaluate(ctx: StrategyContext): Signal {
    const period = ctx.params.rocPeriod ?? this.defaultParams.rocPeriod;
    const threshold = ctx.params.rocThreshold ?? this.defaultParams.rocThreshold;
    const closes = ctx.candles.map((c) => c.close);

    const r = roc(closes, period);
    const m = macd(closes);
    if (r == null || m == null) return this.hold(ctx.symbol, 'indicators warming up');

    const price = closes[closes.length - 1];
    const confidence = Math.min(1, 0.4 + Math.abs(r) / 20);

    if (r > threshold && m.histogram > 0) {
      return this.signal(ctx, 'BUY', price, confidence, `ROC ${r.toFixed(2)}% + MACD up`);
    }
    if (r < -threshold && m.histogram < 0) {
      return this.signal(ctx, 'SELL', price, confidence, `ROC ${r.toFixed(2)}% + MACD down`);
    }
    return this.hold(ctx.symbol, `ROC ${r.toFixed(2)}% below threshold`);
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
      stopPct: sl * 100,
      targetPct: tp * 100,
      referencePrice: price,
      timestamp: Date.now(),
    };
  }
}

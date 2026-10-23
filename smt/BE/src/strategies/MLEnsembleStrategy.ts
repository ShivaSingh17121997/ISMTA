import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { bollinger, emaSeries, macd, roc, rsi, supertrend } from './indicators';

/**
 * ML Ensemble (feature-based scoring model).
 *
 * NOTE: This is a transparent, weighted feature ensemble — NOT a trained
 * Random Forest. It engineers the same kind of features a real model would
 * (trend, momentum, mean-reversion, volatility regime) and combines them via
 * a logistic score into a BUY-probability. It exists so the platform has a
 * "market-regime adaptive" strategy slot with the right interface.
 *
 * To upgrade to a real model: keep `evaluate()`'s signature, replace the fixed
 * weights below with a model loaded from disk (e.g. a Random Forest / gradient
 * boosting model trained offline on historical features → forward returns),
 * and retrain monthly (see CHECKLIST Phase 2).
 */
export class MLEnsembleStrategy extends BaseStrategy {
  readonly type = 'ML_ENSEMBLE';
  readonly defaultParams = {
    buyThreshold: 0.6,
    sellThreshold: 0.4,
    stopLossPct: 1.5,
    takeProfitPct: 3,
  };

  // Feature weights (would be learned by a trained model).
  private readonly weights = {
    emaTrend: 1.6,
    rsi: 1.2,
    macd: 1.4,
    roc: 1.0,
    bollinger: -1.1, // mean-reversion: stretched price pulls the score back
    supertrend: 1.3,
  };

  minCandles(): number {
    return 40;
  }

  evaluate(ctx: StrategyContext): Signal {
    const closes = ctx.candles.map((c) => c.close);
    if (closes.length < 40) return this.hold(ctx.symbol, 'warming up');

    const price = closes[closes.length - 1];
    const ema9 = emaSeries(closes, 9);
    const ema21 = emaSeries(closes, 21);
    const m = macd(closes);
    const r = rsi(closes, 14);
    const ro = roc(closes, 10);
    const bb = bollinger(closes, 20, 2);
    const st = supertrend(ctx.candles, 10, 3);
    if (!m || r == null || ro == null || !bb || !st) {
      return this.hold(ctx.symbol, 'features not ready');
    }

    // Engineer normalised features in roughly [-1, 1].
    const f = {
      emaTrend: clamp((ema9[ema9.length - 1] - ema21[ema21.length - 1]) / price / 0.01),
      rsi: clamp((r - 50) / 50),
      macd: clamp(m.histogram / price / 0.005),
      roc: clamp(ro / 5),
      bollinger: clamp((price - bb.middle) / (bb.upper - bb.middle || 1)),
      supertrend: st.trend, // +1 / -1
    };

    const z =
      this.weights.emaTrend * f.emaTrend +
      this.weights.rsi * f.rsi +
      this.weights.macd * f.macd +
      this.weights.roc * f.roc +
      this.weights.bollinger * f.bollinger +
      this.weights.supertrend * f.supertrend;

    const prob = 1 / (1 + Math.exp(-z)); // BUY probability

    const buyAt = ctx.params.buyThreshold ?? this.defaultParams.buyThreshold;
    const sellAt = ctx.params.sellThreshold ?? this.defaultParams.sellThreshold;

    if (prob >= buyAt) {
      return this.makeSignal(ctx, 'BUY', price, prob, `ensemble P(up)=${prob.toFixed(2)}`);
    }
    if (prob <= sellAt) {
      return this.makeSignal(ctx, 'SELL', price, 1 - prob, `ensemble P(up)=${prob.toFixed(2)}`);
    }
    return this.hold(ctx.symbol, `neutral P(up)=${prob.toFixed(2)}`);
  }
}

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

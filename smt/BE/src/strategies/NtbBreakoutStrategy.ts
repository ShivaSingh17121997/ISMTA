import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { adxSeries, donchian, emaSeries, htfTrend } from './indicators';

/**
 * NTB Model A — trend-filtered breakout (spec Phase 2, the NTB default).
 *
 * Break a `lookback`-bar high in an EMA uptrend, but ONLY when ADX says a trend
 * exists. The ADX gate is the piece that suppresses chop-driven stop-loss bleed;
 * without it a naive breakout gets sawn apart sideways.
 *
 * ⚠️ Per the spec's own out-of-sample bake-off this model LOSES MONEY on the
 * data it was developed against (−13.55, 11.5% win rate, 1/5 symbols profitable,
 * 0/10 optimised configs surviving OOS validation). Those results were measured
 * on crypto and do not transfer to NSE either way — treat this as unvalidated on
 * Indian equities until you have run your own out-of-sample test.
 */
export class NtbBreakoutStrategy extends BaseStrategy {
  readonly type = 'NTB_BREAKOUT';

  readonly defaultParams = {
    emaFast: 20,
    emaSlow: 50,
    adxPeriod: 14,
    adxThreshold: 22,
    lookback: 20,
    /** higher-timeframe confirmation; 1 = disabled */
    htfFactor: 1,
    /** fallback SL/TP for exitMode:'static'; ignored under the trailing engine */
    stopLossPct: 1.0,
    takeProfitPct: 0,
  };

  minCandles(params: Record<string, number>): number {
    const slow = params.emaSlow ?? this.defaultParams.emaSlow;
    const adxPeriod = params.adxPeriod ?? this.defaultParams.adxPeriod;
    const lookback = params.lookback ?? this.defaultParams.lookback;
    return Math.max(slow, 2 * adxPeriod, lookback) + 1;
  }

  evaluate(ctx: StrategyContext): Signal {
    const p = { ...this.defaultParams, ...ctx.params };
    const candles = ctx.candles;
    const i = candles.length - 1;
    const close = candles[i].close;

    // 1. Regime gate — a breakout in a range is noise.
    const adxArr = adxSeries(candles, p.adxPeriod);
    const adxNow = adxArr[i];
    if (adxNow == null) return this.hold(ctx.symbol, 'ADX warming up');
    if (adxNow < p.adxThreshold) {
      return this.hold(ctx.symbol, `ranging (ADX ${adxNow.toFixed(1)} < ${p.adxThreshold})`);
    }

    // 2. Breakout window. donchian() slices (-lookback-1, -1) — it EXCLUDES the
    //    current candle, which is required: including it would compare the close
    //    against a high that contains itself, so the signal would rarely fire.
    const ch = donchian(candles, p.lookback);
    if (!ch) return this.hold(ctx.symbol, 'not enough bars for the breakout window');

    const fast = emaSeries(candles.map((c) => c.close), p.emaFast);
    const slow = emaSeries(candles.map((c) => c.close), p.emaSlow);
    const fNow = fast[i];
    const sNow = slow[i];
    if (fNow == null || sNow == null) return this.hold(ctx.symbol, 'EMA warming up');

    let action: 'BUY' | 'SELL';
    let reason: string;
    if (fNow > sNow && close > ch.upper) {
      action = 'BUY';
      reason = `breakout above ${ch.upper.toFixed(2)} in an uptrend (ADX ${adxNow.toFixed(1)})`;
    } else if (fNow < sNow && close < ch.lower) {
      action = 'SELL';
      reason = `breakdown below ${ch.lower.toFixed(2)} in a downtrend (ADX ${adxNow.toFixed(1)})`;
    } else {
      return this.hold(ctx.symbol, 'no breakout');
    }

    // 3. Higher-timeframe veto — never fight the bigger trend.
    if (p.htfFactor > 1) {
      const htf = htfTrend(candles, p.htfFactor, p.emaFast, p.emaSlow);
      if (htf != null && htf !== action) {
        return this.hold(ctx.symbol, `vetoed by the ${p.htfFactor}x higher-timeframe trend`);
      }
    }

    // Confidence scales with trend strength past the gate, saturating at ADX 50.
    const confidence = Math.min(1, (adxNow - p.adxThreshold) / (50 - p.adxThreshold) + 0.5);
    return this.makeSignal(ctx, action, close, confidence, reason);
  }
}

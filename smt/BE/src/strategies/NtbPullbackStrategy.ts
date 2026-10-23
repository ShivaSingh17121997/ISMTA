import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { adxSeries, emaSeries } from './indicators';

/**
 * NTB Model B — buy the dip in a trend (spec Phase 2).
 *
 * In a confirmed trend, wait for the PRIOR close to dip through the fast EMA and
 * the CURRENT close to reclaim it. The intent is to enter *after* the stop-hunt,
 * near the EMA, so the stop sits closer and reward:risk improves.
 *
 * This is an edge-triggered rule by construction — it requires a cross, so it
 * cannot re-fire on consecutive bars while the condition merely stays true.
 *
 * ⚠️ Spec Phase 12: this was the WORST of the three out-of-sample (−15.63, 0/5
 * symbols profitable). It did not beat breakout. The spec suggests it may do
 * better on 1h/4h where trends are cleaner — untested.
 */
export class NtbPullbackStrategy extends BaseStrategy {
  readonly type = 'NTB_PULLBACK';

  readonly defaultParams = {
    emaFast: 20,
    emaSlow: 50,
    adxPeriod: 14,
    adxThreshold: 22,
    stopLossPct: 1.0,
    takeProfitPct: 0,
  };

  minCandles(params: Record<string, number>): number {
    const slow = params.emaSlow ?? this.defaultParams.emaSlow;
    const adxPeriod = params.adxPeriod ?? this.defaultParams.adxPeriod;
    return Math.max(slow, 2 * adxPeriod) + 2; // +2: the rule reads bar i-1
  }

  evaluate(ctx: StrategyContext): Signal {
    const p = { ...this.defaultParams, ...ctx.params };
    const candles = ctx.candles;
    const i = candles.length - 1;

    // No trend → no continuation trade.
    const adxArr = adxSeries(candles, p.adxPeriod);
    const adxNow = adxArr[i];
    if (adxNow == null) return this.hold(ctx.symbol, 'ADX warming up');
    if (adxNow < p.adxThreshold) {
      return this.hold(ctx.symbol, `no trend (ADX ${adxNow.toFixed(1)} < ${p.adxThreshold})`);
    }

    const closes = candles.map((c) => c.close);
    const fast = emaSeries(closes, p.emaFast);
    const slow = emaSeries(closes, p.emaSlow);
    const fNow = fast[i];
    const fPrev = fast[i - 1];
    const sNow = slow[i];
    if (fNow == null || fPrev == null || sNow == null) {
      return this.hold(ctx.symbol, 'EMA warming up');
    }

    const close = closes[i];
    const prevClose = closes[i - 1];
    const confidence = Math.min(1, (adxNow - p.adxThreshold) / (50 - p.adxThreshold) + 0.5);

    // Long: uptrend, prior close dipped below the fast EMA, current close reclaims it.
    if (fNow > sNow && prevClose < fPrev && close > fNow) {
      return this.makeSignal(
        ctx,
        'BUY',
        close,
        confidence,
        `pullback reclaimed the ${p.emaFast}-EMA in an uptrend (ADX ${adxNow.toFixed(1)})`,
      );
    }

    // Short: mirror.
    if (fNow < sNow && prevClose > fPrev && close < fNow) {
      return this.makeSignal(
        ctx,
        'SELL',
        close,
        confidence,
        `rally rejected at the ${p.emaFast}-EMA in a downtrend (ADX ${adxNow.toFixed(1)})`,
      );
    }

    return this.hold(ctx.symbol, 'no pullback');
  }
}

import { Signal } from '../types';
import { BaseStrategy, StrategyContext } from './BaseStrategy';
import { adxSeries, rsi } from './indicators';

/**
 * NTB Model C — fade RSI extremes in a range (spec Phase 2).
 *
 * The COMPLEMENT to models A and B: it wants exactly the regime where they bleed.
 * Note the gate direction is INVERTED — `adx >= adxMax` rejects. Mean-reversion
 * wants a quiet market; the others want a trending one. Getting this backwards
 * makes the model fade live trends, which is how you lose money quickly.
 *
 * Entry is a CROSS back out of the extreme (prior bar oversold, current bar
 * recovered), not merely "RSI is low" — so it fires on exhaustion, not on the
 * way down.
 *
 * Spec Phase 12: the only one of the three with a positive out-of-sample signal
 * (+4.27, 40% win rate, 3/6 symbols) — but that is ~0.4% over 20 trades on
 * crypto, which the spec itself calls thin and NOT a proven edge. It does not
 * transfer to NSE. Forward paper-test before risking capital.
 *
 * NTB hard-codes the thresholds; they are plumbed through as params here so
 * `optimize()` can sweep them. Defaults are kept STRICT because the spec's sweep
 * showed results degrade monotonically as the gate widens (+4.27 → −11.24 →
 * −23.11 → −43.09). Loosen them at your own risk.
 */
export class NtbMeanRevStrategy extends BaseStrategy {
  readonly type = 'NTB_MEANREV';

  readonly defaultParams = {
    rsiPeriod: 14,
    oversold: 30,
    overbought: 70,
    adxPeriod: 14,
    /** INVERTED gate: reject when ADX is at or above this (a trend — don't fade it) */
    adxMax: 30,
    stopLossPct: 1.0,
    takeProfitPct: 0,
  };

  minCandles(params: Record<string, number>): number {
    const rsiPeriod = params.rsiPeriod ?? this.defaultParams.rsiPeriod;
    const adxPeriod = params.adxPeriod ?? this.defaultParams.adxPeriod;
    return Math.max(rsiPeriod, 2 * adxPeriod) + 2; // +2: the rule reads bar i-1
  }

  evaluate(ctx: StrategyContext): Signal {
    const p = { ...this.defaultParams, ...ctx.params };
    const candles = ctx.candles;
    const i = candles.length - 1;

    // INVERTED gate — trending market means stand aside.
    const adxArr = adxSeries(candles, p.adxPeriod);
    const adxNow = adxArr[i];
    if (adxNow == null) return this.hold(ctx.symbol, 'ADX warming up');
    if (adxNow >= p.adxMax) {
      return this.hold(ctx.symbol, `trending (ADX ${adxNow.toFixed(1)} >= ${p.adxMax}) — don't fade`);
    }

    const closes = candles.map((c) => c.close);
    // Wilder's RSI is path-dependent, so the prior bar's value is the RSI of the
    // history up to that bar — not a re-seeded window.
    const rsiNow = rsi(closes, p.rsiPeriod);
    const rsiPrev = rsi(closes.slice(0, -1), p.rsiPeriod);
    if (rsiNow == null || rsiPrev == null) return this.hold(ctx.symbol, 'RSI warming up');

    // Cross UP out of oversold → exhaustion of the sell-off.
    if (rsiPrev <= p.oversold && rsiNow > p.oversold) {
      const confidence = Math.min(1, 0.5 + (p.oversold - rsiPrev) / 60);
      return this.makeSignal(
        ctx,
        'BUY',
        closes[i],
        confidence,
        `RSI crossed up out of oversold (${rsiPrev.toFixed(1)} → ${rsiNow.toFixed(1)}) in a range`,
      );
    }

    // Cross DOWN out of overbought.
    if (rsiPrev >= p.overbought && rsiNow < p.overbought) {
      const confidence = Math.min(1, 0.5 + (rsiPrev - p.overbought) / 60);
      return this.makeSignal(
        ctx,
        'SELL',
        closes[i],
        confidence,
        `RSI crossed down out of overbought (${rsiPrev.toFixed(1)} → ${rsiNow.toFixed(1)}) in a range`,
      );
    }

    return this.hold(ctx.symbol, 'no RSI reversal');
  }
}

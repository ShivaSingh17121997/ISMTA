/**
 * Backtest honesty statistics. Pure.
 *
 * A Sharpe ratio is a random variable, and the more configurations you try
 * the larger the best one gets by luck alone. Bailey & López de Prado give
 * two closed-form corrections that need only what a run ledger records:
 *
 *  - The EXPECTED MAXIMUM Sharpe among N independent trials with per-trial
 *    variance V is  sqrt(V) · ((1−γ)·Z(1−1/N) + γ·Z(1−1/(N·e)))  with γ the
 *    Euler–Mascheroni constant. Anything below that is what noise produces.
 *  - The DEFLATED Sharpe ratio is the probability that the observed Sharpe
 *    exceeds that benchmark once sample length, skew and kurtosis are
 *    accounted for:  Φ( (SR − SR*) · sqrt(T − 1) / sqrt(1 − γ₃·SR + (γ₄−1)/4 · SR²) ).
 *
 * Both use the PER-PERIOD Sharpe (not annualised) of the trade P&L series.
 * With MinBTL: five years of daily data tolerate about 45 trials before an
 * in-sample Sharpe of 1 is expected by chance; two years, about 7.
 */

export const EULER_GAMMA = 0.5772156649015329;

/** Sample mean, standard deviation, skew and excess-free (raw) kurtosis. */
export function moments(xs: number[]): { mean: number; sd: number; skew: number; kurtosis: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, skew: 0, kurtosis: 3, n: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sd = Math.sqrt(m2);
  const skew = sd > 0 ? m3 / sd ** 3 : 0;
  const kurtosis = sd > 0 ? m4 / sd ** 4 : 3;
  return { mean, sd, skew, kurtosis, n };
}

/** Per-period Sharpe of a return/P&L series (risk-free 0). */
export function periodSharpe(xs: number[]): number {
  const { mean, sd } = moments(xs);
  return sd > 0 ? mean / sd : 0;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Inverse standard normal CDF (Acklam's algorithm, relative error ~1e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  let q: number;
  let r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Expected maximum Sharpe among `trials` independent tries whose Sharpes have
 * variance `varianceOfTrialSharpes`. The bar an observed Sharpe must clear.
 */
export function expectedMaxSharpe(trials: number, varianceOfTrialSharpes: number): number {
  if (trials < 2 || !(varianceOfTrialSharpes > 0)) return 0;
  const sd = Math.sqrt(varianceOfTrialSharpes);
  return sd * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
}

export interface DeflatedSharpeInput {
  /** observed per-period Sharpe of THIS run */
  sharpe: number;
  /** number of periods (trades or bars) behind that Sharpe */
  periods: number;
  skew: number;
  kurtosis: number;
  /** how many configurations were tried for this strategy/symbol, this one included */
  trials: number;
  /** variance of the per-period Sharpe across those trials */
  varianceOfTrialSharpes: number;
}

export interface DeflatedSharpeResult {
  /** probability (0..1) the true Sharpe is above zero given the trials; ≥ 0.95 is the usual bar */
  probability: number;
  /** the benchmark Sharpe that N trials would produce by chance */
  benchmarkSharpe: number;
  trials: number;
  note: string;
}

export function deflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const { sharpe, periods, skew, kurtosis } = input;
  const trials = Math.max(1, Math.floor(input.trials));
  const benchmark = expectedMaxSharpe(trials, input.varianceOfTrialSharpes);
  if (periods < 3) {
    return { probability: 0, benchmarkSharpe: benchmark, trials, note: 'too few periods to say anything' };
  }
  const denom = Math.sqrt(Math.max(1e-9, 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe));
  const z = ((sharpe - benchmark) * Math.sqrt(periods - 1)) / denom;
  const probability = normCdf(z);
  const note =
    trials === 1
      ? 'first configuration tried for this strategy and symbol — the benchmark is zero, so this is the plain significance of the Sharpe'
      : probability >= 0.95
        ? `clears the ${trials}-trial benchmark of ${benchmark.toFixed(2)}`
        : `does not clear the ${trials}-trial benchmark of ${benchmark.toFixed(2)}; a Sharpe this size is what ${trials} tries produce by chance`;
  return { probability: Math.round(probability * 1000) / 1000, benchmarkSharpe: Math.round(benchmark * 1000) / 1000, trials, note };
}

/**
 * Minimum backtest length (periods) for an in-sample Sharpe `sharpe` to be
 * distinguishable from the luck of `trials` tries (Bailey et al. MinBTL).
 */
export function minBacktestLength(trials: number, sharpe: number): number {
  if (trials < 2 || !(sharpe > 0)) return 0;
  const emax = (1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E));
  return Math.ceil((emax / sharpe) ** 2);
}

/** Population variance of a list. */
export function variance(xs: number[]): number {
  const { sd } = moments(xs);
  return sd * sd;
}

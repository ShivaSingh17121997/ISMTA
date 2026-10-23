/**
 * Cross-sectional scoring: which stocks look best, at which horizon. Pure.
 *
 * WHY PERCENTILE RANKS AND NOT THRESHOLDS
 *
 * Every signal here is converted to its rank among the stocks measured on the
 * same day, then combined. A raw threshold ("12% in three months is good") is
 * really a bet on the market, not the stock: in a roaring quarter it flags
 * everything, in a flat one it flags nothing. Ranking removes the market from
 * the comparison and leaves the relative question, which is the one a chooser
 * actually faces.
 *
 * It also makes the weights meaningful. Percentile ranks all live on 0..1, so a
 * weight of 0.4 really is twice the influence of 0.2 — which is not true of a
 * weighted sum over raw numbers where one input is a percentage return and
 * another is an ADX reading.
 *
 * WHAT DRIVES EACH HORIZON, AND WHY
 *
 * long    12-month momentum skipping the last month, plus how close price sits
 *         to its 52-week high, plus a trend filter. This is the best-evidenced
 *         combination in the equity literature (Jegadeesh–Titman momentum;
 *         George–Hwang's 52-week-high effect, which forecasts without the
 *         long-run reversal plain momentum suffers).
 *
 * medium  the same momentum pair with trend structure (EMA20 over EMA50)
 *         carrying more weight, because at this horizon whether a trend is
 *         actually established matters more than how far it has already run.
 *
 * short   deliberately NOT an oversold-bounce scorer. The instinct is to buy
 *         what has fallen, but the evidence for short-horizon reversal sits in
 *         ILLIQUID names, and India-specific work finds that among liquid
 *         stocks the short-horizon effect is continuation, not reversal. So
 *         the short horizon here rewards strength that is continuing, and
 *         penalises the genuinely overbought — buying a pullback inside an
 *         uptrend, not catching a falling knife.
 *
 * A hard filter sits above all of it: nothing below its 200-day average is
 * recommended at any horizon. That is not a scoring input, it is a veto.
 */

import type { Metrics } from './metrics';
import type { Horizon } from './plan';

export interface ScoreWeights {
  [signal: string]: number;
}

/**
 * Weights per horizon. They sum to 1 within each horizon so the composite is
 * itself a 0..1 number before being shown as 0..100.
 *
 * These are judgement, informed by which effects have evidence at which
 * horizon. They are not fitted to this data — fitting weights on the same
 * sample you then report is how a backtest becomes a sales document.
 *
 * REVISED 2026-09-09, BY SUBTRACTION. Three signals were carrying weight
 * without evidence behind them, and were diluting five that have it:
 *
 *   ADX          removed. No credible cross-sectional evidence that trend
 *                STRENGTH predicts returns — it is a confirmation tool that
 *                stays elevated after a trend has already turned. It was also
 *                largely collinear with the EMA/200-day terms beside it.
 *
 *   3-month      removed. Jegadeesh–Titman's result is for 6-, 9- and
 *   momentum     12-month ranking windows; three months is the weakest and
 *                sits closest to short-term reversal, so it imports the noise
 *                the skip-month is there to avoid. Work on Indian F&O-eligible
 *                large caps — this universe — found 6-month optimal and
 *                "accelerated" momentum worse. Both NSE's own Nifty200
 *                Momentum 30 and MSCI use only 6- and 12-month, risk-adjusted,
 *                which is now the only momentum this scores.
 *
 *   volume ratio cut to a token 0.05 rather than removed, because the evidence
 *                points BOTH ways and neither direction is strong: the
 *                high-volume premium is weak in India, while the opposing
 *                turnover anomaly failed replication outright. It stays only
 *                so its sign can be tested later rather than assumed.
 *
 * The freed weight went to 52-week-range position, which is the most
 * underrated signal here — George–Hwang found it can subsume conventional
 * momentum, and it shows positive information coefficients in every region
 * tested. Honest caveat: in emerging-market LARGE caps specifically, which is
 * where this universe sits, that dominance is NOT statistically significant.
 * Hence a moderate upweight rather than making it the primary signal.
 *
 * WHY THE TWO WINDOWS ARE TILTED RATHER THAN SPLIT 50/50. A single momentum
 * index weights 6- and 12-month equally, and the first version of this revision
 * copied that at every horizon. That was wrong here, and the live run showed it
 * immediately: long and medium became near-identical scorers, picked the SAME
 * five stocks, and the medium bucket deduped to nothing — leaving its whole
 * budget unspent and the best-evidenced horizon on the page decorative.
 *
 * Three horizons need three questions. Long leans on the 12-month window and
 * how far the trend has already carried; medium leans on the 6-month window and
 * on whether the trend is established RIGHT NOW (trend structure, its heaviest
 * non-momentum term). Both windows appear at both horizons — that part of the
 * evidence holds — but the tilt is what keeps the horizons distinct.
 */
export const WEIGHTS: Record<Horizon, ScoreWeights> = {
  long: {
    momRiskAdj12_1: 0.3,
    momRiskAdj6_1: 0.15,
    pctOf52wRange: 0.25,
    trendSpreadPct: 0.2,
    smoothClimb: 0.1,
  },
  medium: {
    momRiskAdj6_1: 0.3,
    momRiskAdj12_1: 0.15,
    pctOf52wRange: 0.2,
    trendStructure: 0.25,
    smoothClimb: 0.1,
  },
  short: {
    momRiskAdj6_1: 0.25,
    trendStructure: 0.25,
    ret1w: 0.25,
    notOverbought: 0.2,
    volumeRatio: 0.05,
  },
};

/**
 * How much to trust each horizon, stated because the evidence is not equal and
 * a page that presents three lists side by side implies it is.
 *
 * The India-specific work inverts the intuitive ordering: momentum is strongest
 * at one to six months and weakens as the holding period lengthens, so MEDIUM
 * is the best-evidenced bucket here, not long. Short is the weakest by some
 * distance — it leans on continuation over days, which is far less established
 * than the momentum effect underneath the other two.
 */
export const EVIDENCE: Record<Horizon, { grade: 'A' | 'B' | 'C'; note: string }> = {
  long: {
    grade: 'B',
    note:
      'Momentum and the 52-week-high effect are well evidenced, including in India, but ' +
      'momentum weakens as the holding period lengthens and suffers severe crashes at trend ' +
      'reversals.',
  },
  medium: {
    grade: 'A',
    note:
      'The best-evidenced bucket. Indian studies find volatility-adjusted momentum strongest ' +
      'at one to six months, and strongest among the most liquid names — which is where this ' +
      'universe sits.',
  },
  short: {
    grade: 'C',
    note:
      'Weakest evidence, treat as experimental. Short-horizon reversal is deliberately NOT ' +
      'used: Indian evidence puts those profits in illiquid stocks a retail account cannot ' +
      'trade. This bucket rewards continuation instead, which is thinner ground, and trading ' +
      'costs bite hardest at this frequency.',
  },
};

export interface SignalContribution {
  name: string;
  label: string;
  /** The raw measurement, in its own units. */
  raw: number;
  /** Its percentile among today's universe, 0..1. */
  percentile: number;
  /**
   * True when this percentile ranks the stock against its SECTOR first rather
   * than against the raw cross-section. Reported so the screen can say so —
   * "88th within Capital Goods" means something different from "88th overall".
   */
  sectorRelative: boolean;
  weight: number;
  /** percentile × weight — how much of the final score this signal supplied. */
  contribution: number;
}

export type Verdict = 'strong' | 'good' | 'watch' | 'weak';

export interface HorizonScore {
  symbol: string;
  horizon: Horizon;
  /** 0..100. A RANK against today's universe, not a probability of anything. */
  score: number;
  verdict: Verdict;
  signals: SignalContribution[];
  /** Set when the stock is vetoed outright; score is 0 and it is never ranked. */
  vetoed: boolean;
  vetoReason?: string;
}

/** How a raw metric is read for a given horizon. */
interface SignalDef {
  label: string;
  get: (m: Metrics) => number;
  /** False when a LOWER raw value is better. */
  higherIsBetter?: boolean;
  /**
   * Rank this signal WITHIN the stock's sector before ranking it globally.
   * Set on the momentum family only — see `sectorRelative` below.
   */
  sectorRelative?: boolean;
}

const SIGNALS: Record<string, SignalDef> = {
  // Momentum, all volatility-adjusted. Raw momentum rewards a stock for being
  // violent; dividing by volatility asks how much of the move was signal.
  momRiskAdj12_1: {
    label: '12-month momentum per unit of risk',
    get: (m) => m.momRiskAdj12_1,
    sectorRelative: true,
  },
  momRiskAdj6_1: {
    label: '6-month momentum per unit of risk',
    get: (m) => m.momRiskAdj6_1,
    sectorRelative: true,
  },
  momRiskAdj3_1: {
    label: '3-month momentum per unit of risk',
    get: (m) => m.momRiskAdj3_1,
    sectorRelative: true,
  },
  ret1w: { label: 'Last week', get: (m) => m.ret1w, sectorRelative: true },
  pctOf52wRange: { label: 'Position in the 52-week range', get: (m) => m.pctOf52wRange },
  trendSpreadPct: {
    // Sector-relative for the same reason momentum is: (EMA50 − SMA200)/SMA200
    // is a return measure wearing a different name, so it carries the sector's
    // common move just as directly. Note what is deliberately NOT in this
    // family — `pctOf52wRange` is a bounded position inside the stock's OWN
    // range, already self-normalised, so standardising it again by sector would
    // be measuring the same thing twice.
    label: 'Trend maturity (EMA50 vs 200-day)',
    get: (m) => m.trendSpreadPct,
    sectorRelative: true,
  },
  adx14: { label: 'Trend strength (ADX)', get: (m) => m.adx14 ?? 0 },
  volumeRatio: { label: 'Volume against its 50-day average', get: (m) => m.volumeRatio },
  // Lower is better for these.
  smoothClimb: {
    // Information discreteness. A gain that arrived over many small up days
    // persists; the same gain from three violent days tends to reverse.
    label: 'Climbed smoothly rather than in jumps',
    get: (m) => m.infoDiscreteness,
    higherIsBetter: false,
  },
  shallowDrawdown: { label: 'Worst fall in the last year', get: (m) => m.maxDrawdown1yPct, higherIsBetter: false },
  notOverbought: {
    // Distance of RSI from 50 on the high side only. An RSI of 80 is a poor
    // moment to start a short-term position even in a strong stock.
    label: 'Room before overbought (RSI)',
    get: (m) => Math.max(0, (m.rsi14 ?? 50) - 50),
    higherIsBetter: false,
  },
  trendStructure: {
    // A composite of the two boolean trend facts, so structure counts without
    // needing two near-duplicate weights.
    label: 'Trend structure (above 200-day, EMA20 over EMA50)',
    get: (m) => (m.aboveSma200 ? 1 : 0) + (m.ema20Above50 ? 1 : 0),
  },
};

/**
 * Percentile of each value within the array, 0..1, ties averaged.
 * A single-element universe scores 0.5 — neither good nor bad, since there is
 * nothing to compare it to.
 */
function percentiles(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1].v === idx[i].v) j++;
    // Average rank across the tie, mapped to 0..1.
    const rank = (i + j) / 2;
    for (let k = i; k <= j; k++) out[idx[k].i] = rank / (n - 1);
    i = j + 1;
  }
  return out;
}

/**
 * Minimum names in a sector before a within-sector z-score means anything.
 * Below this, one outlier defines the mean and the "sector-relative" number is
 * just that outlier's noise wearing a sector label.
 */
export const MIN_SECTOR_MEMBERS = 4;

/**
 * Sector-relative standardisation: each value expressed as standard deviations
 * from ITS OWN SECTOR's mean, falling back to the whole-universe mean when the
 * sector is too small to characterise.
 *
 * WHY THIS EXISTS. Ranking momentum across the whole market ranks sectors, not
 * stocks. When pharma runs, every pharma name scores well and the list fills
 * with one bet — which is a sector call dressed up as five stock picks. Scoring
 * a stock against its own sector asks the better question: is this the strong
 * one in its group, or merely a passenger in a strong group.
 *
 * This is a cheap approximation of residual momentum, which strips the factor
 * component out with a regression and earns roughly twice the risk-adjusted
 * profit of total-return momentum. A sector z-score is not a regression, but it
 * removes the largest and most obvious common component for the cost of a
 * groupby, and it uses the exchange's own classification rather than a guess.
 *
 * The fallback matters: values are returned as z-scores either way, so a stock
 * standardised against the universe and one standardised against its sector
 * remain comparable numbers. Mixing z-scores with raw values would not be.
 */
export function sectorRelativeValues(
  values: number[],
  sectors: string[],
  minMembers = MIN_SECTOR_MEMBERS,
): number[] {
  const stats = (xs: number[]): { mean: number; sd: number } => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return { mean, sd: Math.sqrt(varc) };
  };

  const global = stats(values);
  const bySector = new Map<string, number[]>();
  sectors.forEach((sec, i) => {
    const list = bySector.get(sec) ?? [];
    list.push(values[i]);
    bySector.set(sec, list);
  });
  const sectorStats = new Map<string, { mean: number; sd: number }>();
  for (const [sec, xs] of bySector) {
    if (xs.length >= minMembers) sectorStats.set(sec, stats(xs));
  }

  return values.map((v, i) => {
    const st = sectorStats.get(sectors[i]) ?? global;
    // A zero spread means every member is identical: nothing to distinguish,
    // so everyone sits at the mean rather than dividing by zero.
    return st.sd > 0 ? (v - st.mean) / st.sd : 0;
  });
}

export interface EligibilityParams {
  /** Median daily turnover a stock must clear to be recommendable, rupees. */
  minTurnover: number;
  /** Penny stocks behave differently and cost more to trade in percentage terms. */
  minPrice: number;
}

export const DEFAULT_ELIGIBILITY: EligibilityParams = {
  minTurnover: 2_00_00_000, // ₹2 crore a day
  minPrice: 20,
};

/** Why a stock cannot be recommended at all, or null when it can. */
export function vetoReason(m: Metrics, e: EligibilityParams = DEFAULT_ELIGIBILITY): string | null {
  if (m.lastClose < e.minPrice) {
    return `trades at ₹${m.lastClose.toFixed(2)}, below the ₹${e.minPrice} floor`;
  }
  if (m.medianTurnover < e.minTurnover) {
    return `median daily turnover of ₹${(m.medianTurnover / 1e7).toFixed(2)} crore is below the ₹${(e.minTurnover / 1e7).toFixed(0)} crore floor — too thin to enter and exit cleanly`;
  }
  if (!m.aboveSma200) {
    return `below its 200-day average — a downtrend is not recommended at any horizon, whatever else it scores`;
  }
  return null;
}

const verdictFor = (score: number): Verdict =>
  score >= 75 ? 'strong' : score >= 60 ? 'good' : score >= 45 ? 'watch' : 'weak';

/**
 * Score every eligible stock at one horizon.
 *
 * Percentiles are computed across the ELIGIBLE set only, so a vetoed stock
 * cannot drag the ranks of the others. Vetoed stocks are returned too, scored
 * zero and carrying their reason, because "why is this not recommended" is a
 * question worth answering on screen.
 */
export function scoreHorizon(
  all: Metrics[],
  horizon: Horizon,
  eligibility: EligibilityParams = DEFAULT_ELIGIBILITY,
  /**
   * Symbol → NSE sector. Optional: with no map, every stock lands in one
   * bucket, the sector step is a no-op, and scoring behaves exactly as it did
   * before sectors existed. That keeps this function usable — and testable —
   * without a network fetch.
   */
  sectors?: Map<string, string>,
): HorizonScore[] {
  const vetoes = new Map<string, string>();
  const eligible: Metrics[] = [];
  for (const m of all) {
    const reason = vetoReason(m, eligibility);
    if (reason) vetoes.set(m.symbol, reason);
    else eligible.push(m);
  }

  const weights = WEIGHTS[horizon];
  const names = Object.keys(weights);

  // A stock with no known sector gets a bucket of its own, which is always
  // below the member minimum and so falls through to whole-universe
  // standardisation. Lumping the unclassified together would standardise a
  // shipping company against a fintech and call the result sector-relative.
  const GLOBAL = '__universe__';
  const sectorOf = eligible.map((m) => sectors?.get(m.symbol) ?? `${GLOBAL}:${m.symbol}`);

  // One percentile pass per signal across the eligible universe. Momentum
  // signals are standardised within sector FIRST, so what gets ranked globally
  // is "strong for its sector" rather than "in a strong sector".
  const pct: Record<string, number[]> = {};
  for (const name of names) {
    const def = SIGNALS[name];
    const raw = eligible.map((m) => def.get(m));
    const prepared = def.sectorRelative ? sectorRelativeValues(raw, sectorOf) : raw;
    const p = percentiles(prepared);
    pct[name] = def.higherIsBetter === false ? p.map((x) => 1 - x) : p;
  }

  const scored: HorizonScore[] = eligible.map((m, i) => {
    const signals: SignalContribution[] = names.map((name) => {
      const def = SIGNALS[name];
      const percentile = pct[name][i];
      const weight = weights[name];
      return {
        name,
        label: def.label,
        // Always the raw measurement in its own units. The sector step changes
        // how it is RANKED, never what is reported as measured.
        raw: def.get(m),
        percentile,
        sectorRelative: def.sectorRelative === true && !sectorOf[i].startsWith(GLOBAL),
        weight,
        contribution: percentile * weight,
      };
    });
    const score = signals.reduce((s, x) => s + x.contribution, 0) * 100;
    return {
      symbol: m.symbol,
      horizon,
      score,
      verdict: verdictFor(score),
      signals: signals.sort((a, b) => b.contribution - a.contribution),
      vetoed: false,
    };
  });

  for (const [symbol, reason] of vetoes) {
    scored.push({
      symbol,
      horizon,
      score: 0,
      verdict: 'weak',
      signals: [],
      vetoed: true,
      vetoReason: reason,
    });
  }

  return scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

/**
 * Turbulence: how rough the hold is about to be. Pure.
 *
 * This is the warning layer, and the first thing to say about it is what it
 * REFUSES to do. It never says "do not buy". It never predicts a direction. It
 * never produces a date.
 *
 * WHY, BECAUSE THE OBVIOUS VERSION LOSES MONEY
 *
 * The intuitive feature — "this stock is at its high, it will fall, stay out" —
 * was measured before this module was written, over 89 of the names in
 * `universe.ts`, ten years of daily bars, ~189,000 observations, with every
 * return taken as EXCESS OVER NIFTY so that market drift could not flatter it.
 * The result was the opposite of the intuition:
 *
 *      at the 52-week high   +3.45% excess over the next 63 days
 *      RSI(14) above 80      +5.57%
 *      up >50% in 20 days   +11.76%
 *      the average stock     +2.05%
 *
 * Every "overbought" condition BEAT the market by more than an average stock
 * did. Simulating the rule confirmed it: waiting for a 1×ATR dip and buying
 * anyway was a wash (+5.94% → +5.77%), and waiting-or-skipping when no dip
 * arrived cut the return roughly in half (+6.92% → +3.53%), because the names
 * that never dip are exactly the ones that run away. A gate here would
 * systematically sell the best stocks in the universe.
 *
 * WHAT IS ACTUALLY TRUE, AND IS WHAT THIS MODULE REPORTS
 *
 * Extension tells you nothing useful about the DESTINATION. It tells you a
 * great deal about the PATH — how deep the drawdown on the way is, how soon it
 * arrives, and how fat the left tail is. Those are real, and they are what a
 * position-sizer needs.
 *
 * VOLATILITY IS THE DRIVER, NOT THE RUN-UP
 *
 * The 1-D table made recent run-up look like the cause. Controlling for ATR%
 * showed it is mostly a proxy — stocks that jump 30% in a month ARE high-ATR
 * stocks. Tail risk across a run-up × volatility grid:
 *
 *                       ATR<3     ATR 3-5    ATR>=5
 *       run-up <20%      2.4%       6.0%      12.1%
 *       run-up >=30%      n/a       5.5%      18.2%
 *
 * The column dominates; the row only bites inside the already-volatile names.
 * So the buckets below are indexed on ATR%, with a run-up escalation applied on
 * top rather than a dimension of its own.
 *
 * AND ATR IS THE ONLY UNIT THAT SURVIVES
 *
 * Splitting each stock's decade in half and correlating the halves, per symbol
 * (n=89): ATR% persists at 0.808. Down-leg DURATION manages 0.342, max drawdown
 * 0.236, and down-leg DEPTH comes in at −0.141 — negative, i.e. noise. A stock's
 * "typical fall depth" has no predictive content whatsoever, so this module will
 * not quote one. Everything it forecasts is denominated in ATR, which is the one
 * thing that holds still, and which is already the unit `plan.ts` sizes in.
 *
 * Confirming that choice from the other direction: the median 21-day drawdown
 * sits at 1.75×ATR across the whole sample and barely moves across run-up
 * buckets (1.75 / 1.75 / 1.69 / 1.62 / 1.45). The percentage dip varies a lot —
 * 4.7% to 8.6% — but that variation is ENTIRELY volatility, which is the point.
 *
 * HONEST LIMITS, because the numbers below look more precise than they are.
 * The universe is today's large caps, so nothing that went to zero is in it and
 * the tail figures are if anything understated. Observations overlap heavily
 * (daily samples, 63-day forward windows), so the effective sample is nearer
 * 3,000 independent blocks than 189,000 — no significance is claimed, and the
 * robustness evidence is instead that the ordering held in four separate
 * sub-periods and with COVID removed. One market, one decade, one real crash.
 *
 * Calibrated 2026-09-16. See WARNING_ENGINE.md at the repo root for the study.
 */

import type { Metrics } from './metrics';

// ─── the measured base rates ─────────────────────────────────────────────────

/**
 * One calibration bucket, keyed on ATR as a percent of price.
 *
 * Every field is a MEASURED median or frequency over the observations in that
 * bucket, not a parameter anyone chose. `n` is carried so the UI can show what
 * each claim rests on, and so a thin bucket is visibly thin.
 */
export interface TurbulenceBucket {
  /** Lower bound of ATR% for this bucket, inclusive. */
  minAtrPct: number;
  label: string;
  n: number;
  /** Median deepest drawdown over the next 21 sessions, in ATR. */
  dipAtr: number;
  /** Share of observations that saw a 5% fall within 63 sessions, 0..1. */
  prob5: number;
  /** Median sessions until that 5% fall, among those that saw one. */
  days5: number;
  prob10: number;
  days10: number;
  /** Share whose 63-day return trailed NIFTY by more than 20 points, 0..1. */
  tailRisk: number;
  /** Mean 63-day excess return over NIFTY, percent. Positive in every bucket. */
  meanExcess63: number;
}

/**
 * The whole-sample base rate. Every warning is stated against this, because a
 * number without its baseline is not information: a 66% chance of a 5% dip
 * sounds alarming until you learn that is simply what an ordinary stock does.
 */
export const BASELINE: TurbulenceBucket = {
  minAtrPct: 0,
  label: 'all stocks',
  n: 189_622,
  dipAtr: 1.75,
  prob5: 0.659,
  days5: 11,
  prob10: 0.391,
  days10: 22,
  tailRisk: 0.0398,
  meanExcess63: 2.05,
};

/**
 * Buckets, highest ATR first so a linear scan finds the right one.
 *
 * The 5–7 and 7+ buckets were MERGED deliberately. Measured separately, tail
 * risk ran 14.2% then 10.4% — non-monotonic, almost certainly because the most
 * extreme ATR readings cluster in the COVID recovery when everything bounced.
 * Splitting them would be fitting that one episode; merged, the bucket is
 * monotonic against the one below it and rests on 8,848 observations.
 */
export const BUCKETS: readonly TurbulenceBucket[] = [
  {
    minAtrPct: 5,
    label: 'very volatile',
    n: 8_848,
    dipAtr: 1.18,
    prob5: 0.721, days5: 3,
    prob10: 0.501, days10: 8,
    tailRisk: 0.1301,
    meanExcess63: 6.2,
  },
  {
    minAtrPct: 3,
    label: 'volatile',
    n: 59_530,
    dipAtr: 1.58,
    prob5: 0.704, days5: 8,
    prob10: 0.442, days10: 19,
    tailRisk: 0.0593,
    meanExcess63: 2.94,
  },
  {
    minAtrPct: 2,
    label: 'ordinary',
    n: 89_658,
    dipAtr: 1.89,
    prob5: 0.659, days5: 12,
    prob10: 0.385, days10: 24,
    tailRisk: 0.0269,
    meanExcess63: 1.31,
  },
  {
    minAtrPct: 0,
    label: 'calm',
    n: 31_586,
    dipAtr: 1.92,
    prob5: 0.556, days5: 17,
    prob10: 0.278, days10: 32,
    tailRisk: 0.0145,
    meanExcess63: 1.3,
  },
];

/**
 * A month this strong escalates the bucket. 20% is where the measured effect
 * appears, not a round number picked for looking tidy.
 */
export const HOT_RUNUP_PCT = 20;

/**
 * What a hot month does ON TOP of the volatility bucket, measured within
 * high-ATR names (tail 12.23% → 17.63%) and within the rest (3.50% → 4.88%).
 * Both land near 1.4×, so one multiplier covers both rather than two fitted
 * numbers covering one case each.
 *
 * Note what does NOT change: mean excess return over the next 63 days stayed
 * positive in both (+1.73% → +5.87% in the low-ATR case). A hot month buys you
 * more tail and more upside together, which is an argument for sizing down, and
 * never an argument for standing aside.
 */
export const HOT_RUNUP_TAIL_MULTIPLE = 1.4;
/** A hot month also pulls the dip forward. Measured 11d → 7d and 3d → 4d. */
export const HOT_RUNUP_DAYS_MULTIPLE = 0.7;

/** The ATR% above which a name is flagged volatile on its own account. */
export const HIGH_ATR_PCT = 5;

// ─── outputs ─────────────────────────────────────────────────────────────────

export type WarningKind =
  | 'high-volatility'
  | 'run-up-extended'
  | 'dip-imminent'
  | 'thin-liquidity'
  | 'deep-drawdown-history';

/**
 * Severity, and note the ceiling: there is no level above 'serious', and no
 * level means "do not buy". The scale describes how much the position should be
 * sized DOWN, never whether it should exist.
 */
export type Severity = 'note' | 'caution' | 'serious';

export interface Warning {
  kind: WarningKind;
  severity: Severity;
  headline: string;
  detail: string;
  /** The base rate this rests on, so the screen can show its own evidence. */
  evidence: { condition: string; n: number; stat: string; baseline: string };
}

export interface PathForecast {
  /** The volatility bucket this stock landed in. */
  bucket: string;
  bucketN: number;
  /** Median 21-day drawdown, in ATR and converted to this stock's own terms. */
  expectedDipAtr: number;
  expectedDipPct: number;
  /** …and in rupees off the entry price, which is what actually gets felt. */
  expectedDipFrom: number;
  /** P(a 5% fall within 63 sessions), 0..1, and the median sessions to it. */
  dipProbability: number;
  dipMedianDays: number;
  /** The same for a 10% fall. */
  deepDipProbability: number;
  deepDipMedianDays: number;
  /** P(63-day return trailing NIFTY by >20 points), and that over baseline. */
  tailRisk: number;
  tailRiskMultiple: number;
  /** Mean 63-day excess return for this bucket. Shown BECAUSE it is positive. */
  meanExcess63: number;
  /** True when a hot month escalated the figures above. */
  runUpEscalated: boolean;
}

export interface Turbulence {
  symbol: string;
  forecast: PathForecast;
  warnings: Warning[];
  /**
   * The ATR multiple a stop must clear for the ORDINARY drawdown not to reach
   * it — the measured dip plus a 15% margin, so roughly 1.4–2.2 ATR.
   *
   * Stated as a requirement rather than as a multiplier on purpose. A multiplier
   * has to assume what it is multiplying, and the three horizons already stop at
   * 1.5, 2.5 and 4 ATR: scaling all of them by the same factor would widen the
   * long horizon, which clears the dip several times over, and shrink its
   * position for nothing. The caller takes `max(its own multiple, this)`, which
   * is a no-op wherever the horizon is already wide enough — which is most of
   * the time, and correctly so.
   */
  requiredStopAtr: number;
  /**
   * Suggested fraction of the normal position to take now, 0.5 or 1.
   *
   * Never zero. Staging exists because the dip is likely, not because the idea
   * is bad — and the simulation says skipping outright costs half the return.
   */
  stageNowFraction: number;
  /** One line fit for a list row, when there is no space for the full panel. */
  summary: string;
}

// ─── the calculation ─────────────────────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

/** The bucket a given ATR% falls into. Never null: the last bucket starts at 0. */
export function bucketFor(atrPct: number): TurbulenceBucket {
  for (const b of BUCKETS) if (atrPct >= b.minAtrPct) return b;
  return BUCKETS[BUCKETS.length - 1];
}

/**
 * Assess one stock.
 *
 * `entry` is the price the plan intends to pay, which is not always the last
 * close — the dip is quoted off the level actually being risked.
 *
 * Returns null only when ATR is unusable, because every figure here is in ATR
 * and a forecast with no unit is worse than no forecast.
 */
export function assessTurbulence(
  m: Metrics,
  entry: number = m.lastClose,
): Turbulence | null {
  const atrPct = m.atrPct;
  if (atrPct === null || !(atrPct > 0) || !(entry > 0) || m.atr14 === null) return null;

  const b = bucketFor(atrPct);
  const hot = m.ret1m >= HOT_RUNUP_PCT;

  // Escalation is applied to the tail and to the TIMING, never to the depth:
  // the measured dip in ATR barely moved with run-up (1.75 → 1.45 across the
  // whole range), so inflating it would be inventing a number.
  const tailRisk = Math.min(1, b.tailRisk * (hot ? HOT_RUNUP_TAIL_MULTIPLE : 1));
  const days5 = Math.max(1, Math.round(b.days5 * (hot ? HOT_RUNUP_DAYS_MULTIPLE : 1)));
  const days10 = Math.max(1, Math.round(b.days10 * (hot ? HOT_RUNUP_DAYS_MULTIPLE : 1)));
  const prob5 = Math.min(1, b.prob5 * (hot ? 1.07 : 1)); // measured 0.659 → 0.705
  const expectedDipPct = b.dipAtr * atrPct;

  const forecast: PathForecast = {
    bucket: b.label,
    bucketN: b.n,
    expectedDipAtr: b.dipAtr,
    expectedDipPct,
    expectedDipFrom: entry * (1 - expectedDipPct / 100),
    dipProbability: prob5,
    dipMedianDays: days5,
    deepDipProbability: b.prob10,
    deepDipMedianDays: days10,
    tailRisk,
    tailRiskMultiple: tailRisk / BASELINE.tailRisk,
    meanExcess63: b.meanExcess63,
    runUpEscalated: hot,
  };

  const warnings: Warning[] = [];

  // ── volatility: the primary driver, so it leads ──
  if (atrPct >= HIGH_ATR_PCT) {
    warnings.push({
      kind: 'high-volatility',
      severity: 'serious',
      headline: `Daily range averages ${atrPct.toFixed(1)}% — size this one down`,
      detail:
        `Volatility is the strongest predictor of a bad outcome in the study, and it is the ` +
        `one stock characteristic that reliably persists (0.81 correlation across five-year ` +
        `halves). Names this volatile trailed the index by more than 20 points over three ` +
        `months ${pct(b.tailRisk)} of the time. They also BEAT it by ${b.meanExcess63.toFixed(1)}% ` +
        `on average, so this is a reason to take a smaller position, not to skip the idea.`,
      evidence: {
        condition: `ATR >= ${HIGH_ATR_PCT}% of price`,
        n: b.n,
        stat: `${pct(b.tailRisk)} trailed NIFTY by >20 points over 63 sessions`,
        baseline: `${pct(BASELINE.tailRisk)} for an average stock`,
      },
    });
  } else if (atrPct >= 3) {
    warnings.push({
      kind: 'high-volatility',
      severity: 'note',
      headline: `Moves ${atrPct.toFixed(1)}% on an average day`,
      detail:
        `Middling volatility. Expect a ${expectedDipPct.toFixed(1)}% drawdown at some point in ` +
        `the first month — that is the median for this group, not a bad case.`,
      evidence: {
        condition: 'ATR 3–5% of price',
        n: b.n,
        stat: `median 21-day drawdown ${b.dipAtr}× ATR`,
        baseline: `${BASELINE.dipAtr}× ATR for an average stock`,
      },
    });
  }

  // ── a hot month: real, but only as an escalation on top of volatility ──
  if (hot) {
    warnings.push({
      kind: 'run-up-extended',
      severity: atrPct >= HIGH_ATR_PCT ? 'serious' : 'caution',
      headline: `Up ${m.ret1m.toFixed(0)}% in the last month — expect the dip sooner`,
      detail:
        `A month this strong roughly multiplies the chance of a bad three months by ` +
        `${HOT_RUNUP_TAIL_MULTIPLE}× and pulls the first 5% dip forward to a median of ` +
        `${days5} sessions from ${b.days5}. What it does NOT do is reverse the stock: ` +
        `measured over ten years, the hottest names went on to beat the index by more than ` +
        `average, not less. Stage the entry rather than skipping it — a simulated "wait, and ` +
        `skip if no dip comes" rule cut returns roughly in half.`,
      evidence: {
        condition: `1-month return >= ${HOT_RUNUP_PCT}%`,
        n: 1_282 + 4_917,
        stat: `tail risk ×${HOT_RUNUP_TAIL_MULTIPLE}, dip arrives ~30% sooner`,
        baseline: `mean 63-day excess return still positive in every bucket`,
      },
    });
  }

  // ── the dip itself, always stated, always against the baseline ──
  warnings.push({
    kind: 'dip-imminent',
    severity: forecast.dipProbability >= 0.7 && days5 <= 7 ? 'caution' : 'note',
    headline:
      `A 5% dip is ${pct(forecast.dipProbability)} likely, typically within ` +
      `${days5} session${days5 === 1 ? '' : 's'}`,
    detail:
      `Half the time it is sooner and half later, and ${pct(1 - forecast.dipProbability)} of the ` +
      `time it never comes at all — this is a distribution, not a date. An average stock sits ` +
      `at ${pct(BASELINE.prob5)} within ${BASELINE.days5} sessions, so a dip on its own is ` +
      `normal and is not a reason to sell.`,
    evidence: {
      condition: `${b.label} (ATR ${atrPct.toFixed(1)}%)${hot ? ', hot month' : ''}`,
      n: b.n,
      stat: `${pct(forecast.dipProbability)} saw -5% within 63 sessions, median ${days5}d`,
      baseline: `${pct(BASELINE.prob5)} at median ${BASELINE.days5}d`,
    },
  });

  // ── liquidity, which is a genuine constraint rather than a forecast ──
  if (m.medianTurnover > 0 && m.medianTurnover < 5e7) {
    warnings.push({
      kind: 'thin-liquidity',
      severity: m.medianTurnover < 2e7 ? 'serious' : 'caution',
      headline: `Trades about ₹${(m.medianTurnover / 1e7).toFixed(1)} crore a day`,
      detail:
        `Thin enough that the exit matters more than the entry. The drawdown above assumes you ` +
        `can sell at the screen price; in a name this size, on the day you want out, you may ` +
        `not be able to.`,
      evidence: {
        condition: 'median daily turnover < ₹5 crore',
        n: 0,
        stat: 'not a measured base rate — a structural constraint',
        baseline: 'n/a',
      },
    });
  }

  // ── what owning it has actually cost, as description not forecast ──
  if (m.maxDrawdown1yPct >= 35) {
    warnings.push({
      kind: 'deep-drawdown-history',
      severity: 'note',
      headline: `Fell ${m.maxDrawdown1yPct.toFixed(0)}% peak-to-trough in the last year`,
      detail:
        `History, not a forecast — a stock's typical fall DEPTH does not repeat (measured ` +
        `correlation −0.14 across five-year halves, i.e. noise). Useful only as a reminder of ` +
        `what holding this has felt like.`,
      evidence: {
        condition: '1-year max drawdown >= 35%',
        n: 89,
        stat: 'depth correlation across halves: -0.14',
        baseline: 'ATR% correlation across halves: +0.81',
      },
    });
  }

  // ── the two actionable outputs ──
  // Clear the measured dip by 15%, so the drawdown the study says to EXPECT
  // cannot be the thing that takes the position out. Naturally bounded: the
  // widest bucket dip is 1.92 ATR, so this never asks for more than ~2.2.
  const requiredStopAtr = b.dipAtr * 1.15;
  // Stage only when the dip is both likely AND soon enough to be worth waiting
  // half a position for. Otherwise take the whole thing now.
  const stageNowFraction = forecast.dipProbability >= 0.7 && days5 <= 8 ? 0.5 : 1;

  // Plain English, and deliberately free of buy/sell advice: the same line is
  // shown on held positions (/risk), where "buy half now" would be wrong. The
  // recommendations card appends its own action from stageNowFraction.
  const when = days5 <= 7 ? 'within about a week' : `within ~${days5} trading days`;
  const tail =
    forecast.tailRiskMultiple >= 1.2
      ? `. Odds of badly lagging NIFTY are ${forecast.tailRiskMultiple.toFixed(1)}× usual`
      : '';
  const summary =
    `${KIND[b.label] ?? 'Stock'}: a ~${expectedDipPct.toFixed(0)}% dip ${when} is likely ` +
    `(${pct(forecast.dipProbability)} of similar stocks) and normal${tail}.`;

  return {
    symbol: m.symbol,
    forecast,
    warnings: warnings.sort((x, y) => rank(y.severity) - rank(x.severity)),
    requiredStopAtr,
    stageNowFraction,
    summary,
  };
}

/** Bucket label → how the summary line names the stock. */
const KIND: Record<string, string> = {
  'very volatile': 'Very bumpy stock',
  volatile: 'Bumpy stock',
  ordinary: 'Typical stock',
  calm: 'Calm stock',
};

const rank = (s: Severity): number => (s === 'serious' ? 2 : s === 'caution' ? 1 : 0);

/** The loudest severity present, or null when there is nothing to say. */
export function worstSeverity(t: Turbulence | null): Severity | null {
  if (!t || !t.warnings.length) return null;
  return t.warnings[0].severity;
}

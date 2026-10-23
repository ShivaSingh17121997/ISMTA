/**
 * Turnarounds — stocks that are well below their highs where the business
 * underneath has not broken. Pure.
 *
 * This is the most dangerous category in the product and the scoring is built
 * around that fact rather than around finding candidates.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING: depth is a FILTER, never a SCORE.
 * "More down is better" is the falling-knife error stated as arithmetic. A
 * stock must be down enough to be worth the trouble, and not so far down that
 * it is probably impaired — but within that band, being down 60% earns no more
 * credit than being down 30%. What earns credit is the business still working
 * and the decline having stopped.
 *
 * What the evidence supports, and what it does not:
 *
 *  - Buying recent losers is fighting the strongest anomaly there is.
 *    Twelve-month momentum says losers keep losing over the next 3–12 months,
 *    and in India momentum is the largest documented factor of all (WML ≈ 21.9%
 *    a year 1994–2014, 10.65% through 2025). So this category REQUIRES evidence
 *    that the fall has already stopped before it will fund anything.
 *  - Reversal, where it exists, is a 3–5 year formation and a 3–5 year hold
 *    (De Bondt & Thaler). It is not "this fell last month".
 *  - The thing that separates recoverable from impaired is financial strength
 *    and profitability, not cheapness. Piotroski's F-score exists precisely
 *    because most cheap, beaten-down stocks deserve it.
 *  - Distress is the trap: financially distressed stocks underperform badly
 *    (Campbell, Hilscher & Szilagyi, JF 2008), so anything looking like
 *    distress is excluded outright rather than scored low.
 *  - Most large falls are never recovered. Roughly 40% of Russell 3000 members
 *    since 1980 suffered a 70%+ decline they never made back, and in India only
 *    24% of stocks have beaten the market over their lifetime.
 */
import { Growth } from '../futurestars/types';
import { Shareholding } from '../futurestars/shareholding';
import { Grade, PillarScore, RiskFlag } from '../futurestars/types';

export interface TurnPrice {
  last: number;
  high52w: number;
  low52w: number;
  /** 0..100 */
  pctOf52wRange: number;
  /** ≤ 0, distance below the 52-week high */
  fromHighPct: number;
  aboveSma200: boolean;
  sma200: number;
  ema20: number;
  ema50: number;
  ema20Above50: boolean;
  /** lowest low of the last 20 sessions */
  low20: number;
  ret1m: number;
  mom3_1: number;
  mom6_1: number;
  mom12_1: number;
  maxDrawdown1yPct: number;
  rsi14: number | null;
  atrPct: number | null;
  volAnnualPct: number;
  medianTurnover: number;
}

export const WEIGHTS = {
  /** the business is still a business */
  resilience: 0.38,
  /** the fall has demonstrably stopped */
  stabilisation: 0.32,
  /** owners are not heading for the exit */
  ownership: 0.18,
  /** the fall looks like a de-rating rather than a collapse */
  shape: 0.12,
} as const;

const GRADES: Record<keyof typeof WEIGHTS, Grade> = {
  resilience: 'A',
  stabilisation: 'B',
  ownership: 'B',
  shape: 'C',
};

/** The band a stock has to be in to be a turnaround candidate at all. */
export const BAND = {
  /** must be at least this far below its 52-week high to be "down" */
  minFallPct: 20,
  /**
   * Beyond this, recovery is the exception rather than the rule and the
   * category refuses to guess which one it is looking at.
   */
  maxFallPct: 75,
  minTurnover: 20_000_000,
  minPrice: 20,
  minScore: 50,
} as const;

function ramp(x: number | null | undefined, lo: number, hi: number): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0;
  if (hi === lo) return x >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

/**
 * RESILIENCE — is there still a business here?
 *
 * The heaviest pillar, because it is the question that decides whether a fall
 * is an opportunity or a verdict. A company that is still profitable, whose
 * revenue has not collapsed and whose margin is not in free fall has had a
 * DE-RATING. A company whose revenue and margin are both going backwards has
 * had a DOWNGRADE, and the price is right.
 */
export function scoreResilience(g: Growth): { score: number; detail: string } {
  if (g.error) return { score: 0, detail: `results unavailable (${g.error})` };
  if (g.marginPct === null || g.revenueYoYPct === null) {
    return {
      score: 0,
      detail: 'not enough filed results to tell whether the business is intact — this cannot be assessed, so it is not assumed',
    };
  }

  // Still making money at all is the single biggest divider.
  const profitable = g.marginPct > 0 ? 1 : 0;
  // Revenue holding up. Flat is fine; this is not a growth screen.
  const revenue = ramp(g.revenueYoYPct, -15, 10);
  // Margin not collapsing.
  const margin =
    g.marginYearAgoPct === null ? 0.4 : ramp(g.marginPct - g.marginYearAgoPct, -6, 1);
  // The absolute level of profitability — thin margins leave no room to absorb
  // a bad year, which is how a de-rating becomes distress.
  const cushion = ramp(g.marginPct, 0, 15);

  let score = profitable * 0.3 + revenue * 0.25 + margin * 0.25 + cushion * 0.2;
  const age = g.ageDays ?? 0;
  if (age > 130) score *= Math.max(0.4, 1 - (age - 130) / 260);

  const detail =
    (g.marginPct > 0 ? `still profitable at a ${g.marginPct}% pre-tax margin` : `LOSS-MAKING at ${g.marginPct}%`) +
    (g.marginYearAgoPct !== null ? ` against ${g.marginYearAgoPct}% a year earlier` : '') +
    `; revenue ${g.revenueYoYPct >= 0 ? '+' : ''}${g.revenueYoYPct}% year on year` +
    (g.revenueAccelerationPct !== null && g.revenueAccelerationPct > 0
      ? `, improving from ${g.revenueYoYPriorPct}%`
      : '') +
    (age > 130 ? `; the filing is ${age} days old, so this is discounted` : '');
  return { score: Math.max(0, Math.min(1, score)), detail };
}

/**
 * STABILISATION — has the fall actually stopped?
 *
 * The timing pillar, and the one that keeps this category from being an
 * expensive way to catch falling knives. Momentum says losers keep losing for
 * three to twelve months, so the only defensible answer to "when do I buy a
 * stock that is falling" is "once it has stopped falling".
 *
 * Note what is NOT required: being back above the 200-day average. A stock that
 * has recovered that far is no longer a turnaround, it is a momentum name, and
 * the other list catches it. What is required is that the recent path is better
 * than the old one.
 */
export function scoreStabilisation(p: TurnPrice): { score: number; detail: string } {
  // Not making new lows. The single most basic test.
  const offLows = ramp(p.low20 > 0 ? ((p.last - p.low20) / p.low20) * 100 : 0, 0, 12);
  // Short-term trend turning up.
  const shortTrend = p.ema20Above50 ? 1 : ramp(p.ema20 > 0 ? ((p.last - p.ema20) / p.ema20) * 100 : 0, -4, 3);
  // The recent quarter is better than the year: the decline is decelerating.
  const decelerating = ramp(p.mom3_1 - p.mom12_1, -5, 30);
  // A positive last month, without demanding a moonshot.
  const recent = ramp(p.ret1m, -6, 10);
  // Not still in free fall: distance from the 200-day average shrinking is
  // approximated by where it sits in its own range.
  const base = ramp(p.pctOf52wRange, 8, 45);

  const score = offLows * 0.25 + shortTrend * 0.2 + decelerating * 0.25 + recent * 0.15 + base * 0.15;
  const detail =
    `${p.low20 > 0 ? (((p.last - p.low20) / p.low20) * 100).toFixed(0) : '0'}% above its 20-day low` +
    `; 20-day average ${p.ema20Above50 ? 'above' : 'below'} the 50-day` +
    `; 3-month return ${p.mom3_1 >= 0 ? '+' : ''}${p.mom3_1.toFixed(0)}% against ${p.mom12_1 >= 0 ? '+' : ''}${p.mom12_1.toFixed(0)}% over a year` +
    `; last month ${p.ret1m >= 0 ? '+' : ''}${p.ret1m.toFixed(0)}%` +
    (p.aboveSma200 ? '; already back above its 200-day average' : '');
  return { score: Math.max(0, Math.min(1, score)), detail };
}

/**
 * OWNERSHIP — are the people who know most about it buying or leaving?
 *
 * Asymmetric by design. A promoter increasing a stake is mild reassurance; a
 * promoter whose stake is falling, or whose shares are pledged, is a documented
 * warning — and pledging in particular is the mechanism (margin-call cascades)
 * that turns a large fall into a permanent one.
 */
export function scoreOwnership(s: Shareholding): { score: number; detail: string } {
  if (s.error || s.latestPct === null) {
    return { score: 0.35, detail: `shareholding could not be read (${s.error ?? 'no data'}), so this is neutral rather than clean` };
  }
  // A stake that is stable or rising scores well; one that is falling is
  // marked down hard.
  const drift = s.changePct === null ? 0.5 : ramp(s.changePct, -4, 1);
  // A high promoter stake is skin in the game.
  const skin = ramp(s.latestPct, 25, 60);
  let score = drift * 0.65 + skin * 0.35;
  if (s.pledged) score *= 0.4;

  const detail =
    `promoters hold ${s.latestPct}%` +
    (s.changePct !== null
      ? `, ${s.changePct > 0.05 ? 'up' : s.changePct < -0.05 ? 'DOWN' : 'unchanged'} ${Math.abs(s.changePct)} points over the year`
      : '') +
    (s.pledged === true
      ? `; shares are encumbered (${s.encumbrance.join(', ')}) — a falling price can force the promoter to sell, which is how a fall becomes permanent`
      : s.pledged === false
        ? '; no pledged or encumbered promoter shares'
        : '; pledge status unknown');
  return { score: Math.max(0, Math.min(1, score)), detail };
}

/**
 * SHAPE — does the fall look like a de-rating or a collapse?
 *
 * The lightest pillar and the most opinionated. A stock that drifted down 35%
 * over a year with the rest of its sector is a different animal from one that
 * lost 70% in a month on an announcement. Graded C because the distinction is
 * reasonable rather than evidenced.
 */
export function scoreShape(p: TurnPrice): { score: number; detail: string } {
  const fall = Math.abs(p.fromHighPct);
  // The sweet spot is a real fall that is not a collapse.
  const depth = fall <= 45 ? ramp(fall, 18, 32) : ramp(70 - fall, 0, 25);
  // A violent single drawdown is more likely to be news than a de-rating.
  const violence = ramp(-(p.maxDrawdown1yPct - fall), -20, 5);
  // Wild volatility after a fall usually means the story is still unresolved.
  const calm = ramp(70 - p.volAnnualPct, 0, 30);

  const score = depth * 0.5 + violence * 0.25 + calm * 0.25;
  const detail =
    `${fall.toFixed(0)}% below its 52-week high` +
    `, worst drawdown in the year ${Math.abs(p.maxDrawdown1yPct).toFixed(0)}%` +
    `, annualised volatility ${p.volAnnualPct.toFixed(0)}%`;
  return { score: Math.max(0, Math.min(1, score)), detail };
}

export function riskMultiplier(flags: RiskFlag[]): { multiplier: number; detail: string } {
  if (!flags.length) return { multiplier: 1, detail: 'no flags raised from recent filings' };
  const worst = Math.max(...flags.map((f) => f.severity));
  const total = flags.reduce((s, f) => s + f.severity, 0);
  const penalty = Math.min(0.7, worst * 0.55 + (total - worst) * 0.15);
  return { multiplier: 1 - penalty, detail: flags.map((f) => `${f.kind}: ${f.detail.slice(0, 90)}`).join(' · ') };
}

export type TurnVerdict = 'buy-the-base' | 'watch-for-a-base' | 'too-early' | 'avoid';

export interface ScoredTurn {
  score: number;
  pillars: PillarScore[];
  verdict: TurnVerdict;
  rejected: string | null;
}

export function scoreTurnaround(input: {
  growth: Growth;
  price: TurnPrice;
  shareholding: Shareholding;
  risks: RiskFlag[];
}): ScoredTurn {
  const res = scoreResilience(input.growth);
  const stab = scoreStabilisation(input.price);
  const own = scoreOwnership(input.shareholding);
  const shp = scoreShape(input.price);
  const risk = riskMultiplier(input.risks);

  const raw =
    res.score * WEIGHTS.resilience +
    stab.score * WEIGHTS.stabilisation +
    own.score * WEIGHTS.ownership +
    shp.score * WEIGHTS.shape;
  const score = Math.round(raw * risk.multiplier * 1000) / 10;

  const mk = (key: keyof typeof WEIGHTS, label: string, r: { score: number; detail: string }, curated = false): PillarScore => ({
    key,
    label,
    score: Math.round(r.score * 1000) / 1000,
    weight: WEIGHTS[key],
    contribution: Math.round(r.score * WEIGHTS[key] * 1000) / 1000,
    grade: GRADES[key],
    detail: r.detail,
    curated,
  });

  const pillars: PillarScore[] = [
    mk('resilience', 'The business is still working', res),
    mk('stabilisation', 'The fall has stopped', stab),
    mk('ownership', 'Promoters are not leaving', own),
    mk('shape', 'Shape of the decline', shp, true),
  ];

  const fall = Math.abs(input.price.fromHighPct);
  let rejected: string | null = null;
  if (input.price.medianTurnover < BAND.minTurnover) {
    rejected = `traded only ₹${(input.price.medianTurnover / 1e5).toFixed(1)} lakh a day — too thin to enter or leave`;
  } else if (input.price.last < BAND.minPrice) {
    rejected = `share price ₹${input.price.last.toFixed(2)} is below the ₹${BAND.minPrice} floor`;
  } else if (fall < BAND.minFallPct) {
    rejected = `only ${fall.toFixed(0)}% below its high — not down enough to be a turnaround`;
  } else if (fall > BAND.maxFallPct) {
    rejected =
      `${fall.toFixed(0)}% below its high. Past about ${BAND.maxFallPct}% the base rate of recovery collapses, ` +
      `and this list will not guess which side of it this is on`;
  } else if (input.growth.marginPct !== null && input.growth.marginPct < 0) {
    rejected = 'loss-making — a falling price and a loss-making business is distress, not a discount';
  } else if (res.score < 0.45) {
    // 0.45, not 0.30. Merely being profitable is worth 0.30 of this pillar on
    // its own, so a lower bar let a company through whose revenue had fallen a
    // quarter and whose margin had gone from 14% to 1.3% — it scored 0.32
    // purely for not yet losing money. That is a downgrade, and the price is
    // right.
    rejected = 'the business itself is deteriorating, so the fall is a downgrade rather than a de-rating';
  } else if (input.shareholding.pledged === true && (input.shareholding.changePct ?? 0) < -1) {
    rejected = 'promoter shares are pledged AND the stake is falling — the exact setup that turns a fall into a collapse';
  } else if (stab.score < 0.3) {
    rejected = 'still falling — nothing here says the decline has stopped, and losers keep losing for months';
  } else if (score < BAND.minScore) {
    rejected = `scored ${score.toFixed(0)}, below the ${BAND.minScore} bar for this list`;
  }

  const verdict: TurnVerdict = rejected
    ? 'watch-for-a-base'
    : score >= 68 && stab.score >= 0.55 && res.score >= 0.55
      ? 'buy-the-base'
      : score >= BAND.minScore
        ? 'watch-for-a-base'
        : 'too-early';

  return { score, pillars, verdict, rejected };
}

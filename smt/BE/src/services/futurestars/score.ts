/**
 * Scoring a future star. Pure.
 *
 * ABSOLUTE, NOT PERCENTILE — and that is the most important decision in this
 * file. The momentum recommender next door scores by cross-sectional
 * percentile, which is right when you have decided to hold something and only
 * need to know what. Here the honest answer is usually "nothing": a percentile
 * would rank the best of a poor field at 1.0 and dress a company with shrinking
 * revenue and no orders as a future star because its peers were worse. Every
 * threshold below is therefore an absolute bar with a stated reason, and an
 * empty list is a valid — indeed the expected — result on most days.
 *
 * The pillars are weighted by the strength of the evidence behind them, not by
 * how interesting they are:
 *
 *   Order flow  (A)  a mandatory, dated, exchange-filed fact, and the one
 *                    component with direct academic support: order backlog
 *                    predicts future earnings and the market underreacts to it
 *                    (Rajgopal, Shevlin & Venkatachalam, Review of Accounting
 *                    Studies 2003).
 *   Growth      (B)  measured from the company's own XBRL. Growth LEVELS barely
 *                    persist (Chan, Karceski & Lakonishok 2003 find almost no
 *                    persistence in earnings growth beyond chance), so the
 *                    weight sits on ACCELERATION and on margin direction, which
 *                    say something about this year rather than the next decade.
 *   Confirmation(B)  price agreeing with the story. A thesis the market has
 *                    never rewarded is a thesis, not a position.
 *   Policy      (C)  hand-written opinion. Capped hard: a public policy is a
 *                    priced policy, and government-demand exposure looks like
 *                    compensation for political risk rather than a free lunch
 *                    (Belo, Gala & Li, JFE 2013).
 *
 * Risk flags subtract. They cannot be outvoted by a good story, because the way
 * this category fails is not "the thesis was wrong" but "the company diluted,
 * was fined, or was never really growing".
 */
import { FutureStar, Grade, Growth, OrderFlow, PillarScore, PolicyRead, RiskFlag, Verdict } from './types';

export interface PriceContext {
  last: number;
  high52w: number;
  low52w: number;
  /** 0..100 — 0 at the 52-week low, 100 at the high. PERCENT, not the 0..1 fraction `measure` returns. */
  pctOf52wRange: number;
  /** distance below the 52-week high, percent, ≤ 0 */
  fromHighPct: number;
  aboveSma200: boolean;
  sma200: number | null;
  ret1yPct: number;
  atrPct: number | null;
  medianTurnover: number;
}

/**
 * Weights, REVISED 2026-09-11 after the evidence review. The first version
 * weighted order flow at 0.34 and graded it A on the strength of Rajgopal,
 * Shevlin & Venkatachalam (2003). Reading the paper rather than its reputation
 * shows it says the OPPOSITE: the market *overweights* backlog, and the
 * profitable hedge is long the LOWEST backlog decile, worth −5.8% a year on the
 * high side. Hou, Xue & Zhang (RFS 2020) then fail to replicate it at all
 * (0.17%/month, t = 0.71). What survives is the CHANGE in backlog, not the
 * level, and a high backlog-to-sales ratio predicts LOWER future earnings
 * (Banker et al., RQFA 2024).
 *
 * So order flow is demoted to a small, change-based contribution with a
 * penalty at extremes, and the weight moves to the two things that do hold up:
 *
 *   profitability  the single best-supported factor in India — quality-minus-junk
 *                  earns 1.69%/month with a 0.92%/month four-factor alpha over
 *                  1995–2021 on the top 1,000 names (Jacob, Pradeep & Varma,
 *                  IIMA 2022), driven by profitability and payout. In Novy-Marx's
 *                  horse race of seven quality definitions, only gross
 *                  profitability had a significant standalone spread; three of
 *                  the other six were NEGATIVE.
 *   acceleration   earnings surprise and acceleration are incremental to
 *                  everything else (SUE t = 7.14; acceleration 1.6%/month
 *                  controlling for PEAD, size, profitability, B/M and accruals),
 *                  while the growth LEVEL has essentially no persistence.
 */
export const WEIGHTS = {
  profitability: 0.32,
  acceleration: 0.28,
  confirmation: 0.20,
  orders: 0.13,
  policy: 0.07,
} as const;

const GRADES: Record<keyof typeof WEIGHTS, Grade> = {
  profitability: 'A',
  acceleration: 'A',
  confirmation: 'B',
  orders: 'C',
  policy: 'C',
};

/** Map a value onto 0..1 between `lo` (nothing) and `hi` (full marks). */
function ramp(x: number | null | undefined, lo: number, hi: number): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0;
  if (hi === lo) return x >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

/**
 * ORDER FLOW — demoted, and read as a CHANGE.
 *
 * Three findings force this to be small and sceptical rather than the headline
 * pillar it started as:
 *
 *  1. The backlog LEVEL predicts negative returns (Rajgopal, Shevlin &
 *     Venkatachalam 2003: the market overweights it; the hedge is long the
 *     lowest decile) and fails replication altogether (Hou, Xue & Zhang 2020,
 *     t = 0.71). Only the CHANGE has a positive documented sign.
 *  2. A high backlog-to-sales ratio predicts LOWER future earnings (Banker,
 *     Barber, Hollie & Park, RQFA 2024) — so book-to-bill enters as a PENALTY
 *     at extremes, never as an unbounded bonus. The Indian brokerage heuristic
 *     that "3–4× book-to-bill means three years of visibility" has no support.
 *  3. A COUNT of announcements is not a signal in any published study. Under
 *     SEBI's LODR Schedule III it sits in Part A Para B — subject to a
 *     materiality test — so for an EPC, defence or railway company routine
 *     order wins are effectively VOLUNTARY disclosure. The count therefore
 *     measures how talkative the investor-relations team is, and attention
 *     itself predicts lower returns (Fang & Peress, JF 2009: uncovered stocks
 *     beat heavily covered ones by ~3%/yr risk-adjusted, more among small caps).
 *
 * What is left is a modest, bounded credit for an order book that is filling
 * faster than it was, and an explicit penalty when it looks stretched.
 */
export function scoreOrders(flow: OrderFlow): { score: number; detail: string } {
  if (flow.error) return { score: 0, detail: `order filings unavailable (${flow.error})` };
  if (flow.recentCount === 0) {
    // Two different situations that must not read the same. A company that
    // announced wins and then stopped has an order book that is drying up. A
    // company that has never announced one probably does not work that way:
    // an electronics manufacturer ships against customer purchase orders that
    // are never individually material enough to disclose, while a defence or
    // railway contractor files every award. Only the first is bad news.
    return {
      score: 0,
      detail:
        flow.priorCount > 0
          ? `order wins stopped: ${flow.priorCount} filed in the previous six months, none since`
          : 'this company does not file individual order wins with the exchange, so there is nothing to measure here — the score rests on the other pillars',
    };
  }

  // Volume: six wins in six months is a company whose order book is genuinely
  // turning over; one is an event.
  const volume = ramp(flow.recentCount, 1, 6);

  // Direction: this half-year against the last. Rewarded up to a doubling —
  // beyond that it is usually one lumpy contract, not a trend.
  const growth =
    flow.priorCount === 0
      ? flow.recentCount >= 2
        ? 0.6 // new to winning work: promising, unproven
        : 0.3
      : ramp(flow.recentCount / flow.priorCount, 0.8, 2);

  // Recency: an order book that stopped filling three months ago is a story
  // about the past.
  const recency = flow.daysSinceLast === null ? 0 : ramp(120 - flow.daysSinceLast, 0, 90);

  // The direction of travel carries most of the (small) weight, because the
  // change is the only part with a positive documented sign.
  let score = volume * 0.25 + growth * 0.5 + recency * 0.25;

  // Book-to-bill as a PENALTY at extremes. A stretched order book relative to
  // the revenue that has to deliver it predicts lower future earnings.
  let stretched = '';
  if (flow.bookToBill !== null && flow.bookToBill > 3) {
    const penalty = Math.min(0.5, (flow.bookToBill - 3) * 0.15);
    score *= 1 - penalty;
    stretched =
      `; disclosed wins run to ${flow.bookToBill.toFixed(1)}× annual revenue, which is a delivery risk rather than ` +
      `visibility — a stretched backlog predicts weaker future earnings, so this is marked down`;
  }

  const bits = [
    `${flow.recentCount} win${flow.recentCount === 1 ? '' : 's'} in six months against ${flow.priorCount} in the six before`,
    flow.daysSinceLast !== null ? `most recent ${flow.daysSinceLast} days ago` : '',
    flow.bookToBill !== null && flow.bookToBill <= 3
      ? `disclosed value is ${flow.bookToBill.toFixed(2)}× annual revenue`
      : flow.unpriced > 0
        ? `${flow.unpriced} of them disclosed no value in the filing text, so size is unknown`
        : '',
  ].filter(Boolean);
  return { score: Math.max(0, Math.min(1, score)), detail: bits.join('; ') + stretched };
}

/**
 * PROFITABILITY — the heaviest pillar, because it is the best-supported one.
 *
 * Quality-minus-junk is the strongest documented factor in Indian equities:
 * 1.69% a month with a 0.92% four-factor alpha over 1995–2021 on the top 1,000
 * names, clearing even the t ≈ 3 hurdle that Harvey, Liu and Zhu argue new
 * factors should face, and driven by profitability and payout. Value, by
 * contrast, was marginally negative over the same window, and the size premium
 * is zero or negative.
 *
 * Measured from what the filings actually give us: the pre-tax margin, its
 * direction, and whether profit is growing at least as fast as revenue. That
 * is a cruder instrument than gross-profits-to-assets — the balance sheet is
 * not in a quarterly results filing — and the name says so.
 */
export function scoreProfitability(g: Growth): { score: number; detail: string } {
  if (g.error) return { score: 0, detail: `results unavailable (${g.error})` };
  if (g.marginPct === null) {
    return { score: 0, detail: 'no readable pre-tax margin in the filings, so profitability cannot be judged' };
  }

  // Level: 5% pre-tax is thin, 25% is genuinely profitable for a manufacturer.
  const level = ramp(g.marginPct, 3, 25);
  // Direction: widening margins with growth is operating leverage; narrowing
  // margins with growth is buying revenue.
  const trend = g.marginYearAgoPct === null ? 0.35 : ramp(g.marginPct - g.marginYearAgoPct, -3, 4);
  // Profit keeping up with revenue is the same test from the other side.
  const flowThrough =
    g.profitYoYPct === null || g.revenueYoYPct === null
      ? 0.3
      : ramp(g.profitYoYPct - g.revenueYoYPct, -25, 15);

  let score = level * 0.45 + trend * 0.3 + flowThrough * 0.25;
  const age = g.ageDays ?? 0;
  if (age > 130) score *= Math.max(0.4, 1 - (age - 130) / 260);

  const detail =
    `pre-tax margin ${g.marginPct}%` +
    (g.marginYearAgoPct !== null
      ? `, ${g.marginPct > g.marginYearAgoPct ? 'wider' : g.marginPct < g.marginYearAgoPct ? 'narrower' : 'unchanged'} than ${g.marginYearAgoPct}% a year earlier`
      : '') +
    (g.profitYoYPct !== null && g.revenueYoYPct !== null
      ? `; profit ${g.profitYoYPct > g.revenueYoYPct ? 'growing faster than' : 'lagging'} revenue (${g.profitYoYPct}% vs ${g.revenueYoYPct}%)`
      : '') +
    '. Measured from the results filing; the balance sheet is not in a quarterly filing, so this is thinner than a true quality score.';
  return { score: Math.max(0, Math.min(1, score)), detail };
}

/**
 * ACCELERATION — growth as a CHANGE, not a level.
 *
 * The level of growth is very nearly uninformative. Chan, Karceski &
 * Lakonishok (Journal of Finance 2003) find that the share of firms stringing
 * together five years of above-median EARNINGS growth is 3.0% against the 3.1%
 * chance predicts; forecasting regressions on past growth reach an adjusted R²
 * of 0.013. Worse, the market pays for the expectation: sorted on forecast
 * long-term growth, the lowest decile earns about 15% a year and the highest
 * about 3%, at a higher beta (Bordalo, Gennaioli, La Porta & Shleifer, JF 2019).
 *
 * What is informative is the second derivative and the surprise. Earnings
 * acceleration earns 1.6% a month controlling simultaneously for post-earnings
 * drift, size, profitability, book-to-market, past returns, accruals and asset
 * growth (He & Narayanamoorthy, JAE 2020), and earnings surprise carries a
 * t-statistic above 7 (Novy-Marx 2015).
 *
 * One hard rule from Jegadeesh & Livnat (JAE 2006): revenue growth WITHOUT
 * margin follow-through is a negative signal, not a weak positive — "positive
 * sales performance is received with disappointment if the benefits do not
 * contemporaneously flow through to the bottom line."
 *
 * Growth read off a filing two quarters old is not news, so the pillar decays
 * with the age of the latest filing.
 */
export function scoreGrowth(g: Growth): { score: number; detail: string } {
  if (g.error) return { score: 0, detail: `results unavailable (${g.error})` };
  if (g.revenueYoYPct === null) {
    return {
      score: 0,
      detail:
        g.quarters.length > 0
          ? `only ${g.quarters.length} quarter(s) filed and no matching year-ago quarter, so growth cannot be measured`
          : 'no quarterly results could be read',
    };
  }

  // ACCELERATION carries the pillar. The level is kept only as a small
  // qualifier — a company must be growing at all for acceleration to mean
  // anything — and is capped low so a spectacular growth rate cannot buy a
  // high score on its own.
  const level = ramp(g.revenueYoYPct, 0, 25);
  const accel = g.revenueAccelerationPct === null ? 0.3 : ramp(g.revenueAccelerationPct, -10, 20);
  // Consistency: four quarters of year-on-year growth is a trend, one is noise.
  const streak = ramp(g.positiveStreak, 0, 4);

  let score = accel * 0.55 + level * 0.25 + streak * 0.2;

  // Revenue growth with the margin going backwards is penalised outright, not
  // merely scored low: it is documented as a negative signal.
  if (
    g.revenueYoYPct > 10 &&
    g.marginPct !== null &&
    g.marginYearAgoPct !== null &&
    g.marginPct < g.marginYearAgoPct - 1
  ) {
    score *= 0.55;
  }

  // Staleness. A quarter ends, then the filing lands six to eight weeks later,
  // so ~130 days old is normal and only beyond that does it start to rot.
  const age = g.ageDays ?? 0;
  const freshness = age <= 130 ? 1 : Math.max(0.4, 1 - (age - 130) / 260);
  score *= freshness;

  const sinking =
    g.revenueYoYPct > 10 && g.marginPct !== null && g.marginYearAgoPct !== null && g.marginPct < g.marginYearAgoPct - 1;

  const detail =
    `revenue ${g.revenueYoYPct > 0 ? '+' : ''}${g.revenueYoYPct}% against ${g.comparedWith}` +
    (g.revenueAccelerationPct !== null
      ? `, ${g.revenueAccelerationPct >= 0 ? 'accelerating' : 'decelerating'} from ${g.revenueYoYPriorPct}%`
      : ', with no earlier quarter to measure acceleration against') +
    (g.positiveStreak > 0 ? `; ${g.positiveStreak} quarter(s) of year-on-year growth` : '') +
    (sinking ? '; MARKED DOWN — revenue is growing while the margin shrinks, which is revenue being bought rather than earned' : '') +
    (freshness < 1 ? `; filing is ${age} days old, so this is discounted` : '');

  return { score: Math.max(0, Math.min(1, score)), detail };
}

/**
 * CONFIRMATION.
 *
 * Not momentum for its own sake — a gate. A company can win orders and grow for
 * two years while its shares do nothing, and buying it early is indistinguishable
 * in advance from buying something whose story never converts. The price
 * agreeing is the cheapest available evidence that someone with more information
 * than us also believes it.
 *
 * Deliberately NOT scored higher for a stock at its high: paying the most for
 * the most-loved version of a story is how this category loses money.
 */
export function scoreConfirmation(p: PriceContext): { score: number; detail: string } {
  const trend = p.aboveSma200 ? 1 : 0;
  // Best marks in the upper-middle of the 52-week range: participating, not extended.
  const range = 1 - Math.min(1, Math.abs(p.pctOf52wRange - 70) / 55);
  const performance = ramp(p.ret1yPct, -20, 40);
  const score = trend * 0.45 + range * 0.3 + performance * 0.25;
  const detail =
    `${p.aboveSma200 ? 'above' : 'below'} its 200-day average` +
    `; ${p.pctOf52wRange.toFixed(0)}% of the way up its 52-week range` +
    `; ${p.ret1yPct >= 0 ? '+' : ''}${p.ret1yPct.toFixed(0)}% over a year` +
    (p.fromHighPct < -25 ? `; ${Math.abs(p.fromHighPct).toFixed(0)}% below its high` : '');
  return { score: Math.max(0, Math.min(1, score)), detail };
}

export function scorePolicy(p: PolicyRead): { score: number; detail: string } {
  if (!p.tags.length && !p.critical.length) {
    return { score: 0, detail: 'no policy or strategic-production view recorded for this company' };
  }
  const detail =
    [p.tags.map((t) => `${t.scheme} (${t.since})`).join('; '), p.critical.length ? `makes: ${p.critical.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ') + ' — curated opinion, not measured data';
  return { score: p.raw, detail };
}

/**
 * Risk flags, as a multiplier on the whole score.
 *
 * A multiplier rather than a subtraction: these are ways the investment fails
 * outright, and a company with a pending regulatory action and heavy dilution
 * should not be rescued by an excellent order book.
 */
export function riskMultiplier(flags: RiskFlag[]): { multiplier: number; detail: string } {
  if (!flags.length) return { multiplier: 1, detail: 'no flags raised from recent filings' };
  const worst = Math.max(...flags.map((f) => f.severity));
  const total = flags.reduce((s, f) => s + f.severity, 0);
  // One serious flag costs more than several trivial ones.
  const penalty = Math.min(0.6, worst * 0.5 + (total - worst) * 0.12);
  return {
    multiplier: 1 - penalty,
    detail: flags.map((f) => `${f.kind}: ${f.detail.slice(0, 90)}`).join(' · '),
  };
}

/** Absolute bars a name must clear to be shown at all. */
export const GATES = {
  /** below this the market has never agreed with the story */
  minConfirmation: 0.2,
  /** a company with neither orders nor measurable growth is a narrative */
  minEvidence: 0.18,
  /** total, out of 100 */
  minScore: 45,
  /** rupees of median daily turnover — below this a ₹2 lakh position is the market */
  minTurnover: 20_000_000,
  minPrice: 20,
} as const;

export interface Scored {
  score: number;
  pillars: PillarScore[];
  verdict: Verdict;
  rejected: string | null;
}

export function scoreFutureStar(input: {
  orders: OrderFlow;
  growth: Growth;
  policy: PolicyRead;
  price: PriceContext;
  risks: RiskFlag[];
}): Scored {
  const prof = scoreProfitability(input.growth);
  const acc = scoreGrowth(input.growth);
  const c = scoreConfirmation(input.price);
  const o = scoreOrders(input.orders);
  const p = scorePolicy(input.policy);
  const risk = riskMultiplier(input.risks);

  const raw =
    prof.score * WEIGHTS.profitability +
    acc.score * WEIGHTS.acceleration +
    c.score * WEIGHTS.confirmation +
    o.score * WEIGHTS.orders +
    p.score * WEIGHTS.policy;
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
    mk('profitability', 'Profitability and margin direction', prof),
    mk('acceleration', 'Growth acceleration', acc),
    mk('confirmation', 'Price confirmation', c),
    mk('orders', 'Order and contract wins', o),
    mk('policy', 'Policy support and strategic production', p, true),
  ];

  // Reasons to refuse, in the order a person would apply them.
  let rejected: string | null = null;
  if (input.price.medianTurnover < GATES.minTurnover) {
    rejected = `traded only ₹${(input.price.medianTurnover / 1e5).toFixed(1)} lakh a day — too thin to enter or leave`;
  } else if (input.price.last < GATES.minPrice) {
    rejected = `share price ₹${input.price.last.toFixed(2)} is below the ₹${GATES.minPrice} floor for this list`;
  } else if (Math.max(prof.score, acc.score) < GATES.minEvidence) {
    rejected = 'no measurable profitability or growth in the filings — this is a story, not a business yet';
  } else if (c.score < GATES.minConfirmation) {
    rejected = 'the market has not confirmed the story: below its 200-day average and going nowhere';
  } else if (score < GATES.minScore) {
    rejected = `scored ${score.toFixed(0)}, below the ${GATES.minScore} bar for this list`;
  }

  // "Accumulate" now requires the two well-evidenced pillars to carry it, not
  // a good story with a thin balance sheet behind it.
  const verdict: Verdict = rejected
    ? 'watch'
    : score >= 72 && prof.score >= 0.5 && acc.score >= 0.45
      ? 'accumulate'
      : score >= 60
        ? 'stage-in'
        : score >= GATES.minScore
          ? 'watch'
          : 'too-early';

  return { score, pillars, verdict, rejected };
}

/** One paragraph a person can read instead of the numbers. */
export function writeThesis(star: Omit<FutureStar, 'thesis' | 'rank'>): string {
  const { orders: o, growth: g, policy: p, price } = star;
  const parts: string[] = [];

  if (o.recentCount > 0) {
    const named = o.recent.find((w) => w.customer)?.customer;
    parts.push(
      `${star.name} has filed ${o.recentCount} order or contract win${o.recentCount === 1 ? '' : 's'} with the exchange in the last six months` +
        (o.priorCount ? `, against ${o.priorCount} in the six months before` : '') +
        (named ? `, the most recent from ${named}` : '') +
        '.',
    );
  } else {
    parts.push(`${star.name} has filed no order wins with the exchange in the last six months.`);
  }

  if (g.revenueYoYPct !== null) {
    parts.push(
      `Revenue in the quarter to ${g.quarters[g.quarters.length - 1]?.end} was ${g.revenueYoYPct > 0 ? 'up' : 'down'} ` +
        `${Math.abs(g.revenueYoYPct)}% on a year earlier` +
        (g.revenueAccelerationPct !== null
          ? `, ${g.revenueAccelerationPct >= 0 ? 'faster' : 'slower'} than the previous quarter's ${g.revenueYoYPriorPct}%`
          : '') +
        (g.marginPct !== null && g.marginYearAgoPct !== null && g.marginPct !== g.marginYearAgoPct
          ? `, with the pre-tax margin ${g.marginPct > g.marginYearAgoPct ? 'widening' : 'narrowing'} from ${g.marginYearAgoPct}% to ${g.marginPct}%`
          : '') +
        '.',
    );
  }

  if (p.tags.length || p.critical.length) {
    parts.push(
      (p.critical.length ? `It makes ${p.critical.join(' and ')}` : 'It sits') +
        (p.tags.length ? `, in the path of ${p.tags.map((t) => t.scheme).join(' and ')}` : '') +
        '. That connection is a judgement written into this tool, not a measured fact.',
    );
  }

  parts.push(
    `The shares are ${price.aboveSma200 ? 'above' : 'below'} their 200-day average and ` +
      `${price.pctOf52wRange.toFixed(0)}% of the way up the 52-week range.`,
  );

  if (star.risks.length) {
    parts.push(`Against that: ${star.risks.map((r) => r.kind).join(', ')}.`);
  }

  return parts.join(' ');
}

/**
 * "Future stars" — companies that could become materially larger, judged on
 * what they have WON rather than on what they have already returned.
 *
 * This is a different animal from the momentum recommender next door, and the
 * difference matters enough to keep the types separate:
 *
 *   /recommendations  ranks price behaviour. Its evidence is momentum, which is
 *                     the best-documented anomaly in equities.
 *   future stars      ranks order flow, growth and policy exposure. Its
 *                     evidence is thinner, its horizon is years, and its
 *                     failure mode is the opposite one — a good story that
 *                     never turns into cash.
 *
 * So every pillar carries its own evidence grade, the opinionated ones are
 * labelled as opinion, and the output is a STAGED plan rather than a position.
 */

/** How much weight the published evidence justifies for a pillar. */
export type Grade = 'A' | 'B' | 'C';

export interface PillarScore {
  key: string;
  label: string;
  /** 0..1 — this company's standing on this pillar within the scored set. */
  score: number;
  weight: number;
  contribution: number;
  grade: Grade;
  /** One line a human can check, with the numbers behind the score. */
  detail: string;
  /** True when the pillar is a hand-written judgement rather than measured data. */
  curated: boolean;
}

/** A single order or contract win, as the exchange filing reported it. */
export interface OrderWin {
  /** epoch ms of the announcement */
  at: number;
  /** NSE's own category string */
  category: string;
  /** the filing's description, trimmed */
  detail: string;
  /** rupees, when a value could be read out of the text; null when it could not */
  valueInr: number | null;
  /** who placed the order, when the text names them */
  customer: string | null;
  url: string | null;
}

export interface OrderFlow {
  symbol: string;
  /** wins in the last 180 days */
  recent: OrderWin[];
  /** wins in the 180 days before that, for the comparison */
  prior: OrderWin[];
  recentCount: number;
  priorCount: number;
  /** total rupee value read from the recent window; partial by nature */
  recentValueInr: number;
  priorValueInr: number;
  /**
   * Recent value ÷ trailing twelve-month revenue — the book-to-bill idea.
   *
   * Null unless most of the recent wins actually carried a value in their text.
   * Indian filings usually put the amount only in the attached PDF: of BEL's
   * ten wins in the last six months, nine were unpriced, which would have made
   * a book-to-bill of 0.09 out of a company whose order book is several times
   * its revenue. A ratio computed from a tenth of the numerator is not a
   * conservative estimate, it is a wrong one.
   */
  bookToBill: number | null;
  /** share of recent wins whose value could be read, 0..1 */
  valueCoverage: number;
  /** days since the most recent win, or null if there are none */
  daysSinceLast: number | null;
  /** filings we could read but could not price, so the value figures are a floor */
  unpriced: number;
  error?: string;
}

/** One quarter of reported results, as filed with the exchange. */
export interface Quarter {
  /** YYYY-MM-DD of the quarter end */
  end: string;
  /** "Q1".."Q4" as the filing labelled it, when known */
  label: string | null;
  consolidated: boolean;
  revenue: number;
  profit: number;
  /** profit before tax, for a margin that is not distorted by tax one-offs */
  pbt: number | null;
  filedAt: number;
}

export interface Growth {
  symbol: string;
  quarters: Quarter[];
  /** most recent quarter vs the same quarter a year earlier, % */
  revenueYoYPct: number | null;
  profitYoYPct: number | null;
  /** the previous quarter's YoY, so acceleration can be seen */
  revenueYoYPriorPct: number | null;
  /** revenueYoYPct − revenueYoYPriorPct. Positive = accelerating. */
  revenueAccelerationPct: number | null;
  /** trailing twelve months, when four quarters are available */
  ttmRevenue: number | null;
  ttmProfit: number | null;
  /** PBT margin of the latest quarter and of the same quarter a year earlier */
  marginPct: number | null;
  marginYearAgoPct: number | null;
  /** how many quarters in a row revenue grew year on year */
  positiveStreak: number;
  /** the quarter the latest figure was compared against, so the comparison is auditable */
  comparedWith: string | null;
  /** days between the latest quarter end and today — growth read off stale filings is not growth */
  ageDays: number | null;
  error?: string;
}

/** A government scheme or policy the company is exposed to. Curated. */
export interface PolicyTag {
  /** short name, e.g. "PLI: electronics components" */
  scheme: string;
  /** why this company is exposed, in one line */
  why: string;
  /** the year the scheme was announced or last expanded, so staleness is visible */
  since: number;
}

export interface PolicyRead {
  symbol: string;
  tags: PolicyTag[];
  /** strategic / import-substitution production, e.g. "semiconductor assembly" */
  critical: string[];
  /** 0..1 before weighting — how much policy support this company carries */
  raw: number;
}

/** What could kill the thesis, gathered from filings. */
export interface RiskFlag {
  kind: 'dilution' | 'pledge' | 'regulatory' | 'auditor' | 'governance' | 'valuation' | 'liquidity' | 'surveillance';
  detail: string;
  /** how hard this counts against the score, 0..1 */
  severity: number;
  at?: number;
}

/** One tranche of the staged entry plan. */
export interface Tranche {
  n: number;
  /** what has to be true before this tranche is bought */
  trigger: string;
  /** share of the position this tranche represents, % */
  sharePct: number;
  amount: number;
  quantity: number;
  /** the price this tranche assumes; for tranche 1 that is the market */
  price: number;
  /** when this can realistically happen */
  timing: string;
}

export interface EntryPlan {
  /** total rupees the plan would eventually commit */
  amount: number;
  pctOfCapital: number;
  tranches: Tranche[];
  /** the level that says the thesis is wrong, and what it costs to find out */
  invalidation: string;
  invalidationPrice: number | null;
  riskAmount: number;
  /** the date the thesis gets its next real test */
  nextCheck: string;
  holdLabel: string;
  warnings: string[];
}

export type Verdict = 'accumulate' | 'stage-in' | 'watch' | 'too-early' | 'avoid';

export interface FutureStar {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  /** 0..100 */
  score: number;
  verdict: Verdict;
  /** false = it made the list but not the budget: a thesis with no position */
  funded: boolean;
  /** one paragraph: what this company has won and why it might matter */
  thesis: string;
  pillars: PillarScore[];
  orders: OrderFlow;
  growth: Growth;
  policy: PolicyRead;
  risks: RiskFlag[];
  plan: EntryPlan;
  /** last close and the trend context the plan is built on */
  price: {
    last: number;
    high52w: number;
    low52w: number;
    /** 0..100 — 0 at the 52-week low, 100 at the high */
    pctOf52wRange: number;
    /** distance below the 52-week high, percent, ≤ 0 */
    fromHighPct: number;
    aboveSma200: boolean;
    sma200: number | null;
    ret1yPct: number;
    atrPct: number | null;
    medianTurnover: number;
  };
}

export interface FutureStarsRun {
  at: number;
  tradingDay: string;
  capital: number;
  universeSize: number;
  measured: number;
  /** names that passed the eligibility floor and were scored */
  scored: number;
  stars: FutureStar[];
  /** scored but not shortlisted, with the reason */
  rejected: { symbol: string; name: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  /** total rupees the staged plans would commit if every trigger fired */
  totalIfAllStaged: number;
  /** the share of capital this whole category is allowed */
  categoryCapPct: number;
  /**
   * The diversification problem, stated rather than hidden.
   *
   * The strongest single recommendation in the evidence review was structural:
   * a list like this should hold 20–25 names at no more than ~4% each, because
   * no fundamental screen reliably excludes the names that go to zero (54% of
   * stocks suffering catastrophic unrecovered declines were profitable at their
   * peak) and the only defence that works is arithmetic — the probability of
   * beating Treasury bills rises from 47.8% for one stock to 86.7% for 25.
   *
   * A ₹2 lakh account cannot hold 25 small caps above the charge floor. So the
   * product does not pretend otherwise: it reports how far short it is and what
   * the alternative is.
   */
  concentration: {
    fundedCount: number;
    /** names the evidence says a list like this should hold */
    recommendedMinimum: number;
    /** true when the account cannot reach that minimum at a sane position size */
    tooConcentrated: boolean;
    note: string;
  };
  sources: string;
  evidence: string;
  disclaimer: string;
}

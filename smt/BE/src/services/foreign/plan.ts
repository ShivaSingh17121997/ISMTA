/**
 * The per-stock plan and the "why it ranks well" card. Pure.
 *
 * LEVELS, NOT PROMISES. Every level comes from the stock's own volatility and
 * averages, so it is the same kind of number for every stock:
 *   buy zone       last close down to one typical monthly dip (1.75 × ATR,
 *                  the median found in WARNING_ENGINE.md); buy in 2–3 steps
 *   review level   momentum picks: the higher of the 200-day average and
 *                  entry − 3 × ATR (below it the stock leaves the list anyway);
 *                  bounce-backs: the 20-day low × 0.96 (the Turnarounds stop)
 *                  — always below the price, never more than 25% away
 *   6-month range  price × e^(±σ√½), a ±1σ band with no drift: "about two in
 *                  three outcomes land inside", checked against history in the
 *                  calibration backtest. Not a target.
 * The analysts' consensus target is shown separately, as theirs.
 *
 * GRADES on each "why" line say how much evidence stands behind that kind of
 * reason, not how good this stock's number is:
 *   A  trend strength (6/12-month momentum) — the ranking, backtested here
 *   B  revenue growth with margins, profit backed by cash — published evidence
 *   C  earnings surprises and estimate revisions — weak or faded
 *      in US large caps; shown, never ranked
 */
import type { Metrics } from '../recommender/metrics';
import type { QualityScore } from './fundamentals';
import type { NasdaqRead } from './nasdaq';
import type { QuarterRead } from './quarterly';

export const DIP_ATR = 1.75;
export const REVIEW_ATR = 3;
export const MAX_STOP_PCT = 0.25;
export const EARNINGS_WAIT_DAYS = 7;

export interface Levels {
  buyLow: number;
  buyHigh: number;
  review: number;
  reviewPct: number;
  reviewBasis: string;
  rangeLow: number;
  rangeHigh: number;
}

export type Grade = 'A' | 'B' | 'C';
export interface WhyLine {
  grade: Grade;
  /** good = supports the case, bad = against it, info = neither. */
  stance: 'good' | 'bad' | 'info';
  text: string;
}

const round = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number, dp = 0) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(dp)}%`;

/**
 * The plan's levels. `sma50` and `low20` come from the caller (Metrics carries
 * EMAs, not the 50-day simple average). `kind` picks the review rule.
 */
export function levelsFor(m: Metrics, kind: 'momentum' | 'bounce'): Levels {
  const p = m.lastClose;
  const atr = m.atr14 ?? p * 0.02;
  const floor = p * (1 - MAX_STOP_PCT);
  let review: number;
  let basis: string;
  if (kind === 'bounce') {
    review = m.low20 * 0.96;
    basis = '20-day low less 4%';
  } else {
    const byAtr = p - REVIEW_ATR * atr;
    review = Math.max(m.sma200 < p ? m.sma200 : -Infinity, byAtr);
    basis = review === byAtr ? `${REVIEW_ATR}× its daily range below the price` : '200-day average';
  }
  if (!(review < p)) {
    review = p - REVIEW_ATR * atr;
    basis = `${REVIEW_ATR}× its daily range below the price`;
  }
  if (review < floor) {
    review = floor;
    basis = `${MAX_STOP_PCT * 100}% below the price (cap)`;
  }
  const s = (m.volAnnualPct / 100) * Math.sqrt(0.5);
  return {
    buyLow: round(p - DIP_ATR * atr),
    buyHigh: round(p),
    review: round(review),
    reviewPct: review / p - 1,
    reviewBasis: basis,
    rangeLow: round(p * Math.exp(-s)),
    rangeHigh: round(p * Math.exp(s)),
  };
}

/** Days from `today` to an earnings date, or null. */
export function daysTo(date: string | undefined, today: string): number | null {
  if (!date) return null;
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

/** The reasons, each with its evidence grade. */
export function whyLines(input: {
  kind: 'momentum' | 'bounce';
  m: Metrics;
  signals: { label: string; percentile: number }[];
  /** Bounce-backs: the fall from the 252-day closing high (the figure the table shows). */
  fall?: number;
  ret12m: number | null;
  q: QuarterRead | null;
  quality: QualityScore | null;
  nasdaq: NasdaqRead | null;
}): WhyLine[] {
  const out: WhyLine[] = [];
  const { m, q, quality, nasdaq } = input;
  if (input.kind === 'momentum') {
    const top = input.signals
      .slice(0, 2)
      .map((s) => `${s.label} (${s.percentile >= 99 ? 'top 1%' : `better than ${s.percentile}%`} of stocks)`)
      .join('; ');
    out.push({ grade: 'A', stance: 'good', text: `Strong, steady rise${input.ret12m != null ? ` (${pct(input.ret12m)} in a year)` : ''}: ${top}. Strong stocks have tended to keep leading for some months.` });
  } else {
    out.push({
      grade: 'C',
      stance: 'good',
      text: `Fell ${((input.fall ?? Math.abs(m.fromHighPct) / 100) * 100).toFixed(0)}% from its high, has now turned up: back above its 50-day average, which is rising. In the 2012–26 test this pattern beat the market on average, unevenly.`,
    });
  }
  if (q?.revenueGrowth != null) {
    // A margin outside ±100% means the revenue tag does not fit this company
    // (insurers: MetLife showed 121%), so it is not shown or judged.
    const fits = (x: number | null) => x != null && Math.abs(x) <= 1;
    const both = fits(q.margin) && fits(q.marginYearAgo);
    const mUp = both ? q.margin! - q.marginYearAgo! : null;
    const marginTxt = both ? `; net margin ${(q.marginYearAgo! * 100).toFixed(1)}% → ${(q.margin! * 100).toFixed(1)}%` : '';
    const losing = q.margin != null && q.margin < 0;
    const good = q.revenueGrowth > 0 && (mUp == null || mUp >= 0) && !losing;
    const growthNoMargin = q.revenueGrowth > 0 && mUp != null && mUp < 0;
    out.push({
      grade: 'B',
      stance: good ? 'good' : 'bad',
      text:
        `Sales ${pct(q.revenueGrowth, 1)} vs the same quarter a year earlier (quarter to ${q.latestEnd})${marginTxt}.` +
        (losing ? ' ⚑ Still losing money in that quarter.' : growthNoMargin ? ' ⚑ Growing sales with shrinking margins has tended to disappoint.' : ''),
    });
  } else if (q?.latestEnd != null) {
    out.push({ grade: 'B', stance: 'info', text: `Latest quarter to ${q.latestEnd}; no matching quarter a year earlier in SEC filings to compare with.` });
  } else if (q?.latestEnd == null) {
    out.push({ grade: 'B', stance: 'info', text: 'No quarterly sales figure in SEC filings (banks and foreign filers report differently).' });
  }
  if (quality?.score != null) {
    out.push({
      grade: 'B',
      stance: quality.junk ? 'bad' : quality.score >= 0.5 ? 'good' : 'info',
      text: quality.junk
        ? `⚑ Weak finances (${quality.asOfYear} accounts): ${quality.weak.join(', ')}. Expect bigger falls.`
        : `Finances (${quality.asOfYear} accounts): profit ${((quality.roa ?? 0) * 100).toFixed(1)}% of assets, operating cash ${((quality.cfoa ?? 0) * 100).toFixed(1)}% of assets; stronger than ${Math.round(quality.score * 100)}% of the list.`,
    });
  }
  const e = nasdaq?.earnings;
  const s = (e?.surprises ?? []).filter((x) => x.surprise != null);
  if (s.length) {
    const beats = s.filter((x) => x.surprise! > 0).length;
    out.push({ grade: 'C', stance: beats >= Math.ceil(s.length * 0.75) ? 'good' : beats <= s.length / 4 ? 'bad' : 'info', text: `Beat analysts’ profit estimates in ${beats} of the last ${s.length} quarters (latest ${pct(s[0].surprise!, 0)}).` });
  }
  if (e && (e.revisionsUp ?? 0) + (e.revisionsDown ?? 0) > 0) {
    const up = e.revisionsUp ?? 0;
    const down = e.revisionsDown ?? 0;
    const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`;
    out.push({ grade: 'C', stance: up > down ? 'good' : up < down ? 'bad' : 'info', text: `Analysts raised profit estimates ${times(up)} and cut them ${times(down)} in the last 4 weeks.` });
  }
  return out;
}

export interface Outlook {
  /** Why it is suggested now: rank and what put it there. */
  why: string[];
  /** Why it may keep rising, each with its evidence grade. Never a promise. */
  growth: { grade: Grade; text: string }[];
  /** What could go wrong. Always at least one line. */
  risks: string[];
}

/**
 * The plain-words case for one pick: why it is on the list, why it may keep
 * rising, and what could go wrong. Built only from numbers already on the card
 * and the measured history of picks at the same rank tier. Wording says
 * "may", "has tended to", never "will". Pure.
 */
export function outlookFor(input: {
  rank: number;
  tier: 1 | 2;
  universe: number;
  sector: string;
  ret12m: number | null;
  volPct: number;
  signals: { label: string; percentile: number }[];
  q: QuarterRead | null;
  quality: QualityScore | null;
  nasdaq: NasdaqRead | null;
  analystUpside: number | null;
  earningsSoon: boolean;
  /** The tier's measured 1-year history: share up, picks vs all-stock averages per half. */
  history: { upRate: number; picksMean: [number, number]; allMean: [number, number]; edge: boolean } | null;
  /** How many of the shown names share this sector. */
  sectorPeers: number;
}): Outlook {
  const { q, quality, nasdaq } = input;
  const why: string[] = [];
  const growth: Outlook['growth'] = [];
  const risks: string[] = [];
  const pc = (x: number, dp = 0) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(dp)}%`;

  why.push(
    `Ranked #${input.rank} of ${input.universe} US-listed companies${input.tier === 2 ? ' (second tier: ranks 21–40)' : ''} for a strong, steady rise${input.ret12m != null ? ` (${pc(input.ret12m)} in a year)` : ''}, measured against other ${input.sector} companies.`,
  );
  const top = input.signals.slice(0, 2).map((s) => `${s.label.toLowerCase()} (${s.percentile >= 99 ? 'top 1%' : `better than ${s.percentile}%`})`);
  if (top.length) why.push(`Strongest signals: ${top.join('; ')}.`);
  why.push('Above its 200-day average, so its long trend is up.');

  const h = input.history;
  if (h) {
    const edge = [(h.picksMean[0] - h.allMean[0]) * 100, (h.picksMean[1] - h.allMean[1]) * 100];
    growth.push({
      grade: 'A',
      text:
        `Trends like this have tended to continue: since 2012, stocks at this rank were higher a year later ${Math.round(h.upRate * 100)}% of the time` +
        (h.edge ? `, and beat the average stock by ${edge[0].toFixed(1)} and ${edge[1].toFixed(1)} points a year in the two halves of the test.` : '; they did not beat the average stock in both halves.'),
    });
  }
  const mUp = q?.margin != null && q.marginYearAgo != null && Math.abs(q.margin) <= 1 && Math.abs(q.marginYearAgo) <= 1 ? q.margin - q.marginYearAgo : null;
  if (q?.revenueGrowth != null && q.revenueGrowth > 0 && (q.margin ?? 0) > 0 && (mUp == null || mUp >= 0)) {
    growth.push({
      grade: 'B',
      text: `The business behind the price is growing: sales ${pc(q.revenueGrowth, 1)} on a year earlier${mUp != null ? `, with net margin up from ${(q.marginYearAgo! * 100).toFixed(1)}% to ${(q.margin! * 100).toFixed(1)}%` : ''}. Growth that comes with rising margins has tended to persist; growth without it has not.`,
    });
  }
  if (quality?.score != null && !quality.junk && quality.score >= 0.6) {
    growth.push({ grade: 'B', text: `Finances stronger than ${Math.round(quality.score * 100)}% of the list: profits backed by cash, so the rise is not resting on accounting.` });
  }
  const e = nasdaq?.earnings;
  const up = e?.revisionsUp ?? 0;
  const down = e?.revisionsDown ?? 0;
  if (up > down && up >= 2) {
    growth.push({ grade: 'C', text: `Analysts are raising profit forecasts (${up} up, ${down} down in 4 weeks). Rising forecasts have tended to come before further gains, though the effect is weak.` });
  }
  const s = (e?.surprises ?? []).filter((x) => x.surprise != null);
  const beats = s.filter((x) => x.surprise! > 0).length;
  if (s.length >= 3 && beats >= s.length - 1) {
    growth.push({ grade: 'C', text: `Beat profit estimates in ${beats} of the last ${s.length} quarters.` });
  }

  if (quality?.junk) risks.push(`Weak finances (${quality.weak.join(', ')}): such stocks fell harder in the test.`);
  if (mUp != null && mUp < 0 && (q?.revenueGrowth ?? 0) > 0) risks.push('Sales are growing but margins are shrinking; that combination has tended to disappoint.');
  if ((q?.margin ?? 0) < 0) risks.push('Still losing money in its latest quarter.');
  if (input.analystUpside != null && input.analystUpside < 0) risks.push(`Already ${Math.round(-input.analystUpside * 100)}% above the analysts’ average target, so much good news may be in the price.`);
  if (down > up && down >= 2) risks.push(`Analysts are cutting profit forecasts (${down} down, ${up} up in 4 weeks).`);
  if (input.earningsSoon) risks.push('Results are due within 7 days: the price can jump either way.');
  if (input.volPct >= 45) risks.push(`Swings about ${Math.round(input.volPct)}% a year: expect deep dips even if the trend holds.`);
  if (input.sectorPeers >= 3) risks.push(`${input.sectorPeers} of the names shown are ${input.sector}: owning several means one sector shock hits them together.`);
  if (h) risks.push(`Trends do reverse: ${100 - Math.round(h.upRate * 100)}% of stocks at this rank were lower a year later. Sell discipline matters more than the entry.`);
  return { why, growth, risks };
}

export const START_HERE = 40;

/**
 * "Start here": the highest-ranked picks with nothing to wait for. Skips names
 * with results due within 7 days, money held back (news veto or a red filing),
 * or weak finances (not worse on return in the test, but they fell harder; a
 * first buy should not be the riskiest one). Keeps rank order. Pure.
 */
export function readyNow<T extends { ticker: string; quality: { junk: boolean } | null; detail?: { earningsSoon: boolean; withheld: string | null } }>(
  picks: T[],
  n = START_HERE,
): { ready: string[]; skipped: { ticker: string; why: string }[] } {
  const ready: string[] = [];
  const skipped: { ticker: string; why: string }[] = [];
  for (const p of picks) {
    if (ready.length >= n) break;
    const why = p.detail?.withheld
      ? 'money held back: ' + p.detail.withheld
      : p.detail?.earningsSoon
        ? 'results due within 7 days'
        : p.quality?.junk
          ? 'weak finances (riskier first buy)'
          : null;
    if (why) skipped.push({ ticker: p.ticker, why });
    else ready.push(p.ticker);
  }
  return { ready, skipped };
}

/** Upside to the consensus target, fraction; negative when the price is above it. */
export function analystUpside(n: NasdaqRead | null, price: number): number | null {
  const t = n?.analyst?.target;
  return t != null && t > 0 ? t / price - 1 : null;
}

export { pct as fmtPct };

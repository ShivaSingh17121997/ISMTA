/**
 * "Bouncing back": US companies that fell hard, have stopped falling, and
 * still have a working business. Pure. Shared by the live page and the
 * backtest (foreign/bounceBacktest.ts), so what is tested is what is shown.
 *
 * WHY THESE GATES. The prototype test (FOREIGN_RECS_PLAN_V2.md §0, S&P 500,
 * 2012–2026, monthly) found:
 *   - "fallen 20–75%" alone, or "fallen and above the 50-day average" alone,
 *     did not beat holding everything;
 *   - fallen 20–75% AND above a RISING 50-day average AND up over 3 months
 *     beat it in both halves, unevenly (9 of 15 years);
 *   - fallen 40–75% lost money even with survivorship helping it.
 * The Indian Turnarounds rules (smt-turnarounds) suggested business gates
 * (no loss-makers, no weak finances). The backtest did not support excluding
 * on them, so they are flags here; see `bounceVerdict`. A red SEC event or the
 * news veto still excludes.
 *
 * DEPTH IS A FILTER, NEVER A SCORE. Inside the 20–75% band a deeper fall earns
 * no credit; the rank is finances and the direction of sales and margins.
 * Falls of 40% or more carry a "higher risk" badge.
 */
import type { Candle } from '../../types';
import type { QualityScore } from './fundamentals';
import type { QuarterRead } from './quarterly';

export const MIN_FALL = 0.2;
export const MAX_FALL = 0.75;
export const DEEP_FALL = 0.4;
export const SECTION_CAP_PCT = 15;
export const FUNDED = 5;

export interface BounceFeatures {
  price: number;
  /** Fall from the 252-day high, fraction (0.3 = 30% below). */
  fall: number;
  sma50: number;
  /** The 50-day average 20 sessions ago. */
  sma50Prev: number;
  sma200: number;
  ret3m: number;
  low20: number;
}

/** Features from bars up to and including index `upTo`. Null with under 260 bars. Pure. */
export function bounceFeatures(bars: Candle[], upTo = bars.length - 1): BounceFeatures | null {
  if (upTo < 260) return null;
  const c = (k: number) => bars[k].close;
  const avg = (from: number, to: number) => {
    let s = 0;
    for (let k = from; k <= to; k++) s += c(k);
    return s / (to - from + 1);
  };
  let hi = 0;
  for (let k = upTo - 251; k <= upTo; k++) hi = Math.max(hi, c(k));
  let low20 = Infinity;
  for (let k = upTo - 19; k <= upTo; k++) low20 = Math.min(low20, bars[k].low);
  const price = c(upTo);
  return {
    price,
    fall: 1 - price / hi,
    sma50: avg(upTo - 49, upTo),
    sma50Prev: avg(upTo - 69, upTo - 20),
    sma200: avg(upTo - 199, upTo),
    ret3m: price / c(upTo - 63) - 1,
    low20,
  };
}

export interface BounceContext {
  quality: QualityScore | null;
  /** Latest quarter (live only; the backtest has annual figures only). */
  quarter?: QuarterRead | null;
  redEvent?: string | null;
  newsVeto?: boolean;
}

/** The price gates alone, in order. Null = passes. Pure. */
export function priceGate(f: BounceFeatures): string | null {
  if (f.fall < MIN_FALL) return null; // not a fallen stock: not this list's business (not a rejection)
  if (f.fall > MAX_FALL) return `down ${(f.fall * 100).toFixed(0)}% from its high: past 75% the odds of recovery collapse`;
  if (f.price <= f.sma50) return 'still falling: below its 50-day average';
  if (f.sma50 <= f.sma50Prev) return 'not turned yet: its 50-day average is still falling';
  if (f.ret3m <= 0) return 'not turned yet: lower than 3 months ago';
  return null;
}

export interface BounceVerdict {
  status: 'not-fallen' | 'rejected' | 'qualified';
  reason: string | null;
  /** Business problems: shown with a ⚑, not used to exclude (see below). */
  flags: string[];
}

/**
 * Price gates and hard risks EXCLUDE; business problems only FLAG.
 *
 * The plan was to exclude loss-makers and weak finances, as the Indian
 * Turnarounds list does. The point-in-time backtest (check B3, 2026-10-14)
 * said otherwise: with those exclusions the list returned 14.9%/yr against
 * 20.5% without them, and fell behind the plain fallen-stock basket in the
 * second half (13.4% vs 13.7%). The weakest companies bounced hardest. Part of
 * that is survivorship (the weak fallen companies that went bust are missing
 * from the data, so the test flatters exactly this group), so neither version
 * can be trusted to the decimal. The page therefore shows this section as a
 * WATCH-LIST WITHOUT A FUNDING PLAN, and marks business problems with a ⚑,
 * the same decision v1 made for weak finances (FOREIGN_RECS_CHECKLIST C14).
 *
 * Red SEC events and the news veto still exclude: they cannot be backtested
 * (no point-in-time history) and they are the events after which a low price
 * is information, not a discount. Pure.
 */
export function bounceVerdict(f: BounceFeatures, ctx: BounceContext): BounceVerdict {
  if (f.fall < MIN_FALL) return { status: 'not-fallen', reason: null, flags: [] };
  const flags: string[] = [];
  const q = ctx.quality;
  if (q?.roa != null && q.roa <= 0) flags.push('loss-making in its last annual accounts');
  else if (ctx.quarter?.latestProfit != null && ctx.quarter.latestProfit < 0) flags.push('loss-making in its latest quarter');
  if (q?.junk) flags.push(`weak finances (${q.weak.join(', ') || 'bottom 20% on quality'})`);
  if (q?.score == null) flags.push('no SEC accounts to check the business against');
  if (f.fall >= DEEP_FALL) flags.push(`down ${(f.fall * 100).toFixed(0)}%: falls this deep did worst in the test`);
  const p = priceGate(f);
  if (p) return { status: 'rejected', reason: p, flags };
  if (ctx.redEvent) return { status: 'rejected', reason: `SEC filing: ${ctx.redEvent}`, flags };
  if (ctx.newsVeto) return { status: 'rejected', reason: 'news veto: mostly negative headlines this week', flags };
  return { status: 'qualified', reason: null, flags };
}

/** True when the business checks found nothing (the stricter backtest line). Pure. */
export const businessClean = (v: BounceVerdict): boolean => v.status === 'qualified' && !v.flags.some((x) => !x.startsWith('down '));

/** Rank inside the list: finances and business direction, never depth. 0..100. Pure. */
export function bounceScore(ctx: BounceContext): number {
  let s = (ctx.quality?.score ?? 0) * 100;
  const q = ctx.quarter;
  if (q?.revenueGrowth != null && q.revenueGrowth < 0) s *= 0.85;
  if (q?.margin != null && q.marginYearAgo != null && q.margin < q.marginYearAgo) s *= 0.9;
  return Math.round(s * 10) / 10;
}

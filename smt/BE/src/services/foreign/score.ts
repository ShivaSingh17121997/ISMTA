/**
 * Foreign-stock scoring: the Indian recommender's medium-horizon scorer, plus
 * the junk veto, on US-listed shares. Pure.
 *
 * Reused, not rewritten: `measure()` and `scoreHorizon('medium')` from
 * services/recommender. Medium (1–6 months) is the best-evidenced horizon in
 * that module's own notes, it is sector-relative (GICS sectors here), and it
 * already vetoes anything below its 200-day average or too illiquid to trade.
 * Eligibility is restated in dollars: a $5 price floor and $20m median daily
 * turnover (every S&P 500 name clears it; it exists for the ADR tail).
 *
 * Order matters: junk is removed BEFORE ranking, so weak companies cannot sit
 * in the percentile pool and shift everyone else's rank.
 */
import { measure, type Metrics } from '../recommender/metrics';
import { scoreHorizon, type EligibilityParams, type HorizonScore } from '../recommender/score';
import type { Candle } from '../../types';
import type { QualityScore } from './fundamentals';

export const USD_ELIGIBILITY: EligibilityParams = { minTurnover: 20_000_000, minPrice: 5 };
/** How many measured bars `measure()` is given (it needs ~280; more only slows it down). */
export const LOOKBACK_BARS = 320;

export interface ForeignScore extends HorizonScore {
  quality: QualityScore | null;
}

/** Measure from the bars up to and including index `upTo` (inclusive), never later. */
export function measureAt(symbol: string, bars: Candle[], upTo = bars.length - 1): Metrics | null {
  if (upTo < 0) return null;
  return measure(symbol, bars.slice(Math.max(0, upTo - LOOKBACK_BARS + 1), upTo + 1));
}

/** The same three vetoes as the NSE scorer, worded in dollars. */
export function usdVetoReason(m: Metrics): string | null {
  if (m.lastClose < USD_ELIGIBILITY.minPrice) return `trades at $${m.lastClose.toFixed(2)}, below the $${USD_ELIGIBILITY.minPrice} floor`;
  if (m.medianTurnover < USD_ELIGIBILITY.minTurnover) {
    return `median daily turnover of $${(m.medianTurnover / 1e6).toFixed(1)}m is below the $${USD_ELIGIBILITY.minTurnover / 1e6}m floor, too thin to trade cleanly`;
  }
  if (!m.aboveSma200) return 'below its 200-day average: a downtrend is not recommended, whatever else it scores';
  return null;
}

/**
 * `vetoJunk` decides whether weak finances EXCLUDE a stock or only flag it.
 * The point-in-time backtest (FOREIGN_RECS_CHECKLIST.md) found the veto did not
 * help returns in both halves, so the live page ranks with `vetoJunk: false`
 * and shows weak finances as a risk flag. The veto path is kept for the
 * backtest comparison.
 */
export function scoreForeign(
  metrics: Metrics[],
  sectors: Map<string, string>,
  quality: Map<string, QualityScore>,
  opts: { vetoJunk?: boolean } = {},
): ForeignScore[] {
  const vetoJunk = opts.vetoJunk ?? true;
  const clean: Metrics[] = [];
  const junk: Metrics[] = [];
  for (const m of metrics) (vetoJunk && quality.get(m.symbol)?.junk ? junk : clean).push(m);
  const bySym = new Map(metrics.map((m) => [m.symbol, m] as const));
  const scored: ForeignScore[] = scoreHorizon(clean, 'medium', USD_ELIGIBILITY, sectors).map((s) => ({
    ...s,
    // The shared veto text is written in rupees for NSE stocks; restate it in dollars.
    vetoReason: s.vetoed ? usdVetoReason(bySym.get(s.symbol)!) ?? s.vetoReason : s.vetoReason,
    quality: quality.get(s.symbol) ?? null,
  }));
  for (const m of junk) {
    const q = quality.get(m.symbol)!;
    scored.push({
      symbol: m.symbol,
      horizon: 'medium',
      score: 0,
      verdict: 'weak',
      signals: [],
      vetoed: true,
      vetoReason: `weak finances (bottom ${Math.round(100 * 0.2)}% on quality${q.weak.length ? `: ${q.weak.join(', ')}` : ''})`,
      quality: q,
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

/** At most this many picks from one sector: one shock (an oil spike, a chip cycle) should not decide the whole list. */
export const MAX_PER_SECTOR = 4;

/**
 * The next tier: the best `n` eligible stocks NOT in `tier1`, under the same
 * sector cap counted afresh. Used by the live page ("Start here", ranks 21–40)
 * and by the horizon study, so the second tier is measured exactly as shown. Pure.
 */
export function pickNextTier(scored: ForeignScore[], tier1: Set<string>, n: number, sectors: Map<string, string>, maxPerSector = MAX_PER_SECTOR): ForeignScore[] {
  return pickTop(
    scored.filter((s) => !tier1.has(s.symbol)),
    n,
    sectors,
    maxPerSector,
  );
}

/**
 * The top `n` eligible stocks in score order, skipping any that would put more
 * than `maxPerSector` in one sector. Used by both the live page and the
 * backtest, so what is tested is what is shown. Pure.
 */
export function pickTop(scored: ForeignScore[], n: number, sectors: Map<string, string>, maxPerSector = MAX_PER_SECTOR): ForeignScore[] {
  const count = new Map<string, number>();
  const out: ForeignScore[] = [];
  for (const s of scored) {
    if (s.vetoed) continue;
    const sec = sectors.get(s.symbol) ?? `__${s.symbol}`;
    if ((count.get(sec) ?? 0) >= maxPerSector) continue;
    count.set(sec, (count.get(sec) ?? 0) + 1);
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

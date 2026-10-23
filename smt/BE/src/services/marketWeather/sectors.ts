/**
 * Sector playbook: how each NSE industry behaved in past index falls, and in
 * the six months after the bottom. Pure.
 *
 * Baskets are equal-weight, rebalanced daily, over the CURRENT NIFTY 500
 * members of each NSE industry (recommender/sectors.ts). Two biases follow and
 * are stated wherever the numbers appear:
 *
 *   - survivorship: members that collapsed or were dropped are missing, so
 *     every basket looks a little better than it was;
 *   - equal weight drifts ABOVE the cap-weighted index over time, so a basket's
 *     "relative" number carries that drift. Falls are short, so the drift is
 *     small there; the 6-month rebound is longer and carries more of it.
 *
 * What the research found (MARKET_WEATHER.md) and these numbers recompute: the
 * same defensive sectors hold up in almost every fall and the same cyclicals
 * lead the rebound. What does NOT work is trading sectors on macro data after a
 * shock is visible — the move happens on impact day — so this table describes
 * what to expect, never a trade to make.
 */
import type { Drawdown } from './calibrate';
import type { Series } from './series';

export const MIN_BASKET_MEMBERS = 3;
/** A daily move larger than this in one stock is treated as a bad print and ignored. */
const MAX_DAILY_MOVE = 0.4;

export interface Basket {
  sector: string;
  members: string[];
  /** Index level on each axis date; null before the basket has enough members. */
  level: (number | null)[];
}

/** Equal-weight daily-rebalanced baskets per sector on `axis`. */
export function buildBaskets(axis: string[], stocks: Map<string, Series>, sectorOf: Map<string, string>): Basket[] {
  const groups = new Map<string, string[]>();
  for (const sym of stocks.keys()) {
    const sec = sectorOf.get(sym);
    if (!sec) continue;
    const g = groups.get(sec) ?? [];
    g.push(sym);
    groups.set(sec, g);
  }
  const pos = new Map(axis.map((d, i) => [d, i] as const));
  const out: Basket[] = [];
  for (const [sector, members] of groups) {
    if (members.length < MIN_BASKET_MEMBERS) continue;
    const sum = new Float64Array(axis.length);
    const cnt = new Int32Array(axis.length);
    for (const m of members) {
      const s = stocks.get(m)!;
      for (let k = 1; k < s.dates.length; k++) {
        const at = pos.get(s.dates[k]);
        // Only count a return when the previous bar is the previous axis day,
        // so a gap in one stock is not read as a one-day move.
        if (at === undefined || at === 0 || s.dates[k - 1] !== axis[at - 1]) continue;
        const r = s.close[k] / s.close[k - 1] - 1;
        if (!Number.isFinite(r) || Math.abs(r) > MAX_DAILY_MOVE) continue;
        sum[at] += r;
        cnt[at]++;
      }
    }
    const level: (number | null)[] = [];
    let v: number | null = null;
    for (let i = 0; i < axis.length; i++) {
      // Too few members that day: hold the level rather than read one stock as the sector.
      if (cnt[i] >= MIN_BASKET_MEMBERS) v = (v ?? 100) * (1 + sum[i] / cnt[i]);
      level.push(v);
    }
    // Leave the level null until the basket first had enough members.
    const first = Array.from(cnt).findIndex((c) => c >= MIN_BASKET_MEMBERS);
    for (let i = 0; i < Math.max(0, first); i++) level[i] = null;
    out.push({ sector, members: members.sort(), level });
  }
  return out.sort((a, b) => a.sector.localeCompare(b.sector));
}

export interface SectorEpisode {
  peak: string;
  trough: string;
  marketPct: number;
  /** Basket return minus index return, peak → trough, percentage points. */
  relInFallPp: number | null;
  /** Basket minus index over the 126 trading days after the trough. */
  relReboundPp: number | null;
}

export interface SectorCalibration {
  sector: string;
  members: number;
  /** Mean relative return during falls, pp, and how many falls it beat the index in. */
  inFall: { meanPp: number | null; beat: number; n: number };
  rebound: { meanPp: number | null; beat: number; n: number };
  /** Daily beta to the index on its down days and on its up days, since `betaFrom`. */
  downBeta: number | null;
  upBeta: number | null;
  episodes: SectorEpisode[];
}

const REBOUND_DAYS = 126;

function at(axis: string[], d: string): number {
  return axis.findIndex((x) => x >= d);
}

/** Down-day and up-day betas of `y` against `x` over aligned indexes from `from`. */
export function splitBeta(x: (number | null)[], y: (number | null)[], from: number): { down: number | null; up: number | null } {
  let sd = 0;
  let sdd = 0;
  let su = 0;
  let suu = 0;
  for (let i = Math.max(1, from); i < x.length; i++) {
    const a0 = x[i - 1];
    const a1 = x[i];
    const b0 = y[i - 1];
    const b1 = y[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    const rm = a1 / a0 - 1;
    const rs = b1 / b0 - 1;
    if (rm < 0) {
      sd += rs * rm;
      sdd += rm * rm;
    } else if (rm > 0) {
      su += rs * rm;
      suu += rm * rm;
    }
  }
  const r = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) / 100 : null);
  return { down: r(sd, sdd), up: r(su, suu) };
}

export function sectorPlaybook(
  axis: string[],
  close: number[],
  baskets: Basket[],
  falls: Drawdown[],
  betaFrom = '2010-01-01',
): SectorCalibration[] {
  const bFrom = Math.max(0, at(axis, betaFrom));
  return baskets
    .map((b) => {
      const episodes: SectorEpisode[] = falls.map((f) => {
        const p = at(axis, f.peak);
        const t = at(axis, f.trough);
        const mk = close[t] / close[p] - 1;
        const bp = b.level[p];
        const bt = b.level[t];
        const t6 = t + REBOUND_DAYS;
        const b6 = t6 < axis.length ? b.level[t6] : null;
        const mk6 = t6 < axis.length ? close[t6] / close[t] - 1 : null;
        return {
          peak: f.peak,
          trough: f.trough,
          marketPct: Math.round(mk * 1000) / 10,
          relInFallPp: bp != null && bt != null ? Math.round((bt / bp - 1 - mk) * 1000) / 10 : null,
          relReboundPp: bt != null && b6 != null && mk6 != null ? Math.round((b6 / bt - 1 - mk6) * 1000) / 10 : null,
        };
      });
      const agg = (vals: (number | null)[]): { meanPp: number | null; beat: number; n: number } => {
        const v = vals.filter((x): x is number => x != null);
        return {
          meanPp: v.length ? Math.round((v.reduce((a, c) => a + c, 0) / v.length) * 10) / 10 : null,
          beat: v.filter((x) => x > 0).length,
          n: v.length,
        };
      };
      const beta = splitBeta(close, b.level, bFrom);
      return {
        sector: b.sector,
        members: b.members.length,
        inFall: agg(episodes.map((e) => e.relInFallPp)),
        rebound: agg(episodes.map((e) => e.relReboundPp)),
        downBeta: beta.down,
        upBeta: beta.up,
        episodes,
      };
    })
    .filter((s) => s.inFall.n > 0)
    .sort((a, b) => (b.inFall.meanPp ?? -99) - (a.inFall.meanPp ?? -99));
}

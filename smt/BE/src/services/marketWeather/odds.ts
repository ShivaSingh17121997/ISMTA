/**
 * Odds and analogs: turning calibration into what the screen says. Pure.
 *
 * GRADES. A sign earns trust only by working in BOTH halves of history:
 *
 *   A  lift ≥ 1.2 in both halves, with at least 5 episodes in each
 *   B  lift ≥ 1.2 in both halves, but fewer episodes — promising, small sample
 *   C  everything else — shown as context, with its numbers, carrying no weight
 *
 * A sign whose lift is BELOW 0.8 in both halves preceded fewer falls than
 * normal; it is labelled that way rather than hidden, because "high VIX means
 * sell" is a belief the user will otherwise act on.
 *
 * ANALOGS. Past days whose drawdown and breadth looked like today's, with what
 * the index did over the following 3, 6 and 12 months. Days overlap heavily, so
 * the result reports EPISODES and the full spread (median, worst tenth, best
 * tenth), never a single expected number.
 */
import type { Calibration, SignalCalibration } from './calibrate';
import { FALL_THRESHOLD, HORIZON_DAYS } from './calibrate';
import { forwardReturn, forwardWorst, quantile } from './series';
import { kindOf, SIGNAL_BY_ID, type MarketState, type Prepared, type SignalId, type SignalKind } from './regime';

export type Grade = 'A' | 'B' | 'C';
export type Direction = 'higher' | 'lower' | 'mixed';

export const GRADE_MIN_LIFT = 1.2;
export const GRADE_MIN_EPISODES = 5;

/**
 * Grade by what the sign claims. A warning is judged on 10%+ falls within 3
 * months; a turbulence sign on 5%+ dips within the next month; a calm sign on
 * the next 3 months' return beating the normal return by at least a point in
 * both halves.
 */
export function gradeOf(sc: SignalCalibration, kind: SignalKind = kindOf(sc.id)): { grade: Grade; direction: Direction; reason: string } {
  if (kind === 'turbulence' && sc.turbulence) return gradeTurbulence(sc);
  if (kind === 'calm') return gradeCalm(sc);
  return gradeWarning(sc);
}

function gradeTurbulence(sc: SignalCalibration): { grade: Grade; direction: Direction; reason: string } {
  const [a, b] = sc.turbulence!.halves;
  const la = a.lift ?? 0;
  const lb = b.lift ?? 0;
  const enough = a.episodes >= GRADE_MIN_EPISODES && b.episodes >= GRADE_MIN_EPISODES;
  if (a.lift != null && b.lift != null && la >= GRADE_MIN_LIFT && lb >= GRADE_MIN_LIFT) {
    return {
      grade: enough ? 'A' : 'B',
      direction: 'higher',
      reason: `A 5%+ dip within the next month was more likely in both halves of history (${la}× and ${lb}×)${enough ? '' : `, from only ${a.episodes} and ${b.episodes} episodes`}. It signals rough weeks, not a crash.`,
    };
  }
  return { grade: 'C', direction: 'mixed', reason: `Next-month dips were not reliably more likely (${la}× and ${lb}×), so it carries no weight.` };
}

function gradeCalm(sc: SignalCalibration): { grade: Grade; direction: Direction; reason: string } {
  const [a, b] = sc.halves;
  const [ba, bb] = sc.baseFwdRet ?? [null, null];
  const da = a.meanFwdRet != null && ba != null ? a.meanFwdRet - ba : null;
  const db = b.meanFwdRet != null && bb != null ? b.meanFwdRet - bb : null;
  const pp = (x: number | null): string => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pts`);
  const enough = a.episodes >= GRADE_MIN_EPISODES && b.episodes >= GRADE_MIN_EPISODES;
  if (da != null && db != null && da >= 0.01 && db >= 0.01) {
    return {
      grade: enough ? 'A' : 'B',
      direction: 'lower',
      reason: `The next 3 months beat the normal return in both halves of history (${pp(da)} and ${pp(db)}).`,
    };
  }
  return { grade: 'C', direction: 'mixed', reason: `The next 3 months did not reliably beat the normal return (${pp(da)} and ${pp(db)}).` };
}

function gradeWarning(sc: SignalCalibration): { grade: Grade; direction: Direction; reason: string } {
  const [a, b] = sc.halves;
  const la = a.lift ?? 0;
  const lb = b.lift ?? 0;
  const enough = a.episodes >= GRADE_MIN_EPISODES && b.episodes >= GRADE_MIN_EPISODES;
  if (a.lift != null && b.lift != null && la >= GRADE_MIN_LIFT && lb >= GRADE_MIN_LIFT) {
    return enough
      ? { grade: 'A', direction: 'higher', reason: `Falls were more likely in both halves of history (${la}× and ${lb}×).` }
      : {
          grade: 'B',
          direction: 'higher',
          reason: `Falls were more likely in both halves (${la}× and ${lb}×), but from only ${a.episodes} and ${b.episodes} separate episodes.`,
        };
  }
  if (a.lift != null && b.lift != null && la < 0.8 && lb < 0.8) {
    return { grade: 'C', direction: 'lower', reason: `Falls were LESS likely than normal after this, in both halves (${la}× and ${lb}×).` };
  }
  if (a.lift == null || b.lift == null) {
    return { grade: 'C', direction: 'mixed', reason: 'Not enough history in one half to test it.' };
  }
  return { grade: 'C', direction: 'mixed', reason: `Worked in one half of history and not the other (${la}× and ${lb}×), so it carries no weight.` };
}

export interface SignalRead {
  id: SignalId;
  kind: SignalKind;
  label: string;
  detail: string;
  on: boolean | null;
  grade: Grade;
  direction: Direction;
  reason: string;
  /** Chance of a 10%+ fall within 3 months on days this sign was on (whole history). */
  oddsWhenOn: number | null;
  baseline: number | null;
  liftHalves: [number | null, number | null];
  episodes: number;
  meanFwdRet: number | null;
  /** The same odds in the recent half only (since `recentFrom`), and that half's baseline. */
  oddsRecent: number | null;
  baselineRecent: number | null;
  recentFrom: string | null;
  /** Turbulence test: chance of a 5%+ dip within the next month while on, and normally. */
  dipOddsWhenOn: number | null;
  dipBaseline: number | null;
}

/** Every sign with today's state and its evidence. Active first, then by grade. */
export function readSignals(cal: Calibration, state: MarketState): SignalRead[] {
  const rank: Record<Grade, number> = { A: 0, B: 1, C: 2 };
  return cal.signals
    .filter((sc) => SIGNAL_BY_ID.has(sc.id))
    .map((sc) => {
      const def = SIGNAL_BY_ID.get(sc.id)!;
      const g = gradeOf(sc);
      const on = state.unavailable.includes(sc.id) ? null : state.active.includes(sc.id);
      const kind = kindOf(sc.id);
      const lifts: [number | null, number | null] =
        kind === 'turbulence' && sc.turbulence ? [sc.turbulence.halves[0].lift, sc.turbulence.halves[1].lift] : [sc.halves[0].lift, sc.halves[1].lift];
      // Baselines over the days this sign can be read: hitRate ÷ lift recovers them.
      const baseOf = (c: { hitRate: number | null; lift: number | null }): number | null =>
        c.hitRate != null && c.lift ? Math.round((c.hitRate / c.lift) * 1000) / 1000 : null;
      return {
        id: sc.id,
        kind,
        label: def.label,
        detail: def.detail,
        on,
        ...g,
        oddsWhenOn: sc.all.hitRate,
        baseline: baseOf(sc.all) ?? cal.baseline.all.hitRate,
        liftHalves: lifts,
        episodes: kind === 'turbulence' && sc.turbulence ? sc.turbulence.all.episodes : sc.all.episodes,
        meanFwdRet: sc.all.meanFwdRet,
        oddsRecent: sc.halves[1].hitRate,
        baselineRecent: baseOf(sc.halves[1]) ?? cal.baseline.halves[1].hitRate,
        recentFrom: sc.split ?? cal.split,
        dipOddsWhenOn: sc.turbulence?.all.hitRate ?? null,
        dipBaseline: sc.turbulence ? baseOf(sc.turbulence.all) : null,
      };
    })
    .sort((x, y) => Number(y.on === true) - Number(x.on === true) || rank[x.grade] - rank[y.grade]);
}

// ── Analogs ────────────────────────────────────────────────────────────────

export interface AnalogSpec {
  /** Drawdown from the all-time high, inclusive band, as fractions (e.g. -0.25..-0.12). */
  ddLo: number;
  ddHi: number;
  /** Breadth upper bound (exclusive), when today's breadth is weak. */
  breadthMax: number | null;
  /** Human description of the match. */
  describe: string;
}

/** Bands wide enough to find episodes, narrow enough to mean something. */
export function analogSpecFor(state: MarketState): AnalogSpec {
  const dd = state.fromAthPct / 100;
  let ddLo: number;
  let ddHi: number;
  if (dd > -0.05) {
    ddLo = -0.05;
    ddHi = 0.0001;
  } else if (dd > -0.1) {
    ddLo = -0.1;
    ddHi = -0.05;
  } else if (dd > -0.25) {
    ddLo = Math.max(-0.25, dd - 0.06);
    ddHi = Math.min(-0.1, dd + 0.06);
    if (ddHi - ddLo < 0.08) ddLo = ddHi - 0.08;
  } else {
    ddLo = -0.6;
    ddHi = -0.25;
  }
  const b = state.breadthPct;
  const breadthMax = b == null ? null : b < 30 ? 0.3 : b < 50 ? 0.5 : null;
  const pctTxt = (x: number): string => `${Math.round(-x * 100)}%`;
  const ddTxt = ddHi > 0 ? `within 5% of its high` : `${pctTxt(ddHi)}–${pctTxt(ddLo)} below its high`;
  return {
    ddLo,
    ddHi,
    breadthMax,
    describe: `Index ${ddTxt}${breadthMax != null ? ` and fewer than ${Math.round(breadthMax * 100)}% of stocks above their 200-day` : ''}`,
  };
}

export interface ForwardSpread {
  horizonDays: number;
  days: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  shareHigher: number | null;
}

export interface Analogs {
  spec: AnalogSpec;
  /** Start dates of separate episodes (on-days more than 63 trading days apart). */
  episodes: string[];
  /** Episodes with a full 12-month forward window. */
  completeEpisodes: number;
  forward: ForwardSpread[];
  /** Share of matching days followed by another 10%+ fall within 3 months. */
  furtherFallOdds: number | null;
  /** Worst tenth of the lowest point over the next 12 months. */
  worstFurtherFallP10: number | null;
  baselineForward: ForwardSpread[];
  baselineFallOdds: number | null;
  /** The same two odds counting only days since RECENT_FROM: the market has been calmer since 2012. */
  recentFrom: string;
  furtherFallOddsRecent: number | null;
  baselineFallOddsRecent: number | null;
  recentMatchDays: number;
}

/** Start of the recent era: 10% falls within 3 months followed 34% of days before it and 9% after. */
export const RECENT_FROM = '2012-01-01';

const ANALOG_EPISODE_GAP = 63;

function spread(close: number[], days: number[], h: number): ForwardSpread {
  const r = days.map((i) => forwardReturn(close, i, h)).filter((x): x is number => x != null);
  return {
    horizonDays: h,
    days: r.length,
    median: quantile(r, 0.5),
    p10: quantile(r, 0.1),
    p90: quantile(r, 0.9),
    shareHigher: r.length ? r.filter((x) => x > 0).length / r.length : null,
  };
}

export function findAnalogs(p: Prepared, spec: AnalogSpec, upTo = p.axis.length): Analogs {
  const match: number[] = [];
  const all: number[] = [];
  for (let i = 252; i < upTo; i++) {
    all.push(i);
    const dd = p.close[i] / p.ath[i] - 1;
    if (dd < spec.ddLo || dd > spec.ddHi) continue;
    if (spec.breadthMax != null) {
      const b = p.breadth[i];
      if (b == null || b >= spec.breadthMax) continue;
    }
    match.push(i);
  }
  const episodes: string[] = [];
  const starts: number[] = [];
  let last = -Infinity;
  for (const i of match) {
    if (i - last > ANALOG_EPISODE_GAP) {
      episodes.push(p.axis[i]);
      starts.push(i);
    }
    last = i;
  }
  const fallOdds = (days: number[]): number | null => {
    const w = days.map((i) => forwardWorst(p.close, i, HORIZON_DAYS)).filter((x): x is number => x != null);
    return w.length ? w.filter((x) => x <= FALL_THRESHOLD).length / w.length : null;
  };
  const worst12 = match.map((i) => forwardWorst(p.close, i, 252)).filter((x): x is number => x != null);
  const recent = (xs: number[]): number[] => xs.filter((i) => p.axis[i] >= RECENT_FROM);
  return {
    recentFrom: RECENT_FROM,
    furtherFallOddsRecent: fallOdds(recent(match)),
    baselineFallOddsRecent: fallOdds(recent(all)),
    recentMatchDays: recent(match).length,
    spec,
    episodes,
    completeEpisodes: starts.filter((i) => i + 252 < p.close.length).length,
    forward: [63, 126, 252].map((h) => spread(p.close, match, h)),
    furtherFallOdds: fallOdds(match),
    worstFurtherFallP10: quantile(worst12, 0.1),
    baselineForward: [63, 126, 252].map((h) => spread(p.close, all, h)),
    baselineFallOdds: fallOdds(all),
  };
}

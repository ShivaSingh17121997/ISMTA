/**
 * Market regime: the state of the market on a date, and which warning signs
 * are on. Pure.
 *
 * This module only MEASURES. Whether a sign means anything is decided by
 * calibrate.ts against history, and graded there — a sign that is "on" here is
 * a fact about today, not a forecast. Most of these signs failed in one half of
 * history or the other (MARKET_WEATHER.md); they are kept so the screen can say
 * so with numbers, instead of leaving the user to wonder about them.
 *
 * Every input that closes after NSE (US markets, Brent, gold, USD/INR) is read
 * at its PREVIOUS close — see series.ts. Using the same-date close would leak
 * up to ten hours of future information into every backtest.
 */
import type { BreadthRow } from './breadth';
import { GAUGES, type GaugeSeries } from './data';
import { alignTo, change, expandingPct, rollingMax, runningMax, sma, type Series } from './series';

export interface Prepared {
  indexKey: string;
  axis: string[];
  close: number[];
  sma50: (number | null)[];
  sma200: (number | null)[];
  hi252: number[];
  ath: number[];
  indiaVix: (number | null)[];
  spx: (number | null)[];
  spxSma200: (number | null)[];
  usVix: (number | null)[];
  brent: (number | null)[];
  usdinr: (number | null)[];
  us10y: (number | null)[];
  gold: (number | null)[];
  breadth: (number | null)[];
  at52wLow: (number | null)[];
  breadthCoverage: number[];
  /** Consecutive axis days (including today) with Brent above $90 / $100. */
  brentDaysAbove90: number[];
  brentDaysAbove100: number[];
  /** Cumulative advance–decline line (sum of daily net advancers share). */
  adLine: (number | null)[];
  /** Spread of 1-month returns across stocks, and its expanding percentile. */
  dispersion: (number | null)[];
  dispersionPct: (number | null)[];
  /** Defensive basket ÷ cyclical basket, change over 63 sessions. */
  defCyc63: (number | null)[];
  /** Index realised volatility over 21 sessions (annualised), and its expanding percentile. */
  rv21: (number | null)[];
  rvPct: (number | null)[];
  /** S&P 500 change over 21 sessions (previous US close). */
  spx21: (number | null)[];
  /** Variance risk premium: India VIX² minus 21-session realised variance; and its expanding percentile. */
  vrp: (number | null)[];
  vrpPct: (number | null)[];
  /** US 10-year minus 3-month yield, percentage points (previous US close). */
  curve: (number | null)[];
  us3m: (number | null)[];
}

export function prepare(index: Series, gauges: GaugeSeries, breadth: BreadthRow[] = []): Prepared {
  const axis = index.dates;
  const close = index.close;
  const al = (k: keyof typeof GAUGES): (number | null)[] => alignTo(axis, gauges[k], GAUGES[k].lag);
  // S&P's own 200-day is computed on ITS calendar, then aligned with the lag.
  const spxS = gauges.spx;
  const spxSmaSeries: Series | undefined = spxS
    ? (() => {
        const m = sma(spxS.close, 200);
        const dates: string[] = [];
        const vals: number[] = [];
        m.forEach((v, i) => {
          if (v != null) {
            dates.push(spxS.dates[i]);
            vals.push(v);
          }
        });
        return { key: 'spxSma200', dates, close: vals };
      })()
    : undefined;
  const brent = al('brent');
  const run = (th: number): number[] => {
    let n = 0;
    return brent.map((b) => (n = b != null && b > th ? n + 1 : 0));
  };
  const bmap = new Map(breadth.map((r) => [r.date, r] as const));
  const rows = axis.map((d) => bmap.get(d));
  // A/D line: a running sum, carried across days with too few stocks to read.
  let ad = 0;
  let adSeen = false;
  const adLine = rows.map((r) => {
    if (r?.advNet == null) return adSeen ? ad : null;
    adSeen = true;
    return (ad += r.advNet);
  });
  const dispersion = rows.map((r) => r?.dispersion21 ?? null);
  // Defensive ÷ cyclical as two compounding baskets.
  let dv = 100;
  let cv = 100;
  const ratio = rows.map((r) => {
    if (r?.defRet == null || r?.cycRet == null) return null;
    dv *= 1 + r.defRet;
    cv *= 1 + r.cycRet;
    return dv / cv;
  });
  const rv21 = close.map((_, i) => {
    if (i < 21) return null;
    let a = 0;
    let b = 0;
    for (let k = i - 20; k <= i; k++) {
      const r = Math.log(close[k] / close[k - 1]);
      a += r;
      b += r * r;
    }
    return Math.sqrt(Math.max(0, b / 21 - (a / 21) ** 2) * 252);
  });
  const indiaVix = al('indiaVix');
  const vrp = rv21.map((rv, i) => (rv == null || indiaVix[i] == null ? null : (indiaVix[i]! / 100) ** 2 - rv * rv));
  const us10y = al('us10y');
  const us3m = al('us3m');
  const spx = al('spx');
  return {
    indexKey: index.key,
    axis,
    close,
    sma50: sma(close, 50),
    sma200: sma(close, 200),
    hi252: rollingMax(close, 252),
    ath: runningMax(close),
    indiaVix,
    spx,
    spxSma200: alignTo(axis, spxSmaSeries, true),
    usVix: al('usVix'),
    brent,
    usdinr: al('usdinr'),
    us10y,
    gold: al('gold'),
    breadth: axis.map((d) => bmap.get(d)?.above200 ?? null),
    at52wLow: axis.map((d) => bmap.get(d)?.at52wLow ?? null),
    breadthCoverage: axis.map((d) => bmap.get(d)?.coverage ?? 0),
    brentDaysAbove90: run(90),
    brentDaysAbove100: run(100),
    adLine,
    dispersion,
    dispersionPct: expandingPct(dispersion),
    defCyc63: ratio.map((v, i) => (i >= 63 && v != null && ratio[i - 63] != null ? v / ratio[i - 63]! - 1 : null)),
    rv21,
    rvPct: expandingPct(rv21),
    spx21: spx.map((_, i) => change(spx, i, 21)),
    vrp,
    vrpPct: expandingPct(vrp),
    curve: us10y.map((y, i) => (y != null && us3m[i] != null ? y - us3m[i]! : null)),
    us3m,
  };
}

export type SignalId =
  | 'breadthDivergence'
  | 'vixSpike'
  | 'below200'
  | 'deathCross'
  | 'spxBelow200'
  | 'oilShock'
  | 'indiaVixHigh'
  | 'usVixHigh'
  | 'rupeeWeak'
  | 'yieldsUp'
  | 'overheated'
  | 'washedOut'
  | 'rally50'
  | 'vixComplacent'
  | 'newLowsSpread'
  | 'adDivergence'
  | 'dispersionHigh'
  | 'defensiveRotation'
  | 'curveResteepen'
  | 'volatilityHigh'
  | 'spxMonthDown'
  | 'vrpLow'
  | 'vrpHigh';

/**
 * What a sign is tested against:
 *   warning     a 10%+ fall within 3 months (63 sessions)
 *   turbulence  a 5%+ dip within the next month (21 sessions): rough weeks, not crashes
 *   calm        forward 3-month returns above normal: a "keep buying" cue
 */
export type SignalKind = 'warning' | 'turbulence' | 'calm';

export interface SignalDef {
  id: SignalId;
  /** Defaults to 'warning'. */
  kind?: SignalKind;
  label: string;
  /** What it measures, in plain words, for the screen. */
  detail: string;
  /** true / false, or null when its inputs are unavailable on that date. */
  test: (p: Prepared, i: number) => boolean | null;
}

const both = (a: number | null | undefined, b: number | null | undefined): a is number => a != null && b != null;

export const SIGNALS: SignalDef[] = [
  {
    id: 'breadthDivergence',
    label: 'Index near its high while most stocks are not',
    detail: 'Index within 2% of its 52-week high, but fewer than 60% of NIFTY 500 stocks above their own 200-day average.',
    test: (p, i) => (p.breadth[i] == null ? null : p.close[i] >= p.hi252[i] * 0.98 && p.breadth[i]! < 0.6),
  },
  {
    id: 'vixSpike',
    kind: 'turbulence',
    label: 'India VIX up 30%+ over the last 5 days',
    detail: 'Fear rising fast. Measured to predict rougher days ahead, not the direction.',
    test: (p, i) => {
      const r = change(p.indiaVix, i, 5);
      return r == null ? null : r > 0.3;
    },
  },
  {
    id: 'below200',
    label: 'Index below its 200-day average',
    detail: 'The long-term trend is down.',
    test: (p, i) => (p.sma200[i] == null ? null : p.close[i] < p.sma200[i]!),
  },
  {
    id: 'deathCross',
    label: '50-day average below the 200-day',
    detail: 'The medium-term trend has crossed below the long-term one.',
    test: (p, i) => (both(p.sma50[i], p.sma200[i]) ? p.sma50[i]! < p.sma200[i]! : null),
  },
  {
    id: 'spxBelow200',
    label: 'S&P 500 below its 200-day average',
    detail: 'The global trend is down (previous US close).',
    test: (p, i) => (both(p.spx[i], p.spxSma200[i]) ? p.spx[i]! < p.spxSma200[i]! : null),
  },
  {
    id: 'oilShock',
    label: 'Crude up 30%+ over the last 3 months',
    detail: 'An oil shock: Brent (WTI before Aug 2007) up more than 30% over 63 trading days.',
    test: (p, i) => {
      const r = change(p.brent, i, 63);
      return r == null ? null : r > 0.3;
    },
  },
  {
    id: 'indiaVixHigh',
    label: 'India VIX above 25',
    detail: 'Fear is high.',
    test: (p, i) => (p.indiaVix[i] == null ? null : p.indiaVix[i]! > 25),
  },
  {
    id: 'usVixHigh',
    label: 'US VIX above 25',
    detail: 'Global fear is high (previous US close).',
    test: (p, i) => (p.usVix[i] == null ? null : p.usVix[i]! > 25),
  },
  {
    id: 'rupeeWeak',
    label: 'Rupee down 3%+ over the last 3 months',
    detail: 'USD/INR up more than 3% over 63 trading days.',
    test: (p, i) => {
      const r = change(p.usdinr, i, 63);
      return r == null ? null : r > 0.03;
    },
  },
  {
    id: 'yieldsUp',
    label: 'US 10-year yield up 0.75 points over the last 6 months',
    detail: 'Global rates rising fast.',
    test: (p, i) => {
      if (i < 126) return null;
      const a = p.us10y[i - 126];
      const b = p.us10y[i];
      return both(a, b) ? b! - a! > 0.75 : null;
    },
  },
  {
    id: 'overheated',
    label: 'Index 15%+ above its 200-day average',
    detail: 'Stretched far above the long-term trend.',
    test: (p, i) => (p.sma200[i] == null ? null : p.close[i] > p.sma200[i]! * 1.15),
  },
  {
    id: 'washedOut',
    label: 'Fewer than 35% of stocks above their 200-day',
    detail: 'Most stocks are in their own downtrends.',
    test: (p, i) => (p.breadth[i] == null ? null : p.breadth[i]! < 0.35),
  },
  {
    id: 'rally50',
    label: 'Index up 50%+ over the last 12 months',
    detail: 'A very large one-year rally.',
    test: (p, i) => {
      if (i < 252) return null;
      return p.close[i] / p.close[i - 252] - 1 > 0.5;
    },
  },
  {
    id: 'vixComplacent',
    label: 'India VIX below 12',
    detail: 'Very low fear.',
    test: (p, i) => (p.indiaVix[i] == null ? null : p.indiaVix[i]! < 12),
  },
  // ── Added 2026-10-09 from the factor study (MARKET_WEATHER.md) ──
  {
    // Turbulence, not an action warning: its index-level pause rule beat the matched mix in
    // both halves, but pausing the accumulator on it was WORSE than the live baseline in 4 of 6
    // backtests (MARKET_WEATHER.md, 2026-10-09). Next-month dips were more likely in both halves.
    id: 'newLowsSpread',
    kind: 'turbulence',
    label: 'At least 10% of stocks at 52-week lows',
    detail: 'Damage spreading under the surface: one in ten NIFTY 500 stocks is at its lowest price of the past year.',
    test: (p, i) => (p.at52wLow[i] == null ? null : p.at52wLow[i]! >= 0.1),
  },
  {
    id: 'adDivergence',
    label: 'Fewer stocks joining the rally',
    detail: 'Index within 2% of its 52-week high, but the advance–decline line is lower than three months ago.',
    test: (p, i) => (i < 63 || p.adLine[i] == null || p.adLine[i - 63] == null ? null : p.close[i] >= p.hi252[i] * 0.98 && p.adLine[i]! < p.adLine[i - 63]!),
  },
  {
    id: 'dispersionHigh',
    label: 'Stocks scattering',
    detail: 'The spread of one-month returns across stocks is in the top 20% of its history so far.',
    test: (p, i) => (p.dispersionPct[i] == null ? null : p.dispersionPct[i]! > 0.8),
  },
  {
    id: 'defensiveRotation',
    label: 'Money hiding in defensives',
    detail: 'FMCG and healthcare stocks beat metals, realty, financials and capital goods by 8%+ over the last 3 months.',
    test: (p, i) => (p.defCyc63[i] == null ? null : p.defCyc63[i]! > 0.08),
  },
  {
    id: 'curveResteepen',
    label: 'US yield curve back to normal after an inversion',
    detail: 'The US 10-year yield is above the 3-month again after being below it within the past year: a classic late-cycle sign (previous US close).',
    test: (p, i) => {
      if (i < 252 || p.curve[i] == null) return null;
      if (p.curve[i]! <= 0) return false;
      for (let k = i - 252; k < i; k++) if (p.curve[k] != null && p.curve[k]! < 0) return true;
      return false;
    },
  },
  {
    id: 'volatilityHigh',
    kind: 'turbulence',
    label: 'NIFTY swings unusually large',
    detail: 'The index realised volatility over the last month is in the top 20% of its history so far.',
    test: (p, i) => (p.rvPct[i] == null ? null : p.rvPct[i]! > 0.8),
  },
  {
    id: 'spxMonthDown',
    kind: 'turbulence',
    label: 'S&P 500 down 5%+ over the last month',
    detail: 'A bad month on Wall Street has tended to spill into Indian stocks the following month (previous US close).',
    test: (p, i) => (p.spx21[i] == null ? null : p.spx21[i]! < -0.05),
  },
  {
    id: 'vrpLow',
    kind: 'turbulence',
    label: 'Actual swings bigger than the fear priced in',
    detail: 'Real NIFTY moves over the last month exceed what India VIX prices (variance risk premium in its bottom 20%).',
    test: (p, i) => (p.vrpPct[i] == null ? null : p.vrpPct[i]! < 0.2),
  },
  {
    id: 'vrpHigh',
    kind: 'calm',
    label: 'Fear priced high',
    detail: 'India VIX prices much bigger swings than the market is actually making (variance risk premium in its top 20%).',
    test: (p, i) => (p.vrpPct[i] == null ? null : p.vrpPct[i]! > 0.8),
  },
];

export const SIGNAL_BY_ID = new Map(SIGNALS.map((s) => [s.id, s] as const));
export const kindOf = (id: SignalId): SignalKind => SIGNAL_BY_ID.get(id)?.kind ?? 'warning';

export type Phase = 'at-highs' | 'pullback' | 'correction' | 'bear';

/** Distance from the all-time high, named. Thresholds are the conventional 5/10/20%. */
export function phaseOf(fromAthPct: number): Phase {
  if (fromAthPct > -5) return 'at-highs';
  if (fromAthPct > -10) return 'pullback';
  if (fromAthPct > -20) return 'correction';
  return 'bear';
}

export interface MarketState {
  date: string;
  index: string;
  close: number;
  fromAthPct: number;
  from52wHighPct: number;
  phase: Phase;
  vs200Pct: number | null;
  deathCross: boolean | null;
  ret3mPct: number | null;
  ret12mPct: number | null;
  breadthPct: number | null;
  at52wLowPct: number | null;
  breadthCoverage: number;
  indiaVix: number | null;
  indiaVix5dPct: number | null;
  spxVs200Pct: number | null;
  usVix: number | null;
  brent: number | null;
  brent3mPct: number | null;
  brentDaysAbove90: number;
  brentDaysAbove100: number;
  usdinr: number | null;
  usdinr3mPct: number | null;
  us10y: number | null;
  us10y6mChange: number | null;
  gold3mPct: number | null;
  /** Signals on today (only those whose inputs exist). */
  active: SignalId[];
  /** Signals whose inputs are missing today. */
  unavailable: SignalId[];
}

const pct = (x: number | null): number | null => (x == null ? null : Math.round(x * 1000) / 10);

export function stateAt(p: Prepared, i: number): MarketState {
  const c = p.close[i];
  const fromAth = (c / p.ath[i] - 1) * 100;
  const active: SignalId[] = [];
  const unavailable: SignalId[] = [];
  for (const s of SIGNALS) {
    const v = s.test(p, i);
    if (v == null) unavailable.push(s.id);
    else if (v) active.push(s.id);
  }
  const us10y6 = i >= 126 && both(p.us10y[i], p.us10y[i - 126]) ? Math.round((p.us10y[i]! - p.us10y[i - 126]!) * 100) / 100 : null;
  return {
    date: p.axis[i],
    index: p.indexKey,
    close: c,
    fromAthPct: Math.round(fromAth * 10) / 10,
    from52wHighPct: pct(c / p.hi252[i] - 1)!,
    phase: phaseOf(fromAth),
    vs200Pct: p.sma200[i] == null ? null : pct(c / p.sma200[i]! - 1),
    deathCross: both(p.sma50[i], p.sma200[i]) ? p.sma50[i]! < p.sma200[i]! : null,
    ret3mPct: i >= 63 ? pct(c / p.close[i - 63] - 1) : null,
    ret12mPct: i >= 252 ? pct(c / p.close[i - 252] - 1) : null,
    breadthPct: pct(p.breadth[i]),
    at52wLowPct: pct(p.at52wLow[i]),
    breadthCoverage: p.breadthCoverage[i],
    indiaVix: p.indiaVix[i],
    indiaVix5dPct: pct(change(p.indiaVix, i, 5)),
    spxVs200Pct: both(p.spx[i], p.spxSma200[i]) ? pct(p.spx[i]! / p.spxSma200[i]! - 1) : null,
    usVix: p.usVix[i],
    brent: p.brent[i],
    brent3mPct: pct(change(p.brent, i, 63)),
    brentDaysAbove90: p.brentDaysAbove90[i],
    brentDaysAbove100: p.brentDaysAbove100[i],
    usdinr: p.usdinr[i],
    usdinr3mPct: pct(change(p.usdinr, i, 63)),
    us10y: p.us10y[i],
    us10y6mChange: us10y6,
    gold3mPct: pct(change(p.gold, i, 63)),
    active,
    unavailable,
  };
}

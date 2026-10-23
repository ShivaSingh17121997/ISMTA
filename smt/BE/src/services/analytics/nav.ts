/**
 * NAV curve and performance statistics — pure functions over the store's data.
 *
 * The raw material is one equity snapshot per IST trading day, written after
 * the close. That series is young (or empty), so BEFORE the first snapshot the
 * daily equity is RECONSTRUCTED: capital, plus the cumulative realised P&L of
 * every closed accumulator lot and every valid closed trade, bucketed by the
 * IST day the money was booked. That reconstruction is realised-only — open
 * positions are not marked — which is stated in `meta.note` rather than hidden.
 *
 * NAV is a unit price, base 1000, chain-linked day over day and adjusted for
 * external cash flow, so a deposit moves equity but never the NAV. NIFTY 50 is
 * rebased to 1000 on the first day of the series so both lines share an axis.
 *
 * Everything here is deterministic: the clock, the market data and the store
 * are inputs, so the same history always draws the same curve and the tests
 * can pin every number.
 */
import { EquitySnapshot } from '../../types';
import { istParts, isTradingDay } from '../session';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
/** NSE trading days in a year, for annualising daily figures. */
const TRADING_DAYS = 252;
export const NAV_BASE = 1000;

export type NavRange = '1y' | 'all';

/** One realised outcome: a sold lot or an exited trade. */
export interface RealisedEvent {
  source: 'lot' | 'trade';
  /** when the P&L was booked — the sale or the exit */
  at: number;
  /** net of charges */
  pnl: number;
  charges: number;
  holdMs: number;
}

/** Capital at work over an interval, for the deployed line before snapshots exist. */
export interface Exposure {
  openedAt: number;
  closedAt?: number;
  notional: number;
}

export type PointSource = 'baseline' | 'reconstructed' | 'snapshot' | 'carried' | 'live';

export interface NavPoint {
  /** IST day, YYYY-MM-DD */
  day: string;
  equity: number;
  nav: number;
  nifty: number | null;
  niftyNav: number | null;
  deployed: number;
  flow: number;
  source: PointSource;
}

export interface NavStats {
  /** calendar days between the first and last point */
  spanDays: number;
  totalReturnPct: number;
  cagrPct: number;
  volPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  maxDrawdownDays: number;
  currentDrawdownPct: number;
  timeInMarketPct: number;
  niftyReturnPct: number | null;
  activeReturnPct: number | null;
}

export interface MonthRow {
  /** YYYY-MM */
  month: string;
  pnl: number;
  pct: number;
  niftyPct: number | null;
}

export interface Drawdown {
  start: string;
  trough: string;
  end: string | null;
  depthPct: number;
  days: number;
}

export interface CostSummary {
  charges: number;
  grossProfit: number;
  netProfit: number;
  /** charges / grossProfit; null when there is no gross profit to share */
  costSharePct: number | null;
}

export interface TradeStats {
  n: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWin: number;
  /** negative: the mean of the losing outcomes */
  avgLoss: number;
  payoff: number | null;
  expectancy: number;
  profitFactor: number | null;
  medianHoldDays: number;
}

export interface NavInput {
  capital: number;
  /** sorted by day ascending */
  snapshots: EquitySnapshot[];
  events: RealisedEvent[];
  exposures: Exposure[];
  /** the live point, from computeEquity */
  today: { day: string; equity: number; deployed: number };
  /** IST day → NIFTY 50 close */
  niftyCloses: Map<string, number>;
  range: NavRange;
}

export interface NavReport {
  range: NavRange;
  points: NavPoint[];
  stats: NavStats;
  monthly: MonthRow[];
  drawdowns: Drawdown[];
  costs: CostSummary;
  tradeStats: TradeStats;
  meta: {
    snapshots: number;
    reconstructedDays: number;
    niftyDays: number;
    events: number;
    note: string;
  };
}

// ─── day arithmetic (IST) ─────────────────────────────────────────────

export function istDay(t: number): string {
  return istParts(t).date;
}

/** Noon IST of a YYYY-MM-DD day, as a UTC epoch — safely inside the day for `isTradingDay`. */
function noonIst(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS + 12 * 3_600_000;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function prevTradingDay(day: string): string {
  let d = addDays(day, -1);
  for (let i = 0; i < 30 && !isTradingDay(noonIst(d)); i++) d = addDays(d, -1);
  return d;
}

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Sample standard deviation. */
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── the series ───────────────────────────────────────────────────────

/**
 * One point per trading day from a baseline at `capital` through today.
 * Snapshots are authoritative where they exist; days before the first snapshot
 * are reconstructed from realised P&L; a missing day after snapshots began is
 * carried forward; today is the live figure.
 */
export function buildSeries(input: Omit<NavInput, 'range'>): NavPoint[] {
  const { capital, snapshots, events, exposures, today, niftyCloses } = input;
  const snapByDay = new Map(snapshots.map((s) => [s.day, s] as const));
  const firstSnapDay = snapshots.length ? snapshots[0].day : undefined;

  const eventDays = events.map((e) => istDay(e.at)).filter((d) => d <= today.day);
  const candidates = [...eventDays, ...(firstSnapDay && firstSnapDay <= today.day ? [firstSnapDay] : [])];
  const start = candidates.length ? candidates.reduce((a, b) => (a < b ? a : b)) : today.day;
  const baselineDay = prevTradingDay(start);

  // Cumulative realised P&L by day, for the reconstruction.
  const sortedEvents = [...events].sort((a, b) => a.at - b.at);
  const realisedThrough = (day: string): number => {
    let s = 0;
    for (const e of sortedEvents) {
      if (istDay(e.at) > day) break;
      s += e.pnl;
    }
    return s;
  };
  const deployedOn = (day: string): number =>
    exposures.reduce((s, x) => {
      const open = istDay(x.openedAt) <= day && (x.closedAt == null || istDay(x.closedAt) > day);
      return open ? s + x.notional : s;
    }, 0);

  const points: NavPoint[] = [];
  let prev: NavPoint | undefined;
  for (let day = baselineDay; day <= today.day; day = addDays(day, 1)) {
    const isToday = day === today.day;
    if (!isToday && !isTradingDay(noonIst(day))) continue;
    const snap = snapByDay.get(day);
    let equity: number;
    let deployed: number;
    let flow = 0;
    let source: PointSource;
    if (isToday) {
      equity = today.equity;
      deployed = today.deployed;
      flow = snap?.flow ?? 0;
      source = 'live';
    } else if (day === baselineDay) {
      equity = capital;
      deployed = deployedOn(day);
      source = 'baseline';
    } else if (snap) {
      equity = snap.equity;
      deployed = snap.deployed;
      flow = snap.flow ?? 0;
      source = 'snapshot';
    } else if (!firstSnapDay || day < firstSnapDay) {
      equity = capital + realisedThrough(day);
      deployed = deployedOn(day);
      source = 'reconstructed';
    } else {
      equity = prev?.equity ?? capital;
      deployed = prev?.deployed ?? 0;
      source = 'carried';
    }
    const nifty = snap?.nifty ?? niftyCloses.get(day) ?? prev?.nifty ?? null;
    const p: NavPoint = { day, equity, nav: NAV_BASE, nifty, niftyNav: null, deployed, flow, source };
    points.push(p);
    prev = p;
  }
  chainNav(points);
  return points;
}

/**
 * Chain-link the unit price. A day's return is measured on equity NET of that
 * day's external flow, so money moved in or out never shows as performance.
 */
export function chainNav(points: NavPoint[]): void {
  let niftyBase: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) {
      p.nav = NAV_BASE;
    } else {
      const prev = points[i - 1];
      const r = prev.equity > 0 ? (p.equity - p.flow) / prev.equity - 1 : 0;
      p.nav = prev.nav * (1 + r);
    }
    if (p.nifty != null) {
      if (niftyBase == null) niftyBase = p.nifty;
      p.niftyNav = (NAV_BASE * p.nifty) / niftyBase;
    } else {
      p.niftyNav = null;
    }
  }
}

/** Trim to the range and rebase both unit prices to 1000 on the first kept day. */
export function applyRange(points: NavPoint[], range: NavRange, todayDay: string): NavPoint[] {
  if (range === 'all' || points.length === 0) return points;
  const cutoff = addDays(todayDay, -365);
  const kept = points.filter((p) => p.day >= cutoff);
  if (kept.length === points.length || kept.length === 0) return kept.length ? kept : points;
  const nav0 = kept[0].nav;
  const nifty0 = kept.find((p) => p.niftyNav != null)?.niftyNav ?? null;
  return kept.map((p) => ({
    ...p,
    nav: (NAV_BASE * p.nav) / nav0,
    niftyNav: p.niftyNav != null && nifty0 ? (NAV_BASE * p.niftyNav) / nifty0 : null,
  }));
}

// ─── statistics ───────────────────────────────────────────────────────

/** Peak-to-trough episodes in the unit price, deepest first. */
export function drawdownEpisodes(points: NavPoint[], top = 5): Drawdown[] {
  const episodes: Drawdown[] = [];
  if (points.length === 0) return episodes;
  let peakIdx = 0;
  let troughIdx = -1;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.nav >= points[peakIdx].nav) {
      if (troughIdx >= 0) {
        episodes.push(episode(points, peakIdx, troughIdx, p.day));
        troughIdx = -1;
      }
      peakIdx = i;
    } else if (troughIdx < 0 || p.nav < points[troughIdx].nav) {
      troughIdx = i;
    }
  }
  if (troughIdx >= 0) episodes.push(episode(points, peakIdx, troughIdx, null));
  return episodes
    .filter((e) => e.depthPct < 0)
    .sort((a, b) => a.depthPct - b.depthPct)
    .slice(0, top);
}

function episode(points: NavPoint[], peakIdx: number, troughIdx: number, end: string | null): Drawdown {
  const start = points[peakIdx].day;
  const last = points[points.length - 1].day;
  return {
    start,
    trough: points[troughIdx].day,
    end,
    depthPct: round((points[troughIdx].nav / points[peakIdx].nav - 1) * 100, 2),
    days: daysBetween(start, end ?? last),
  };
}

export function navStats(points: NavPoint[]): NavStats {
  if (points.length === 0) {
    return {
      spanDays: 0,
      totalReturnPct: 0,
      cagrPct: 0,
      volPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      maxDrawdownDays: 0,
      currentDrawdownPct: 0,
      timeInMarketPct: 0,
      niftyReturnPct: null,
      activeReturnPct: null,
    };
  }
  const first = points[0];
  const last = points[points.length - 1];
  const rets: number[] = [];
  for (let i = 1; i < points.length; i++) rets.push(points[i].nav / points[i - 1].nav - 1);
  const spanDays = daysBetween(first.day, last.day);
  const growth = last.nav / first.nav;
  const totalReturnPct = (growth - 1) * 100;
  const cagrPct = spanDays >= 1 && growth > 0 ? (growth ** (365 / spanDays) - 1) * 100 : totalReturnPct;
  const s = sd(rets);
  const volPct = s * Math.sqrt(TRADING_DAYS) * 100;
  const sharpe = s > 0 ? (mean(rets) / s) * Math.sqrt(TRADING_DAYS) : 0;

  const episodes = drawdownEpisodes(points, 1);
  const deepest = episodes[0];
  let peak = -Infinity;
  for (const p of points) peak = Math.max(peak, p.nav);
  const currentDrawdownPct = peak > 0 ? (last.nav / peak - 1) * 100 : 0;

  const inMarket = points.filter((p) => p.deployed > 0).length;
  const firstNifty = points.find((p) => p.niftyNav != null)?.niftyNav ?? null;
  const niftyReturnPct =
    firstNifty != null && last.niftyNav != null ? (last.niftyNav / firstNifty - 1) * 100 : null;

  return {
    spanDays,
    totalReturnPct: round(totalReturnPct, 2),
    cagrPct: round(cagrPct, 2),
    volPct: round(volPct, 2),
    sharpe: round(sharpe, 2),
    maxDrawdownPct: deepest ? deepest.depthPct : 0,
    maxDrawdownDays: deepest ? deepest.days : 0,
    currentDrawdownPct: round(currentDrawdownPct, 2),
    timeInMarketPct: round((inMarket / points.length) * 100, 1),
    niftyReturnPct: niftyReturnPct == null ? null : round(niftyReturnPct, 2),
    activeReturnPct: niftyReturnPct == null ? null : round(totalReturnPct - niftyReturnPct, 2),
  };
}

/** Month rows: rupee P&L (net of flows), unit-price return, and NIFTY's return over the same points. */
export function monthlyTable(points: NavPoint[]): MonthRow[] {
  const rows: MonthRow[] = [];
  if (points.length === 0) return rows;
  let prevPoint = points[0];
  let i = 0;
  while (i < points.length) {
    const month = points[i].day.slice(0, 7);
    const inMonth: NavPoint[] = [];
    while (i < points.length && points[i].day.slice(0, 7) === month) inMonth.push(points[i++]);
    const last = inMonth[inMonth.length - 1];
    const flows = inMonth.filter((p) => p !== prevPoint).reduce((s, p) => s + p.flow, 0);
    const niftyBase = prevPoint.niftyNav ?? inMonth.find((p) => p.niftyNav != null)?.niftyNav ?? null;
    rows.push({
      month,
      pnl: round(last.equity - prevPoint.equity - flows, 2),
      pct: round((last.nav / prevPoint.nav - 1) * 100, 2),
      niftyPct: niftyBase != null && last.niftyNav != null ? round((last.niftyNav / niftyBase - 1) * 100, 2) : null,
    });
    prevPoint = last;
  }
  return rows;
}

export function costSummary(events: RealisedEvent[]): CostSummary {
  const charges = events.reduce((s, e) => s + e.charges, 0);
  const netProfit = events.reduce((s, e) => s + e.pnl, 0);
  const grossProfit = netProfit + charges;
  return {
    charges: round(charges, 2),
    grossProfit: round(grossProfit, 2),
    netProfit: round(netProfit, 2),
    costSharePct: grossProfit > 0 ? round((charges / grossProfit) * 100, 2) : null,
  };
}

export function tradeStats(events: RealisedEvent[]): TradeStats {
  const wins = events.filter((e) => e.pnl > 0);
  const losses = events.filter((e) => e.pnl < 0);
  const grossWin = wins.reduce((s, e) => s + e.pnl, 0);
  const grossLoss = losses.reduce((s, e) => s + e.pnl, 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  return {
    n: events.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: events.length ? round((wins.length / events.length) * 100, 1) : 0,
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    payoff: avgLoss < 0 ? round(avgWin / -avgLoss, 2) : null,
    expectancy: events.length ? round((grossWin + grossLoss) / events.length, 2) : 0,
    profitFactor: grossLoss < 0 ? round(grossWin / -grossLoss, 2) : null,
    medianHoldDays: round(median(events.map((e) => e.holdMs)) / DAY_MS, 2),
  };
}

// ─── the report ───────────────────────────────────────────────────────

export function computeNav(input: NavInput): NavReport {
  const all = buildSeries(input);
  const points = applyRange(all, input.range, input.today.day);
  const rangeStart = points[0]?.day ?? input.today.day;
  const events = input.events.filter((e) => istDay(e.at) >= rangeStart && istDay(e.at) <= input.today.day);

  const reconstructedDays = points.filter((p) => p.source === 'reconstructed').length;
  const snapshotDays = points.filter((p) => p.source === 'snapshot').length;
  const niftyDays = points.filter((p) => p.nifty != null).length;
  const note =
    events.length === 0 && snapshotDays === 0
      ? 'No closed trades or lots yet — the curve starts at your capital and today is marked live.'
      : snapshotDays === 0
        ? `No end-of-day snapshots yet — ${reconstructedDays} day${reconstructedDays === 1 ? '' : 's'} reconstructed from realised P&L (charges included, open positions not marked); today is live.`
        : reconstructedDays > 0
          ? `${reconstructedDays} day${reconstructedDays === 1 ? '' : 's'} before the first snapshot reconstructed from realised P&L; ${snapshotDays} from end-of-day snapshots; today is live.`
          : `${snapshotDays} end-of-day snapshots; today is live.`;

  return {
    range: input.range,
    points: points.map((p) => ({
      ...p,
      equity: round(p.equity, 2),
      nav: round(p.nav, 4),
      nifty: p.nifty == null ? null : round(p.nifty, 2),
      niftyNav: p.niftyNav == null ? null : round(p.niftyNav, 4),
      deployed: round(p.deployed, 2),
      flow: round(p.flow, 2),
    })),
    stats: navStats(points),
    monthly: monthlyTable(points),
    drawdowns: drawdownEpisodes(points, 5),
    costs: costSummary(events),
    tradeStats: tradeStats(events),
    meta: {
      snapshots: input.snapshots.length,
      reconstructedDays,
      niftyDays,
      events: events.length,
      note: niftyDays === 0 ? `${note} NIFTY 50 closes were not available, so the benchmark line is empty.` : note,
    },
  };
}

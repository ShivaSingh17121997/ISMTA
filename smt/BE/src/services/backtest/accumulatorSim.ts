/**
 * Portfolio backtest of the accumulator, driving the REAL engine. Pure: the
 * caller supplies daily bars; nothing here touches the network or the store.
 *
 * Every decision comes from `accumulator/engine`, every fee from `costs`, the
 * allocator from `allocator/allocate` + `strength`, the regime from `trend`.
 * What it reports is a property of the shipped code.
 *
 * What it fixes over the old per-symbol script:
 *   - The window is exactly `years` long, ending on the last bar.
 *   - Max drawdown is the PORTFOLIO's, from one summed daily equity curve. The
 *     average of per-symbol drawdowns overstated it about twofold.
 *   - CAGR always uses the window's real length.
 *   - The regime is read each day (closes up to the day before), so the uptrend
 *     trail and the scalp autopilot are exercised as they are live.
 *   - ETFs are priced as ETFs (sell-only STT), not as stocks.
 *   - The rung a buy fills at comes from `paramsFor`, so a scalp ladder is used
 *     while scalp is on.
 *   - Optional: the daily capital allocator and the idle-cash sweep, with the
 *     sweep's real buy and sell charges.
 *
 * FILL MODEL (limit): exits at the target when the day's high reaches it; a buy
 * at the rung when the day's low reaches it, or at the open on a gap down. An
 * armed lot arms only on the open or the high, as the 60-second poller would
 * have seen. One buy per book per day, which is the swing buy brake.
 *
 * Known simplifications, stated so nobody reads more into the numbers:
 *   - Daily bars only. Intraday order of high and low is unknown.
 *   - Settlement is T+1 for books; the sweep's T+1 lock on parked units is not
 *     modelled (units are assumed redeemable when a rung needs them).
 *   - Survivorship: the universe is whatever the caller passes, usually today's
 *     names, which flatters single-stock results.
 */
import { charges } from '../costs';
import { istParts, nextTradingDayStart } from '../session';
import {
  applyBuyFill,
  applyTrail,
  decide,
  deployedCapital,
  equity,
  mergeDayHighs,
  nextTrancheSize,
  paramsFor,
  recordDayHigh,
  releaseSettled,
  sellLot,
  unsettledCash,
  BreakevenViolationError,
} from '../accumulator/engine';
import { validateScalp } from '../accumulator/scalp';
import { dailyVolPct } from '../accumulator/math';
import { entryBlock, isGapDown } from '../accumulator/events';
import { adjustmentFactor, type CorporateAction } from '../accumulator/corporateActions';
import { autoProfileDecision, classifyRegime } from '../accumulator/trend';
import type { AccumulatorBook, AccumulatorParams } from '../accumulator/types';
import { allocate, bookCandidateFields, rungsForBudget, DEFAULT_ALLOCATION_PARAMS, type AllocationParams, type Candidate } from '../allocator/allocate';
import { strength } from '../allocator/strength';
import { bufferNeed, rungsPerSession, DEFAULT_SWEEP_PARAMS } from '../sweep/plan';
import type { Candle } from '../../types';

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
/** Entry window the live engine trades in, 09:20–15:00 IST. */
const ENTRY_WINDOW_MIN = 340;
/** Bars before the window used only to warm up highs, regime and strength. */
const WARMUP_GATE = 45;

export type RegimeMode = 'off' | 'regime' | 'auto';

export interface SimOptions {
  /** Window length in years, ending on the last bar of the data. */
  years: number;
  capital: number;
  params: AccumulatorParams;
  /**
   * `off`: no regime read (the trail arms only on a gap).
   * `regime`: the regime is read daily, so the uptrend trail works.
   * `auto`: also the scalp autopilot, as live books run.
   */
  regime: RegimeMode;
  /** Equal fixed budgets per symbol, or the daily capital allocator. */
  sizing: 'equal' | 'allocator';
  allocation?: Partial<AllocationParams>;
  /** Idle-cash sweep: annual yield in percent; 0 or absent = off. */
  sweepYieldPct?: number;
  /** Also park money no book holds (the live sweep does not). */
  sweepUnassigned?: boolean;
  /** Symbols to price as ETFs. Others are stocks. */
  etfs?: ReadonlySet<string>;
  /** Past results board-meeting days per symbol (YYYY-MM-DD), for the results block. */
  resultsDays?: ReadonlyMap<string, string[]>;
  /**
   * Market Weather hook (MARKET_WEATHER.md Phase 5): return true to skip a BUY
   * of this rung level on this IST day. Only ever withholds a buy — sells and
   * the no-loss floor are untouched. Absent = no hook, the live behaviour.
   */
  buyBlock?: (day: string, level: number) => boolean;
}

export interface DayPoint {
  day: string;
  /** Total portfolio value: books at the close + parked units + unassigned cash. */
  equity: number;
  /** Cost basis of open lots. */
  deployed: number;
  /** Market value of parked units. */
  parked: number;
  /** Equal-weight buy-and-hold of the same symbols, same capital. */
  buyHold: number;
}

export interface OpenLotEnd {
  symbol: string;
  pctVsCost: number;
  ageDays: number;
  cost: number;
}

export interface SimRun {
  from: string;
  to: string;
  years: number;
  symbols: string[];
  /** Symbols dropped because they lack history before the window. */
  skipped: string[];
  curve: DayPoint[];
  roundTrips: number;
  /** Round trips that armed and rode past their target before selling. */
  armedExits: number;
  avgHoldDays: number;
  realisedPnl: number;
  bookCharges: number;
  sweepGain: number;
  sweepCharges: number;
  openLots: OpenLotEnd[];
}

export interface SeriesStats {
  cagrPct: number;
  maxDdPct: number;
  /** CAGR of the first and second half of the window. A sign flip means noise. */
  halves: [number, number];
}

// ─── helpers ──────────────────────────────────────────────────────────────

export function cagrPct(start: number, end: number, years: number): number {
  if (!(start > 0) || !(end > 0) || !(years > 0)) return 0;
  return ((end / start) ** (1 / years) - 1) * 100;
}

export function maxDrawdownPct(series: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd * 100;
}

export function seriesStats(values: number[], days: string[]): SeriesStats {
  const yrs = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / YEAR;
  const mid = Math.floor(values.length / 2);
  const h1 = (Date.parse(days[mid]) - Date.parse(days[0])) / YEAR;
  const h2 = (Date.parse(days[days.length - 1]) - Date.parse(days[mid])) / YEAR;
  return {
    cagrPct: cagrPct(values[0], values[values.length - 1], yrs),
    maxDdPct: maxDrawdownPct(values),
    halves: [cagrPct(values[0], values[mid], h1), cagrPct(values[mid], values[values.length - 1], h2)],
  };
}

/** Daily-compounded growth series at a fixed annual rate over the given days. */
export function fixedRateSeries(start: number, days: string[], annualPct: number): number[] {
  const out = [start];
  for (let i = 1; i < days.length; i++) {
    const dt = (Date.parse(days[i]) - Date.parse(days[i - 1])) / YEAR;
    out.push(out[i - 1] * (1 + annualPct / 100) ** dt);
  }
  return out;
}

/**
 * The fair benchmark for a strategy that keeps only part of its money in the
 * market: hold that same average fraction `w` in the basket and the rest at a
 * cash rate, rebalanced daily.
 */
export function exposureMatched(basket: number[], days: string[], w: number, cashPct: number): number[] {
  const out = [basket[0]];
  for (let i = 1; i < days.length; i++) {
    const dt = (Date.parse(days[i]) - Date.parse(days[i - 1])) / YEAR;
    const rb = basket[i] / basket[i - 1] - 1;
    const rc = (1 + cashPct / 100) ** dt - 1;
    out.push(out[i - 1] * (1 + w * rb + (1 - w) * rc));
  }
  return out;
}

function freshBook(symbol: string, instrument: 'EQUITY' | 'ETF', budget: number, at: number, auto: boolean): AccumulatorBook {
  return {
    id: symbol, userId: 'sim', symbol, instrument,
    budget, cash: budget, unsettled: [], openLots: [], closedLots: [], epochs: [],
    lotSeq: 0, dayHighs: {}, orderedDays: [], enabled: true, killSwitchEngaged: false,
    createdAt: at, updatedAt: at,
    ...(auto ? { autoProfile: true } : {}),
  } as AccumulatorBook;
}

/** The price a buy decision is actually waiting at: its rung, or the start gate's trigger. */
function rungPrice(book: AccumulatorBook, epochIndex: number, level: number, params: AccumulatorParams): number | null {
  const epoch = book.epochs[epochIndex];
  if (epoch && epoch.levels[level] !== undefined) return epoch.levels[level];
  if (level !== 0) return null;
  const p = paramsFor(book, params);
  const from = Math.max(0, book.orderedDays.length - p.hiLookbackDays);
  let hi = 0;
  for (let i = from; i < book.orderedDays.length; i++) hi = Math.max(hi, book.dayHighs[book.orderedDays[i]] ?? 0);
  return hi > 0 ? hi * (1 - p.startDiscountPct / 100) : null;
}

const CNC_ETF = { product: 'CNC' as const, instrument: 'ETF' as const };

// ─── the run ──────────────────────────────────────────────────────────────

export function simulatePortfolio(data: Map<string, Candle[]>, opts: SimOptions): SimRun {
  const etfs = opts.etfs ?? new Set<string>();
  const clean = new Map<string, Candle[]>();
  for (const [s, bars] of data) clean.set(s, bars.filter((c) => c.close > 0 && c.high > 0 && c.low > 0));

  // Refuse anything but daily bars. Monthly bars read as days would invent a
  // strategy that holds for years and "rides" every gap.
  for (const [s, b] of clean) {
    if (b.length < 3) continue;
    const gaps = b.slice(1).map((c, i) => c.timestamp - b[i].timestamp).sort((x, y) => x - y);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median > 4 * DAY) throw new Error(`${s}: bars are ${(median / DAY).toFixed(0)} days apart; daily bars are required`);
  }

  const lastTs = Math.max(...[...clean.values()].filter((b) => b.length).map((b) => b[b.length - 1].timestamp));
  const startTs = lastTs - opts.years * YEAR;

  // A symbol needs enough history before the window to warm up its gate (and,
  // with the allocator, a year to score it — it is simply unscored until then).
  const symbols: string[] = [];
  const skipped: string[] = [];
  const startIdx = new Map<string, number>();
  for (const [s, bars] of clean) {
    const i = bars.findIndex((c) => c.timestamp >= startTs);
    if (i >= WARMUP_GATE) {
      symbols.push(s);
      startIdx.set(s, i);
    } else skipped.push(s);
  }
  if (!symbols.length) throw new Error('no symbol has enough history before the window');

  const auto = opts.regime === 'auto';
  const equalBudget = Math.floor(opts.capital / symbols.length);
  const books = new Map<string, AccumulatorBook>();
  for (const s of symbols) {
    const bars = clean.get(s)!;
    const i0 = startIdx.get(s)!;
    const budget = opts.sizing === 'equal' ? equalBudget : 0;
    let b = freshBook(s, etfs.has(s) ? 'ETF' : 'EQUITY', budget, bars[i0].timestamp, auto);
    // Rungs as the allocator would set them: what the budget affords above the
    // dust gate, within its min/max. The allocator re-sets them daily.
    if (opts.sizing === 'equal') {
      const a = { ...DEFAULT_ALLOCATION_PARAMS, ...opts.allocation };
      b = { ...b, tranches: rungsForBudget(budget, a) };
    }
    b = mergeDayHighs(b, bars.slice(i0 - WARMUP_GATE, i0).map((c) => ({ day: istParts(c.timestamp).date, high: c.high })));
    if (opts.sizing === 'allocator') b = { ...b, allocatorPaused: true };
    books.set(s, b);
  }
  // Money no book holds. Equal sizing leaves only the rounding here.
  let unassigned = opts.capital - (opts.sizing === 'equal' ? equalBudget * symbols.length : 0);

  // Per-symbol bar lookup by IST day.
  const byDay = new Map<string, Map<string, { bar: Candle; idx: number }>>();
  for (const s of symbols) {
    const bars = clean.get(s)!;
    for (let i = startIdx.get(s)!; i < bars.length; i++) {
      const d = istParts(bars[i].timestamp).date;
      if (!byDay.has(d)) byDay.set(d, new Map());
      byDay.get(d)!.set(s, { bar: bars[i], idx: i });
    }
  }
  const days = [...byDay.keys()].sort();

  // Sweep state: parked units of a liquid ETF that grows at `sweepYieldPct`.
  const sweepOn = (opts.sweepYieldPct ?? 0) > 0;
  let unitPrice = 1000;
  let units = 0;
  let cashOut = 0; // rupees away from the books' cash because of the sweep
  let sweepCharges = 0;
  let sweepCost = 0; // cost basis of units held, for the realised gain
  let sweepGain = 0;

  const lastClose = new Map<string, number>();
  const firstClose = new Map<string, number>();
  const curve: DayPoint[] = [];
  let bookCharges = 0;

  const allocParams: AllocationParams = { ...DEFAULT_ALLOCATION_PARAMS, ...opts.allocation, totalCapital: 0 };

  const redeem = (need: number, day: number): void => {
    // Sell enough units to put `need` rupees back in the account.
    if (!(need > 0) || units <= 0) return;
    const qty = Math.min(units, Math.ceil(need / unitPrice) + 1);
    const fee = charges('SELL', unitPrice, qty, CNC_ETF).total;
    const proceeds = qty * unitPrice - fee;
    const costShare = (sweepCost * qty) / units;
    sweepGain += proceeds - costShare;
    sweepCost -= costShare;
    sweepCharges += fee;
    units -= qty;
    cashOut -= proceeds;
    void day;
  };

  for (let k = 0; k < days.length; k++) {
    const day = days[k];
    const today = byDay.get(day)!;
    const t0 = [...today.values()][0].bar.timestamp;

    if (sweepOn && k > 0) {
      const dt = (Date.parse(day) - Date.parse(days[k - 1])) / YEAR;
      unitPrice *= (1 + opts.sweepYieldPct! / 100) ** dt;
    }

    // ── allocator: last night's pass, on bars up to yesterday's close ──
    if (opts.sizing === 'allocator') {
      const cands: Candidate[] = [];
      for (const s of symbols) {
        const b = books.get(s)!;
        const hit = today.get(s);
        const bars = clean.get(s)!;
        const upTo = hit ? hit.idx : bars.findIndex((c) => istParts(c.timestamp).date > day);
        const hist = bars.slice(Math.max(0, (upTo < 0 ? bars.length : upTo) - 260), upTo < 0 ? bars.length : upTo);
        const st = strength(s, hist.map((c) => c.close), hist.map((c) => c.high));
        cands.push({
          ...bookCandidateFields(b),
          score: st.score,
          trendUp: st.trendUp,
          eligible: st.eligible,
          ...(st.reason ? { reason: st.reason } : {}),
        });
      }
      const cashPool = unassigned + symbols.reduce((s, x) => s + books.get(x)!.cash, 0);
      const committed = cands.reduce((s, c) => s + c.deployed + c.unsettled, 0);
      const plan = allocate(cands, { ...allocParams, totalCapital: cashPool + committed });
      let assigned = 0;
      for (const a of plan.allocations) {
        const b = books.get(a.symbol)!;
        books.set(a.symbol, {
          ...b,
          budget: a.targetBudget,
          cash: a.targetCash,
          tranches: a.tranches,
          allocatorPaused: !a.selected,
        });
        assigned += a.targetCash;
      }
      unassigned = cashPool - assigned;
    }

    // ── each book trades the day ──
    for (const s of symbols) {
      const hit = today.get(s);
      if (!hit) continue;
      const { bar, idx } = hit;
      const t = bar.timestamp;
      const bars = clean.get(s)!;
      let b = books.get(s)!;
      if (!firstClose.has(s)) firstClose.set(s, bar.close);

      // Daily volatility from closes up to yesterday, as the live engine keeps it.
      const vol = dailyVolPct(bars.slice(Math.max(0, idx - 61), idx).map((c) => c.close));
      if (vol) b = { ...b, volPct: vol };

      // Gap-down block, as the live engine applies it from the day's first
      // price. Surveillance and results need NSE history the sim does not have.
      const ev = opts.params.eventVeto;
      if (ev && (ev.gapPct > 0 || ev.resultsSessions > 0)) {
        const today = istParts(t).date;
        if (isGapDown(bars[idx - 1]?.close, bar.open, ev.gapPct)) b = { ...b, gapDownDay: today };
        const days = opts.resultsDays?.get(s) ?? [];
        const block = entryBlock({
          now: t,
          params: { ...ev, surveillance: false },
          lastResultsDay: days.find((d) => d <= today),
          gapDownDay: b.gapDownDay,
        });
        b = { ...b, entryBlock: block ?? undefined };
      }

      if (opts.regime !== 'off') {
        const read = classifyRegime(bars.slice(Math.max(0, idx - 300), idx).map((c) => c.close));
        if (read.regime) b = { ...b, regime: read.regime };
        if (auto) {
          const dec = autoProfileDecision(b, read, t);
          if (dec.scalp !== null) {
            const errs = dec.scalp ? validateScalp(b, paramsFor({ ...b, scalp: true }, opts.params), bars[idx - 1].close) : [];
            if (!errs.length) b = { ...b, scalp: dec.scalp, profileSwitchedAt: t };
          }
        }
      }

      b = releaseSettled(b, t);
      b = recordDayHigh(b, bar.high, t);
      b = applyTrail(b, bar.open, opts.params);
      b = applyTrail(b, bar.high, opts.params);

      for (const d of decide(b, bar.high, t, opts.params)) {
        if (d.action !== 'SELL') continue;
        try {
          const before = b.closedLots.length;
          b = sellLot(b, d.lotId!, d.limitPrice!, t, nextTradingDayStart(t), opts.params);
          const closed = b.closedLots[before];
          bookCharges += closed.quantity * closed.sellPrice - closed.proceeds;
        } catch (e) {
          if (!(e instanceof BreakevenViolationError)) throw e;
        }
      }

      for (const d of decide(b, bar.low, t, opts.params)) {
        if (d.action !== 'BUY') continue;
        if (opts.buyBlock?.(day, d.level!)) break;
        const rung = rungPrice(b, d.epoch!, d.level!, opts.params);
        const fillPrice = rung !== null ? Math.min(rung, bar.open) : d.limitPrice!;
        const quantity = Math.floor((d.quantity! * d.limitPrice!) / fillPrice);
        if (quantity < 1) break;
        if (sweepOn) {
          // The rupees for this rung may be parked: bring back what is short.
          const onHand = symbols.reduce((x, y) => x + books.get(y)!.cash, 0) - cashOut;
          const cost = quantity * fillPrice * 1.002;
          if (onHand < cost) redeem(cost - onHand, t);
        }
        const cashBefore = b.cash;
        b = applyBuyFill(b, { epoch: d.epoch!, level: d.level!, fillPrice, quantity, at: t }, opts.params);
        bookCharges += cashBefore - b.cash - quantity * fillPrice;
        break;
      }

      b = { ...b, previousClose: bar.close };
      books.set(s, b);
      lastClose.set(s, bar.close);
    }

    // ── sweep: park after the day's buys, as the live sweep does at 15:01 ──
    if (sweepOn) {
      const bookCash = symbols.reduce((x, y) => x + books.get(y)!.cash, 0);
      const idle = bookCash + (opts.sweepUnassigned ? unassigned : 0);
      const buffer = bufferNeed(
        symbols.map((s) => {
          const b = books.get(s)!;
          const p = paramsFor(b, opts.params);
          return {
            cash: b.cash,
            tranche: nextTrancheSize(b, p),
            rungs: rungsPerSession(p.minBuyGapMs, ENTRY_WINDOW_MIN),
            active: b.enabled && !b.allocatorPaused && b.cash > 0,
          };
        }),
      );
      const parkedValue = units * unitPrice;
      const want = idle - buffer;
      const extra = want - parkedValue;
      if (extra >= DEFAULT_SWEEP_PARAMS.minParkRs) {
        const qty = Math.floor((extra * (1 - DEFAULT_SWEEP_PARAMS.chargePadPct / 100)) / unitPrice);
        if (qty > 0) {
          const fee = charges('BUY', unitPrice, qty, CNC_ETF).total;
          units += qty;
          sweepCost += qty * unitPrice + fee;
          sweepCharges += fee;
          cashOut += qty * unitPrice + fee;
        }
      } else if (parkedValue - Math.max(0, want) >= DEFAULT_SWEEP_PARAMS.minTopUpRs) {
        redeem(parkedValue - Math.max(0, want), t0);
      }
    }

    // ── mark the day ──
    let eq = unassigned - cashOut + units * unitPrice;
    let dep = 0;
    for (const s of symbols) {
      const b = books.get(s)!;
      const px = lastClose.get(s);
      eq += px ? equity(b, px) : b.cash + unsettledCash(b);
      dep += deployedCapital(b);
    }
    let bh = 0;
    for (const s of symbols) {
      const f = firstClose.get(s);
      const l = lastClose.get(s);
      bh += f && l ? (opts.capital / symbols.length) * (l / f) : opts.capital / symbols.length;
    }
    curve.push({ day, equity: eq, deployed: dep, parked: units * unitPrice, buyHold: bh });
  }

  const endTs = Date.parse(days[days.length - 1]);
  const closed = symbols.flatMap((s) => books.get(s)!.closedLots);
  return {
    from: days[0],
    to: days[days.length - 1],
    years: (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / YEAR,
    symbols,
    skipped,
    curve,
    roundTrips: closed.length,
    armedExits: closed.filter((l) => l.armed).length,
    avgHoldDays: closed.length ? closed.reduce((a, l) => a + (l.closedAt - l.openedAt) / DAY, 0) / closed.length : 0,
    realisedPnl: closed.reduce((a, l) => a + l.pnl, 0),
    bookCharges,
    sweepGain: sweepGain + (units * unitPrice - sweepCost),
    sweepCharges,
    openLots: symbols
      .flatMap((s) =>
        books.get(s)!.openLots.map((l) => ({
          symbol: s,
          pctVsCost: ((l.quantity * (lastClose.get(s) ?? l.fillPrice)) / l.quoteSpent - 1) * 100,
          ageDays: (endTs - l.openedAt) / DAY,
          cost: l.quoteSpent,
        })),
      )
      .sort((a, b) => a.pctVsCost - b.pctVsCost),
  };
}

/**
 * Average fraction of the portfolio in open lots (at cost) over the run,
 * measured against the portfolio's value that day. Against the starting
 * capital instead, an allocator that reinvests its profits reads as more than
 * 100% invested, and the exposure-matched benchmark becomes a leveraged one.
 */
export function capitalAtWork(run: SimRun): number {
  return run.curve.reduce((a, p) => a + (p.equity > 0 ? p.deployed / p.equity : 0), 0) / run.curve.length;
}

export { dropBadPrints } from '../barCleaning';

export interface SplitAdjustment {
  exDay: string;
  factor: number;
  /** False when Yahoo had already adjusted the prices, so nothing was changed. */
  applied: boolean;
}

/**
 * Back-adjust daily bars for splits and bonuses, the way the live engine scales
 * a book on the ex-date. Only when the bars actually JUMP by the action's
 * factor across the ex-date: Yahoo adjusts some histories and not others, and
 * dividing an already-adjusted series again would invent a crash. Pure.
 */
export function adjustForSplits(
  bars: Candle[],
  actions: ReadonlyArray<CorporateAction>,
): { bars: Candle[]; adjustments: SplitAdjustment[] } {
  let out = [...bars];
  const adjustments: SplitAdjustment[] = [];
  for (const a of actions) {
    if (a.type === 'DIVIDEND') continue;
    const factor = adjustmentFactor(a);
    if (!(factor > 0) || factor === 1) continue;
    const exDay = istParts(a.exDate).date;
    const i = out.findIndex((c) => istParts(c.timestamp).date >= exDay);
    if (i <= 0) continue;
    // Unadjusted if the ex-day open sits near close/factor rather than near the close.
    const ratio = out[i - 1].close / out[i].open;
    const unadjusted = Math.abs(Math.log(ratio / factor)) < Math.abs(Math.log(ratio));
    adjustments.push({ exDay, factor, applied: unadjusted });
    if (!unadjusted) continue;
    out = out.map((c, k) =>
      k < i ? { ...c, open: c.open / factor, high: c.high / factor, low: c.low / factor, close: c.close / factor } : c,
    );
  }
  return { bars: out, adjustments };
}

/**
 * Market Weather tests — Phases 1 and 2 (data, regime, calibration, odds, summary).
 *
 * The arithmetic matters, but the guards matter more. This feature's measured
 * failure mode is drifting into confident timing claims that history does not
 * support (MARKET_WEATHER.md), so several tests exist only to keep that out:
 *
 *   - US / global inputs must be read at the PREVIOUS close (no look-ahead);
 *   - a rule's exposure applies from the NEXT bar, never the one it observed;
 *   - every summary string is checked against the banned-phrase list;
 *   - "slow new buying" may only come from a sign whose rule beat the
 *     same-exposure mix in both halves — read from calibration, not hard-coded;
 *   - the shipped calibration must cover every signal and carry baselines.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { alignTo, expandingPct, forwardWorst, rollingMax, rollingMin, sma, splice, type Series } from '../services/marketWeather/series';
import { mergeSeries } from '../services/marketWeather/data';
import { computeBreadth } from '../services/marketWeather/breadth';
import { parseNiDate, parseValuation, readValuation } from '../services/marketWeather/valuation';
import { phaseOf, prepare, SIGNALS, stateAt, type MarketState } from '../services/marketWeather/regime';
import {
  calibrate,
  countEpisodes,
  diffCalibrations,
  drawdowns,
  rateCell,
  RULES,
  simulate,
  type Calibration,
  type SignalCalibration,
} from '../services/marketWeather/calibrate';
import { analogSpecFor, findAnalogs, gradeOf, readSignals } from '../services/marketWeather/odds';
import { BANNED, levelOf, summarize, supportedSignals, violations } from '../services/marketWeather/summary';
import shipped from '../services/marketWeather/calibration.json';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/** Weekday dates from `start`, n of them. */
function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

const series = (key: string, dates: string[], close: number[]): Series => ({ key, dates, close });

/** A long synthetic market: steady rise, a 30% crash, recovery. Deterministic. */
function synthMarket(n = 2600): Series {
  const dates = weekdays('2000-01-03', n);
  const close: number[] = [];
  let v = 1000;
  for (let i = 0; i < n; i++) {
    const wiggle = Math.sin(i / 7) * 0.004;
    const crash = i >= 1300 && i < 1360 ? -0.006 : 0;
    v *= 1 + 0.0004 + wiggle + crash;
    close.push(v);
  }
  return series('synth', dates, close);
}

// ── series ────────────────────────────────────────────────────────────────

test('alignTo with lag reads strictly BEFORE the date (no look-ahead into US closes)', () => {
  const axis = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const us = series('spx', ['2024-01-02', '2024-01-03', '2024-01-04'], [10, 20, 30]);
  assert.deepEqual(alignTo(axis, us, true), [null, 10, 20]);
  assert.deepEqual(alignTo(axis, us, false), [10, 20, 30]);
});

test('alignTo goes null when the source is stale', () => {
  const axis = ['2024-01-02', '2024-02-20'];
  const s = series('x', ['2024-01-01'], [5]);
  assert.deepEqual(alignTo(axis, s, false, 10), [5, null]);
});

test('sma, rollingMax, rollingMin', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(sma([1, null, 3, 4], 2), [null, null, null, 3.5]);
  assert.deepEqual(rollingMax([3, 1, 2, 5, 4], 2), [3, 3, 2, 5, 5]);
  assert.deepEqual(rollingMin([3, 1, 2, 5, 4], 3), [3, 1, 1, 1, 2]);
});

test('forwardWorst is null without a full window', () => {
  assert.ok(Math.abs(forwardWorst([100, 90, 95], 0, 2)! + 0.1) < 1e-12);
  assert.equal(forwardWorst([100, 90, 95], 1, 2), null);
});

test('splice uses the older series only before the cut', () => {
  const s = splice('b', series('w', ['a1', 'a2', 'a3'], [1, 2, 3]), series('n', ['a2', 'a3'], [20, 30]), 'a2');
  assert.deepEqual(s.close, [1, 20, 30]);
});

test('mergeSeries: fresh values win on overlapping dates', () => {
  const m = mergeSeries('k', series('k', ['d1', 'd2'], [1, 2]), series('k', ['d2', 'd3'], [22, 3]));
  assert.deepEqual(m.dates, ['d1', 'd2', 'd3']);
  assert.deepEqual(m.close, [1, 22, 3]);
});

// ── breadth ───────────────────────────────────────────────────────────────

test('breadth counts stocks above their own 200-day, and reports null under the coverage floor', () => {
  const dates = weekdays('2020-01-01', 260);
  const up = (k: number): Series => series(`u${k}`, dates, dates.map((_, i) => 100 + i + k));
  const down = (k: number): Series => series(`d${k}`, dates, dates.map((_, i) => 400 - i - k));
  const rows = computeBreadth(dates, [up(1), up(2), up(3), down(1)], 4);
  const last = rows[rows.length - 1];
  assert.equal(last.coverage, 4);
  assert.equal(last.above200, 0.75);
  assert.equal(last.at52wLow, 0.25);
  assert.equal(rows[100].above200, null, 'no stock has 200 closes yet');
  assert.equal(computeBreadth(dates, [up(1)], 4)[259].above200, null, 'below coverage floor');
});

test('breadth skips a stock with no bar that day instead of carrying it forward', () => {
  const dates = weekdays('2020-01-01', 230);
  const full = series('a', dates, dates.map((_, i) => 100 + i));
  const gap = series('b', dates.slice(0, 220), dates.slice(0, 220).map((_, i) => 100 + i));
  const rows = computeBreadth(dates, [full, gap], 1);
  assert.equal(rows[225].coverage, 1);
});

// ── valuation ─────────────────────────────────────────────────────────────

test('valuation parses the page-method body and the dates', () => {
  assert.equal(parseNiDate('08 Oct 2026'), '2026-10-08');
  assert.equal(parseNiDate('8-Jan-1999'), '1999-01-08');
  assert.equal(parseNiDate('garbage'), null);
  const body = {
    d: JSON.stringify([
      { DATE: '02 Jan 2020', pe: '28.1', pb: '3.6', divYield: '1.2' },
      { DATE: '01 Jan 2020', pe: '28.0', pb: '3.5', divYield: '1.2' },
      { DATE: '03 Jan 2020', pe: '0', pb: '3.5', divYield: '1.2' },
    ]),
  };
  const v = parseValuation(body);
  assert.deepEqual(v.dates, ['2020-01-01', '2020-01-02']);
  assert.deepEqual(v.pe, [28.0, 28.1]);
});

test('PE is ranked only inside the consolidated era; PB over all history', () => {
  const v = {
    dates: ['2020-01-01', '2021-03-30', '2021-03-31', '2022-01-01', '2023-01-01'],
    pe: [40, 41, 33, 22, 20],
    pb: [4, 4.2, 4.2, 3, 2.5],
    dy: [1, 1, 1, 1, 1],
  };
  const r = readValuation(v, '2023-06-01')!;
  assert.equal(r.date, '2023-01-01');
  assert.equal(r.pePctConsolidated, 0, 'lowest within 2021+ (pre-break 40/41 ignored)');
  assert.equal(r.pbPctAll, 0);
  assert.equal(readValuation(v, '2020-06-01')!.pePctConsolidated, null);
});

// ── regime ────────────────────────────────────────────────────────────────

test('phases follow the 5/10/20% convention', () => {
  assert.equal(phaseOf(-2), 'at-highs');
  assert.equal(phaseOf(-7), 'pullback');
  assert.equal(phaseOf(-14.6), 'correction');
  assert.equal(phaseOf(-25), 'bear');
});

test('the S&P signal on an Indian date uses the previous US close', () => {
  const dates = weekdays('2020-01-01', 260);
  const idx = series('nifty', dates, dates.map(() => 100));
  const spx = dates.map(() => 100);
  spx[259] = 50; // a US crash printed on the last date
  const p = prepare(idx, { spx: series('spx', dates, spx) });
  const sig = SIGNALS.find((s) => s.id === 'spxBelow200')!;
  assert.equal(sig.test(p, 259), false, 'the same-date US close is not yet knowable at 15:30 IST');
});

test('stateAt reports active and unavailable signals separately', () => {
  const m = synthMarket();
  const p = prepare(m, {});
  const s = stateAt(p, m.dates.length - 1);
  assert.ok(s.unavailable.includes('spxBelow200'));
  assert.ok(s.unavailable.includes('breadthDivergence'));
  assert.ok(!s.active.includes('spxBelow200'));
});

test('Brent persistence counts consecutive days above $90', () => {
  const dates = weekdays('2020-01-01', 10);
  const idx = series('n', dates, dates.map(() => 100));
  const brent = series('brent', dates, [80, 95, 96, 97, 85, 91, 92, 93, 94, 95]);
  const p = prepare(idx, { brent });
  // lagged by one day: on the last date Brent reads 94, the 4th day in a row above 90
  assert.equal(p.brentDaysAbove90[9], 4);
});

// ── calibration ───────────────────────────────────────────────────────────

test('countEpisodes groups on-days closer than the gap', () => {
  assert.equal(countEpisodes([1, 2, 3, 50, 51, 200], 21), 3);
  assert.equal(countEpisodes([], 21), 0);
});

test('drawdowns finds the crash and its recovery', () => {
  const m = synthMarket();
  const dd = drawdowns(m.dates, m.close, 0.1);
  assert.ok(dd.length >= 1);
  const big = dd.reduce((a, b) => (a.depthPct < b.depthPct ? a : b));
  assert.ok(big.depthPct < -15, `deepest ${big.depthPct}`);
});

test('rateCell: hit rate and lift against the baseline', () => {
  const m = synthMarket();
  const p = prepare(m, {});
  const r = { from: 260, to: m.close.length };
  const base = rateCell(p, r, () => true, null);
  assert.ok(base.hitRate! > 0 && base.hitRate! < 1);
  const pre = rateCell(p, r, (i) => i >= 1280 && i < 1300, base.hitRate);
  assert.equal(pre.hitRate, 1, 'every day just before the crash was followed by a 10% fall');
  assert.ok(pre.lift! > 1);
  assert.equal(pre.episodes, 1);
});

test('a rule acts on the NEXT bar: it cannot dodge the day it reacts to', () => {
  const dates = weekdays('2020-01-01', 300);
  const close = dates.map((_, i) => (i < 280 ? 100 : 50));
  const p = prepare(series('n', dates, close), {});
  const r = { from: 260, to: 300 };
  // An oracle that goes to cash the moment it SEES the crash close still eats it.
  const reactive = simulate(p, r, (pp, i) => (pp.close[i] < 60 ? 0 : 1));
  assert.ok(reactive.maxDD < -0.45, `maxDD ${reactive.maxDD}`);
});

test('calibrate covers every signal and both halves; buy-and-hold has zero edge', () => {
  const p = prepare(synthMarket(), {});
  const cal = calibrate(p, { split: '2005-01-01' });
  assert.equal(cal.signals.length, SIGNALS.length);
  const bh = cal.rules.find((r) => r.id === 'buyHold')!;
  assert.equal(bh.all.edgePp, 0);
  assert.equal(cal.priorReturn.length, 3);
  assert.deepEqual(diffCalibrations(cal, cal), []);
});

test('every rule closure is fresh per run (stateful rules do not leak a timer)', () => {
  const p = prepare(synthMarket(), {});
  const r = { from: 260, to: 2600 };
  const rule = RULES.find((x) => x.id === 'breadthHalf')!;
  assert.deepEqual(simulate(p, r, rule.make()), simulate(p, r, rule.make()));
});

test('shipped calibration.json: every signal, baselines, sane rates', () => {
  const cal = shipped as unknown as Calibration;
  assert.equal(cal.version, 1);
  for (const s of SIGNALS) assert.ok(cal.signals.some((x) => x.id === s.id), `missing ${s.id}`);
  for (const h of [cal.baseline.all, ...cal.baseline.halves]) assert.ok(h.hitRate! > 0 && h.hitRate! < 1);
  for (const s of cal.signals) {
    assert.equal(s.halves.length, 2);
    for (const c of [s.all, ...s.halves]) if (c.hitRate != null) assert.ok(c.hitRate >= 0 && c.hitRate <= 1);
  }
  assert.ok(cal.drawdowns.length >= 10, 'Sensex since 1998 had many 10% falls');
  assert.ok(cal.from < '2000-01-01');
});

// ── odds ──────────────────────────────────────────────────────────────────

const cell = (lift: number | null, episodes: number) => ({ days: 100, episodes, hitRate: 0.3, meanFwdRet: 0.02, lift });
const sc = (l1: number | null, l2: number | null, e1 = 10, e2 = 10): SignalCalibration => ({
  id: 'below200',
  all: cell(1, e1 + e2),
  halves: [cell(l1, e1), cell(l2, e2)],
});

test('grades: A needs both halves and enough episodes; B is the small-sample version', () => {
  assert.equal(gradeOf(sc(1.5, 1.4)).grade, 'A');
  assert.equal(gradeOf(sc(1.5, 1.4, 1, 9)).grade, 'B');
  assert.equal(gradeOf(sc(1.5, 0.7)).grade, 'C');
  assert.equal(gradeOf(sc(0.6, 0.5)).direction, 'lower');
  assert.equal(gradeOf(sc(null, 1.5)).grade, 'C');
});

test('shipped grades: India VIX spike is A, high India VIX is not', () => {
  const cal = shipped as unknown as Calibration;
  const g = (id: string) => gradeOf(cal.signals.find((s) => s.id === id)!).grade;
  assert.equal(g('vixSpike'), 'A');
  assert.equal(g('indiaVixHigh'), 'C');
  assert.equal(g('usVixHigh'), 'C');
});

test('analog spec bands bracket today', () => {
  const st = { fromAthPct: -14.5, breadthPct: 19 } as MarketState;
  const s = analogSpecFor(st);
  assert.ok(s.ddLo <= -0.145 && s.ddHi >= -0.145);
  assert.equal(s.breadthMax, 0.3);
  assert.equal(analogSpecFor({ fromAthPct: -2, breadthPct: 70 } as MarketState).breadthMax, null);
});

test('findAnalogs separates episodes and only uses full forward windows', () => {
  const p = prepare(synthMarket(), {});
  const a = findAnalogs(p, { ddLo: -0.25, ddHi: -0.1, breadthMax: null, describe: 'x' });
  assert.ok(a.episodes.length >= 1);
  for (const f of a.forward) if (f.median != null) assert.ok(f.p10! <= f.median && f.median <= f.p90!);
  assert.ok(a.baselineFallOdds! > 0);
});

// ── summary ───────────────────────────────────────────────────────────────

test('the banned list catches what it should (positive control)', () => {
  for (const bad of ['NIFTY will fall', 'a crash is due', 'crash in 30 days', 'target 20000', 'sell everything now', 'do not buy']) {
    assert.ok(violations(bad).length > 0, bad);
  }
  assert.equal(violations('Falls were more likely in both halves.').length, 0);
  assert.ok(BANNED.length >= 8);
});

test('no generated text ever contains a banned phrase, on any day of a full market cycle', () => {
  const cal = shipped as unknown as Calibration;
  const p = prepare(synthMarket(), {});
  const supported = supportedSignals(cal);
  for (let i = 300; i < p.axis.length; i += 25) {
    const st = stateAt(p, i);
    const sig = readSignals(cal, st);
    const an = findAnalogs(p, analogSpecFor(st), i);
    const s = summarize(st, sig, an, 'NIFTY 50', supported);
    for (const line of [s.headline, ...s.drivers, ...s.odds, ...s.guidance, s.note, ...sig.map((x) => x.reason)]) {
      assert.deepEqual(violations(line), [], `${st.date}: ${line}`);
    }
  }
});

test('every sign label and detail passes the banned list (they are quoted in the summary)', () => {
  // Found by the 2022-02-24 back-run: "India VIX jumped 30%+ in 5 days" reads as a forecast window.
  for (const s of SIGNALS) {
    assert.deepEqual(violations(s.label), [], s.label);
    assert.deepEqual(violations(s.detail), [], s.detail);
    assert.deepEqual(violations(`Warning sign on (grade A): ${s.label.toLowerCase()}.`), [], s.id);
  }
});

test('"slow new buying" comes only from signs whose rule beat the matched mix in both halves', () => {
  const cal = shipped as unknown as Calibration;
  const sup = supportedSignals(cal);
  for (const id of sup) {
    const ruleIds = { breadthDivergence: 'breadthHalf', spxBelow200: 'spxHalf', below200: 'trend200Half' } as Record<string, string>;
    const r = cal.rules.find((x) => x.id === ruleIds[id] || (id === 'below200' && x.id === 'trend200Out'))!;
    assert.ok(r.halves[0].edgePp > 0 && r.halves[1].edgePp > 0, id);
  }
  const fake: Calibration = { ...cal, rules: cal.rules.map((r) => ({ ...r, halves: [{ ...r.halves[0], edgePp: -1 }, r.halves[1]] })) };
  assert.deepEqual(supportedSignals(fake), []);
});

test('a correction is "stormy" and the guidance never says sell', () => {
  const cal = shipped as unknown as Calibration;
  const st = {
    date: '2026-10-09', index: 'nifty', close: 22500, fromAthPct: -14.5, from52wHighPct: -14.5, phase: 'correction',
    vs200Pct: -7.2, deathCross: true, ret3mPct: -7, ret12mPct: -8, breadthPct: 38, at52wLowPct: 10, breadthCoverage: 480,
    indiaVix: 14.6, indiaVix5dPct: 1, spxVs200Pct: 7, usVix: 15, brent: 104, brent3mPct: 30, brentDaysAbove90: 27,
    brentDaysAbove100: 5, usdinr: 96.6, usdinr3mPct: 0.3, us10y: 5.2, us10y6mChange: 0.9, gold3mPct: 5,
    active: ['below200', 'deathCross', 'oilShock', 'yieldsUp'], unavailable: [],
  } as MarketState;
  const sig = readSignals(cal, st);
  assert.equal(levelOf(st, sig), 'stormy');
  const s = summarize(st, sig, null, 'NIFTY 50', supportedSignals(cal));
  assert.ok(!s.guidance.join(' ').toLowerCase().includes('sell '));
  assert.ok(s.note.includes('not a forecast'));
});

// ── factor-study additions (2026-10-09) ──

test('expandingPct ranks against EARLIER values only', () => {
  const r = expandingPct([5, 1, 3, 10, null, 0], 2);
  assert.deepEqual(r, [null, null, 0.5, 1, null, 0]);
});

test('breadth pass: advance–decline, dispersion and defensive/cyclical returns', () => {
  const dates = weekdays('2020-01-01', 30);
  const up = (k: string, step: number): Series => ({ key: k, dates, close: dates.map((_, i) => 100 + i * step) });
  const stocks = [up('stk_A', 1), up('stk_B', 2), up('stk_C', 3), up('stk_D', -1)];
  const sec: Record<string, string> = { stk_A: 'Healthcare', stk_B: 'Healthcare', stk_C: 'Realty', stk_D: 'Realty' };
  const rows = computeBreadth(dates, stocks, 3, (k) => sec[k]);
  const last = rows[rows.length - 1];
  assert.equal(last.advNet, 0.5, '3 up, 1 down');
  assert.ok(last.dispersion21! > 0);
  // Groups need 5 members, so with 2 each the returns are null rather than a noisy read.
  assert.equal(last.defRet, null);
});

test('new signs fire on constructed states', () => {
  const dates = weekdays('2019-01-01', 400);
  const idx = { key: 'nifty', dates, close: dates.map((_, i) => 100 + i * 0.1) };
  const rows = dates.map((date, i) => ({
    date, coverage: 300, above200: 0.7, at52wLow: i === 399 ? 0.12 : 0.01,
    advNet: i > 330 ? -0.2 : 0.1, dispersion21: 0.05, defRet: 0.001, cycRet: -0.0005,
  }));
  const p = prepare(idx, {}, rows);
  const t = (id: string) => SIGNALS.find((s) => s.id === id)!.test(p, 399);
  assert.equal(t('newLowsSpread'), true);
  assert.equal(t('adDivergence'), true, 'index at its high, A/D line lower than 3 months ago');
  assert.equal(t('defensiveRotation'), true, 'defensives +0.15%/day over cyclicals for 63 days ≈ +10%');
  assert.equal(t('dispersionHigh'), false, 'flat dispersion is never in its own top 20%');
  assert.equal(t('spxMonthDown'), null, 'no S&P data → unavailable, never false');
});

test('turbulence and calm grades use their own tests', () => {
  const cell = (lift: number | null, episodes: number, fwd = 0.02) => ({ days: 100, episodes, hitRate: 0.3, meanFwdRet: fwd, lift });
  const sc = {
    id: 'spxMonthDown' as const,
    all: cell(1, 40),
    halves: [cell(0.7, 20), cell(0.8, 20)] as [ReturnType<typeof cell>, ReturnType<typeof cell>],
    turbulence: { all: cell(1.5, 40), halves: [cell(1.4, 20), cell(1.7, 20)] as [ReturnType<typeof cell>, ReturnType<typeof cell>] },
  };
  assert.equal(gradeOf(sc, 'turbulence').grade, 'A', 'judged on next-month dips, not 3-month falls');
  assert.equal(gradeOf(sc, 'warning').grade, 'C');
  const calm = { id: 'vrpHigh' as const, all: cell(0.5, 30), halves: [cell(0.3, 13, 0.11), cell(0.7, 15, 0.07)] as [ReturnType<typeof cell>, ReturnType<typeof cell>], baseFwdRet: [0.03, 0.03] as [number, number] };
  assert.equal(gradeOf(calm, 'calm').grade, 'A');
  assert.equal(gradeOf({ ...calm, baseFwdRet: [0.03, 0.065] }, 'calm').grade, 'C', 'must beat normal by a point in both halves');
});

test('shipped calibration carries turbulence cells and the new rules', () => {
  const cal = shipped as unknown as Calibration;
  for (const s of cal.signals) assert.ok(s.turbulence, `${s.id} has no turbulence cell`);
  for (const id of ['newLowsHalf', 'curveHalf']) assert.ok(cal.rules.some((r) => r.id === id), id);
});

test('the summary quotes the calmer post-2012 base rate next to the full history', () => {
  const cal = shipped as unknown as Calibration;
  const p = prepare(synthMarket(4200), {});
  const st = stateAt(p, 4000);
  const an = findAnalogs(p, analogSpecFor(st));
  assert.ok(an.baselineFallOddsRecent != null, 'the synthetic market reaches past 2012');
  const s = summarize(st, readSignals(cal, st), an, 'NIFTY 50');
  assert.ok(s.odds.some((l) => l.startsWith('Since 2012')), s.odds.join(' | '));
});

if (failures.length) {
  console.error(`marketWeather: ${passed} passed, ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`✓ marketWeather: ${passed} passed`);

/**
 * Market Weather tests — Phases 3 and 4: sector playbook, book exposure, the
 * news classifier and the event history.
 *
 * The classifier is held to a labelled set of headlines written in the style of
 * the catalogued events (≥80% must get their primary label). The guards that
 * matter most:
 *   - a single headline never activates an event (two distinct ones are needed);
 *   - IT stops counting as defensive under a US/AI/rates shock;
 *   - the book's "if NIFTY falls 10%" is exactly the value-weighted beta × −10;
 *   - sector advice is read from calibration, never typed in.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { buildBaskets, sectorPlaybook, splitBeta } from '../services/marketWeather/sectors';
import { bookExposure, downBetaOf, isDefensive } from '../services/marketWeather/exposure';
import { activeEvents, classifyHeadline, EVENT_HISTORY, labelHistory, measureEvents, parseFiiDii, SECTOR_REPORTS, type EventLabel } from '../services/marketWeather/events';
import { nseDate } from '../services/marketEvents';
import { sectorLeaders } from '../services/marketWeather/summary';
import type { Calibration } from '../services/marketWeather/calibrate';
import type { Series } from '../services/marketWeather/series';
import shipped from '../services/marketWeather/calibration.json';
import { scoreStocks } from '../services/marketWeather/stockCalls';
import { verdictOf } from '../services/marketWeather/verdict';
import { levelOf, violations } from '../services/marketWeather/summary';
import type { MarketState } from '../services/marketWeather/regime';
import type { SignalRead } from '../services/marketWeather/odds';

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

// ── sectors ───────────────────────────────────────────────────────────────

test('splitBeta separates down-day and up-day sensitivity', () => {
  const x = [100, 99, 100, 98, 100, 97, 100];
  // y falls twice as much on down days and moves the same on up days
  const y = [100];
  for (let i = 1; i < x.length; i++) {
    const r = x[i] / x[i - 1] - 1;
    y.push(y[i - 1] * (1 + (r < 0 ? 2 * r : r)));
  }
  const b = splitBeta(x, y, 1);
  assert.equal(b.down, 2);
  assert.equal(b.up, 1);
});

test('baskets are equal-weight, need 3 members, and ignore one-stock gaps', () => {
  const axis = weekdays('2020-01-01', 5);
  const mk = (k: string, c: number[]): Series => ({ key: k, dates: axis, close: c });
  const stocks = new Map<string, Series>([
    ['A', mk('A', [100, 110, 110, 110, 110])],
    ['B', mk('B', [100, 100, 100, 100, 100])],
    ['C', mk('C', [100, 100, 100, 100, 100])],
    ['D', mk('D', [100, 50, 50, 50, 50])], // other sector, only one member
  ]);
  const sectors = new Map([['A', 'S'], ['B', 'S'], ['C', 'S'], ['D', 'T']]);
  const b = buildBaskets(axis, stocks, sectors);
  assert.equal(b.length, 1, 'T has one member, below the minimum');
  assert.ok(Math.abs(b[0].level[1]! - 100 * (1 + 0.1 / 3)) < 1e-9);
});

test('sectorPlaybook measures relative return in the fall and the rebound', () => {
  const axis = weekdays('2020-01-01', 400);
  const close = axis.map((_, i) => (i < 100 ? 100 : i < 150 ? 100 - (i - 100) * 0.5 : 75 + (i - 150) * 0.1));
  const defensive = axis.map((_, i) => (i < 100 ? 100 : i < 150 ? 100 - (i - 100) * 0.1 : 95));
  const pb = sectorPlaybook(axis, close, [{ sector: 'Def', members: ['x', 'y', 'z'], level: defensive }], [
    { peak: axis[99], trough: axis[149], depthPct: -25, fallDays: 50, recovered: null },
  ]);
  assert.equal(pb[0].inFall.beat, 1);
  assert.ok(pb[0].inFall.meanPp! > 15);
  assert.ok(pb[0].rebound.meanPp! < 0, 'a flat defensive lags the rebound');
});

// ── exposure ──────────────────────────────────────────────────────────────

test('book beta is the value-weighted down-day beta; −10% scales it', () => {
  const betas: Record<string, number | null> = { A: 0.5, B: 1.5, C: null };
  const e = bookExposure(
    [
      { symbol: 'A', quantity: 10, price: 100 },
      { symbol: 'B', quantity: 10, price: 100 },
      { symbol: 'C', quantity: 10, price: 100 },
    ],
    (s) => betas[s],
    () => 'Capital Goods',
  );
  assert.equal(e.totalValue, 3000);
  assert.equal(e.downBeta, 1, 'C has no beta and is excluded from the weighting, not counted as zero');
  assert.equal(e.ifIndexMinus10Pct, -10);
  assert.ok(Math.abs(e.coverage - 2 / 3) < 1e-9);
});

test('IT is defensive unless a US / AI / rates shock is active', () => {
  assert.equal(isDefensive('TCS', 'Information Technology', []), true);
  assert.equal(isDefensive('TCS', 'Information Technology', ['sector-disruption']), false);
  assert.equal(isDefensive('TCS', 'Information Technology', ['rates']), false);
  assert.equal(isDefensive('TCS', 'Information Technology', ['war-oil']), true);
  assert.equal(isDefensive('HINDUNILVR', 'Fast Moving Consumer Goods', ['rates']), true);
  assert.equal(isDefensive('GOLDBEES', 'Unclassified', []), true);
  assert.equal(isDefensive('SBIN', 'Financial Services', []), false);
});

test('downBetaOf needs enough overlapping history', () => {
  const axis = weekdays('2020-01-01', 300);
  const idx: Series = { key: 'n', dates: axis, close: axis.map((_, i) => 100 + Math.sin(i) * 3) };
  const stk: Series = { key: 's', dates: axis, close: idx.close.map((c) => c * 2) };
  assert.ok(Math.abs(downBetaOf(idx, stk)! - 1) < 0.01);
  assert.equal(downBetaOf(idx, { key: 's', dates: axis.slice(0, 50), close: stk.close.slice(0, 50) }), null);
  assert.equal(downBetaOf(idx, undefined), null);
});

// ── events ────────────────────────────────────────────────────────────────

const LABELLED: [string, EventLabel][] = [
  ['Sensex tanks 1,000 points as Iran fires missiles at Israel', 'war-oil'],
  ['Stock market crash: Nifty below 23,800 as US-Iran war sends crude soaring', 'war-oil'],
  ['Israel strikes Iran nuclear sites; markets open deep in red', 'war-oil'],
  ['Russia invades Ukraine: Sensex crashes 2,700 points', 'war-oil'],
  ['Hamas attack on Israel: Adani Ports, OMC stocks fall', 'war-oil'],
  ['Operation Sindoor: India strikes terror camps in Pakistan', 'war-indo-pak'],
  ['Pahalgam terror attack: tourism stocks slide', 'war-indo-pak'],
  ['India-Pakistan tension: defence stocks HAL, BEL rally', 'war-indo-pak'],
  ['Galwan clash: Nifty swings as India-China border tension rises', 'war-other'],
  ['India, Pakistan agree to ceasefire; Nifty jumps 3.8%', 'de-escalation'],
  ['US-Iran ceasefire lifts markets; IndiGo up 10%', 'de-escalation'],
  ['RBI hikes repo rate by 25 bps to 5.50% in surprise move', 'rates'],
  ['Fed signals more rate hikes; bond yields climb', 'rates'],
  ['MPC keeps repo rate unchanged at 5.25%', 'rates'],
  ['Rupee hits record low of 96.8 against the dollar', 'fx'],
  ['Rupee slumps past 68 as foreign outflows mount', 'fx'],
  ['Election results 2024: BJP falls short of majority, Nifty sinks 6%', 'election'],
  ['Exit polls predict clear majority; markets set to rally', 'election'],
  ['Budget 2024: STCG raised to 20%, LTCG to 12.5%; STT on F&O hiked', 'tax-policy'],
  ['SEBI F&O curbs: broker stocks Angel One, BSE tumble', 'tax-policy'],
  ['LTCG tax returns in Budget; Sensex falls 840 points', 'tax-policy'],
  ['IL&FS default spooks NBFC stocks; DHFL crashes 60%', 'credit'],
  ['Hindenburg report: Adani stocks lose $100 billion', 'corporate'],
  ['Trump announces 25% tariff on Indian goods', 'trade'],
  ['US 50% tariffs hit textile, shrimp exporters', 'trade'],
  ['Wall Street sell-off drags Asian markets lower', 'global-financial'],
  ['Yen carry trade unwind triggers global sell-off; Nifty down 2.7%', 'global-financial'],
  ['Nifty IT crashes 5% on AI disruption fears; TCS, Infosys slide', 'sector-disruption'],
  ['$100,000 H-1B visa fee hits IT stocks', 'sector-disruption'],
  ['Brent crude surges above $100 a barrel', 'oil-spike'],
  ['Government announces corporate tax cut; Sensex soars 1,900 points', 'positive-policy'],
];

test('classifier gets the primary label on ≥80% of the labelled headlines', () => {
  const misses = LABELLED.filter(([t, l]) => !classifyHeadline(t).includes(l));
  const acc = 1 - misses.length / LABELLED.length;
  assert.ok(acc >= 0.8, `accuracy ${(acc * 100).toFixed(0)}%; misses: ${misses.map((m) => m[0]).join(' | ')}`);
});

test('classifier ignores ordinary market headlines and cricket', () => {
  for (const t of ['Nifty ends flat; HDFC Bank, Reliance gain', 'India vs Pakistan cricket: record viewership', 'Infosys Q2 results beat estimates']) {
    assert.deepEqual(classifyHeadline(t), [], t);
  }
});

// False positives the first LIVE run produced on 2026-10-09. Each must no longer carry the label.
const LIVE_FALSE_POSITIVES: [string, EventLabel][] = [
  ['Pakistan Out, Bangladesh In: Major Shake Up Takes Place In Participants Lineup In Asian Hockey Champions Trophy', 'war-indo-pak'],
  ['Indian SIMs used to operate WhatsApp from Pakistan, NIA starts probe | India News', 'war-indo-pak'],
  ['TCS shares rise as AI revenue offsets sluggish growth, lifts Indian IT stocks', 'sector-disruption'],
  ['TCS stock surges over 5% after Q2 results, IT stocks rally as AI, growth optimism overshadows US visa curbs', 'sector-disruption'],
  ["Dow Jones Futures Rise After AI Stocks Tumble On OpenAI News; SpaceX Move Slams Verizon, AT&T Late", 'global-financial'],
  ['GIFT Nifty jumps 100 pts, signals positive start for Sensex, Nifty; crude oil, FII selling remain key...', 'oil-spike'],
  ['India plans Exim Bank credit lines to rescue solar exports', 'trade'],
];

test('the false positives from the first live run stay fixed', () => {
  for (const [t, l] of LIVE_FALSE_POSITIVES) assert.ok(!classifyHeadline(t).includes(l), `${l}: ${t}`);
});

test('and the true positives from that run still label', () => {
  assert.ok(classifyHeadline('Sensex Plunges 1,045 Points, Nifty Hits 2026 Low as Oil Prices Surge').includes('oil-spike'));
  assert.ok(classifyHeadline('RBI hikes repo rate to 5.50%; shifts policy stance to calibrated tightening').includes('rates'));
  assert.ok(classifyHeadline("INDIA RUPEE-Dip in US yields, dollar lend RBI hand in slowing rupee's slide to all-time low").includes('fx'));
  assert.ok(classifyHeadline('Asian stocks open lower as AI spending doubts hit Wall Street; Kospi, Taiwan shut').includes('global-financial'));
});

test('one headline never activates an event; two distinct ones do; duplicates count once', () => {
  const h = (title: string, labels: EventLabel[]) => ({ title, source: 's', at: Date.now(), url: '', labels });
  assert.deepEqual(activeEvents([h('Iran strikes Israel', ['war-oil'])]), []);
  assert.deepEqual(activeEvents([h('Iran strikes Israel', ['war-oil']), h('Iran strikes Israel!', ['war-oil'])]), []);
  const a = activeEvents([h('Iran strikes Israel', ['war-oil']), h('Oil jumps as Israel hits back', ['war-oil'])]);
  assert.equal(a.length, 1);
  assert.equal(a[0].label, 'war-oil');
});

test('every label has a sector report; event history is dated and ordered', () => {
  for (const l of Object.keys(SECTOR_REPORTS)) assert.ok(SECTOR_REPORTS[l as EventLabel].hit);
  for (let i = 1; i < EVENT_HISTORY.length; i++) assert.ok(EVENT_HISTORY[i].date > EVENT_HISTORY[i - 1].date);
});

test('measureEvents: first day, worst 60, recovery', () => {
  const dates = weekdays('2020-01-01', 100);
  const close = dates.map((_, i) => (i < 10 ? 100 : i < 20 ? 90 : 101));
  const m = measureEvents(dates, close, [{ date: dates[10], label: 'war-oil', name: 'x' }]);
  assert.equal(m[0].firstDayPct, -10);
  assert.equal(m[0].worst60Pct, -10);
  assert.equal(m[0].recoveryDays, 10);
  const lh = labelHistory(m, dates, close);
  assert.equal(lh[0].higherAfter60, 1);
});

test('FII/DII parser reads NSE\'s payload', () => {
  const body = [
    { buyValue: '22987.97', category: 'DII', date: '08-Oct-2026', netValue: '10703.11', sellValue: '12284.86' },
    { buyValue: '15725.45', category: 'FII/FPI', date: '08-Oct-2026', netValue: '-12943.58', sellValue: '28669.03' },
  ];
  assert.deepEqual(parseFiiDii(body, nseDate), { date: '2026-10-08', fiiNet: -12943.58, diiNet: 10703.11 });
  assert.equal(parseFiiDii({}, nseDate), null);
});

// ── shipped calibration (phases 3–4) ───────────────────────────────────────

test('shipped sector table and event history are present and readable', () => {
  const cal = shipped as unknown as Calibration;
  assert.ok((cal.sectors?.length ?? 0) >= 15);
  assert.ok((cal.eventMoves?.length ?? 0) >= 35);
  assert.ok(cal.events?.some((e) => e.label === 'war-oil'));
});

test('sector advice comes from calibration and names real defensives', () => {
  const cal = shipped as unknown as Calibration;
  const l = sectorLeaders(cal);
  assert.ok(l.heldUp.includes('Fast Moving Consumer Goods'));
  assert.ok(l.heldUp.includes('Healthcare'));
  assert.ok(!l.heldUp.includes('Realty'));
  assert.ok(l.ledRebound.includes('Metals & Mining'));
  assert.deepEqual(sectorLeaders({ ...cal, sectors: [] }), { heldUp: [], ledRebound: [] });
});

// ── verdict (top of the screen) ───────────────────────────────────────────

const baseState = {
  date: '2026-10-09', index: 'nifty', close: 22518, fromAthPct: -14.5, from52wHighPct: -14.5, phase: 'correction',
  vs200Pct: -7.2, deathCross: true, ret3mPct: -7, ret12mPct: -8, breadthPct: 38, at52wLowPct: 10, breadthCoverage: 488,
  indiaVix: 14.6, indiaVix5dPct: 1, spxVs200Pct: 7, usVix: 15, brent: 104, brent3mPct: 37, brentDaysAbove90: 27,
  brentDaysAbove100: 5, usdinr: 96.6, usdinr3mPct: 0.3, us10y: 5.2, us10y6mChange: 0.9, gold3mPct: 5,
  active: ['below200', 'deathCross'], unavailable: [],
} as MarketState;
const sigRead = (id: string, on: boolean, kind: SignalRead['kind'] = 'warning', grade: SignalRead['grade'] = 'B'): SignalRead => ({
  id: id as SignalRead['id'], kind, label: 'Index near its high while most stocks are not', detail: '', on, grade, direction: kind === 'calm' ? 'lower' : 'higher',
  reason: 'Falls were more likely in both halves.', oddsWhenOn: 0.38, baseline: 0.21, liftHalves: [2.9, 4.1], episodes: 10, meanFwdRet: -0.06,
  oddsRecent: 0.2, baselineRecent: 0.09, recentFrom: '2012-01-01', dipOddsWhenOn: 0.3, dipBaseline: 0.2,
});

test('verdict: HOLD only when a supported sign is on; steps in a correction; invest when calm', () => {
  const hold = verdictOf({ ...baseState, phase: 'at-highs', fromAthPct: -1 }, [sigRead('breadthDivergence', true)], ['breadthDivergence'], null, 'stormy');
  assert.equal(hold.action, 'hold');
  // The same sign ON but not supported by the rule test does not produce HOLD.
  assert.notEqual(verdictOf({ ...baseState, phase: 'at-highs', fromAthPct: -1 }, [sigRead('breadthDivergence', true)], [], null, 'stormy').action, 'hold');
  assert.equal(verdictOf(baseState, [], ['breadthDivergence'], null, 'stormy').action, 'invest-in-steps');
  assert.equal(verdictOf({ ...baseState, phase: 'at-highs', fromAthPct: -2, active: [] }, [], [], null, 'calm').action, 'invest');
});

test('verdict text is plain, gives a rupee example, never says sell, and passes the banned list', () => {
  for (const v of [
    verdictOf(baseState, [], [], null, 'stormy'),
    verdictOf({ ...baseState, phase: 'at-highs', fromAthPct: -1 }, [sigRead('breadthDivergence', true)], ['breadthDivergence'], null, 'stormy'),
    verdictOf({ ...baseState, phase: 'at-highs', fromAthPct: -2, active: [] }, [], [], null, 'calm'),
  ]) {
    assert.ok(v.example.includes('₹'), v.action);
    for (const t of [v.title, v.oneLine, v.example, ...v.why, v.never]) assert.deepEqual(violations(t), [], t);
    assert.ok(!/\bsell (your|all|everything)\b/i.test([v.oneLine, v.example, ...v.why].join(' ')));
  }
  const steps = verdictOf(baseState, [], [], null, 'stormy');
  assert.ok(steps.example.includes('21,730'), 'step levels come from today\'s close');
});

test('verdict step plans: smaller in turbulence, front-loaded when fear is priced high, standard when both', () => {
  const turb = sigRead('spxMonthDown', true, 'turbulence', 'A');
  const calm = sigRead('vrpHigh', true, 'calm', 'A');
  const a = verdictOf(baseState, [turb], [], null, 'stormy');
  assert.equal(a.action, 'invest-in-steps');
  assert.equal(a.steps, 'smaller');
  assert.ok(a.example.includes('₹20,000') && a.example.includes('three weeks'));
  const b = verdictOf(baseState, [calm], [], null, 'stormy');
  assert.equal(b.steps, 'front-loaded');
  assert.ok(b.example.includes('₹40,000'));
  assert.equal(verdictOf(baseState, [turb, calm], [], null, 'stormy').steps, 'standard');
  // A grade-C turbulence sign changes nothing.
  assert.equal(verdictOf(baseState, [sigRead('vrpLow', true, 'turbulence', 'C')], [], null, 'stormy').steps, 'standard');
  for (const v of [a, b]) for (const t of [v.title, v.oneLine, v.example, ...v.why]) assert.deepEqual(violations(t), [], t);
});

test('turbulence alone makes a calm market at least unsettled, and never stormy', () => {
  const calmState = { ...baseState, phase: 'at-highs', fromAthPct: -1, active: [], brentDaysAbove90: 0 } as MarketState;
  assert.equal(levelOf(calmState, [sigRead('spxMonthDown', true, 'turbulence', 'A')]), 'unsettled');
  assert.equal(levelOf(calmState, [sigRead('vrpHigh', true, 'calm', 'A')]), 'calm');
});

// ── stock calls ───────────────────────────────────────────────────────────

test('stock scoring: high-beta weak names are careful, low-beta strong ones hold up, news counts once', () => {
  const axis = weekdays('2023-01-02', 600);
  const idx: Series = { key: 'nifty', dates: axis, close: axis.map((_, i) => 100 * (1 + Math.sin(i / 3) * 0.02) * (1 + i * 0.0002)) };
  const scaled = (k: string, beta: number, drift: number): Series => {
    const c = [100];
    for (let i = 1; i < axis.length; i++) c.push(c[i - 1] * (1 + beta * (idx.close[i] / idx.close[i - 1] - 1) + drift));
    return { key: k, dates: axis, close: c };
  };
  const names: [string, string, number, number][] = [
    ['BPCL', 'Oil Gas & Consumable Fuels', 1.4, -0.0015],
    ['TORNT', 'Healthcare', 0.5, 0.0012],
  ];
  for (let k = 0; k < 10; k++) names.push([`F${k}`, 'Capital Goods', 1, 0]);
  const inputs = names.map(([symbol, sector, b, d]) => ({ symbol, sector, series: scaled(symbol, b, d), held: false }));
  inputs.push({ symbol: 'FLAG', sector: 'Capital Goods', series: scaled('FLAG', 0.5, 0.0012), held: false, surveillance: { asm: 'LT-ASM Stage 1' } } as never);
  const r = scoreStocks(idx, inputs, shipped as unknown as Calibration, ['war-oil', 'oil-spike', 'fx']);
  const bpcl = r.careful.find((c) => c.symbol === 'BPCL');
  assert.ok(bpcl, 'BPCL is on the careful list');
  assert.equal(bpcl!.tags.filter((t) => t.text.startsWith("Today's news")).length, 1, 'three labels, one shock, one tag');
  assert.ok(r.resilient.some((c) => c.symbol === 'TORNT'));
  assert.ok(!r.resilient.some((c) => c.symbol === 'FLAG'), 'a stock under surveillance is never on the holding-up list');
  for (const c of [...r.careful, ...r.resilient]) for (const t of c.tags) assert.deepEqual(violations(t.text), [], t.text);
});

if (failures.length) {
  console.error(`marketWeatherBook: ${passed} passed, ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`✓ marketWeatherBook: ${passed} passed`);

/**
 * Portfolio backtest of the accumulator, driving the REAL engine.
 *
 *   npm run sim -- --set large --years 5
 *   npm run sim -- --symbols NIFTYBEES,BANKBEES,JUNIORBEES --years 10 --sizing equal --sweep 6
 *   npm run sim -- --set etf --compare          # equal vs allocator, sweep off vs on
 *   npm run sim -- --set large --sens           # target / step / rung sensitivity
 *
 * Flags
 *   --set large|books|etf   a preset universe, or --symbols A,B,C
 *   --years N               window length, ending on the last bar (default 5)
 *   --capital N             rupees (default 200000)
 *   --regime off|regime|auto  regime read each day; auto = also the scalp
 *                           autopilot, as live books run (default auto)
 *   --sizing equal|allocator  fixed equal budgets, or the daily capital
 *                           allocator as live (default allocator)
 *   --sweep PCT             park idle book cash in a liquid ETF yielding PCT%/yr,
 *                           with real charges (default 0 = off)
 *   --sweep-unassigned      also park money no book holds (live does not)
 *   --core PCT              index-ETF core share of capital (allocator)
 *   --ceiling PCT           most of capital all books may hold together
 *   --rescue N              rungs of cash for a dropped stock still holding lots
 *   --count-held            dropped stocks holding lots take up book slots
 *   --phase3                one line per Phase 3 setting against the baseline
 *   --phase4                one line per Phase 4 setting (re-armed rungs, volatility gaps)
 *   --phase5                one line per gap-down block setting
 *   --weather               Market Weather hook: withhold buys for 63 sessions after
 *                           a breadth divergence (and a failed sign as a control)
 *
 * Every number comes from `services/backtest/accumulatorSim`, which calls the
 * shipped engine, allocator, regime reader and cost model. Read its header for
 * the fill model and what is not modelled.
 *
 * READING THE OUTPUT. A strategy that keeps a fraction w of its money in the
 * market must be compared with simply holding w in the basket and the rest in
 * cash ("exposure-matched"), not with full buy-and-hold. And a difference that
 * changes sign between the two halves of the window is noise.
 */
import { fetchYahooDailyHistory } from '../services/yahoo';
import { fetchCalendar } from '../services/marketEvents';
import { istParts } from '../services/session';
import { DEFAULT_ACCUMULATOR_PARAMS, type AccumulatorParams } from '../services/accumulator/types';
import {
  adjustForSplits,
  dropBadPrints,
  capitalAtWork,
  exposureMatched,
  fixedRateSeries,
  seriesStats,
  simulatePortfolio,
  type RegimeMode,
  type SimOptions,
  type SimRun,
} from '../services/backtest/accumulatorSim';
import type { Candle } from '../types';
import { loadMarketHistory, prepareIndex } from '../services/marketWeather/history';
import { SIGNAL_BY_ID, type SignalId } from '../services/marketWeather/regime';

export const PRESETS: Record<string, string[]> = {
  large: 'RELIANCE,TCS,HDFCBANK,ICICIBANK,INFY,ITC,LT,SBIN,BHARTIARTL,AXISBANK,KOTAKBANK,HINDUNILVR'.split(','),
  books: 'ETERNAL,BAJAJHFL,OIL,COALINDIA,OLAELEC,NTPC,COROMANDEL,KAYNES,SEAMECLTD,ABFRL,ARE&M,SCI,NHPC,RCF,IREDA,NBCC,RELIANCE,TCS,SYRMA'.split(','),
  etf: 'NIFTYBEES,BANKBEES,JUNIORBEES'.split(','),
};
// Stocks plus the index ETFs, for the core / satellite split.
PRESETS.mix = [...PRESETS.books, ...PRESETS.etf];
PRESETS.largemix = [...PRESETS.large, ...PRESETS.etf];
const isEtf = (s: string) => PRESETS.etf.includes(s) || /BEES$|ETF$|IETF$/i.test(s);

const LIQUID_PCT = 6.5;
const pc = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

/** The window plus a year and a half of warm-up for the start gate, regime and strength score. */
const WARMUP_YEARS = 1.5;

function row(label: string, values: number[], days: string[]): string {
  const s = seriesStats(values, days);
  const ratio = s.maxDdPct > 0 ? s.cagrPct / s.maxDdPct : 0;
  return (
    `  ${label.padEnd(44)} CAGR ${pc(s.cagrPct).padStart(8)}  maxDD ${s.maxDdPct.toFixed(1).padStart(5)}%  ` +
    `CAGR/DD ${ratio.toFixed(2).padStart(5)}  halves ${pc(s.halves[0])} / ${pc(s.halves[1])}`
  );
}

function report(label: string, run: SimRun, opts: SimOptions, nifty?: Candle[]): void {
  const days = run.curve.map((p) => p.day);
  const eq = run.curve.map((p) => p.equity);
  const bh = run.curve.map((p) => p.buyHold);
  const w = capitalAtWork(run);
  const cashPct = opts.sweepYieldPct && opts.sweepYieldPct > 0 ? opts.sweepYieldPct : LIQUID_PCT;

  console.log(`\n── ${label} ── ${run.from}..${run.to} (${run.years.toFixed(2)}y), ${run.symbols.length} symbols, ${inr(opts.capital)}`);
  if (run.skipped.length) console.log(`  skipped (too little history before the window): ${run.skipped.join(', ')}`);
  console.log(
    `  at work ${(w * 100).toFixed(1)}%  trips ${run.roundTrips} (${run.armedExits} rode past target)  avg hold ${run.avgHoldDays.toFixed(0)}d  ` +
      `realised ${inr(run.realisedPnl)}  book charges ${inr(run.bookCharges)}` +
      (opts.sweepYieldPct ? `  sweep gain ${inr(run.sweepGain)} (charges ${inr(run.sweepCharges)})` : ''),
  );
  const open = run.openLots;
  console.log(
    `  open lots at end ${open.length}, cost ${inr(open.reduce((a, l) => a + l.cost, 0))}` +
      (open.length ? `, worst ${open[0].pctVsCost.toFixed(0)}% (${open[0].symbol}, ${open[0].ageDays.toFixed(0)}d)` : '') +
      (open.length ? `, oldest ${Math.max(...open.map((l) => l.ageDays)).toFixed(0)}d` : ''),
  );
  console.log(row('strategy', eq, days));
  console.log(row(`exposure-matched: ${(w * 100).toFixed(0)}% basket + cash at ${cashPct}%`, exposureMatched(bh, days, w, cashPct), days));
  console.log(row('equal-weight buy-and-hold of the basket', bh, days));
  if (nifty?.length) {
    const map = new Map(nifty.map((c) => [istParts(c.timestamp).date, c.close]));
    let last = 0;
    const series = days.map((d) => (last = map.get(d) ?? last));
    const first = series.find((x) => x > 0) ?? 1;
    console.log(row('NIFTYBEES buy-and-hold', series.map((x) => (opts.capital * (x || first)) / first), days));
  }
  console.log(row(`liquid fund ${LIQUID_PCT}%`, fixedRateSeries(opts.capital, days, LIQUID_PCT), days));
}

/** One line per variant: strategy, exposure-matched benchmark, the difference, each with its halves. */
function lineTable(variants: [string, SimOptions][], universe: Map<string, Candle[]>): void {
  console.log(`\n${'variant'.padEnd(30)} ${'CAGR'.padStart(7)} ${'maxDD'.padStart(6)}  halves          | matched  halves          | diff   halves        | work  trips  oldest/worst lot`);
  for (const [name, o] of variants) {
    const run = simulatePortfolio(universe, o);
    const days = run.curve.map((x) => x.day);
    const st = seriesStats(run.curve.map((x) => x.equity), days);
    const w = capitalAtWork(run);
    const m = seriesStats(exposureMatched(run.curve.map((x) => x.buyHold), days, w, 6), days);
    const f = (n: number) => n.toFixed(2).padStart(6);
    const worst = run.openLots[0];
    console.log(
      `${name.padEnd(30)} ${f(st.cagrPct)}% ${st.maxDdPct.toFixed(1).padStart(5)}%  ${f(st.halves[0])}/${f(st.halves[1])} | ` +
        `${f(m.cagrPct)}  ${f(m.halves[0])}/${f(m.halves[1])} | ` +
        `${f(st.cagrPct - m.cagrPct)} ${f(st.halves[0] - m.halves[0])}/${f(st.halves[1] - m.halves[1])} | ` +
        `${(w * 100).toFixed(0).padStart(3)}%  ${String(run.roundTrips).padStart(5)}  ` +
        (run.openLots.length ? `${Math.max(...run.openLots.map((l) => l.ageDays)).toFixed(0)}d / ${worst.pctVsCost.toFixed(0)}%` : '-'),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
  };
  const set = arg('set', '');
  const symbols = set ? PRESETS[set] : arg('symbols', PRESETS.large.join(',')).split(',').map((s) => s.trim().toUpperCase());
  if (!symbols?.length) throw new Error(`unknown --set ${set}; use ${Object.keys(PRESETS).join('|')} or --symbols`);
  const years = Number(arg('years', '5'));
  const base: SimOptions = {
    years,
    capital: Number(arg('capital', '200000')),
    params: DEFAULT_ACCUMULATOR_PARAMS,
    regime: arg('regime', 'auto') as RegimeMode,
    sizing: arg('sizing', 'allocator') as SimOptions['sizing'],
    sweepYieldPct: Number(arg('sweep', '0')),
    sweepUnassigned: args.includes('--sweep-unassigned'),
    etfs: new Set(symbols.filter(isEtf)),
    allocation: {
      ...(args.includes('--core') ? { corePct: Number(arg('core', '60')) } : {}),
      ...(args.includes('--ceiling') ? { maxDeployPct: Number(arg('ceiling', '85')) } : {}),
      ...(args.includes('--rescue') ? { rescueRungs: Number(arg('rescue', '1')) } : {}),
      ...(args.includes('--count-held') ? { countHeldBooks: true } : {}),
    },
  };

  const from = Date.now() - (years + WARMUP_YEARS) * 365.25 * 86_400_000;
  console.log(`\nFetching ${(years + WARMUP_YEARS).toFixed(1)} years of daily bars for ${symbols.length} symbols…`);
  const data = new Map<string, Candle[]>();
  for (const s of [...new Set([...symbols, 'NIFTYBEES'])]) {
    const chart = await fetchYahooDailyHistory(s, from);
    const raw = (chart?.candles ?? []).filter((c) => c.close > 0);
    if (!raw.length) {
      console.log(`  ${s}: no data`);
      continue;
    }
    // Splits and bonuses Yahoo left unadjusted would read as crashes.
    const split = adjustForSplits(raw, chart?.actions ?? []);
    for (const a of split.adjustments.filter((x) => x.applied)) {
      console.log(`  ${s}: ×${a.factor.toFixed(2)} split/bonus on ${a.exDay} adjusted (Yahoo had not)`);
    }
    // Then bad prints, which would otherwise be bought and sold as real prices.
    const { bars, dropped } = dropBadPrints(split.bars);
    if (dropped.length) console.log(`  ${s}: dropped ${dropped.length} bad print(s): ${dropped.join(', ')}`);
    data.set(s, bars);
  }
  const nifty = data.get('NIFTYBEES');
  const universe = new Map([...data].filter(([s]) => symbols.includes(s)));
  console.log(
    'Note: the universe is today\'s list, so names that fell out of the market are missing. ' +
      'That flatters single-stock results (survivorship bias).',
  );

  const describe = (o: SimOptions) =>
    `${o.sizing}, regime ${o.regime}, sweep ${o.sweepYieldPct ? `${o.sweepYieldPct}%${o.sweepUnassigned ? ' incl. unassigned' : ''}` : 'off'}`;

  if (args.includes('--compare')) {
    for (const sizing of ['equal', 'allocator'] as const) {
      for (const sweep of [0, 6]) {
        const o = { ...base, sizing, sweepYieldPct: sweep };
        report(describe(o), simulatePortfolio(universe, o), o, nifty);
      }
    }
    return;
  }

  if (args.includes('--phase3')) {
    // Live-like baseline: allocator, regime auto, 6% sweep on book cash.
    const b0: SimOptions = { ...base, sizing: 'allocator', regime: 'auto', sweepYieldPct: 6, allocation: {} };
    const variants: [string, SimOptions][] = [
      ['baseline (live today)', b0],
      ['sweep unassigned too', { ...b0, sweepUnassigned: true }],
      ['core 50%', { ...b0, allocation: { corePct: 50 } }],
      ['core 60%', { ...b0, allocation: { corePct: 60 } }],
      ['core 70%', { ...b0, allocation: { corePct: 70 } }],
      ['core 60% + sweep unassigned', { ...b0, sweepUnassigned: true, allocation: { corePct: 60 } }],
      ['ceiling 85%', { ...b0, allocation: { maxDeployPct: 85 } }],
      ['ceiling 70%', { ...b0, allocation: { maxDeployPct: 70 } }],
      ['rescue 1 rung', { ...b0, allocation: { rescueRungs: 1 } }],
      ['count held books', { ...b0, allocation: { countHeldBooks: true } }],
    ];
    lineTable(variants, universe);
    return;
  }

  if (args.includes('--phase4')) {
    // Live defaults after Phase 3: allocator (60% core), regime auto, sweep incl. unassigned.
    const b0: SimOptions = { ...base, sizing: 'allocator', regime: 'auto', sweepYieldPct: 6, sweepUnassigned: true, allocation: {} };
    const P0 = DEFAULT_ACCUMULATOR_PARAMS;
    const vol = (k: number) => ({ ...P0, volStep: { enabled: true, k, minPct: 3, maxPct: 15 } });
    const variants: [string, SimOptions][] = [
      ['baseline (live defaults)', b0],
      ['re-arm sold rungs', { ...b0, params: { ...P0, rearmSoldRungs: true } }],
      ['vol gap k=0.75', { ...b0, params: vol(0.75) }],
      ['vol gap k=1.0', { ...b0, params: vol(1) }],
      ['vol gap k=1.25', { ...b0, params: vol(1.25) }],
      ['re-arm + vol gap k=1.0', { ...b0, params: { ...vol(1), rearmSoldRungs: true } }],
    ];
    lineTable(variants, universe);
    return;
  }

  if (args.includes('--phase5')) {
    // Historical results days from NSE, for the results block.
    const resultsDays = new Map<string, string[]>();
    for (const s of universe.keys()) {
      if (isEtf(s)) continue;
      try {
        resultsDays.set(s, (await fetchCalendar(s)).filter((e) => e.results).map((e) => e.date));
      } catch (e) {
        console.log(`  ${s}: no results calendar (${e instanceof Error ? e.message : e})`);
      }
    }
    console.log(`  results calendars: ${[...resultsDays.values()].reduce((a, d) => a + d.length, 0)} results days across ${resultsDays.size} stocks`);
    const b0: SimOptions = { ...base, sizing: 'allocator', regime: 'auto', sweepYieldPct: 6, sweepUnassigned: true, allocation: {}, resultsDays };
    const P0 = DEFAULT_ACCUMULATOR_PARAMS;
    const res = (resultsSessions: number) => ({
      ...b0,
      params: { ...P0, eventVeto: { surveillance: false, resultsSessions, gapPct: 0, gapSessions: 0 } },
    });
    const gap = (gapPct: number, gapSessions: number) => ({
      ...b0,
      params: { ...P0, eventVeto: { surveillance: false, resultsSessions: 0, gapPct, gapSessions } },
    });
    lineTable(
      [
        ['baseline (live defaults)', { ...b0, params: { ...P0, eventVeto: undefined } }],
        ['gap 3%, wait 2 sessions', gap(3, 2)],
        ['gap 4%, wait 2 sessions', gap(4, 2)],
        ['gap 5%, wait 2 sessions', gap(5, 2)],
        ['gap 4%, wait 1 session', gap(4, 1)],
        ['gap 4%, wait 3 sessions', gap(4, 3)],
        ['results, wait 1 session', res(1)],
        ['results, wait 2 sessions', res(2)],
        ['results, wait 3 sessions', res(3)],
      ],
      universe,
    );
    return;
  }

  if (args.includes('--weather')) {
    // Days to withhold buys: the 63 sessions AFTER a sign is on at a close
    // (decided at the close, acting from the next session), on NIFTY 50.
    const h = await loadMarketHistory();
    const nf = prepareIndex(h, 'nifty');
    if (!nf) throw new Error('NIFTY history unavailable for the weather hook');
    const blockDays = (id: SignalId): Set<string> => {
      const sig = SIGNAL_BY_ID.get(id)!;
      const out = new Set<string>();
      const p = nf.prepared;
      for (let i = 0; i < p.axis.length; i++) {
        if (sig.test(p, i) !== true) continue;
        for (let k = i + 1; k <= Math.min(p.axis.length - 1, i + 63); k++) out.add(p.axis[k]);
      }
      return out;
    };
    const bd = blockDays('breadthDivergence');
    const nl = blockDays('newLowsSpread');
    const b200 = blockDays('below200');
    const inWin = (set: Set<string>) => [...set].filter((d) => Date.parse(d) >= Date.now() - years * 365.25 * 86_400_000).length;
    console.log(`  breadth-divergence hold days in window: ${inWin(bd)} · new-lows hold days: ${inWin(nl)} · below-200 hold days: ${inWin(b200)}`);
    const b0: SimOptions = { ...base, sizing: 'allocator', regime: 'auto', sweepYieldPct: 6, sweepUnassigned: true, allocation: {} };
    lineTable(
      [
        ['baseline (live defaults)', b0],
        ['breadth div: no new ladders', { ...b0, buyBlock: (d, level) => level === 0 && bd.has(d) }],
        ['breadth div: pause all buys', { ...b0, buyBlock: (d) => bd.has(d) }],
        ['new lows 10%: no new ladders', { ...b0, buyBlock: (d, level) => level === 0 && nl.has(d) }],
        ['new lows 10%: pause all buys', { ...b0, buyBlock: (d) => nl.has(d) }],
        ['either sign: pause all buys', { ...b0, buyBlock: (d) => bd.has(d) || nl.has(d) }],
        ['control, below 200d: no new', { ...b0, buyBlock: (d, level) => level === 0 && b200.has(d) }],
      ],
      universe,
    );
    return;
  }

  if (args.includes('--sens')) {
    const variants: [string, AccumulatorParams][] = [
      ['defaults', DEFAULT_ACCUMULATOR_PARAMS],
      ['target 3%', { ...DEFAULT_ACCUMULATOR_PARAMS, targetPct: 3 }],
      ['target 6%', { ...DEFAULT_ACCUMULATOR_PARAMS, targetPct: 6 }],
      ['step 4%', { ...DEFAULT_ACCUMULATOR_PARAMS, stepPct: 4 }],
      ['step 8%', { ...DEFAULT_ACCUMULATOR_PARAMS, stepPct: 8 }],
      ['start gate 0% (no dip filter)', { ...DEFAULT_ACCUMULATOR_PARAMS, startDiscountPct: 0 }],
      ['trail off', { ...DEFAULT_ACCUMULATOR_PARAMS, trail: { ...DEFAULT_ACCUMULATOR_PARAMS.trail, enabled: false } }],
    ];
    for (const [name, params] of variants) {
      const o = { ...base, params };
      report(`${name} — ${describe(o)}`, simulatePortfolio(universe, o), o, nifty);
    }
    return;
  }

  report(describe(base), simulatePortfolio(universe, base), base, nifty);
}

if (require.main === module) {
  void main().catch((e) => {
    console.error('sim failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

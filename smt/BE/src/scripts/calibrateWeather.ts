/**
 * Recompute Market Weather's calibration from history.
 *
 *   npm run calibrate:weather            write src/services/marketWeather/calibration.json
 *   npm run calibrate:weather -- --check  recompute and fail if the shipped file has drifted
 *   add --force to refetch every series instead of using the 6h disk cache
 *
 * Calibrates on the Sensex (history from 1997; NIFTY on Yahoo starts in 2007),
 * from 1998, split into 1998–2011 and 2012 onward. Then prints today's state
 * on NIFTY 50.
 */
import fs from 'node:fs';
import path from 'node:path';
import { calibrate, diffCalibrations, type Calibration } from '../services/marketWeather/calibrate';
import { loadMarketHistory, prepareIndex } from '../services/marketWeather/history';
import { SIGNAL_BY_ID, stateAt } from '../services/marketWeather/regime';
import { buildBaskets, sectorPlaybook } from '../services/marketWeather/sectors';
import { labelHistory, measureEvents } from '../services/marketWeather/events';
import { loadSeries } from '../services/marketWeather/data';
import { analogSpecFor, findAnalogs, readSignals } from '../services/marketWeather/odds';
import { levelOf, sectorLeaders, summarize, supportedSignals, violations } from '../services/marketWeather/summary';
import { forwardWorst } from '../services/marketWeather/series';

const OUT = path.join(__dirname, '..', 'services', 'marketWeather', 'calibration.json');
const check = process.argv.includes('--check');
const force = process.argv.includes('--force');

const fmt = (x: number | null | undefined, dp = 1): string => (x == null ? '   –  ' : `${(x * 100).toFixed(dp)}%`);

async function main(): Promise<void> {
  let last = 0;
  const h = await loadMarketHistory({
    force,
    onProgress: (d, t) => {
      if (d - last >= 50 || d === t) {
        last = d;
        process.stdout.write(`  stocks ${d}/${t}\n`);
      }
    },
  });
  console.log(`Loaded ${Object.keys(h.gauges).length} gauges, ${h.stocks.size} stock histories (${h.failedStocks.length} unavailable).`);

  const sx = prepareIndex(h, 'sensex');
  if (!sx) throw new Error('Sensex history unavailable — cannot calibrate');
  const cal = calibrate(sx.prepared, { from: '1998-01-01' });

  console.log(`\nCalibration ${cal.from} → ${cal.to}, split ${cal.split}, breadth from ${cal.breadthFrom}`);
  const b = cal.baseline;
  console.log(`Baseline P(10% fall in 63d): all ${fmt(b.all.hitRate)} | 1st ${fmt(b.halves[0].hitRate)} | 2nd ${fmt(b.halves[1].hitRate)}`);
  console.log('\nsignal'.padEnd(52), 'lift1  lift2  eps1 eps2  fwdRet');
  for (const s of cal.signals) {
    console.log(
      SIGNAL_BY_ID.get(s.id)!.label.padEnd(51),
      String(s.halves[0].lift ?? '–').padStart(5),
      String(s.halves[1].lift ?? '–').padStart(6),
      String(s.halves[0].episodes).padStart(5),
      String(s.halves[1].episodes).padStart(4),
      fmt(s.all.meanFwdRet).padStart(7),
    );
  }
  console.log('\nrule'.padEnd(80), 'CAGR    maxDD   edge1   edge2');
  for (const r of cal.rules) {
    console.log(
      r.label.padEnd(79),
      fmt(r.all.cagr).padStart(6),
      fmt(r.all.maxDD).padStart(7),
      `${r.halves[0].edgePp.toFixed(1)}pp`.padStart(7),
      `${r.halves[1].edgePp.toFixed(1)}pp`.padStart(7),
    );
  }
  console.log(`\n${cal.drawdowns.length} drawdowns of 10%+`);

  // Phase 3 — sector baskets in past falls. Falls from 2003 on: Yahoo's .NS
  // history before then is thin and patchy for most names.
  const SECTOR_FALLS_FROM = '2003-01-01';
  const stocks = new Map(h.stocks);
  const sectorOf = new Map(h.sectors);
  const gold = await loadSeries('stk_GOLDBEES', 'GOLDBEES.NS', { force });
  const GOLD = 'Gold (GOLDBEES)';
  if (gold) {
    // A one-member "sector": passed through the basket minimum as copies of itself.
    for (const k of ['GOLDBEES', 'GOLDBEES#2', 'GOLDBEES#3']) {
      stocks.set(k, gold);
      sectorOf.set(k, GOLD);
    }
  }
  const sxAxis = sx.prepared.axis;
  const baskets = buildBaskets(sxAxis, stocks, sectorOf).map((b) => (b.sector === GOLD ? { ...b, members: ['GOLDBEES'] } : b));
  cal.sectorFallsFrom = SECTOR_FALLS_FROM;
  cal.sectors = sectorPlaybook(sxAxis, sx.prepared.close, baskets, cal.drawdowns.filter((d) => d.peak >= SECTOR_FALLS_FROM));
  console.log('\nsector (members)'.padEnd(48), 'in falls      rebound 6m    downβ upβ');
  for (const s of cal.sectors) {
    console.log(
      `${s.sector} (${s.members})`.padEnd(47),
      `${(s.inFall.meanPp ?? 0).toFixed(1)}pp ${s.inFall.beat}/${s.inFall.n}`.padEnd(13),
      `${(s.rebound.meanPp ?? 0).toFixed(1)}pp ${s.rebound.beat}/${s.rebound.n}`.padEnd(13),
      String(s.downBeta).padStart(5),
      String(s.upBeta).padStart(5),
    );
  }

  // Phase 4 — the catalogued shock events, measured on the Sensex.
  cal.eventMoves = measureEvents(sxAxis, sx.prepared.close);
  cal.events = labelHistory(cal.eventMoves, sxAxis, sx.prepared.close);
  console.log('\nevent label'.padEnd(22), 'n  day0   worst60  recov  higher@60');
  for (const e of cal.events) {
    console.log(
      e.label.padEnd(21),
      String(e.events).padStart(2),
      `${e.medianFirstDayPct}%`.padStart(6),
      `${e.medianWorst60Pct}%`.padStart(8),
      String(e.medianRecoveryDays === 10_000 ? 'never' : e.medianRecoveryDays).padStart(6),
      fmt(e.higherAfter60, 0).padStart(9),
    );
  }

  const nf = prepareIndex(h, 'nifty');
  if (nf) {
    // How each level read near highs, and how often a 10% fall followed (false-alarm check).
    const lv: Record<string, { days: number; hits: number }> = {};
    const np = nf.prepared;
    for (let i = 300; i < np.axis.length - 63; i++) {
      const st = stateAt(np, i);
      if (st.phase !== 'at-highs') continue;
      const l = levelOf(st, readSignals(cal, st));
      const w = forwardWorst(np.close, i, 63)!;
      (lv[l] ??= { days: 0, hits: 0 }).days++;
      if (w <= -0.1) lv[l].hits++;
    }
    cal.levelAtHighs = Object.fromEntries(Object.entries(lv).map(([k, v]) => [k, { days: v.days, hitRate: Math.round((v.hits / v.days) * 1000) / 1000 }]));
    console.log(`
Level near highs → 10% fall within 3 months: ${Object.entries(cal.levelAtHighs).map(([k, v]) => `${k} ${v.days}d ${((v.hitRate ?? 0) * 100).toFixed(1)}%`).join(' · ')}`);

    const s = stateAt(nf.prepared, nf.prepared.axis.length - 1);
    console.log(`\nToday on NIFTY 50 (${s.date}): ${s.close.toFixed(0)}, ${s.fromAthPct}% from high (${s.phase}), vs 200-day ${s.vs200Pct}%`);
    console.log(`  breadth ${s.breadthPct}% of ${s.breadthCoverage} · India VIX ${s.indiaVix} · Brent ${s.brent?.toFixed(1)} (${s.brentDaysAbove90}d > $90) · S&P vs 200-day ${s.spxVs200Pct}%`);
    console.log(`  active: ${s.active.join(', ') || 'none'}${s.unavailable.length ? ` · unavailable: ${s.unavailable.join(', ')}` : ''}`);
    // Analogs are matched on the Sensex (longer history) using the Sensex's own state today.
    const sxState = stateAt(sx.prepared, sx.prepared.axis.length - 1);
    const an = findAnalogs(sx.prepared, analogSpecFor(sxState));
    const sig = readSignals(cal, s);
    const sum = summarize(s, sig, an, 'NIFTY 50', supportedSignals(cal), sectorLeaders(cal), cal.levelAtHighs);
    console.log(`\n${sum.headline}`);
    for (const l of [...sum.drivers, ...sum.odds, ...sum.guidance]) console.log(`  · ${l}`);
    console.log(`  analog episodes: ${an.episodes.join(', ')}`);
    console.log(`  graded signs: ${sig.filter((x) => x.grade !== 'C').map((x) => `${x.id}=${x.grade}${x.on ? ' (ON)' : ''}`).join(', ')}`);
    console.log(`  supported for "slow buying": ${supportedSignals(cal).join(', ') || 'none'}`);
    const bad = [sum.headline, ...sum.drivers, ...sum.odds, ...sum.guidance].flatMap(violations);
    if (bad.length) throw new Error(`banned phrase in live summary: ${bad.join(', ')}`);
  }

  if (check) {
    const shipped = JSON.parse(fs.readFileSync(OUT, 'utf8')) as Calibration;
    const diffs = diffCalibrations(shipped, cal);
    if (diffs.length) {
      console.error(`\n✗ calibration.json has drifted (${diffs.length}):\n  ${diffs.join('\n  ')}\nRe-run without --check to update it.`);
      process.exit(1);
    }
    console.log('\n✓ calibration.json matches a fresh recomputation');
    return;
  }
  fs.writeFileSync(OUT, `${JSON.stringify(cal, null, 1)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

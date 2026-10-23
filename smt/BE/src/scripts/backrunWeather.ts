/**
 * Back-run Market Weather on past dates: what the screen would have said, using
 * only data up to that date, next to what the market then did.
 *
 *   npm run backrun:weather                     the default dates
 *   npm run backrun:weather -- 2020-01-14 2024-09-26
 *
 * HONESTY LIMITS, stated in the output too:
 *   - prices, breadth and analog forward returns are truncated at the date;
 *   - the signal GRADES come from today's full-sample calibration, so they know
 *     the future a little (a grade can only be earned by working in both halves
 *     of 1998–today). Re-calibrating at each date would remove that but leave
 *     the early dates with almost no history.
 * The point is to show misses as plainly as hits.
 */
import calibrationJson from '../services/marketWeather/calibration.json';
import type { Calibration } from '../services/marketWeather/calibrate';
import { computeBreadth } from '../services/marketWeather/breadth';
import { loadMarketHistory } from '../services/marketWeather/history';
import { analogSpecFor, findAnalogs, readSignals } from '../services/marketWeather/odds';
import { prepare, stateAt } from '../services/marketWeather/regime';
import type { Series } from '../services/marketWeather/series';
import { forwardReturn, forwardWorst } from '../services/marketWeather/series';
import { levelOf, summarize, supportedSignals, sectorLeaders, violations } from '../services/marketWeather/summary';

const cal = calibrationJson as unknown as Calibration;
const DEFAULT_DATES = ['2008-01-08', '2010-11-05', '2015-03-03', '2018-08-28', '2020-01-14', '2020-03-23', '2021-10-18', '2022-02-24', '2024-09-26', '2026-03-02'];

const cut = (s: Series, date: string): Series => {
  const n = s.dates.findIndex((d) => d > date);
  return n < 0 ? s : { key: s.key, dates: s.dates.slice(0, n), close: s.close.slice(0, n) };
};
const pc = (x: number | null | undefined): string => (x == null ? '   – ' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);

async function main(): Promise<void> {
  const dates = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const h = await loadMarketHistory();
  const nifty = h.gauges.nifty!;
  const sensex = h.gauges.sensex!;
  const stocksAll = [...h.stocks.values()];
  const supported = supportedSignals(cal);
  const leaders = sectorLeaders(cal);
  const today = nifty.dates[nifty.dates.length - 1];
  const list = dates.length ? dates : [...DEFAULT_DATES, today];

  console.log('Back-run: what Market Weather would have said, using only data up to each date (grades from today\'s calibration).\n');
  console.log('date        level      NIFTY   from-high  active signs (grade)                         analog 12m med / 10%-fall odds | then: worst 3m  12m');
  for (const date of list) {
    const nf = cut(nifty, date);
    const sx = cut(sensex, date);
    if (nf.dates.length < 300) {
      console.log(`${date}  (NIFTY history too short)`);
      continue;
    }
    const stocks = stocksAll.map((s) => cut(s, date));
    const sectorOf = (k: string) => h.sectors.get(k.replace(/^stk_/, ''));
    const pN = prepare(nf, h.gauges, computeBreadth(nf.dates, stocks, undefined, sectorOf));
    const pS = prepare(sx, h.gauges, computeBreadth(sx.dates, stocks, undefined, sectorOf));
    const st = stateAt(pN, pN.axis.length - 1);
    const sig = readSignals(cal, st);
    const an = findAnalogs(pS, analogSpecFor(stateAt(pS, pS.axis.length - 1)));
    const sum = summarize(st, sig, an, 'NIFTY 50', supported, leaders, cal.levelAtHighs);
    const bad = [sum.headline, ...sum.drivers, ...sum.odds, ...sum.guidance].flatMap(violations);
    // What happened next, from the FULL series.
    const i = nifty.dates.findIndex((d) => d >= st.date);
    const worst3 = forwardWorst(nifty.close, i, 63);
    const ret12 = forwardReturn(nifty.close, i, 252);
    const active = sig
      .filter((x) => x.on === true)
      .map((x) => `${x.id}(${x.grade})`)
      .join(' ');
    const y = an.forward.find((f) => f.horizonDays === 252);
    console.log(
      `${st.date}  ${levelOf(st, sig).padEnd(9)} ${st.close.toFixed(0).padStart(6)}  ${`${st.fromAthPct}%`.padStart(7)}   ${active.padEnd(46).slice(0, 46)} ${pc(y?.median).padStart(5)} / ${pc(an.furtherFallOdds).padStart(4)}        | ${pc(worst3).padStart(5)}  ${pc(ret12).padStart(5)}${bad.length ? `  BANNED: ${bad.join(',')}` : ''}`,
    );
    if (sum.guidance.some((g) => g.includes('slowing new buying'))) console.log(`            → would have advised slowing new buying (${sig.filter((x) => x.on && supported.includes(x.id)).map((x) => x.id).join(', ')})`);
  }
  console.log('\nRead the right-hand columns against the level: a "calm" read before a deep fall is a miss, and is shown as one.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

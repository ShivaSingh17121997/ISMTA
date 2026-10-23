/**
 * Live smoke test for Market Weather, run outside the server.
 *
 *   npm run verify:weather
 *
 * Builds one real snapshot (history from the disk cache, live news, live
 * FII/DII, live valuation), prints it, and measures exposure for a sample book.
 * Read-only: it places no orders and touches no stored books.
 */
import { marketWeather } from '../services/MarketWeatherService';
import { marketEvents } from '../services/marketEvents';
import { bookExposure, downBetaOf } from '../services/marketWeather/exposure';
import { loadSeries } from '../services/marketWeather/data';
import { violations } from '../services/marketWeather/summary';
import { classify, loadSectors } from '../services/recommender/sectors';
import fs from 'node:fs';

async function main(): Promise<void> {
  await marketEvents.refresh();
  const t0 = Date.now();
  const s = await marketWeather.refresh();
  if (!s) throw new Error(`no snapshot: ${marketWeather.status().lastError}`);
  console.log(`snapshot in ${((Date.now() - t0) / 1000).toFixed(1)}s for ${s.state.date}\n`);
  console.log(`VERDICT: ${s.verdict.title} — ${s.verdict.oneLine}
  e.g. ${s.verdict.example}`);
  for (const w of s.verdict.why) console.log(`  · ${w}`);
  const calls = await marketWeather.stocksFor('verify-no-user');
  if (calls) {
    console.log(`
stocks scored ${calls.scored}; active news types: ${calls.activeEvents.join(', ') || 'none'}`);
    console.log('  CAREFUL NOW: ' + calls.careful.map((c) => `${c.symbol}(${c.score})`).join(' '));
    for (const c of calls.careful.slice(0, 3)) console.log(`    ${c.symbol}: ${c.tags.map((t) => t.text).join(' | ')}`);
    console.log('  HOLDING UP BETTER: ' + calls.resilient.map((c) => `${c.symbol}(${c.score})`).join(' '));
    for (const c of calls.resilient.slice(0, 3)) console.log(`    ${c.symbol}: ${c.tags.map((t) => t.text).join(' | ')}`);
    const allText = [s.verdict.title, s.verdict.oneLine, s.verdict.example, ...s.verdict.why, ...[...calls.careful, ...calls.resilient].flatMap((c) => c.tags.map((t) => t.text))];
    const bad = allText.flatMap(violations);
    if (bad.length) throw new Error(`banned phrases in verdict/stock text: ${bad.join(', ')}`);
    (s as unknown as { stocks: unknown }).stocks = calls;
  }
  console.log('');
  console.log(s.summary.headline);
  for (const l of [...s.summary.drivers, ...s.summary.odds, ...s.summary.guidance]) console.log(`  · ${l}`);
  const v = s.valuation;
  if (v) console.log(`\nvaluation ${v.date}: PE ${v.pe} (rank since 2021: ${Math.round((v.pePctConsolidated ?? 0) * 100)}%) · PB ${v.pb} (rank since 1999: ${Math.round((v.pbPctAll ?? 0) * 100)}%)`);
  console.log(`\nflows: ${s.escalation.flows.map((f) => `${f.date} FII ${f.fiiNet} DII ${f.diiNet}`).join(' | ') || 'none'}${s.health.flowsError ? ` (error ${s.health.flowsError})` : ''}`);
  console.log(`\nactive events (${s.events.length}) from ${s.headlines.length} labelled headlines:`);
  for (const e of s.events) {
    console.log(`  ${e.label} [${e.headlines.length}] ${e.title} — hist: ${e.history ? `${e.history.events} events, median day ${e.history.medianFirstDayPct}%` : 'none'}`);
    for (const h of e.headlines.slice(0, 2)) console.log(`      "${h.title}" (${h.source})`);
  }
  console.log(`\nhealth: gauges ${s.health.gauges.length}, stocks ${s.health.stocks} (${s.health.failedStocks} failed), breadth coverage ${s.health.breadthCoverage}, news errors ${s.health.newsErrors.length}`);

  // Sample book: one each of defensive, financial, IT, index ETF, gold ETF.
  const sectors = await loadSectors();
  const nifty = (await loadSeries('nifty', '^NSEI'))!;
  const sample = ['HINDUNILVR', 'SBIN', 'TCS', 'NIFTYBEES', 'GOLDBEES', 'TATASTEEL'];
  const betas = new Map<string, number | null>();
  for (const sym of sample) betas.set(sym, downBetaOf(nifty, (await loadSeries(`stk_${sym}`, `${sym}.NS`)) ?? undefined));
  const ex = bookExposure(
    sample.map((symbol) => ({ symbol, quantity: 10, price: 1000 })),
    (sym) => betas.get(sym) ?? null,
    (sym) => classify(sym, sectors).sector,
    s.events.map((e) => e.label),
  );
  console.log(`\nsample book (equal ₹10k each): down-beta ${ex.downBeta} → NIFTY −10% ≈ ${ex.ifIndexMinus10Pct}% · defensive ${(ex.defensiveShare * 100).toFixed(0)}% · IT defensive now: ${ex.itDefensive}`);
  for (const h of ex.holdings) console.log(`  ${h.symbol.padEnd(11)} ${h.sector.padEnd(30)} β↓ ${h.downBeta} → ${h.ifIndexMinus10Pct}%${h.defensive ? ' (defensive)' : ''}`);

  const all = [s.summary.headline, ...s.summary.drivers, ...s.summary.odds, ...s.summary.guidance, ...s.signals.map((x) => x.reason)];
  const bad = all.flatMap(violations);
  if (bad.length) throw new Error(`banned phrases: ${bad.join(', ')}`);
  console.log('\n✓ no banned phrases in live text');
  // --dump <file>: write the snapshot the API would serve (with the sample book as exposure), for screenshots.
  const at = process.argv.indexOf('--dump');
  if (at > 0 && process.argv[at + 1]) {
    fs.writeFileSync(process.argv[at + 1], JSON.stringify({ ...s, exposure: ex, status: marketWeather.status() }));
    console.log(`wrote ${process.argv[at + 1]}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

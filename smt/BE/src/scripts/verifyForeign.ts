/**
 * Live check for the foreign-stock recommender, run outside the server.
 *
 *   npm run verify:foreign [-- --dump <file>] [-- --rebuild-backtest]
 *
 * Builds one real snapshot and prints picks, flags, the not-now list and the
 * backtest. Read-only.
 */
import fs from 'node:fs';
import { foreignRecs } from '../services/ForeignRecsService';

const p = (x: number | null | undefined, dp = 0): string => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`);

async function main(): Promise<void> {
  const t0 = Date.now();
  const s = await foreignRecs.refresh({ rebuildBacktest: process.argv.includes('--rebuild-backtest') });
  if (!s) throw new Error(`no snapshot: ${foreignRecs.status().lastError}`);
  console.log(`snapshot in ${((Date.now() - t0) / 1000).toFixed(0)}s, data to ${s.asOf}, USD/INR ${s.usdInr?.toFixed(2)} (12m ${p(s.usdInr12m, 1)})`);
  console.log(`counts: ${JSON.stringify(s.counts)} · failed: ${s.health.failed.join(', ') || 'none'}`);
  console.log('\nTop picks:');
  for (const r of s.picks) {
    console.log(
      `  ${r.ticker.padEnd(6)} ${r.name.slice(0, 28).padEnd(28)} ${r.sector.slice(0, 22).padEnd(22)} score ${r.score.toFixed(0).padStart(3)} · 12m $ ${p(r.ret12mUsd).padStart(5)} ₹ ${p(r.ret12mInr).padStart(5)} · dip ~${r.typicalDipPct}%` +
        (r.quality?.junk ? `  ⚑ weak finances: ${r.quality.weak.join(', ')}` : ''),
    );
  }
  console.log(`\nNot now (biggest names): ${s.avoid.map((a) => `${a.ticker} (${a.vetoReason?.slice(0, 40)})`).join(' · ')}`);
  console.log(`ADRs top 5: ${s.adrs.filter((a) => !a.vetoed).slice(0, 5).map((a) => `${a.name} ${p(a.ret12mUsd)}`).join(' · ')}`);
  const bt = s.backtest;
  if (bt) {
    console.log(`\nbacktest ${bt.from} → ${bt.to} split ${bt.split}: momentum worked=${bt.worked}, veto worked=${bt.vetoWorked}`);
    for (const l of bt.lines) console.log(`  ${l.label.padEnd(52)} ${p(l.cagr, 1).padStart(6)} maxDD ${p(l.maxDD).padStart(5)} edge ${l.edgeHalves.join(' / ')}`);
  }
  console.log('\nPlans (picks):');
  for (const r of s.picks) {
    const d = r.detail;
    if (!d) continue;
    const L = d.levels;
    console.log(
      `  ${r.ticker.padEnd(6)} buy $${L.buyLow}–${L.buyHigh} · review $${L.review} (${p(L.reviewPct)}, ${L.reviewBasis}) · 6m range $${L.rangeLow}–${L.rangeHigh}` +
        ` · analysts ${d.analyst?.target ?? '–'} (${p(d.analyst?.upside)}) · earnings ${d.earningsDate ?? '–'}${d.earningsSoon ? ' WAIT' : ''}` +
        ` · news ${d.news ? `${d.news.headlines.length}h/${d.news.offTopic} off, tone ${d.news.sentiment.toFixed(2)}` : '–'} · 8-K ${d.events?.length ?? 'n/a'}${d.withheld ? ` · WITHHELD: ${d.withheld}` : ''}`,
    );
    for (const w of d.reasons) console.log(`        [${w.grade}${w.stance === 'good' ? '+' : w.stance === 'bad' ? '-' : ' '}] ${w.text}`);
  }
  const hs = s.horizonStudy;
  if (hs) {
    console.log(`\nHorizon study ${hs.from} → ${hs.to} (split ${hs.split}):`);
    for (const h of hs.stats) {
      console.log(
        `  ${h.label.padEnd(24)} n ${h.n} · up ${p(h.upRate)} · picks ${p(h.picksMean[0], 1)}/${p(h.picksMean[1], 1)} vs all ${p(h.allMean[0], 1)}/${p(h.allMean[1], 1)} · edge ${h.edge}` +
          ` · H2 out-of-sample: inside middle ${p(h.oos.insideMiddle, 1)} (aim 50%), above base ${p(h.oos.aboveBase, 1)} (aim 50%)`,
      );
    }
  }
  for (const h of hs?.stats2 ?? []) console.log(`  tier 2 ${h.label.padEnd(24)} up ${p(h.upRate)} · picks ${p(h.picksMean[0], 1)}/${p(h.picksMean[1], 1)} vs all ${p(h.allMean[0], 1)}/${p(h.allMean[1], 1)} · edge ${h.edge}`);
  const shown = [...s.picks, ...s.more];
  const first = shown.find((x) => x.ticker === s.startHere.ready[0]);
  if (first?.detail?.outlook) {
    const o = first.detail.outlook;
    console.log(`\nOutlook for ${first.ticker}:`);
    for (const w of o.why) console.log(`  why: ${w}`);
    for (const g of o.growth) console.log(`  grow [${g.grade}]: ${g.text}`);
    for (const r of o.risks) console.log(`  risk: ${r}`);
  }
  const allText = shown.flatMap((x) => [...(x.detail?.outlook?.why ?? []), ...(x.detail?.outlook?.growth.map((g) => g.text) ?? []), ...(x.detail?.outlook?.risks ?? [])]).join(' ');
  if (/\bwill\b|guarantee/i.test(allText)) throw new Error('promise wording in an outlook');
  if (shown.some((x) => x.detail && !x.detail.outlook?.risks.length)) throw new Error('an outlook without a single risk');
  console.log(`\nStart here (${s.startHere.ready.length}): ${s.startHere.ready.join(', ')}${s.startHere.skipped.length ? ` · skipped ${s.startHere.skipped.map((x) => `${x.ticker} (${x.why})`).join(', ')}` : ''}`);
  for (const r of s.picks.filter((x) => s.startHere.ready.includes(x.ticker))) {
    console.log(`  ${r.ticker.padEnd(6)} $${r.priceUsd.toFixed(2)} ` + (r.detail?.targets ?? []).map((t) => `${t.key} $${t.low}–$${t.high} base $${t.base} (${p(t.basePct, 1)})`).join(' · '));
  }
  const bb = s.bounceBacktest;
  console.log(`\nBouncing back: ${s.bounce.qualified.length} qualified, ${s.bounce.rejected.length} rejected shown, funded=${s.bounce.funded}`);
  for (const r of s.bounce.qualified) {
    console.log(`  ${r.ticker.padEnd(6)} ${r.name.slice(0, 26).padEnd(26)} down ${(r.fallPct * 100).toFixed(0)}% · score ${r.bounceScore} · ${r.clean ? 'clean' : 'flags: ' + r.flags.join('; ')} · review $${r.detail?.levels.review}`);
  }
  const why = new Map<string, number>();
  for (const r of s.bounce.rejected) why.set(r.reason.split(':')[0], (why.get(r.reason.split(':')[0]) ?? 0) + 1);
  console.log(`  rejected (shown) by reason: ${[...why].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (bb) {
    console.log(`  bounce backtest ${bb.from} → ${bb.to}: gated passed=${bb.passed}, price-only passed=${bb.pricePassed}; T3 calibration ${(100 * bb.calibration.inside / bb.calibration.observations).toFixed(1)}% inside of ${bb.calibration.observations}`);
    for (const l of bb.lines) console.log(`    ${l.label.padEnd(62)} ${p(l.cagr, 1).padStart(6)} halves ${p(l.halves[0], 1)} / ${p(l.halves[1], 1)} maxDD ${p(l.maxDD)} avg ${l.avgHoldings.toFixed(1)}`);
  }
  console.log(`\nMarket: ${s.market.sectors.map((x) => `${x.ticker} ${p(x.ret1w, 1)}`).join(' · ')}`);
  for (const h of s.market.headlines.slice(0, 5)) console.log(`  (${h.tone.toFixed(2)}) ${h.title}`);
  const text = [...s.picks, ...s.avoid].flatMap((r) => [r.vetoReason ?? '', ...(r.quality?.weak ?? [])]).join(' ');
  const v2text = [...s.picks, ...s.bounce.qualified].flatMap((r) => [...(r.detail?.reasons.map((w) => w.text) ?? []), r.detail?.levels.reviewBasis ?? '', r.detail?.withheld ?? '']).join(' ') + s.bounce.rejected.map((r) => r.reason).join(' ');
  if (/₹|crore/.test(v2text)) throw new Error('rupee wording leaked into a v2 reason');
  if (/will (?:go up|rise)|guarantee/i.test(v2text)) throw new Error('promise wording in a reason (X3)');
  if (/₹|crore/.test(text)) throw new Error('rupee wording leaked into a US stock reason');
  const at = process.argv.indexOf('--dump');
  if (at > 0 && process.argv[at + 1]) {
    fs.writeFileSync(process.argv[at + 1], JSON.stringify({ ...s, status: foreignRecs.status() }));
    console.log(`\nwrote ${process.argv[at + 1]}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

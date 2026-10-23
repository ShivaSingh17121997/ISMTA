/**
 * Live check for Global Markets, run outside the server.
 *
 *   npm run verify:global [-- --dump <file>]
 *
 * Builds one real snapshot (cached Yahoo history, live AMFI NAVs), prints the
 * ranking, the leaders, the ETF premiums and the backtest. Read-only.
 */
import fs from 'node:fs';
import { globalMarkets } from '../services/GlobalMarketsService';

const p = (x: number | null | undefined, dp = 0): string => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`);

async function main(): Promise<void> {
  const t0 = Date.now();
  const s = await globalMarkets.refresh();
  if (!s) throw new Error(`no snapshot: ${globalMarkets.status().lastError}`);
  console.log(`snapshot in ${((Date.now() - t0) / 1000).toFixed(1)}s, data to ${s.asOf}, ${s.health.tickers} series, failed: ${s.health.failed.join(', ') || 'none'}\n`);
  console.log(`strongest (uptrend, foreign): ${s.strongest.join(', ')}`);
  for (const m of s.markets.slice(0, 8)) {
    console.log(`  #${m.rank} ${m.name.padEnd(28)} 12m INR ${p(m.inr?.ret12m).padStart(6)} (local ${p(m.local12m)}) · 3y ${p(m.inr?.cagr3y)}/yr · corr India ${m.corrWithIndia ?? '–'}`);
  }
  for (const c of s.strongest) {
    console.log(`  leaders ${c}: ${(s.leaders[c] ?? []).slice(0, 3).map((l) => `${l.name} ${p(l.inr?.ret12m)}${l.inr?.uptrend ? '' : ' (down)'}`).join(' · ') || '(none listed)'}`);
  }
  console.log(`\nglobal leaders: ${s.globalLeaders.slice(0, 8).map((l) => `${l.name} (${l.country}) ${p(l.inr?.ret12m)}`).join(' · ')}`);
  console.log('\nIndia-listed international ETFs, price vs NAV:');
  for (const e of s.etfs) console.log(`  ${e.symbol.padEnd(11)} price ${e.price?.toFixed(2)} (${e.priceDate}) NAV ${e.nav} (${e.navDate}) premium ${p(e.premium, 1)}${e.overpriced ? '  OVERPRICED' : ''}`);
  console.log(`\nbacktest ${s.backtest.from} → ${s.backtest.to} (split ${s.backtest.split}); ranking worked: ${s.backtest.rankingWorked}`);
  for (const b of s.backtest.strategies) console.log(`  ${b.label.padEnd(58)} ${p(b.cagr, 1).padStart(6)} maxDD ${p(b.maxDD).padStart(5)} halves ${p(b.halves[0], 1)} / ${p(b.halves[1], 1)}`);
  const at = process.argv.indexOf('--dump');
  if (at > 0 && process.argv[at + 1]) {
    fs.writeFileSync(process.argv[at + 1], JSON.stringify({ ...s, status: globalMarkets.status() }));
    console.log(`\nwrote ${process.argv[at + 1]}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

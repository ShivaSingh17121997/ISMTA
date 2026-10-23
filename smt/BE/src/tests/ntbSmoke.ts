/**
 * NTB port smoke test — exercises the full backtest pipeline for each entry
 * model: entry → Phase 4 stop → Phase 5 sizing → trailing engine over the
 * adverse price path → cost-netted P&L.
 *
 * Not wired into `npm test` (it uses the random-walk generator, so trade counts
 * vary run to run). Run manually:
 *   npx ts-node --transpile-only src/tests/ntbSmoke.ts
 */
import { backtestEngine } from '../services/BacktestEngine';
import { marketData } from '../services/MarketDataService';
import { roundTripCostPct } from '../services/costs';
import { config } from '../config';

const SYMBOL = 'RELIANCE';
const BARS = 3000;

console.log('─'.repeat(78));
console.log('NTB port smoke test');
console.log('─'.repeat(78));
console.log(
  `exit engine: activation ${config.ntb.activationPct}% / trail ${config.ntb.trailPct}% / ` +
    `stop ${config.ntb.stopLossPct}% (${config.ntb.stopMode}) / tp ${config.ntb.takeProfitPct}`,
);
console.log(
  `sizing: ₹${config.ntb.quoteOrderSize} fixed, riskPerTrade ${config.ntb.riskPerTradePct}%, ` +
    `cap ₹${config.ntb.maxPositionQuote}`,
);
console.log(`DCA: ${config.ntb.dca.enabled ? 'ENABLED' : 'disabled'}`);

// The Phase 4 cost floor, at a realistic notional.
const px = 2950;
const qty = Math.floor(config.ntb.quoteOrderSize / px);
const cost = roundTripCostPct(px, qty);
console.log(
  `\ncost floor: round trip ${cost.toFixed(3)}% at ₹${(px * qty).toFixed(0)} notional ` +
    `→ stop must exceed ${(1.5 * cost).toFixed(3)}% (configured: ${config.ntb.stopLossPct}%)`,
);

const candles = marketData.generateHistory(SYMBOL, BARS);
console.log(`\n${BARS} candles, ₹${candles[0].close.toFixed(2)} → ₹${candles[BARS - 1].close.toFixed(2)}\n`);

const header = ['strategy', 'trades', 'win%', 'net ₹', 'expectancy', 'maxDD%', 'exits'];
const rows: string[][] = [];

for (const type of ['NTB_BREAKOUT', 'NTB_PULLBACK', 'NTB_MEANREV']) {
  const t0 = Date.now();
  const r = backtestEngine.run({ strategyType: type, symbol: SYMBOL, candles, startingCapital: 1_000_000 });
  const ms = Date.now() - t0;

  const byReason: Record<string, number> = {};
  for (const t of r.tradeLog) byReason[t.reason ?? '?'] = (byReason[t.reason ?? '?'] ?? 0) + 1;
  const exits = Object.entries(byReason)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

  rows.push([
    type,
    String(r.trades),
    r.winRate.toFixed(1),
    (r.endingCapital - r.startingCapital).toFixed(0),
    r.expectancy.toFixed(2),
    r.maxDrawdownPct.toFixed(2),
    exits || '—',
  ]);
  console.log(`  ${type} ran in ${ms}ms`);
}

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log('\n' + line(header));
console.log(widths.map((w) => '─'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

console.log(
  '\nNOTE: this is a random walk with a built-in upward drift, not real NSE data.\n' +
    'These numbers say the MACHINERY runs. They say nothing about edge.\n',
);

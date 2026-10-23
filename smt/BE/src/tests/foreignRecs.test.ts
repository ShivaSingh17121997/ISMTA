/**
 * Foreign-stock recommender tests. Several map directly to items in
 * FOREIGN_RECS_CHECKLIST.md (the checklist cites them by name):
 *
 *   C3  share classes map to Yahoo's dash form (BRK.B → BRK-B)
 *   C5  a fiscal year is used only 120 days after it ends (point in time)
 *   C6  quality directions: high profit/cash good; accruals, debt, instability bad
 *   C7  junk is removed BEFORE ranking and shown with its reason
 *   C8  measuring at a date never reads a later bar
 *   C9  the backtest cannot profit from a jump it had not yet seen
 *   C10 veto text is in dollars, never rupees
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { parseSp500, ADRS } from '../services/foreign/universe';
import { qualityAt, scoreQuality, AVAILABLE_AFTER_DAYS, type FiscalYear } from '../services/foreign/fundamentals';
import { measureAt, pickTop, scoreForeign, usdVetoReason } from '../services/foreign/score';
import { mergeBars } from '../services/foreign/candles';
import { runForeignBacktest, monthEnds } from '../services/foreign/backtest';
import type { Candle } from '../types';

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

/** Weekday bars from `start`, with a price path and a fixed volume. */
function bars(symbol: string, start: string, n: number, price: (i: number) => number, volume = 5_000_000): Candle[] {
  const out: Candle[] = [];
  let t = Date.parse(`${start}T14:30:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const p = price(out.length);
      out.push({ symbol, timestamp: t, open: p, high: p * 1.01, low: p * 0.99, close: p, volume });
    }
    t += 86_400_000;
  }
  return out;
}

test('C3: S&P 500 CSV parses quoted fields and maps share classes to Yahoo form', () => {
  const csv = [
    'Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded',
    'MMM,3M,Industrials,Industrial Conglomerates,"Saint Paul, Minnesota",1957-03-04,66740,1902',
    'BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings,"Omaha, Nebraska",2010-02-16,1067983,1839',
  ].join('\n');
  const u = parseSp500(csv);
  assert.equal(u.length, 2);
  assert.equal(u[0].cik, 66740);
  assert.equal(u[1].ticker, 'BRK-B');
  assert.equal(u[1].sector, 'Financials');
  assert.ok(ADRS.every((a) => a.kind === 'adr' && a.cik === null && a.country !== 'United States'));
});

const fy = (year: number, ni: number, cfo: number, assets: number, liab: number): FiscalYear => ({
  year,
  end: `${year}-12-31`,
  availableFrom: new Date(Date.parse(`${year}-12-31`) + AVAILABLE_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10),
  ni,
  cfo,
  assets,
  liab,
});

test('C5: a fiscal year is used only once it is 120 days old', () => {
  const ys = [fy(2020, 10, 12, 100, 40), fy(2021, 20, 22, 100, 40)];
  assert.equal(qualityAt(ys, '2022-03-01', false).asOfYear, 2020, '2021 accounts not yet filed');
  assert.equal(qualityAt(ys, '2022-05-01', false).asOfYear, 2021);
  assert.equal(qualityAt(ys, '2021-01-01', false).asOfYear, null);
});

test('C6: quality directions and the financials exception', () => {
  const q = qualityAt([fy(2019, 5, 2, 100, 90), fy(2020, 5, 2, 100, 90), fy(2021, 5, 2, 100, 90)], '2023-01-01', false);
  assert.equal(q.roa, 0.05);
  assert.equal(q.accruals, 0.03, 'profit 5, cash 2 → accruals 3% of assets');
  assert.equal(q.leverage, 0.9);
  assert.ok(Math.abs(q.roaVol!) < 1e-12, 'identical profits → no variability');
  assert.equal(qualityAt([fy(2021, 5, 2, 100, 90)], '2023-01-01', true).leverage, null, 'leverage is the business for a bank');
  const good = { asOfYear: 2021, roa: 0.15, cfoa: 0.18, accruals: -0.03, leverage: 0.3, roaVol: 0.01 };
  const bad = { asOfYear: 2021, roa: -0.05, cfoa: -0.02, accruals: 0.1, leverage: 0.95, roaVol: 0.2 };
  const mids = Array.from({ length: 8 }, (_, i) => ({ asOfYear: 2021, roa: 0.05 + i * 0.005, cfoa: 0.06, accruals: 0, leverage: 0.5, roaVol: 0.03 }));
  const s = scoreQuality([good, bad, ...mids]);
  assert.ok(s[0].score! > s[1].score!);
  assert.equal(s[1].junk, true);
  assert.equal(s[0].junk, false);
  assert.ok(s[1].weak.includes('profit not backed by cash'));
  assert.equal(scoreQuality([{ asOfYear: null, roa: null, cfoa: null, accruals: null, leverage: null, roaVol: null }])[0].score, null, 'no data → no score, never junk');
});

test('C8: measuring at a date never reads a later bar', () => {
  const b = bars('X', '2020-01-01', 600, (i) => (i < 400 ? 100 + i * 0.1 : 1));
  const m = measureAt('X', b, 399)!;
  assert.ok(m.lastClose > 100, 'the crash after bar 399 is invisible');
  assert.equal(measureAt('X', b, -1), null);
});

test('C7 + C10: junk is vetoed before ranking, with dollar wording', () => {
  const up = (s: string, k: number) => measureAt(s, bars(s, '2020-01-01', 400, (i) => 50 * Math.exp(i * 0.001 * k)))!;
  const ms = [up('A', 1), up('B', 2), up('C', 3), up('JUNK', 4)];
  const q = new Map([['JUNK', { asOfYear: 2021, roa: -0.1, cfoa: -0.1, accruals: 0.2, leverage: 0.9, roaVol: 0.2, score: 0.05, junk: true, weak: ['heavy debt'] }]]);
  const s = scoreForeign(ms, new Map(), q);
  const junk = s.find((x) => x.symbol === 'JUNK')!;
  assert.equal(junk.vetoed, true);
  assert.match(junk.vetoReason!, /weak finances.*heavy debt/);
  assert.equal(s[0].symbol, 'C', 'strongest clean stock first, even though JUNK rose fastest');
  const flagOnly = scoreForeign(ms, new Map(), q, { vetoJunk: false });
  assert.equal(flagOnly[0].symbol, 'JUNK', 'without the veto JUNK ranks on momentum like anyone else');
  assert.equal(flagOnly[0].quality?.junk, true, '...and still carries its weak-finances flag');
  const penny = measureAt('P', bars('P', '2020-01-01', 400, (i) => 2 + i * 0.001, 100))!;
  assert.match(usdVetoReason(penny)!, /\$/);
  for (const x of scoreForeign([penny, ...ms], new Map(), q)) if (x.vetoReason) assert.ok(!/₹|crore/.test(x.vetoReason), x.vetoReason);
});

test('C11: picks hold at most 4 per sector, in score order', () => {
  const fake = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, horizon: 'medium' as const, score: 100 - i, verdict: 'strong' as const, signals: [], vetoed: false, quality: null }));
  const sec = new Map(fake.map((f, i) => [f.symbol, i < 8 ? 'Energy' : 'Tech']));
  const p = pickTop(fake, 6, sec);
  assert.deepEqual(p.map((x) => x.symbol), ['S0', 'S1', 'S2', 'S3', 'S8', 'S9']);
});

test('mergeBars: fresh bars win on the same timestamp', () => {
  const a = bars('X', '2020-01-01', 3, () => 10);
  const b = [{ ...a[2], close: 11 }];
  const m = mergeBars(a, b);
  assert.equal(m.length, 3);
  assert.equal(m[2].close, 11);
});

test('monthEnds lists calendar month ends', () => {
  assert.deepEqual(monthEnds('2024-11-03', '2025-01-31'), ['2024-11-30', '2024-12-31', '2025-01-31']);
});

test('C9: the backtest cannot profit from a jump it had not seen', () => {
  // 25 steady stocks plus one that doubles overnight on 2015-06-15. A strategy with
  // look-ahead would hold it into the jump; this one can only see it afterwards.
  const m = new Map<string, Candle[]>();
  for (let k = 0; k < 25; k++) m.set(`S${k}`, bars(`S${k}`, '2012-01-01', 1500, (i) => 50 * Math.exp(i * 0.0001 * (1 + (k % 5)))));
  const jumpIdx = 900;
  m.set('JMP', bars('JMP', '2012-01-01', 1500, (i) => (i < jumpIdx ? 50 : 100)));
  const jumpDate = new Date(m.get('JMP')![jumpIdx].timestamp).toISOString().slice(0, 10);
  const bt = runForeignBacktest({ bars: m, sectors: new Map(), ciks: new Map(), fundamentals: new Map(), from: '2013-06-01', topN: 5 });
  const rec = bt.lines.find((l) => l.id === 'momentum')!;
  const eq = bt.lines.find((l) => l.id === 'equal')!;
  assert.ok(rec && eq);
  assert.ok(bt.months > 20);
  // The equal-weight basket holds JMP through the jump (1/26 of a doubling ≈ +3.8% that month);
  // the top-5 list could not have ranked a flat stock above the risers before it jumped.
  void jumpDate;
  assert.ok(rec.cagr < eq.cagr + 0.05);
});

if (failures.length) {
  console.error(`foreignRecs: ${passed} passed, ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`✓ foreignRecs: ${passed} passed`);

/**
 * NSE listed-company master + external price isolation.
 *
 * Two things that would fail silently rather than loudly: a header drift in
 * NSE's CSV mapping a column to the wrong field, and the simulator random-
 * walking a real externally-fed price so every no-loss decision downstream is
 * made on noise.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { parseEquityMaster, parseEtfMaster, searchInstruments } from '../services/instruments';
import { marketData } from '../services/MarketDataService';
import { store } from '../store/memoryStore';

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

// A verbatim slice of EQUITY_L.csv, stray header spaces included.
const CSV = [
  'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE',
  'SCI,Shipping Corporation Of India Limited,EQ,13-AUG-1997,10,1,INE109A01011,10',
  'SYRMA,Syrma SGS Technology Limited,EQ,26-AUG-2022,10,1,INE0DYJ01015,10',
  'SCIENTECH,Scientech Technologies Limited,BE,05-JAN-2015,10,1,INE00XX01019,10',
  '',
].join('\r\n');

// ─── parser ───────────────────────────────────────────────────────────────
test('parses NSE header with its stray spaces and maps every column', () => {
  const rows = parseEquityMaster(CSV, 123);
  assert.equal(rows.length, 3);
  const sci = rows.find((r) => r.symbol === 'SCI')!;
  assert.equal(sci.name, 'Shipping Corporation Of India Limited');
  assert.equal(sci.series, 'EQ');
  assert.equal(sci.isin, 'INE109A01011');
  assert.equal(sci.faceValue, 10);
  assert.equal(sci.fetchedAt, 123);
});

test('converts NSE dates (13-AUG-1997) to ISO', () => {
  const rows = parseEquityMaster(CSV);
  assert.equal(rows.find((r) => r.symbol === 'SCI')!.listedOn, '1997-08-13');
  assert.equal(rows.find((r) => r.symbol === 'SYRMA')!.listedOn, '2022-08-26');
});

test('refuses a header it does not recognise instead of mis-mapping columns', () => {
  assert.throws(() => parseEquityMaster('FOO,BAR\n1,2'), /Unrecognised equity master header/);
});

test('an empty file yields an empty list, not a crash', () => {
  assert.deepEqual(parseEquityMaster(''), []);
});

// ─── ETF list ─────────────────────────────────────────────────────────────
// A verbatim slice of eq_etfseclist.csv: two-digit years, and one row whose
// "Underlying Asset" is the fund's full name rather than the index.
const ETF_CSV = [
  'Symbol,Underlying Asset,SecurityName,DateofListing,MarketLot,ISINNumber,FaceValue,ETF Underlying,Underlying Key',
  'NIFTYBEES,Nifty 50,NIPINDETFNIFTYBEES,08-Jan-02,1,INF204KB14I2,1,EQUITY,Nifty 50',
  'JUNIORBEES,Nippon India ETF Nifty Next 50 Junior BeES,NIP IND ETF JUNIOR BEES,06-Mar-03,1,INF732E01045,1.25,EQUITY,Nifty Next 50',
  'BANKBEES,Nifty Bank,NIPINDETFBANKBEES,04-Jun-04,1,INF204KB15I9,1,EQUITY,Nifty Bank',
  'GOLDBEES,Gold,NIPINDETFGOLDBEES,19-Mar-07,1,INF204KB17I5,1,COMMODITY,GOLD',
  '',
].join('\r\n');

test('parses the ETF list as EQ-series ETFs with their underlying', () => {
  const rows = parseEtfMaster(ETF_CSV, 7);
  assert.equal(rows.length, 4);
  const nb = rows.find((r) => r.symbol === 'NIFTYBEES')!;
  assert.equal(nb.kind, 'ETF');
  assert.equal(nb.series, 'EQ');
  assert.equal(nb.underlying, 'Nifty 50');
  assert.equal(nb.isin, 'INF204KB14I2');
  assert.equal(nb.fetchedAt, 7);
  assert.equal(nb.name, 'Nifty 50 ETF · NIPINDETFNIFTYBEES');
  assert.equal(rows.find((r) => r.symbol === 'GOLDBEES')!.underlying, 'GOLD');
});

test('keeps a full fund name as the name and reads the index from the key column', () => {
  const jb = parseEtfMaster(ETF_CSV).find((r) => r.symbol === 'JUNIORBEES')!;
  assert.equal(jb.name, 'Nippon India ETF Nifty Next 50 Junior BeES');
  assert.equal(jb.underlying, 'Nifty Next 50');
});

test('reads two-digit ETF listing years as 20xx', () => {
  const rows = parseEtfMaster(ETF_CSV);
  assert.equal(rows.find((r) => r.symbol === 'NIFTYBEES')!.listedOn, '2002-01-08');
  assert.equal(rows.find((r) => r.symbol === 'GOLDBEES')!.listedOn, '2007-03-19');
});

test('equity rows are tagged EQUITY; an unknown ETF header is refused', () => {
  assert.ok(parseEquityMaster(CSV).every((r) => r.kind === 'EQUITY'));
  assert.throws(() => parseEtfMaster('FOO,BAR\n1,2'), /Unrecognised ETF master header/);
  assert.deepEqual(parseEtfMaster(''), []);
});

test('a search for the index name finds its ETF', () => {
  for (const r of parseEtfMaster(ETF_CSV)) store.instruments.set(r.symbol, r);
  assert.ok(searchInstruments('nifty bank').some((h) => h.symbol === 'BANKBEES'));
  assert.equal(searchInstruments('niftybees')[0].symbol, 'NIFTYBEES');
});

// ─── search ranking ───────────────────────────────────────────────────────
test('symbol-prefix matches rank ahead of name matches', () => {
  for (const r of parseEquityMaster(CSV)) store.instruments.set(r.symbol, r);
  const hits = searchInstruments('sci');
  assert.equal(hits[0].symbol, 'SCI', 'exact symbol first');
  assert.equal(hits[1].symbol, 'SCIENTECH');
  assert.ok(searchInstruments('shipping').some((h) => h.symbol === 'SCI'), 'name search works');
  assert.deepEqual(searchInstruments('   '), [], 'blank query returns nothing');
});

// ─── simulator isolation ──────────────────────────────────────────────────
test('an externally-fed price is never random-walked by the simulator', () => {
  marketData.ingestExternal('SYRMA', 1647.9);
  assert.equal(marketData.isExternal('SYRMA'), true);
  assert.equal(marketData.getPrice('SYRMA'), 1647.9);

  // Drive the simulator's tick directly, many times. RELIANCE (seeded) must
  // move; SYRMA (external) must not move by even a paisa.
  const tick = (marketData as unknown as { tickOnce: () => void }).tickOnce.bind(marketData);
  const relBefore = marketData.getPrice('RELIANCE');
  for (let i = 0; i < 50; i++) tick();
  assert.equal(marketData.getPrice('SYRMA'), 1647.9, 'external price must be untouched');
  assert.notEqual(marketData.getPrice('RELIANCE'), relBefore, 'seeded price must still simulate');
});

test('a symbol the simulator does not know is not priced until something feeds it', () => {
  assert.equal(marketData.getPrice('NOSUCHSYM'), 0);
  assert.equal(marketData.isExternal('NOSUCHSYM'), false);
});

if (failures.length) {
  console.error(`✗ instruments: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ instruments: ${passed} passed`);

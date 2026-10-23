/**
 * Foreign stocks v2 tests: plans and targets, the "why" card, bouncing back,
 * US news and SEC events. Test names carry the check IDs used in
 * FOREIGN_RECS_PLAN_V2.md / FOREIGN_RECS_CHECKLIST.md:
 *
 *   D4  year-ago quarter matched by date, not by counting rows
 *   D6  a failed or odd Nasdaq/SEC response leaves the card blank, never throws
 *   R2  bounce gates; a deeper fall never scores higher
 *   R3  rejections carry their reason; business problems are flags
 *   R5  reasons are in dollars
 *   T1  analyst upside can be negative
 *   T2  the review level is below the price and at most 25% away
 *   T5  earnings within 7 days are detected
 *   N2  US headline phrases score the right way; Indian scoring unchanged
 *   N3  headlines about another company are dropped
 *   N4  8-K item codes are translated and the red ones found
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { readQuarters, recentQuarters, yearAgoOf, type QuarterFact } from '../services/foreign/quarterly';
import { nasdaqSymbol, parseEarnings, parseTarget } from '../services/foreign/nasdaq';
import { parseSubmissions } from '../services/foreign/secEvents';
import { cleanName, isListicle, namesCompany, newsQuery, readHeadlines, usTone } from '../services/foreign/usNews';
import { analystUpside, daysTo, levelsFor, outlookFor, readyNow, whyLines, MAX_STOP_PCT } from '../services/foreign/plan';
import { pickNextTier, pickTop } from '../services/foreign/score';
import { bandFor, fitBands, quantile, runHorizonStudy, targetsFor, type HorizonStudy } from '../services/foreign/horizons';
import { bounceFeatures, bounceScore, bounceVerdict, businessClean, priceGate, type BounceFeatures } from '../services/foreign/bounce';
import { runBounceBacktest } from '../services/foreign/bounceBacktest';
import { measureAt } from '../services/foreign/score';
import { toneOf, toneWith, _internal, type Headline } from '../services/recommender/news';
import type { QualityScore } from '../services/foreign/fundamentals';
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

const q = (start: string, end: string, val: number): QuarterFact => ({ start, end, val });
const quality = (over: Partial<QualityScore> = {}): QualityScore => ({
  asOfYear: 2025, roa: 0.08, cfoa: 0.1, accruals: -0.02, leverage: 0.5, roaVol: 0.01, score: 0.7, junk: false, weak: [], ...over,
});

// ---------------- quarterly (D4) ----------------

test('D4: year-ago quarter is matched by date even with a quarter missing', () => {
  // Q4 2025 is missing (as in thin Q4 frames). Counting back 4 rows from Q2 2026 would land on Q1 2025.
  const rev = [q('2025-01-01', '2025-03-31', 80), q('2025-04-01', '2025-06-30', 100), q('2025-07-01', '2025-09-30', 105), q('2026-01-01', '2026-03-31', 110), q('2026-04-01', '2026-06-30', 120)];
  assert.equal(yearAgoOf(rev, '2026-06-30')!.end, '2025-06-30');
  const r = readQuarters([rev], [q('2026-04-01', '2026-06-30', 12), q('2025-04-01', '2025-06-30', 8)]);
  assert.equal(r.latestEnd, '2026-06-30');
  assert.ok(Math.abs(r.revenueGrowth! - 0.2) < 1e-9);
  assert.ok(Math.abs(r.margin! - 0.1) < 1e-9);
  assert.ok(Math.abs(r.marginYearAgo! - 0.08) < 1e-9);
});

test('D4: no year-ago quarter within 45 days means no growth figure, not a wrong one', () => {
  const r = readQuarters([[q('2026-04-01', '2026-06-30', 120), q('2025-01-01', '2025-03-31', 80)]], []);
  assert.equal(r.revenueGrowth, null);
});

test('D4: year-to-date and annual facts are not read as quarters', () => {
  const r = readQuarters([[q('2026-01-01', '2026-06-30', 999), q('2025-07-01', '2026-06-30', 5000)]], []);
  assert.equal(r.latestEnd, null);
});

test('D4: the second revenue tag is used when the first has nothing', () => {
  const r = readQuarters([[], [q('2026-04-01', '2026-06-30', 50), q('2025-04-01', '2025-06-30', 40)]], []);
  assert.ok(Math.abs(r.revenueGrowth! - 0.25) < 1e-9);
});

test('recentQuarters walks back across years', () => {
  assert.deepEqual(recentQuarters('2026-02-10', 3), ['CY2026Q1', 'CY2025Q4', 'CY2025Q3']);
});

// ---------------- Nasdaq (D6, T4) ----------------

test('D6: empty or failed Nasdaq bodies give null, never throw', () => {
  assert.equal(parseTarget(null), null);
  assert.equal(parseTarget({ data: null }), null);
  assert.equal(parseEarnings(null, null), null);
});

test('Nasdaq shapes parse (from responses fetched 2026-10-14)', () => {
  const t = parseTarget({
    data: {
      consensusOverview: { lowPriceTarget: 245.0, highPriceTarget: 400.0, priceTarget: 338.31, buy: 16, sell: 4, hold: 9 },
      historicalConsensus: [{ z: { date: '10/01/2025' }, y: 255.45 }, { z: { date: '11/01/2025' }, y: 270.37 }],
    },
  })!;
  assert.equal(t.target, 338.31);
  assert.equal(t.buy + t.hold + t.sell, 29);
  // historicalConsensus[].y is the PRICE that month, not a target: it must not be read as one.
  assert.equal('targetYearAgo' in t, false);
  const e = parseEarnings(
    { data: { earningsSurpriseTable: { rows: [{ fiscalQtrEnd: 'Jun 2026', dateReported: '8/4/2026', eps: 17.73, consensusForecast: '14.52', percentageSurprise: '22.11' }] } } },
    { data: { quarterlyForecast: { rows: [{ up: 4, down: 0, noOfEstimates: 5 }] }, yearlyForecast: { rows: [{ up: 3, down: 1 }] } } },
  )!;
  assert.ok(Math.abs(e.surprises[0].surprise! - 0.2211) < 1e-9);
  assert.equal(e.revisionsUp, 7);
  assert.equal(e.revisionsDown, 1);
  assert.equal(nasdaqSymbol('BRK-B'), 'BRK.B');
});

// ---------------- SEC events (N4) ----------------

test('N4: 8-K item codes translate; exhibits dropped; red items found; old and non-8-K ignored', () => {
  const r = parseSubmissions(
    {
      filings: {
        recent: {
          form: ['8-K', '10-Q', '8-K', '8-K', '8-K/A'],
          filingDate: ['2026-09-03', '2026-08-30', '2026-08-26', '2025-01-01', '2026-07-01'],
          items: ['4.02,9.01', '', '2.02,9.01', '1.03', '5.02'],
        },
      },
    },
    '2026-07-01',
  );
  assert.deepEqual(r.events.map((e) => e.item), ['4.02', '2.02', '5.02']);
  assert.equal(r.red.length, 1);
  assert.match(r.red[0].text, /relied on/);
  assert.deepEqual(parseSubmissions(null, '2026-01-01'), { events: [], red: [] });
});

// ---------------- US news (N2, N3) ----------------

test('N2: US phrases score the right way', () => {
  assert.ok(usTone('Acme cuts guidance as demand slows').tone < 0);
  assert.ok(usTone('Acme raises guidance after strong quarter').tone > 0);
  assert.ok(usTone('Acme files for Chapter 11 protection').tone < 0);
  assert.ok(usTone('Acme beats expectations on revenue').tone > 0);
  assert.ok(usTone('Short seller targets Acme').tone < 0);
  assert.ok(usTone('Acme stock hits all-time high').tone > 0);
  assert.ok(usTone('Acme downgraded at Morgan Stanley').tone < 0);
});

test('N2: Indian scoring is unchanged by the US extension', () => {
  for (const t of ['Reliance Slips 0.30% as Profit-Taking Sets In', 'TCS beats estimates, shares jump', 'Infosys downgrade after weak guidance']) {
    assert.deepEqual(toneOf(t), toneWith(t, _internal.LEXICON, _internal.BIGRAMS));
  }
  assert.equal(_internal.LEXICON.downgraded, undefined);
});

test('N3: headlines must name the company', () => {
  assert.equal(namesCompany('Apple shares rise after iPhone launch', 'Apple Inc.', 'AAPL'), true);
  assert.equal(namesCompany("Apple's services revenue climbs", 'Apple Inc.', 'AAPL'), true);
  assert.equal(namesCompany('Apple Hospitality REIT raises dividend', 'Apple Inc.', 'AAPL'), false);
  assert.equal(namesCompany('Best apple pie recipes', 'Apple Inc.', 'AAPL'), false);
  assert.equal(namesCompany('Analyst raises price target on Nvidia', 'Target Corporation', 'TGT'), false);
  assert.equal(namesCompany('Price Target Raised For Nvidia', 'Target Corporation', 'TGT'), false);
  assert.equal(namesCompany("Target's holiday sales beat", 'Target Corporation', 'TGT'), true);
  assert.equal(namesCompany('Google unveils new AI model', 'Alphabet Inc. (Class A)', 'GOOGL'), true);
  assert.equal(namesCompany('NVDA slides in early trade', 'Nvidia', 'NVDA'), true);
  assert.equal(namesCompany('IT spending forecast rises', 'Gartner', 'IT'), false);
  assert.equal(namesCompany('American Express beats estimates', 'American Airlines Group', 'AAL'), false);
  assert.equal(namesCompany('Exxon Mobil boosts output', 'ExxonMobil', 'XOM'), true);
  assert.equal(namesCompany('Amazon expands same-day delivery', 'Amazon.com Inc.', 'AMZN'), true);
  // Found in the live run 2026-10-14:
  assert.equal(namesCompany('Refresh Your Portfolios with Coca-Cola Consolidated Stock', 'Coca-Cola Company (The)', 'KO'), false);
  assert.equal(namesCompany("99% of PNB MetLife's Equity Fund Assets Receive 4- or 5-Star Ratings", 'MetLife', 'MET'), false);
  assert.equal(namesCompany('MetLife (NYSE:MET) Hits New 52-Week High', 'MetLife', 'MET'), true);
});

test('market panel drops stock-picking listicles', () => {
  assert.equal(isListicle('1 S&P 500 Stock with Solid Fundamentals and 2 We Avoid'), true);
  assert.equal(isListicle('3 Dividend Stocks to Buy Now'), true);
  assert.equal(isListicle("3 of Wall Street's Favorite Stocks That Fall Short"), true);
  assert.equal(isListicle('Is It Too Late to Invest in the Stock Market?'), false);
  assert.equal(isListicle('S&P 500, Dow futures rise ahead of big bank results, CPI data'), false);
});

test('duplicate headlines count once', () => {
  const one = (title: string): Headline => ({ title, source: 'x', at: Date.now(), url: '', tone: 0, matched: [] });
  const r = readHeadlines([one('Accenture Stock Surges 60% in 3 Months'), one('Accenture Stock Surges 60% in 3 Months')], 'Accenture', 'ACN');
  assert.equal(r.headlines.length, 1);
});

test('N3: names are cleaned of legal suffixes; generic one-word names search by alias', () => {
  assert.equal(cleanName('Coca-Cola Company (The)'), 'Coca-Cola');
  assert.equal(cleanName('Travelers Companies (The)'), 'Travelers Companies');
  assert.equal(cleanName('News Corp (Class A)'), 'News');
  assert.match(newsQuery('Target Corporation', 'TGT'), /"Target Corp"/);
});

const h = (title: string): Headline => ({ title, source: 'x', at: Date.now(), url: '', tone: 0, matched: [] });

test('news veto: 3 strongly negative headlines withhold; 2 do not; off-topic ones are dropped', () => {
  const bad = ['Acme Widgets plunges after fraud probe', 'Acme Widgets downgraded, guidance cut', 'Acme Widgets faces class action lawsuit'];
  const three = readHeadlines([...bad, 'Other Co soars on record revenue'].map(h), 'Acme Widgets Inc.', 'ACMW');
  assert.equal(three.veto, true);
  assert.equal(three.offTopic, 1);
  const two = readHeadlines(bad.slice(0, 2).map(h), 'Acme Widgets Inc.', 'ACMW');
  assert.equal(two.veto, false);
});

// ---------------- plan and targets (T1, T2, T5, R5) ----------------

const rising = bars('UP', '2024-01-01', 400, (i) => 100 * Math.exp(i * 0.002 + 0.01 * Math.sin(i / 3)));
const mUp = measureAt('UP', rising)!;

test('T2: review level is below the price and never more than 25% away, both kinds', () => {
  for (const kind of ['momentum', 'bounce'] as const) {
    const L = levelsFor(mUp, kind);
    assert.ok(L.review < mUp.lastClose, `${kind} review ${L.review} >= price`);
    assert.ok(L.review >= mUp.lastClose * (1 - MAX_STOP_PCT) - 0.01, `${kind} review too far`);
    assert.ok(L.buyLow < L.buyHigh && L.rangeLow < mUp.lastClose && mUp.lastClose < L.rangeHigh);
  }
  // A 200-day average ABOVE the price (a bounce stock) must not become a "stop" above the price.
  const L = levelsFor({ ...mUp, sma200: mUp.lastClose * 1.2 }, 'momentum');
  assert.ok(L.review < mUp.lastClose);
  // A very volatile stock: the cap applies.
  const wild = levelsFor({ ...mUp, atr14: mUp.lastClose * 0.2, sma200: mUp.lastClose * 0.5 }, 'momentum');
  assert.ok(Math.abs(wild.reviewPct + MAX_STOP_PCT) < 1e-6);
});

test('T1: analyst upside is negative when the price is above the target', () => {
  const n = { analyst: { target: 90, targetLow: 80, targetHigh: 100, buy: 1, hold: 1, sell: 0 }, earnings: null };
  assert.ok(analystUpside(n, 100)! < 0);
  assert.equal(analystUpside(null, 100), null);
});

test('T5: earnings within 7 days are detected', () => {
  assert.equal(daysTo('2026-10-20', '2026-10-14'), 6);
  assert.equal(daysTo(undefined, '2026-10-14'), null);
});

test('R5/X3: reasons are in dollars, graded, and never promise a rise', () => {
  const lines = whyLines({
    kind: 'momentum',
    m: mUp,
    signals: [{ label: '12-month momentum', percentile: 95 }],
    ret12m: 0.4,
    q: { latestEnd: '2026-06-30', revenue: 120, revenueYearAgo: 100, revenueGrowth: 0.2, margin: 0.05, marginYearAgo: 0.08, latestProfit: 6 },
    quality: quality(),
    nasdaq: { analyst: null, earnings: { surprises: [{ quarter: 'Jun', reported: '', surprise: 0.05 }], revisionsUp: 3, revisionsDown: 1, estimates: 5 } },
  });
  const text = lines.map((l) => l.text).join(' ');
  assert.doesNotMatch(text, /₹|crore|will (go up|rise)|guarantee/i);
  const sales = lines.find((l) => /^Sales/.test(l.text))!;
  assert.equal(sales.stance, 'bad'); // growth with shrinking margins is flagged
  assert.match(sales.text, /⚑/);
  assert.equal(lines[0].grade, 'A');
  assert.match(lines[0].text, /12-month momentum \(better than 95% of stocks\)/);
  const top = whyLines({ kind: 'momentum', m: mUp, signals: [{ label: 'x', percentile: 100 }], ret12m: null, q: null, quality: null, nasdaq: null });
  assert.match(top[0].text, /x \(top 1% of stocks\)/);
  const b = whyLines({ kind: 'bounce', m: mUp, signals: [], fall: 0.264, ret12m: null, q: null, quality: null, nasdaq: null });
  assert.match(b[0].text, /^Fell 26% /);
  assert.ok(lines.some((l) => l.grade === 'C' && /raised profit estimates 3 times and cut them 1 time/.test(l.text)));
  assert.ok(!lines.some((l) => /insider/i.test(l.text)));
});

test('margins that cannot be right are hidden; a loss-making quarter is never "good"', () => {
  const base = { kind: 'momentum' as const, m: mUp, signals: [], ret12m: 0.1, quality: null, nasdaq: null };
  const ins = whyLines({ ...base, q: { latestEnd: '2026-06-30', revenue: 100, revenueYearAgo: 80, revenueGrowth: 0.25, margin: 1.2, marginYearAgo: 1.0, latestProfit: 120 } });
  assert.doesNotMatch(ins.find((l) => /^Sales/.test(l.text))!.text, /margin/);
  const loss = whyLines({ ...base, q: { latestEnd: '2026-06-30', revenue: 100, revenueYearAgo: 98, revenueGrowth: 0.02, margin: -0.5, marginYearAgo: -0.6, latestProfit: -50 } });
  const sales = loss.find((l) => /^Sales/.test(l.text))!;
  assert.equal(sales.stance, 'bad');
  assert.match(sales.text, /losing money/);
});

// ---------------- bouncing back (R2, R3) ----------------

const F = (o: Partial<BounceFeatures> = {}): BounceFeatures => ({ price: 70, fall: 0.3, sma50: 65, sma50Prev: 62, sma200: 75, ret3m: 0.08, low20: 64, ...o });

test('R2: price gates', () => {
  assert.equal(priceGate(F()), null);
  assert.equal(bounceVerdict(F({ fall: 0.1 }), { quality: quality() }).status, 'not-fallen');
  assert.match(bounceVerdict(F({ fall: 0.8 }), { quality: quality() }).reason!, /75%/);
  assert.match(priceGate(F({ price: 60 }))!, /still falling/);
  assert.match(priceGate(F({ sma50Prev: 66 }))!, /50-day average is still falling/);
  assert.match(priceGate(F({ ret3m: -0.01 }))!, /3 months/);
});

test('R2: a deeper fall never scores higher', () => {
  const ctx = { quality: quality() };
  const shallow = bounceScore(ctx);
  assert.equal(bounceVerdict(F({ fall: 0.6 }), ctx).status, 'qualified');
  assert.ok(bounceScore(ctx) <= shallow);
  assert.ok(bounceVerdict(F({ fall: 0.6 }), ctx).flags.some((x) => /falls this deep/.test(x)));
});

test('R3: business problems are flags (backtest B3), hard risks reject with the reason', () => {
  const loss = bounceVerdict(F(), { quality: quality({ roa: -0.02 }) });
  assert.equal(loss.status, 'qualified');
  assert.ok(loss.flags.some((x) => /loss-making/.test(x)));
  assert.equal(businessClean(loss), false);
  const junk = bounceVerdict(F(), { quality: quality({ junk: true, weak: ['heavy debt'] }) });
  assert.ok(junk.flags.some((x) => /heavy debt/.test(x)));
  assert.equal(businessClean(bounceVerdict(F({ fall: 0.5 }), { quality: quality() })), true); // depth alone is not a business flag
  const red = bounceVerdict(F(), { quality: quality(), redEvent: 'past accounts can no longer be relied on (2026-09-01)' });
  assert.equal(red.status, 'rejected');
  assert.match(red.reason!, /SEC filing/);
  assert.equal(bounceVerdict(F(), { quality: quality(), newsVeto: true }).status, 'rejected');
  const qLoss = bounceVerdict(F(), { quality: quality(), quarter: { latestEnd: null, revenue: null, revenueYearAgo: null, revenueGrowth: null, margin: null, marginYearAgo: null, latestProfit: -5 } });
  assert.ok(qLoss.flags.some((x) => /latest quarter/.test(x)));
});

test('bounce score falls with shrinking sales or margins', () => {
  const base = bounceScore({ quality: quality() });
  const shrink = bounceScore({ quality: quality(), quarter: { latestEnd: 'x', revenue: 90, revenueYearAgo: 100, revenueGrowth: -0.1, margin: 0.05, marginYearAgo: 0.08, latestProfit: 4 } });
  assert.ok(shrink < base);
});

test('bounce features never read a later bar', () => {
  const b = bars('B', '2024-01-01', 320, (i) => 100 - (i < 200 ? i * 0.2 : (400 - i) * 0.05));
  const at = bounceFeatures(b, 300)!;
  const changed = b.map((c, i) => (i > 300 ? { ...c, close: c.close * 3, low: c.low * 3 } : c));
  assert.deepEqual(bounceFeatures(changed, 300), at);
  assert.equal(bounceFeatures(b, 200), null);
});

test('bounce backtest: runs point in time, reports both verdicts and calibration', () => {
  const m = new Map<string, Candle[]>();
  const added = new Map<string, string | null>();
  for (let k = 0; k < 12; k++) {
    // V-shaped and steady names, so the fallen and bounce baskets are sometimes non-empty.
    m.set(`S${k}`, bars(`S${k}`, '2012-01-01', 1400, (i) => (k % 3 === 0 ? 100 * (1 + 0.5 * Math.cos(i / (60 + k * 5))) + 20 : 50 * Math.exp(i * 0.0003))));
    added.set(`S${k}`, '2000-01-01');
  }
  m.set('LATE', bars('LATE', '2012-01-01', 1400, (i) => 100 + i));
  added.set('LATE', '2030-01-01'); // never in the universe
  const bt = runBounceBacktest({ bars: m, sectors: new Map(), ciks: new Map(), added, fundamentals: new Map(), from: '2013-06-01' });
  const eq = bt.lines.find((l) => l.id === 'equal')!;
  assert.ok(bt.months > 20);
  assert.ok(eq.avgHoldings <= 12 + 1e-9, 'a stock not yet in the index was held');
  assert.equal(typeof bt.passed, 'boolean');
  assert.equal(typeof bt.pricePassed, 'boolean');
  assert.equal(bt.calibration.inside + bt.calibration.above + bt.calibration.below, bt.calibration.observations);
  // Without SEC accounts nothing is business-clean, so the gated line holds nothing.
  assert.equal(bt.lines.find((l) => l.id === 'bounce')!.avgHoldings, 0);
});

// ---------------- horizon targets (H1–H3) ----------------

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

test('H: bands are ordered, wider for wilder stocks, and the drift is capped', () => {
  const obs = Array.from({ length: 300 }, (_, i) => ({ z: ((i * 37) % 100) / 50 - 0.5, sigma: 0.1 + (i % 30) / 100 }));
  const m = fitBands(obs, 126);
  assert.equal(m.buckets.length, 3);
  for (const sg of [0.12, 0.3, 1.5]) {
    const b = bandFor(m, sg);
    assert.ok(b.low < b.base && b.base < b.high, `unordered at sigma ${sg}`);
  }
  const calm = bandFor(m, 0.35);
  const wild = bandFor(m, 1.5);
  assert.ok(wild.high - wild.low > calm.high - calm.low);
  // Same bucket, far more volatile: the base (drift) does not grow past the cap.
  assert.ok(Math.abs(bandFor(m, 1.5).base - bandFor(m, 5).base) < 1e-12);
});

test('H: a stored model (Infinity became null in JSON) still finds its last bucket', () => {
  const m = fitBands(Array.from({ length: 90 }, (_, i) => ({ z: (i % 9) / 10, sigma: 0.1 + i / 300 })), 21);
  const stored = JSON.parse(JSON.stringify(m));
  assert.equal(stored.buckets[2].maxSigma, null);
  assert.deepEqual(bandFor(stored, 2), bandFor(m, 2));
});

test('H: targets come out in dollars around the price, one per horizon', () => {
  const model = fitBands(Array.from({ length: 90 }, (_, i) => ({ z: (i % 9) / 10 - 0.2, sigma: 0.15 + i / 600 })), 252);
  const study: HorizonStudy = { from: 'a', to: 'b', split: 'c', stats2: [], stats: [{ key: 'long', days: 252, label: 'Long term (1 year)', n: 90, model, upRate: 0.7, picksMean: [0.1, 0.1], allMean: [0.08, 0.08], edge: true, oos: { n: 1, insideMiddle: 0.5, aboveBase: 0.5 } }] };
  const [t] = targetsFor(100, 25, study);
  assert.ok(t.low < t.base && t.base < t.high);
  assert.ok(Math.abs(t.base / 100 - 1 - t.basePct) < 1e-3);
  assert.deepEqual(targetsFor(100, 25, null), []);
});

test('H: the study only scores stocks already in the index, and reports all three horizons', () => {
  const m = new Map<string, Candle[]>();
  const added = new Map<string, string | null>();
  for (let k = 0; k < 30; k++) {
    m.set(`S${k}`, bars(`S${k}`, '2012-01-01', 1300, (i) => 50 * Math.exp(i * 0.0002 * (1 + (k % 6)) + 0.02 * Math.sin(i / (5 + k)))));
    added.set(`S${k}`, '2000-01-01');
  }
  const st = runHorizonStudy({ bars: m, sectors: new Map(), ciks: new Map(), added, fundamentals: new Map(), from: '2013-06-01', topN: 5 });
  assert.deepEqual(st.stats.map((s) => s.key), ['short', 'medium', 'long']);
  for (const s of st.stats) {
    assert.ok(s.n > 0);
    assert.equal(s.model.buckets.length, 3);
  }
  const none = runHorizonStudy({ bars: m, sectors: new Map(), ciks: new Map(), added: new Map(), fundamentals: new Map(), from: '2013-06-01', topN: 5 });
  assert.equal(none.stats[0].n, 0);
});

test('start here: skips results-due, held-back and weak-finance picks, keeps rank order', () => {
  const row = (ticker: string, o: { soon?: boolean; held?: string; junk?: boolean } = {}) => ({
    ticker,
    quality: { junk: !!o.junk },
    detail: { earningsSoon: !!o.soon, withheld: o.held ?? null },
  });
  const r = readyNow([row('A'), row('B', { soon: true }), row('C', { junk: true }), row('D', { held: 'news veto' }), row('E'), row('F'), row('G'), row('H'), row('I')], 5);
  assert.deepEqual(r.ready, ['A', 'E', 'F', 'G', 'H']);
  assert.deepEqual(r.skipped.map((x) => x.ticker), ['B', 'C', 'D']);
});

// ---------------- outlook and second tier ----------------

const outlookBase = {
  rank: 3,
  tier: 1 as const,
  universe: 527,
  sector: 'Energy',
  ret12m: 1.6,
  volPct: 30,
  signals: [{ label: '6-month momentum', percentile: 98 }],
  q: { latestEnd: '2026-06-30', revenue: 154, revenueYearAgo: 100, revenueGrowth: 0.54, margin: 0.099, marginYearAgo: 0.036, latestProfit: 15 },
  quality: quality({ score: 0.7 }),
  nasdaq: { analyst: null, earnings: { surprises: [{ quarter: 'a', reported: '', surprise: 0.2 }, { quarter: 'b', reported: '', surprise: 0.1 }, { quarter: 'c', reported: '', surprise: 0.3 }], revisionsUp: 9, revisionsDown: 0, estimates: 5 } },
  analystUpside: -0.07,
  earningsSoon: false,
  history: { upRate: 0.7, picksMean: [0.144, 0.152] as [number, number], allMean: [0.125, 0.113] as [number, number], edge: true },
  sectorPeers: 1,
};

test('outlook: why, growth (graded) and risks, never a promise', () => {
  const o = outlookFor(outlookBase);
  assert.match(o.why[0], /Ranked #3 of 527/);
  assert.equal(o.growth[0].grade, 'A');
  assert.match(o.growth[0].text, /70% of the time/);
  assert.ok(o.growth.some((g) => g.grade === 'B' && /sales \+54\.0%/.test(g.text)));
  assert.ok(o.growth.some((g) => g.grade === 'C' && /raising profit forecasts/.test(g.text)));
  assert.ok(o.risks.some((r) => /^Already 7% above the analysts/.test(r)));
  assert.ok(o.risks.some((r) => /30% of stocks at this rank were lower/.test(r)));
  const all = [...o.why, ...o.growth.map((g) => g.text), ...o.risks].join(' ');
  assert.doesNotMatch(all, /\bwill\b|guarantee|₹/i);
});

test('outlook: problems move to risks, and crowding is named', () => {
  const o = outlookFor({
    ...outlookBase,
    tier: 2,
    rank: 27,
    quality: quality({ junk: true, weak: ['heavy debt'], score: 0.1 }),
    q: { ...outlookBase.q, margin: 0.03, marginYearAgo: 0.05 },
    volPct: 60,
    earningsSoon: true,
    sectorPeers: 4,
  });
  assert.match(o.why[0], /second tier/);
  assert.ok(!o.growth.some((g) => /business behind the price/.test(g.text)));
  for (const re of [/heavy debt/, /margins are shrinking/, /within 7 days/, /Swings about 60%/, /4 of the names shown are Energy/]) assert.ok(o.risks.some((r) => re.test(r)), String(re));
});

test('second tier: never overlaps the top tier and keeps its own sector cap', () => {
  const sectors = new Map<string, string>();
  const scored = Array.from({ length: 60 }, (_, i) => {
    sectors.set(`S${i}`, `sec${i % 5}`);
    return { symbol: `S${i}`, horizon: 'medium', score: 100 - i, verdict: 'strong', signals: [], vetoed: false, vetoReason: null, quality: null } as unknown as Parameters<typeof pickTop>[0][number];
  });
  const t1 = pickTop(scored, 20, sectors);
  const t2 = pickNextTier(scored, new Set(t1.map((s) => s.symbol)), 20, sectors);
  assert.equal(t2.length, 20);
  assert.ok(t2.every((s) => !t1.some((x) => x.symbol === s.symbol)));
  const per = new Map<string, number>();
  for (const s of t2) per.set(sectors.get(s.symbol)!, (per.get(sectors.get(s.symbol)!) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 4));
});

if (failures.length) {
  console.error(`foreignV2: ${passed} passed, ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`✓ foreignV2: ${passed} passed`);

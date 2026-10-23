/**
 * Future stars: the parsers, the scorer and the staged plan.
 *
 * Every case here is either a real filing shape verified against NSE on
 * 2026-09-11 or a bug that was found by running the engine against live data.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  classifyAnnouncement,
  parseCustomer,
  parseNseDate,
  parseOrderValue,
  summariseOrders,
} from '../services/futurestars/orders';
import { computeGrowth, parseResultsXbrl } from '../services/futurestars/fundamentals';
import { policyFor, POLICY_UNIVERSE } from '../services/futurestars/policy';
import { GATES, PriceContext, WEIGHTS, scoreFutureStar, scoreGrowth, scoreOrders, scoreProfitability } from '../services/futurestars/score';
import { DEFAULT_PLAN_PARAMS, buildEntryPlan, fundingPlan } from '../services/futurestars/plan';
import { Quarter } from '../services/futurestars/types';

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

const CR = 1e7;
const NOW = Date.parse('2026-09-11T06:00:00Z');
const day = (n: number): string => {
  const d = new Date(NOW - n * 86_400_000);
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${mons[d.getUTCMonth()]}-${d.getUTCFullYear()} 10:00:00`;
};

// ── dates ──
test('NSE filing timestamps parse as IST', () => {
  const t = parseNseDate('10-Sep-2026 20:23:14');
  assert.ok(t !== null);
  // 20:23 IST is 14:53 UTC the same day.
  assert.equal(new Date(t!).toISOString(), '2026-09-10T14:53:14.000Z');
  assert.equal(parseNseDate('garbage'), null);
  assert.equal(parseNseDate(undefined), null);
});

// ── money ──
test('rupee values parse from the shapes Indian filings actually use', () => {
  assert.equal(parseOrderValue('order worth Rs. 1,234.56 crore from Indian Railways'), 1234.56 * CR);
  assert.equal(parseOrderValue('contract valued at ₹450 Cr'), 450 * CR);
  assert.equal(parseOrderValue('Letter of Award of INR 45.6 million'), 45.6e6);
  assert.equal(parseOrderValue('aggregate value of Rs 2.3 lakh crore'), 2.3e12);
  assert.equal(parseOrderValue('no value here'), null);
});

test('the largest amount in the text wins, so an incidental figure cannot displace the order value', () => {
  assert.equal(parseOrderValue('order of Rs 500 crore; earlier order of Rs 20 crore'), 500 * CR);
});

// ── classification: the bug that started this ──
test('a regulatory order is never read as an order win', () => {
  // NSE's category for a FINE contains the word "orders". Matching loosely
  // turned an exchange penalty into a bullish signal on RVNL in testing.
  assert.equal(
    classifyAnnouncement({
      desc: 'Action(s) taken or orders passed',
      attchmntText: 'Imposition of fine by NSE for the quarter ended 30th June, 2026',
    }),
    'regulatory',
  );
  assert.equal(
    classifyAnnouncement({ desc: 'Bagging/Receiving of orders/contracts', attchmntText: 'informed about orders' }),
    'win',
  );
  assert.equal(classifyAnnouncement({ desc: 'Awarding of order(s)/contract(s)', attchmntText: '' }), 'win');
});

test('a win can be found in a generic category, but cancellations are not wins', () => {
  assert.equal(classifyAnnouncement({ desc: 'Updates', attchmntText: 'Company bags order worth Rs 500 crore' }), 'win');
  assert.equal(
    classifyAnnouncement({ desc: 'Updates', attchmntText: 'Cancellation of the order received earlier' }),
    'other',
  );
  assert.equal(
    classifyAnnouncement({ desc: 'Updates', attchmntText: 'Show cause notice regarding delay in the contract' }),
    'other',
  );
});

// ── customer: the "SEBI" bug ──
test('regulatory boilerplate is never reported as the customer', () => {
  const real =
    'Disclosure under Regulation 30 of SEBI (LODR) Regulations, 2015- Letter of Award from SJVN Thermal Private Limited';
  assert.equal(parseCustomer(real), 'SJVN Thermal Private Limited');
  // The first attempt at this returned "SEBI" for the line above.
  assert.notEqual(parseCustomer(real), 'SEBI');
  assert.equal(parseCustomer('Disclosure under Regulation 30 of SEBI (LODR) Regulations, 2015'), null);
});

// ── order flow ──
test('order flow splits the windows and keeps the regulatory filings apart', () => {
  const { flow, regulatory } = summariseOrders(
    'TEST',
    [
      { an_dt: day(10), desc: 'Bagging/Receiving of orders/contracts', attchmntText: 'order of Rs 100 crore' },
      { an_dt: day(60), desc: 'Bagging/Receiving of orders/contracts', attchmntText: 'order of Rs 50 crore' },
      { an_dt: day(200), desc: 'Bagging/Receiving of orders/contracts', attchmntText: 'order of Rs 30 crore' },
      { an_dt: day(20), desc: 'Action(s) taken or orders passed', attchmntText: 'Imposition of fine by NSE' },
    ],
    NOW,
    1000 * CR,
  );
  assert.equal(flow.recentCount, 2, 'two wins inside 180 days');
  assert.equal(flow.priorCount, 1);
  assert.equal(flow.recentValueInr, 150 * CR);
  assert.equal(flow.daysSinceLast, 10);
  assert.equal(flow.valueCoverage, 1);
  // (150cr × 2) / 1000cr
  assert.equal(flow.bookToBill, 0.3);
  assert.equal(regulatory.length, 1, 'the fine is a risk flag, not a win');
  assert.equal(regulatory[0].kind, 'regulatory');
});

test('book-to-bill is withheld when most wins disclosed no value', () => {
  // BEL: nine of ten recent wins carried no number in the filing text. A ratio
  // built on the tenth is wrong, not conservative.
  const announcements = Array.from({ length: 10 }, (_, i) => ({
    an_dt: day(i * 15),
    desc: 'Bagging/Receiving of orders/contracts',
    attchmntText: i === 0 ? 'order worth Rs 100 crore' : 'has informed the Exchange about Bagging/Receiving of orders',
  }));
  const { flow } = summariseOrders('TEST', announcements, NOW, 1000 * CR);
  assert.equal(flow.recentCount, 10);
  assert.equal(flow.unpriced, 9);
  assert.equal(flow.valueCoverage, 0.1);
  assert.equal(flow.bookToBill, null, 'not enough coverage to quote a ratio');
});

// ── XBRL ──
const XBRL_LEGACY = `<?xml version="1.0"?><xbrl xmlns:in-bse-fin="x" xmlns:xbrli="y">
<xbrli:context id="OneD"><xbrli:period><xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<in-bse-fin:DateOfStartOfReportingPeriod contextRef="OneD">2024-10-01</in-bse-fin:DateOfStartOfReportingPeriod>
<in-bse-fin:DateOfEndOfReportingPeriod contextRef="OneD">2024-12-31</in-bse-fin:DateOfEndOfReportingPeriod>
<in-bse-fin:RevenueFromOperations contextRef="OneD" unitRef="INR" decimals="-6">8691980000.00</in-bse-fin:RevenueFromOperations>
<in-bse-fin:RevenueFromOperations contextRef="FourD" unitRef="INR" decimals="-6">28618300000.00</in-bse-fin:RevenueFromOperations>
<in-bse-fin:ProfitBeforeTax contextRef="OneD" unitRef="INR" decimals="-6">635330000.00</in-bse-fin:ProfitBeforeTax>
<in-bse-fin:ProfitLossForPeriod contextRef="OneD" unitRef="INR" decimals="-6">530070000.00</in-bse-fin:ProfitLossForPeriod>
</xbrl>`;

// SEBI's 2026 integrated-filing taxonomy: a different namespace, same tags.
const XBRL_INTEGRATED = `<?xml version="1.0"?><xbrl xmlns:in-capmkt="http://www.sebi.gov.in/xbrl/2026-01-31/in-capmkt" xmlns:xbrli="y">
<xbrli:context id="OneD"><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
<in-capmkt:DateOfStartOfReportingPeriod contextRef="OneD">2026-04-01</in-capmkt:DateOfStartOfReportingPeriod>
<in-capmkt:DateOfEndOfReportingPeriod contextRef="OneD">2026-06-30</in-capmkt:DateOfEndOfReportingPeriod>
<in-capmkt:RevenueFromOperations contextRef="OneD" decimals="-4" unitRef="INR">15886180000
</in-capmkt:RevenueFromOperations>
<in-capmkt:ProfitBeforeTax contextRef="OneD" decimals="-4" unitRef="INR">1408000000</in-capmkt:ProfitBeforeTax>
<in-capmkt:ProfitLossForPeriod contextRef="OneD" decimals="-4" unitRef="INR">1057000000</in-capmkt:ProfitLossForPeriod>
</xbrl>`;

test('both XBRL taxonomies parse, and the quarter column is read rather than the year-to-date one', () => {
  const legacy = parseResultsXbrl(XBRL_LEGACY, NOW, true);
  assert.ok(legacy, 'legacy filing parsed');
  assert.equal(legacy!.end, '2024-12-31');
  // 869.2cr is the quarter; 2,861.8cr under FourD is nine months and must not win.
  assert.equal(legacy!.revenue, 8_691_980_000);
  assert.equal(legacy!.pbt, 635_330_000);

  const integrated = parseResultsXbrl(XBRL_INTEGRATED, NOW, true);
  assert.ok(integrated, 'SEBI 2026 integrated filing parsed');
  assert.equal(integrated!.end, '2026-06-30');
  assert.equal(integrated!.revenue, 15_886_180_000);
});

test('an annual or year-to-date filing is refused, not mistaken for a quarter', () => {
  const annual = XBRL_LEGACY.replace('2024-10-01</in-bse-fin:DateOfStartOfReportingPeriod>', '2024-04-01</in-bse-fin:DateOfStartOfReportingPeriod>');
  assert.equal(parseResultsXbrl(annual, NOW, true), null);
});

// ── growth: the index-arithmetic bug ──
const q = (end: string, revenue: number, profit: number, pbt = profit): Quarter => ({
  end,
  label: null,
  consolidated: true,
  revenue,
  profit,
  pbt,
  filedAt: Date.parse(end) + 45 * 86_400_000,
});

test('year-on-year is matched by DATE, so a missing quarter cannot fake an 18-month comparison', () => {
  // Syrma's real series: the March 2025 quarter is missing from NSE entirely.
  // Counting back four places compared June 2026 against December 2024 and
  // reported it as "+82.8% year on year".
  const g = computeGrowth('SYRMA', [
    q('2024-12-31', 869 * CR, 53 * CR),
    q('2025-06-30', 944 * CR, 50 * CR),
    q('2025-09-30', 1146 * CR, 70 * CR),
    q('2025-12-31', 1264 * CR, 80 * CR),
    q('2026-06-30', 1589 * CR, 106 * CR),
  ]);
  assert.equal(g.comparedWith, '2025-06-30', 'compared against the right quarter');
  assert.equal(g.revenueYoYPct, 68.3);
  assert.equal(g.ttmRevenue, null, 'four quarters with a hole in them are not a year');
});

test('a contiguous series gives year-on-year, the prior year-on-year and the acceleration', () => {
  const g = computeGrowth('T', [
    q('2025-06-30', 100 * CR, 10 * CR),
    q('2025-09-30', 110 * CR, 11 * CR),
    q('2025-12-31', 120 * CR, 12 * CR),
    q('2026-03-31', 130 * CR, 13 * CR),
    q('2026-06-30', 150 * CR, 20 * CR),
    q('2026-09-30', 160 * CR, 22 * CR),
  ]);
  assert.equal(g.comparedWith, '2025-09-30');
  assert.equal(g.revenueYoYPct, 45.5);
  assert.equal(g.revenueYoYPriorPct, 50);
  assert.equal(g.revenueAccelerationPct, -4.5, 'decelerating, and says so');
  assert.equal(g.positiveStreak, 2);
  assert.ok(g.ttmRevenue !== null);
});

test('no year-ago quarter means no growth number, not a guess', () => {
  const g = computeGrowth('T', [q('2026-06-30', 100 * CR, 10 * CR)]);
  assert.equal(g.revenueYoYPct, null);
  assert.equal(g.comparedWith, null);
  assert.equal(scoreGrowth(g).score, 0);
});

// ── policy ──
test('the policy map is opinion, saturates, and knows what it does not know', () => {
  const bel = policyFor('BEL');
  assert.ok(bel.tags.length >= 1, 'BEL is on the defence list');
  assert.ok(bel.critical.length >= 1);
  assert.ok(bel.raw > 0.6 && bel.raw <= 1);

  const unknown = policyFor('SOMERANDOMCO');
  assert.equal(unknown.tags.length, 0);
  assert.equal(unknown.raw, 0);

  // Saturating: four schemes must not be worth four times one.
  assert.ok(policyFor('RELIANCE').raw <= 1);
  assert.ok(POLICY_UNIVERSE.length > 50);
});

// ── scoring ──
const price = (over: Partial<PriceContext> = {}): PriceContext => ({
  last: 500,
  high52w: 600,
  low52w: 300,
  pctOf52wRange: 67,
  fromHighPct: -16,
  aboveSma200: true,
  sma200: 450,
  ret1yPct: 40,
  atrPct: 3,
  medianTurnover: 500_000_000,
  ...over,
});

test('a company that never files order wins is scored differently from one whose wins stopped', () => {
  const never = scoreOrders({
    symbol: 'A', recent: [], prior: [], recentCount: 0, priorCount: 0, recentValueInr: 0,
    priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: null, unpriced: 0,
  });
  const stopped = scoreOrders({
    symbol: 'B', recent: [], prior: [], recentCount: 0, priorCount: 4, recentValueInr: 0,
    priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: null, unpriced: 0,
  });
  assert.equal(never.score, 0);
  assert.equal(stopped.score, 0);
  assert.match(never.detail, /does not file individual order wins/);
  assert.match(stopped.detail, /stopped/);
});

// ── the evidence review's corrections ──
test('a stretched order book is a penalty, not a bonus', () => {
  // Banker et al. (RQFA 2024): a high backlog-to-sales ratio predicts LOWER
  // future earnings. The first version of this scorer rewarded it without limit.
  const base = {
    symbol: 'X', recent: [], prior: [], recentCount: 6, priorCount: 3, recentValueInr: 0,
    priorValueInr: 0, valueCoverage: 1, daysSinceLast: 10, unpriced: 0,
  };
  const healthy = scoreOrders({ ...base, bookToBill: 1.2 });
  const stretched = scoreOrders({ ...base, bookToBill: 6 });
  assert.ok(stretched.score < healthy.score, `${stretched.score} < ${healthy.score}`);
  assert.match(stretched.detail, /delivery risk/);
});

test('revenue growing while the margin shrinks is marked down, not merely scored low', () => {
  // Jegadeesh & Livnat (JAE 2006): sales growth without margin follow-through
  // earns NEGATIVE abnormal returns.
  const earned = computeGrowth('GOOD', [
    q('2025-06-30', 100 * CR, 10 * CR, 12 * CR),
    q('2025-09-30', 105 * CR, 11 * CR, 13 * CR),
    q('2026-06-30', 150 * CR, 18 * CR, 22 * CR),
    q('2026-09-30', 160 * CR, 20 * CR, 25 * CR),
  ]);
  const bought = computeGrowth('BAD', [
    q('2025-06-30', 100 * CR, 10 * CR, 20 * CR),
    q('2025-09-30', 105 * CR, 11 * CR, 21 * CR),
    q('2026-06-30', 150 * CR, 9 * CR, 12 * CR),
    q('2026-09-30', 160 * CR, 9 * CR, 13 * CR),
  ]);
  assert.ok(scoreGrowth(bought).score < scoreGrowth(earned).score);
  assert.match(scoreGrowth(bought).detail, /MARKED DOWN/);
});

test('profitability reads the margin and its direction', () => {
  const widening = computeGrowth('W', [
    q('2025-06-30', 100 * CR, 8 * CR, 10 * CR),
    q('2026-06-30', 130 * CR, 20 * CR, 26 * CR),
  ]);
  const narrowing = computeGrowth('N', [
    q('2025-06-30', 100 * CR, 18 * CR, 24 * CR),
    q('2026-06-30', 130 * CR, 8 * CR, 10 * CR),
  ]);
  const w = scoreProfitability(widening);
  const n = scoreProfitability(narrowing);
  assert.ok(w.score > n.score, `${w.score} > ${n.score}`);
  assert.match(w.detail, /wider/);
  assert.match(n.detail, /narrower/);
  assert.equal(scoreProfitability(computeGrowth('E', [])).score, 0);
});

test('the weights put profitability and acceleration ahead of the story', () => {
  // Corrected 2026-09-11: order flow was 0.34 and graded A on a misreading of
  // Rajgopal/Shevlin/Venkatachalam, which actually finds the market OVERWEIGHTS
  // backlog. Policy has never had evidence behind it.
  assert.ok(WEIGHTS.profitability > WEIGHTS.orders * 2);
  assert.ok(WEIGHTS.acceleration > WEIGHTS.orders * 2);
  assert.ok(WEIGHTS.policy <= 0.08, 'policy is opinion and must stay near-unweighted');
  const total = Object.values(WEIGHTS).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test('a story with no confirmation is refused however good the story', () => {
  const out = scoreFutureStar({
    orders: {
      symbol: 'X', recent: [], prior: [], recentCount: 8, priorCount: 3, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 5, unpriced: 8,
    },
    growth: computeGrowth('X', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 200 * CR, 30 * CR)]),
    policy: policyFor('BEL'),
    price: price({ aboveSma200: false, pctOf52wRange: 8, ret1yPct: -40 }),
    risks: [],
  });
  assert.ok(out.rejected, 'must be refused');
  assert.match(out.rejected!, /market has not confirmed/);
});

test('an illiquid name is refused before anything else', () => {
  const out = scoreFutureStar({
    orders: {
      symbol: 'X', recent: [], prior: [], recentCount: 8, priorCount: 3, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 5, unpriced: 8,
    },
    growth: computeGrowth('X', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 200 * CR, 30 * CR)]),
    policy: policyFor('BEL'),
    price: price({ medianTurnover: GATES.minTurnover / 2 }),
    risks: [],
  });
  assert.match(out.rejected ?? '', /too thin/);
});

test('risk flags multiply the score down and cannot be outvoted by the story', () => {
  const base = {
    orders: {
      symbol: 'X', recent: [], prior: [], recentCount: 8, priorCount: 3, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 5, unpriced: 8,
    },
    growth: computeGrowth('X', [
      q('2025-06-30', 100 * CR, 10 * CR),
      q('2025-09-30', 110 * CR, 11 * CR),
      q('2026-06-30', 200 * CR, 30 * CR),
      q('2026-09-30', 230 * CR, 36 * CR),
    ]),
    policy: policyFor('BEL'),
    price: price(),
  };
  const clean = scoreFutureStar({ ...base, risks: [] });
  const flagged = scoreFutureStar({
    ...base,
    risks: [{ kind: 'regulatory' as const, detail: 'fine imposed by NSE', severity: 0.4 }],
  });
  assert.ok(flagged.score < clean.score, `${flagged.score} < ${clean.score}`);
});

// ── the plan ──
test('an unfunded idea gets a thesis and no position, never a "buy now" for zero rupees', () => {
  const g = computeGrowth('T', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 150 * CR, 20 * CR)]);
  const plan = buildEntryPlan({
    score: 60,
    verdict: 'stage-in',
    price: price(),
    growth: g,
    orders: {
      symbol: 'T', recent: [], prior: [], recentCount: 3, priorCount: 1, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 20, unpriced: 3,
    },
    params: DEFAULT_PLAN_PARAMS,
    now: NOW,
    budget: null,
    unfundedReason: 'outside the funded set',
  });
  assert.equal(plan.amount, 0);
  assert.match(plan.tranches[0].trigger, /Watchlist only/);
  assert.ok(!/^Now\./.test(plan.tranches[0].trigger));
});

test('a position too small to split is one purchase, and says why', () => {
  const g = computeGrowth('T', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 150 * CR, 20 * CR)]);
  const plan = buildEntryPlan({
    score: 70,
    verdict: 'stage-in',
    // A ₹7,313 share cannot be split across three ₹3,700 tranches.
    price: price({ last: 7313, sma200: 6000, high52w: 8000, low52w: 2000, pctOf52wRange: 81 }),
    growth: g,
    orders: {
      symbol: 'T', recent: [], prior: [], recentCount: 5, priorCount: 7, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 16, unpriced: 5,
    },
    params: DEFAULT_PLAN_PARAMS,
    now: NOW,
    budget: 11_000,
  });
  assert.equal(plan.tranches.length, 1);
  assert.equal(plan.tranches[0].sharePct, 100);
  assert.ok(plan.warnings.some((w) => /Too small to stage/.test(w)));
});

test('a cheap share inside the same budget stages in three', () => {
  const g = computeGrowth('T', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 150 * CR, 20 * CR)]);
  const plan = buildEntryPlan({
    score: 70,
    verdict: 'stage-in',
    price: price({ last: 234, sma200: 200, high52w: 260, low52w: 90, pctOf52wRange: 88 }),
    growth: g,
    orders: {
      symbol: 'T', recent: [], prior: [], recentCount: 10, priorCount: 6, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 10, unpriced: 10,
    },
    params: DEFAULT_PLAN_PARAMS,
    now: NOW,
    budget: 12_000,
  });
  assert.equal(plan.tranches.length, 3);
  assert.equal(plan.tranches.reduce((s, t) => s + t.sharePct, 0), 100);
  assert.ok(plan.tranches.every((t) => t.quantity >= 2));
  // Later tranches are conditional on new evidence, not on a date.
  assert.match(plan.tranches[1].trigger, /quarter is filed/);
  assert.match(plan.tranches[2].trigger, /order win/);
  assert.ok(plan.invalidationPrice !== null && plan.invalidationPrice < 234);
});

test('below the 200-day average nothing is bought today', () => {
  const g = computeGrowth('T', [q('2025-06-30', 100 * CR, 10 * CR), q('2026-06-30', 150 * CR, 20 * CR)]);
  const plan = buildEntryPlan({
    score: 65,
    verdict: 'stage-in',
    price: price({ aboveSma200: false, last: 400, sma200: 450 }),
    growth: g,
    orders: {
      symbol: 'T', recent: [], prior: [], recentCount: 3, priorCount: 1, recentValueInr: 0,
      priorValueInr: 0, valueCoverage: 0, bookToBill: null, daysSinceLast: 20, unpriced: 3,
    },
    params: DEFAULT_PLAN_PARAMS,
    now: NOW,
    budget: 12_000,
  });
  assert.match(plan.tranches[0].trigger, /wait for a close above/i);
  assert.ok(plan.warnings.some((w) => /nothing is bought today/.test(w)));
});

// ── the budget ──
test('the budget funds a few ideas properly rather than all of them badly', () => {
  const ranked = Array.from({ length: 11 }, (_, i) => ({ symbol: `S${i}`, score: 70 - i }));
  const { budgets, funded, note } = fundingPlan(ranked, DEFAULT_PLAN_PARAMS);
  // ₹40,000 cap ÷ ₹15,000 minimum = 2 fundable.
  assert.equal(funded, 2);
  assert.equal(budgets.get('S0'), 20_000);
  assert.equal(budgets.get('S2'), null, 'the rest are watchlist entries');
  assert.match(note, /watchlist entries/);
});

test('with nothing qualifying, no capital is committed', () => {
  const { funded, note } = fundingPlan([], DEFAULT_PLAN_PARAMS);
  assert.equal(funded, 0);
  assert.match(note, /Nothing qualified/);
});

if (failures.length) {
  console.error(`\n✗ futureStars: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ futureStars: ${passed} passed`);

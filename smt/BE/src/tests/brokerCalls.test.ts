/**
 * Broker-call parser tests.
 *
 * Most assertions guard against a WRONG call rather than a missed one: a
 * missed Jefferies note costs the user a line of context, while "Kotak
 * Mahindra Bank shares rise" read as a Kotak buy call is misinformation on
 * the card. The headlines are the shapes the Indian financial press uses.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  dedupeCalls,
  parseBrokerCalls,
  parseTarget,
  searchName,
  searchQuery,
  summarise,
  withUpside,
  type BrokerCall,
} from '../services/recommender/brokerCalls';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

const T = Date.parse('2026-09-20T06:00:00Z');
const H = (title: string, at = T, source = 'Moneycontrol') => ({ title, source, at, url: 'https://x' });
const one = (title: string, company = '', symbol = ''): BrokerCall => {
  const calls = parseBrokerCalls(H(title), company, symbol);
  assert.equal(calls.length, 1, `expected one call from "${title}", got ${calls.length}`);
  return calls[0];
};
const none = (title: string, company = '', symbol = '') =>
  assert.equal(parseBrokerCalls(H(title), company, symbol).length, 0, `expected no call from "${title}"`);

// ── the calls themselves ──

test('an upgrade reads broker, action, the NEW rating and the target', () => {
  const c = one('Jefferies upgrades Tata Motors to buy from hold, raises target to ₹1,200');
  assert.equal(c.broker, 'Jefferies');
  assert.equal(c.action, 'upgrade');
  assert.equal(c.rating, 'buy');
  assert.equal(c.stance, 'bullish');
  assert.equal(c.target, 1200);
});

test('"from X to Y" and "to Y from X" both land on Y', () => {
  assert.equal(one('CLSA downgrades Infosys from outperform to underperform').rating, 'underperform');
  assert.equal(one('CLSA downgrades Infosys to underperform from outperform').rating, 'underperform');
});

test('an initiation with a Buy — the most common shape — is read, not scored as nothing', () => {
  const c = one('Jefferies initiates coverage on Zomato with Buy rating, sees 30% upside');
  assert.equal(c.action, 'initiate');
  assert.equal(c.rating, 'buy');
  assert.equal(c.statedUpsidePct, 30);
});

test('a reiteration with a target is a reiteration', () => {
  const c = one('Morgan Stanley maintains overweight on HDFC Bank, target price Rs 2,050');
  assert.equal(c.broker, 'Morgan Stanley');
  assert.equal(c.action, 'reiterate');
  assert.equal(c.rating, 'overweight');
  assert.equal(c.target, 2050);
});

test('a target cut is a target cut even when the rating is kept', () => {
  const c = one('Nomura cuts target on Asian Paints to ₹2,600, retains neutral');
  assert.equal(c.action, 'target-cut');
  assert.equal(c.rating, 'neutral');
  assert.equal(c.stance, 'neutral');
  assert.equal(c.target, 2600);
});

test('a target raise with "from … to …" takes the new figure', () => {
  assert.equal(parseTarget('Goldman raises Trent target from Rs 5,800 to Rs 7,000'), 7000);
  assert.equal(one('Goldman raises Trent target from Rs 5,800 to Rs 7,000').action, 'target-raise');
});

test('a target written before the word "target" is read', () => {
  assert.equal(parseTarget('Buy BEL, ₹340 target: Motilal Oswal'), 340);
});

test('stated downside is negative', () => {
  assert.equal(one('Macquarie retains underperform on Paytm, sees 25% downside').statedUpsidePct, -25);
});

test('two brokers in one headline are credited to each', () => {
  const calls = parseBrokerCalls(H('Jefferies, CLSA upgrade Bharti Airtel to buy after strong Q1'));
  assert.deepEqual(calls.map((c) => c.broker).sort(), ['CLSA', 'Jefferies']);
  assert.ok(calls.every((c) => c.rating === 'buy' && c.action === 'upgrade'));
});

test('JP Morgan spelled three ways is one broker', () => {
  for (const t of ['JPMorgan upgrades SBI to overweight', 'JP Morgan upgrades SBI to overweight', 'J.P. Morgan upgrades SBI to overweight']) {
    assert.equal(one(t).broker, 'JPMorgan', t);
  }
});

// ── the false positives ──

test('a BANK sharing a brokerage name is not a broker', () => {
  none('Kotak Mahindra Bank shares rise 3% after strong Q2 loan growth');
  none('ICICI Bank to buy stake in fintech startup');
  none('HDFC Bank upgrades mobile app for retail customers');
  none('Axis Bank board approves fund raise; target to grow deposits');
});

test('the brokerage ARM of a bank is a broker', () => {
  assert.equal(one('Kotak Institutional Equities upgrades Maruti to add').broker, 'Kotak Institutional Equities');
  assert.equal(one('ICICI Securities initiates coverage on Nykaa with buy').broker, 'ICICI Securities');
});

test('a broker that IS the covered company is not a call on itself', () => {
  none('Motilal Oswal Financial shares jump 8% to record high; target raised by board', 'Motilal Oswal Financial Services Ltd');
});

test('a broker name with no call attached is not a call', () => {
  none("Jefferies' Chris Wood trims India weight in Asia portfolio");
  none('Goldman Sachs sells 2% stake in ABC via block deal');
});

test('"hold" in ordinary English is not a hold rating', () => {
  // The upgrade is real; "hold" here is a verb about promoters, not a rating.
  const c = one('Jefferies upgrades ITC as promoters hold firm on stake');
  assert.equal(c.rating, null);
  assert.equal(c.action, 'upgrade');
});

test('an explainer listing every rating yields no rating rather than a guess', () => {
  const calls = parseBrokerCalls(H('Buy, sell or hold? What Jefferies and CLSA say on Reliance after Q2'));
  assert.ok(calls.every((c) => c.rating === null), `got ${calls.map((c) => c.rating).join(',')}`);
});

test('"outperforms" and "underperforms" as verbs are not ratings', () => {
  none('Nifty underperforms as FIIs sell; Jefferies notes caution');
});

// ── attribution: is the call about THIS company? (live headlines, 2026-09-22) ──

const TM = 'Tata Motors Passenger Vehicles Limited';

test('NSE master names are cleaned to what headlines say', () => {
  assert.equal(searchName('HDFC Bank Limited'), 'HDFC Bank');
  assert.equal(searchName('ETERNAL LIMITED'), 'Eternal');
  assert.equal(searchName('State Bank of India'), 'State Bank of India');
});

test('the search covers the names headlines actually use', () => {
  assert.equal(searchQuery('Tata Consultancy Services Limited', 'TCS'), '("Tata Consultancy Services" OR "Tata Consultancy" OR TCS)');
  assert.equal(searchQuery('HDFC Bank Limited', 'HDFCBANK'), '"HDFC Bank"', 'a squashed symbol is never written');
  assert.equal(searchQuery('Mahindra & Mahindra Limited', 'M&M'), '("Mahindra & Mahindra" OR "M&M")');
  assert.equal(searchQuery('Bank of Baroda', 'BANKBARODA'), '"Bank of Baroda"', 'no "Bank of" alias');
});

test('title-case commas are not a list of picks', () => {
  const c = one("L&T Gearing For Growth, Valuation Attractive, Says JPMorgan; Maintains 'Overweight'", 'Larsen & Toubro Limited', 'LT');
  assert.equal(c.basket, false);
  assert.equal(c.rating, 'overweight');
});

test('a call on a SIBLING company is not credited to this one', () => {
  none("Tata Capital shares: Systematix retains 'Buy'; sees scope for valuation gap to narrow; check target", TM, 'TMPV');
  none("Tata Tech Receives A 'Sell' From Goldman Sachs — Check Target Price, Downside", TM, 'TMPV');
  none('M&M Share Price in Focus as Nomura Retains Buy Alongside Hyundai and TVS Motor on Strong August Volumes', TM, 'TMPV');
});

test('a group name extended into a sibling company ("Tata Motors Finance", "L&T Finance") is not a mention', () => {
  none('Tata Capital shares: Nuvama ups target price; says Tata Motors Finance drag largely behind', TM, 'TMPV');
  none("NBFC Stocks To Buy: Bajaj Finance, L&T Finance, PNB Housing Finance Among Motilal Oswal's Top Picks", 'Larsen & Toubro Limited', 'LT');
  // …while the company's own suffixes and abbreviations still count.
  assert.equal(one('Jefferies upgrades Tata Motors PV to buy', TM, 'TMPV').broker, 'Jefferies');
  assert.equal(one('Jefferies upgrades Bajaj Finance to buy', 'Bajaj Finance Limited', 'BAJFINANCE').rating, 'buy');
});

test('"Maintaining \'Hold\'" is a reiteration', () => {
  const c = one("TCS-Porsche Deal Strengthens Europe Play, Says Systematix Maintaining 'Hold'", 'Tata Consultancy Services Limited', 'TCS');
  assert.equal(c.action, 'reiterate');
  assert.equal(c.rating, 'hold');
});

test('a call naming the company by its short name is credited', () => {
  const c = one('Buy Tata Motors; target of Rs 482: Geojit Financial Services', TM, 'TMPV');
  assert.equal(c.broker, 'Geojit');
  assert.equal(c.rating, 'buy');
  assert.equal(c.target, 482);
});

test('"L&T" and the symbol both identify their company', () => {
  assert.equal(one('Jefferies upgrades L&T to buy', 'Larsen & Toubro Limited', 'LT').broker, 'Jefferies');
  assert.equal(one('CLSA downgrades TCS to sell', 'Tata Consultancy Services Limited', 'TCS').rating, 'sell');
});

test('a list of picks is tagged as a basket, not a single-stock call', () => {
  const c = one('Axis Securities Top Picks: Bharti Airtel Tops List Of 15 Stocks To Buy — Check Full List', 'Bharti Airtel Limited');
  assert.equal(c.basket, true);
  assert.equal(one('TCS, Infosys, HCL Tech Maintained At Hold By CLSA As WTI Falls Below $100', 'Infosys Limited').basket, true);
  assert.equal(one('UBS Retains \'Buy\' For HDFC Bank Stock; Target Price At Rs 1,000', 'HDFC Bank Limited').basket, false);
});

test('two brokers in one headline: the target goes to the one it sits next to', () => {
  const calls = parseBrokerCalls(H('Weekly Recap: JPMorgan Neutral ₹1,050 target and INFY 4th in CLSA AI'), 'Infosys Limited', 'INFY');
  assert.deepEqual(calls.map((c) => c.broker), ['JPMorgan']);
});

test('the "Buy, Sell or Hold:" column prefix is not an explainer', () => {
  const t = 'Buy, Sell or Hold: Goldman Sachs maintains buy Solar Industries; Morgan Stanley retains Equal Weight on Tata Motors';
  const tm = parseBrokerCalls(H(t), TM, 'TMPV');
  assert.equal(tm.length, 1);
  assert.equal(tm[0].broker, 'Morgan Stanley');
  assert.equal(tm[0].rating, 'equal-weight');
  const solar = parseBrokerCalls(H(t), 'Solar Industries India Limited', 'SOLARINDS');
  assert.deepEqual(solar.map((c) => [c.broker, c.rating]), [['Goldman Sachs', 'buy']]);
});

test('conflicting ratings in one clause resolve to the one beside the company', () => {
  const t = "Jefferies sees CAS proposals easing uncertainty; maintains 'BUY' on Groww, 'Underperform' on BSE";
  assert.equal(parseBrokerCalls(H(t), 'BSE Limited', 'BSE')[0]?.rating, 'underperform');
});

test('a list mention is shown but not counted in the stance tally', () => {
  const calls = dedupeCalls([
    ...parseBrokerCalls(H('Axis Securities Top Picks: Bharti Airtel Tops List Of 15 Stocks To Buy'), 'Bharti Airtel Limited'),
    ...parseBrokerCalls(H('Jefferies downgrades Bharti Airtel to hold'), 'Bharti Airtel Limited'),
  ]);
  const s = summarise(calls, 30);
  assert.equal(s.calls.length, 2);
  assert.equal(s.bullish, 0);
  assert.equal(s.neutral, 1);
  assert.match(s.note, /1 more only in a list/);
});

// ── dedupe, upside, summary ──

test('five outlets carrying the same note are one call with four echoes', () => {
  const titles = [
    'Jefferies upgrades Tata Motors to buy, target ₹1,200',
    'Jefferies upgrades Tata Motors to buy; sets target price of Rs 1,200',
    'Tata Motors: Jefferies upgrades to buy',
    'Jefferies turns bullish, upgrades Tata Motors to buy',
    'Jefferies upgrades Tata Motors to buy with target Rs 1200',
  ];
  const calls = dedupeCalls(titles.flatMap((t, i) => parseBrokerCalls(H(t, T - i * 3_600_000))));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].echoes, 5);
  assert.equal(calls[0].target, 1200);
});

test('a later call from the same broker a month on is a separate call', () => {
  const calls = dedupeCalls([
    ...parseBrokerCalls(H('CLSA upgrades Infosys to buy', T)),
    ...parseBrokerCalls(H('CLSA downgrades Infosys to sell', T + 25 * 86_400_000)),
  ]);
  assert.equal(calls.length, 2);
});

test('upside is measured against the last close', () => {
  const [c] = withUpside(parseBrokerCalls(H('Jefferies upgrades Tata Motors to buy, target ₹1,200')), 1000);
  assert.ok(Math.abs(c.upsidePct! - 20) < 1e-9);
});

test('a target wildly off the price is dropped as a misparse, not shown as 400% upside', () => {
  const calls = parseBrokerCalls(H('Jefferies upgrades X to buy, target ₹25,000'));
  const [c] = withUpside(calls, 10_000);
  assert.equal(c.target, 25_000, 'a 2.5× target is aggressive but plausible — kept');
  const [d] = withUpside(calls, 5_000);
  assert.equal(d.target, null, 'a 5× target is a misparse — dropped');
  assert.equal(d.upsidePct, null);
});

test('the summary counts BROKERS by their latest call, not headlines', () => {
  const calls = dedupeCalls([
    ...parseBrokerCalls(H('CLSA upgrades Infosys to buy', T - 20 * 86_400_000)),
    ...parseBrokerCalls(H('CLSA downgrades Infosys to sell', T)),
    ...parseBrokerCalls(H('Jefferies maintains buy on Infosys, target Rs 2,100', T)),
    ...parseBrokerCalls(H('Jefferies maintains buy on Infosys with target of Rs 2,100', T - 3_600_000)),
  ]);
  const s = summarise(calls, 30);
  assert.equal(s.bullish, 1, 'Jefferies');
  assert.equal(s.bearish, 1, 'CLSA — its latest call, not the older upgrade');
  assert.match(s.note, /2 brokers/);
  assert.match(s.note, /not used in the ranking/);
});

if (failures.length) {
  console.error(`✗ brokerCalls: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ brokerCalls: ${passed} passed`);

/**
 * Yahoo feed: parser, symbol mapping, tracked-set derivation.
 *
 * All pure — no network. The one network-dependent behaviour (a failed fetch
 * marks a symbol unpriced instead of leaving a seeded placeholder) is covered by
 * `npm run verify:feed` against a running server.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { YahooError, parseYahooChart, yahooSymbol } from '../services/yahoo';
import { trackedSymbols } from '../services/YahooFeed';

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

const T0 = 1_757_309_100; // 2026-09-08 03:45:00Z = 09:15 IST
const body = {
  chart: {
    result: [
      {
        meta: { symbol: 'RELIANCE.NS', currency: 'INR', exchangeName: 'NSI', regularMarketPrice: 2951.25 },
        timestamp: [T0, T0 + 60, T0 + 120, T0 + 180],
        indicators: {
          quote: [
            {
              open: [2950, 2951, null, 2953],
              high: [2952, 2953, 2954, 2955],
              low: [2949, 2950, 2951, 2952],
              close: [2951, 2952, 2953, 2954],
              volume: [100, 200, 300, 400],
            },
          ],
        },
      },
    ],
  },
};

// ─── symbol mapping ───────────────────────────────────────────────────────
test('stocks and ETFs map to .NS; indices map to their Yahoo codes', () => {
  assert.equal(yahooSymbol('RELIANCE'), 'RELIANCE.NS');
  assert.equal(yahooSymbol('niftybees'), 'NIFTYBEES.NS');
  assert.equal(yahooSymbol('NIFTY'), '^NSEI');
  assert.equal(yahooSymbol('BANKNIFTY'), '^NSEBANK');
  assert.equal(yahooSymbol('SENSEX'), '^BSESN');
  assert.equal(yahooSymbol('TCS.NS'), 'TCS.NS', 'already suffixed is left alone');
  assert.equal(yahooSymbol('^NSEI'), '^NSEI');
});

// ─── parser ───────────────────────────────────────────────────────────────
test('parses bars into our Candle shape with ms timestamps', () => {
  const c = parseYahooChart(body, 'RELIANCE');
  assert.equal(c.symbol, 'RELIANCE.NS');
  assert.equal(c.regularMarketPrice, 2951.25);
  assert.equal(c.candles[0].symbol, 'RELIANCE');
  assert.equal(c.candles[0].timestamp, T0 * 1000);
  assert.equal(c.candles[0].close, 2951);
  assert.equal(c.candles[0].volume, 100);
});

test('drops a bar with a null in OHLC instead of inventing one', () => {
  const c = parseYahooChart(body, 'RELIANCE');
  assert.equal(c.candles.length, 3);
  assert.equal(c.dropped, 1);
  assert.deepEqual(c.candles.map((x) => x.close), [2951, 2952, 2954]);
});

test('bars come back sorted and de-duplicated by timestamp', () => {
  const shuffled = JSON.parse(JSON.stringify(body));
  shuffled.chart.result[0].timestamp = [T0 + 180, T0, T0 + 60, T0 + 60];
  shuffled.chart.result[0].indicators.quote[0] = {
    open: [1, 1, 1, 1], high: [2, 2, 2, 2], low: [1, 1, 1, 1], close: [9, 1, 2, 3], volume: [0, 0, 0, 0],
  };
  const c = parseYahooChart(shuffled, 'X');
  assert.deepEqual(c.candles.map((x) => x.timestamp), [T0 * 1000, (T0 + 60) * 1000, (T0 + 180) * 1000]);
  assert.equal(c.candles[1].close, 3, 'the later duplicate wins');
});

test('throws on an error payload or a missing result, never returns fake data', () => {
  assert.throws(() => parseYahooChart({ chart: { error: { code: 'Not Found' } } }, 'X'), YahooError);
  assert.throws(() => parseYahooChart({ chart: { result: [] } }, 'X'), YahooError);
  assert.throws(() => parseYahooChart(null, 'X'), YahooError);
});

test('a payload with no bars yields zero candles, not a crash', () => {
  const c = parseYahooChart({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}] } }] } }, 'X');
  assert.equal(c.candles.length, 0);
  assert.equal(c.regularMarketPrice, null);
});

// ─── tracked set ──────────────────────────────────────────────────────────
test('tracked set is the union of seeds, books and enabled strategies, upper-cased, sorted, deduped', () => {
  const t = trackedSymbols(
    ['RELIANCE', 'tcs'],
    [{ symbol: 'syrma' }, { symbol: 'TCS' }],
    [{ symbols: ['INFY', ' sci '] }, { symbols: [] }],
  );
  assert.deepEqual(t, ['INFY', 'RELIANCE', 'SCI', 'SYRMA', 'TCS']);
});

test('blank symbols are ignored', () => {
  assert.deepEqual(trackedSymbols(['', '  '], [{ symbol: '' }], []), []);
});

test('the quote carries the exchange print time, so a frozen feed reads as stale', () => {
  const withTime = { chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: 1_790_000_000 }, timestamp: [], indicators: { quote: [{}] } }] } };
  assert.equal(parseYahooChart(withTime, 'X').quoteTime, 1_790_000_000_000);
  const without = { chart: { result: [{ meta: { regularMarketPrice: 100 }, timestamp: [], indicators: { quote: [{}] } }] } };
  assert.equal(parseYahooChart(without, 'X').quoteTime, null);
});

if (failures.length) {
  console.error(`✗ yahoo: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ yahoo: ${passed} passed`);

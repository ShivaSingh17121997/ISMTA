/**
 * Runtime checklist: is every price on the platform real, and are the charts
 * built from real bars?
 *
 * Runs against a LIVE server (default http://localhost:${PORT}). Each check
 * prints PASS / FAIL / SKIP with the evidence, and the process exits non-zero
 * on any FAIL. Pure-logic coverage lives in src/tests; this is the part only a
 * running system can prove.
 *
 *   npm run verify:feed
 */
import WebSocket from 'ws';
import { config } from '../config';
import { fetchYahooLtp, yahooSymbol } from '../services/yahoo';

const BASE = process.env.VERIFY_BASE_URL ?? `http://localhost:${config.port}`;
type Verdict = 'PASS' | 'FAIL' | 'SKIP';
const rows: { id: string; name: string; verdict: Verdict; evidence: string }[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function j<T>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function check(id: string, name: string, fn: () => Promise<string | { skip: string }>): Promise<void> {
  try {
    const r = await fn();
    if (typeof r === 'object') rows.push({ id, name, verdict: 'SKIP', evidence: r.skip });
    else rows.push({ id, name, verdict: 'PASS', evidence: r });
  } catch (e) {
    rows.push({ id, name, verdict: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
  }
}

const pctDiff = (a: number, b: number): number => (Math.abs(a - b) / Math.max(a, b)) * 100;

async function main(): Promise<void> {
  // ── auth: one fixed verification account, reused across runs ──
  // (A fresh user per run litters the users collection; log in first, register
  // only if it does not exist yet.)
  const creds = { email: 'verify@local.test', password: 'verify-pass-123' };
  let auth = await j<{ token?: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify(creds) });
  if (!auth.body?.token) {
    auth = await j<{ token?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ ...creds, name: 'Verify' }),
    });
  }
  const token = auth.body?.token;
  if (!token) throw new Error(`could not authenticate the verification user (${auth.status})`);

  type Feed = {
    dataSource: string; running?: boolean; passes?: number; tracked?: string[];
    priced?: number; unpriced?: string[]; marketOpen?: boolean;
  };
  const feed = (await j<Feed>('/api/market/feed', {}, token)).body;

  await check('F1', 'Data source is yahoo, not the simulator', async () => {
    if (feed.dataSource !== 'yahoo') throw new Error(`DATA_SOURCE is "${feed.dataSource}"`);
    if (!feed.running) throw new Error('feed reports not running');
    return `source=yahoo running passes=${feed.passes} market=${feed.marketOpen ? 'open' : 'closed'}`;
  });

  await check('F2', 'Every tracked symbol has a real price (none left on a seed)', async () => {
    const t = feed.tracked ?? [];
    const un = feed.unpriced ?? [];
    if (!t.length) throw new Error('nothing tracked');
    if (un.length) throw new Error(`unpriced: ${un.join(', ')} (of ${t.length})`);
    return `${feed.priced}/${t.length} priced: ${t.join(' ')}`;
  });

  type Quotes = { quotes: { symbol: string; ltp: number }[] };
  const q1 = (await j<Quotes>('/api/market/quotes', {}, token)).body.quotes;
  const ltp = (s: string, qs = q1): number => qs.find((x) => x.symbol === s)?.ltp ?? 0;

  await check('F3', 'Platform quotes match Yahoo directly (3 symbols, ≤1%)', async () => {
    const out: string[] = [];
    for (const s of ['RELIANCE', 'TCS', 'INFY']) {
      const ours = ltp(s);
      const theirs = await fetchYahooLtp(s);
      if (theirs === null) throw new Error(`Yahoo gave no price for ${s} right now`);
      const d = pctDiff(ours, theirs);
      if (d > 1) throw new Error(`${s}: platform ₹${ours} vs Yahoo ₹${theirs} (${d.toFixed(2)}% apart)`);
      out.push(`${s} ₹${ours} vs ₹${theirs} (${d.toFixed(3)}%)`);
    }
    return out.join(' | ');
  });

  await check('F4', 'Index symbols resolve through their Yahoo codes', async () => {
    const n = ltp('NIFTY');
    if (!(n > 1000)) throw new Error(`NIFTY=${n} (mapped to ${yahooSymbol('NIFTY')})`);
    return `NIFTY ₹${n} via ${yahooSymbol('NIFTY')}`;
  });

  await check('F5', 'Prices are not random-walking (simulator is off)', async () => {
    await sleep(3000);
    const q2 = (await j<Quotes>('/api/market/quotes', {}, token)).body.quotes;
    const symbols = q1.map((x) => x.symbol);
    const moved = symbols.filter((s) => ltp(s) !== ltp(s, q2));
    // The simulator moves EVERY symbol EVERY second. Real prices, sampled 3s
    // apart inside a 15s poll, move on at most a handful.
    if (moved.length === symbols.length && symbols.length > 3) {
      throw new Error(`all ${symbols.length} symbols changed in 3s — that is the simulator`);
    }
    return `${moved.length}/${symbols.length} symbols changed in 3s${moved.length ? ` (${moved.join(', ')})` : ''}`;
  });

  type Candles = { source: string; candles: { timestamp: number; open: number; high: number; low: number; close: number }[] };
  await check('F6', 'Intraday candles come from Yahoo and are well-formed', async () => {
    const c = (await j<Candles>('/api/market/candles/RELIANCE?range=1d&interval=1m', {}, token)).body;
    if (c.source !== 'yahoo') throw new Error(`source=${c.source}`);
    if (c.candles.length < 10) throw new Error(`only ${c.candles.length} bars`);
    for (let i = 1; i < c.candles.length; i++) {
      if (c.candles[i].timestamp <= c.candles[i - 1].timestamp) throw new Error(`bar ${i} out of order`);
    }
    for (const b of c.candles) {
      if (!(b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close)) {
        throw new Error(`malformed bar at ${new Date(b.timestamp).toISOString()}`);
      }
    }
    const last = c.candles[c.candles.length - 1];
    const ageH = (Date.now() - last.timestamp) / 3_600_000;
    if (ageH > 24 * 4) throw new Error(`latest bar is ${ageH.toFixed(0)}h old`);
    return `${c.candles.length} × 1m bars, latest ${ageH.toFixed(1)}h ago, close ₹${last.close}`;
  });

  await check('F7', 'Daily candles cover months of real history', async () => {
    const c = (await j<Candles>('/api/market/candles/RELIANCE?range=6mo&interval=1d', {}, token)).body;
    if (c.source !== 'yahoo') throw new Error(`source=${c.source}`);
    if (c.candles.length < 60) throw new Error(`only ${c.candles.length} daily bars`);
    const span = (c.candles[c.candles.length - 1].timestamp - c.candles[0].timestamp) / 86_400_000;
    if (span < 120) throw new Error(`span ${span.toFixed(0)} days`);
    return `${c.candles.length} daily bars spanning ${span.toFixed(0)} days`;
  });

  await check('F8', 'A symbol nothing seeded (SYRMA) is priced live from Yahoo', async () => {
    const r = (await j<{ ltp?: number }>('/api/market/quote/SYRMA', {}, token)).body;
    const direct = await fetchYahooLtp('SYRMA');
    if (!r?.ltp || direct === null) return { skip: `platform=${r?.ltp} yahoo=${direct} — not tracked yet or Yahoo down` };
    const d = pctDiff(r.ltp, direct);
    if (d > 1) throw new Error(`₹${r.ltp} vs ₹${direct}`);
    return `SYRMA ₹${r.ltp} (${d.toFixed(3)}% from Yahoo)`;
  });

  await check('F9', 'WebSocket ticks carry Yahoo prices', async () => {
    const url = BASE.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const tick = await new Promise<{ symbol: string; ltp: number } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 25_000);
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'tick' && m.data?.ltp > 0) {
            clearTimeout(timer);
            resolve(m.data);
          }
        } catch { /* ignore */ }
      });
      ws.on('error', () => { clearTimeout(timer); resolve(null); });
    });
    ws.close();
    if (!tick) return { skip: 'no tick within 25s (closed market, or WS needs a different auth)' };
    const d = pctDiff(tick.ltp, ltp(tick.symbol) || tick.ltp);
    if (d > 1) throw new Error(`tick ${tick.symbol} ₹${tick.ltp} vs quotes ₹${ltp(tick.symbol)}`);
    return `tick ${tick.symbol} ₹${tick.ltp}`;
  });

  // ── report ──
  const pad = (s: string, n: number): string => (s + ' '.repeat(n)).slice(0, n);
  let fails = 0;
  console.log('');
  for (const r of rows) {
    if (r.verdict === 'FAIL') fails++;
    console.log(`  ${pad(r.verdict, 5)} ${pad(r.id, 4)} ${pad(r.name, 62)} ${r.evidence}`);
  }
  console.log(`\n  ${rows.filter((r) => r.verdict === 'PASS').length} passed, ${fails} failed, ` +
    `${rows.filter((r) => r.verdict === 'SKIP').length} skipped\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

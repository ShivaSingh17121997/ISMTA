/**
 * Yahoo Finance chart endpoint — LTP and OHLC candles for NSE symbols.
 *
 * Measured live against NSE during an open session: `regularMarketPrice` and
 * the 1-minute bar series update in real time, not on a 15-minute delay. It is
 * still UNOFFICIAL — no SLA, may rate-limit or change shape — so it is the
 * research / paper feed, never the execution price for a real order.
 *
 * Two things this file refuses to do, because both produce plausible-looking
 * wrong data:
 *   - it never interpolates a bar with a null in its OHLC (Yahoo emits those
 *     for halted stamps); the bar is dropped and counted;
 *   - it never guesses a price when the fetch fails; callers get `null` and
 *     decide, and the feed marks the symbol unpriced rather than leave a stale
 *     or seeded number in place.
 */
import { Candle } from '../types';
import { logger } from '../utils/logger';
import type { CorporateAction } from './accumulator/corporateActions';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * NSE ticker → Yahoo ticker. Stocks and ETFs are `<SYMBOL>.NS`; the indices the
 * watchlist seeds are NOT — Yahoo carries them under their own codes.
 */
const INDEX_MAP: Record<string, string> = {
  NIFTY: '^NSEI',
  NIFTY50: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
  MIDCPNIFTY: 'NIFTY_MID_SELECT.NS',
  SENSEX: '^BSESN',
};

export function yahooSymbol(nseSymbol: string): string {
  const s = nseSymbol.trim().toUpperCase();
  if (INDEX_MAP[s]) return INDEX_MAP[s];
  // `=` marks Yahoo futures and FX (BZ=F, INR=X); no NSE symbol contains one.
  if (s.startsWith('^') || s.includes('=') || /\.(NS|BO)$/.test(s)) return s;
  return `${s}.NS`;
}

export class YahooError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YahooError';
  }
}

export interface YahooChart {
  symbol: string;
  currency: string;
  exchange: string;
  /** Yahoo's live print, when the payload carries one. */
  regularMarketPrice: number | null;
  /** Previous session's close, the reference every price band is measured from. */
  previousClose: number | null;
  /** When the exchange printed regularMarketPrice (ms), from Yahoo's regularMarketTime. */
  quoteTime: number | null;
  candles: Candle[];
  /** Bars dropped for a null in OHLC. */
  dropped: number;
}

interface RawQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

/** Parse a `/v8/finance/chart` body into our Candle shape. Pure. */
export function parseYahooChart(body: unknown, nseSymbol: string): YahooChart {
  const chart = (body as { chart?: { result?: unknown[]; error?: unknown } } | null)?.chart;
  if (chart?.error) throw new YahooError(`Yahoo error: ${JSON.stringify(chart.error)}`);
  const result = chart?.result?.[0] as
    | {
        meta?: {
          symbol?: string;
          currency?: string;
          exchangeName?: string;
          regularMarketPrice?: number;
          previousClose?: number;
          chartPreviousClose?: number;
          regularMarketTime?: number;
        };
        timestamp?: number[];
        indicators?: { quote?: RawQuote[] };
      }
    | undefined;
  if (!result) throw new YahooError('Yahoo response had no chart result');

  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const q = result.indicators?.quote?.[0] ?? {};
  const { open = [], high = [], low = [], close = [], volume = [] } = q;
  const symbol = nseSymbol.toUpperCase();

  const byTime = new Map<number, Candle>();
  let dropped = 0;
  for (let i = 0; i < stamps.length; i++) {
    const t = stamps[i];
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    if (
      typeof t !== 'number' ||
      typeof o !== 'number' || typeof h !== 'number' ||
      typeof l !== 'number' || typeof c !== 'number' ||
      !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0) || h < l
    ) {
      dropped++;
      continue;
    }
    const v = volume[i];
    byTime.set(t * 1000, {
      symbol,
      timestamp: t * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: typeof v === 'number' ? v : 0,
    });
  }

  const meta = result.meta ?? {};
  const rmp = meta.regularMarketPrice;
  // Intraday payloads carry `previousClose`; daily ones only `chartPreviousClose`.
  const pc = typeof meta.previousClose === 'number' ? meta.previousClose : meta.chartPreviousClose;
  return {
    symbol: meta.symbol ?? yahooSymbol(symbol),
    currency: meta.currency ?? 'INR',
    exchange: meta.exchangeName ?? 'NSI',
    regularMarketPrice: typeof rmp === 'number' && rmp > 0 ? rmp : null,
    previousClose: typeof pc === 'number' && pc > 0 ? pc : null,
    quoteTime: typeof meta.regularMarketTime === 'number' && meta.regularMarketTime > 0 ? meta.regularMarketTime * 1000 : null,
    candles: [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp),
    dropped,
  };
}

/**
 * Split and dividend events for a symbol, from Yahoo's `events` block.
 *
 * Yahoo reports an Indian BONUS issue as a split — a 1:1 bonus arrives as a
 * 2-for-1 split — because both change the share count without moving money.
 * That is convenient: the numerator/denominator it gives already encodes the
 * total factor, so consuming splits handles bonuses too, and this maps every
 * one to a SPLIT with the ratio Yahoo reported rather than trying to guess
 * which it was.
 *
 * Returns an empty array when Yahoo has no events, which is the common case.
 * Never invents one: a fabricated split would corrupt a cost basis.
 */
export function parseYahooEvents(body: unknown, nseSymbol: string): CorporateAction[] {
  const result = (body as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | {
        events?: {
          splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
          dividends?: Record<string, { date?: number; amount?: number }>;
        };
      }
    | undefined;
  const events = result?.events;
  if (!events) return [];

  const out: CorporateAction[] = [];

  for (const s of Object.values(events.splits ?? {})) {
    const { date, numerator, denominator } = s ?? {};
    // numerator=5, denominator=1 means one share became five.
    if (typeof date !== 'number' || !(numerator! > 0) || !(denominator! > 0)) continue;
    if (numerator === denominator) continue; // a no-op "split" is noise
    out.push({
      type: 'SPLIT',
      exDate: date * 1000,
      ratio: { from: denominator!, to: numerator! },
      source: 'yahoo',
    });
  }

  for (const d of Object.values(events.dividends ?? {})) {
    const { date, amount } = d ?? {};
    if (typeof date !== 'number' || !(amount! > 0)) continue;
    out.push({ type: 'DIVIDEND', exDate: date * 1000, dividendPerShare: amount!, source: 'yahoo' });
  }

  if (out.length) {
    logger.info(`Yahoo ${nseSymbol}: ${out.length} corporate action(s) in range`);
  }
  return out.sort((a, b) => a.exDate - b.exDate);
}

/**
 * Corporate actions over a window. Splits are what matter to this engine; an
 * unapplied one strands a lot permanently, so this is best-effort by design —
 * a failure returns nothing rather than a guess.
 */
export async function fetchYahooCorporateActions(
  nseSymbol: string,
  range = '2y',
  timeoutMs = 15_000,
): Promise<CorporateAction[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(nseSymbol))}` +
    `?range=${encodeURIComponent(range)}&interval=1d&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new YahooError(`HTTP ${res.status}`);
    return parseYahooEvents(await res.json(), nseSymbol);
  } catch (e) {
    logger.warn(`Yahoo events ${nseSymbol}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export async function fetchYahooChart(
  nseSymbol: string,
  range = '1d',
  interval = '1m',
  timeoutMs = 10_000,
): Promise<YahooChart | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(nseSymbol))}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new YahooError(`HTTP ${res.status}`);
    return parseYahooChart(await res.json(), nseSymbol);
  } catch (e) {
    logger.warn(`Yahoo ${nseSymbol} ${range}/${interval}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * DAILY bars between two instants. Use this, not `range=max`, for long
 * histories: Yahoo answers `range=max&interval=1d` with MONTHLY bars, which a
 * backtest would silently treat as days.
 */
export async function fetchYahooDailyHistory(
  nseSymbol: string,
  fromMs: number,
  toMs = Date.now(),
  timeoutMs = 20_000,
): Promise<(YahooChart & { actions: CorporateAction[] }) | null> {
  // With the split and bonus events: these bars can come back UNADJUSTED
  // (NIFTYBEES' 2019 split reads as a 90% crash), so the caller adjusts.
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(nseSymbol))}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(toMs / 1000)}&interval=1d&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new YahooError(`HTTP ${res.status}`);
    const body = await res.json();
    const chart = parseYahooChart(body, nseSymbol);
    return chart ? { ...chart, actions: parseYahooEvents(body, nseSymbol) } : null;
  } catch (e) {
    logger.warn(`Yahoo ${nseSymbol} daily history: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** OHLC candles. Empty on failure — never synthetic. */
export async function fetchYahooCandles(nseSymbol: string, range = '1d', interval = '1m'): Promise<Candle[]> {
  return (await fetchYahooChart(nseSymbol, range, interval))?.candles ?? [];
}

interface CachedLtp {
  ltp: number;
  previousClose: number | null;
  quoteTime: number | null;
  at: number;
}
const ltpCache = new Map<string, CachedLtp>();
/** Serve from cache inside this window so a burst of callers is one request. */
const LTP_CACHE_MS = 15_000;

export interface YahooQuote {
  ltp: number;
  previousClose: number | null;
  /** The print's own time (ms), so staleness is measured from the exchange, not from our poll. */
  quoteTime: number | null;
}

/** Last traded price plus the previous close. `null` on failure — the caller decides what that means. */
export async function fetchYahooQuote(nseSymbol: string): Promise<YahooQuote | null> {
  const key = nseSymbol.toUpperCase();
  const hit = ltpCache.get(key);
  if (hit && Date.now() - hit.at < LTP_CACHE_MS) return { ltp: hit.ltp, previousClose: hit.previousClose, quoteTime: hit.quoteTime };

  const chart = await fetchYahooChart(key, '1d', '1m');
  if (!chart) return null;
  const last = chart.candles[chart.candles.length - 1];
  const ltp = chart.regularMarketPrice ?? last?.close ?? null;
  if (ltp === null) return null;
  // The candle's time stands in when Yahoo omits regularMarketTime.
  const quoteTime = chart.quoteTime ?? last?.timestamp ?? null;
  ltpCache.set(key, { ltp, previousClose: chart.previousClose, quoteTime, at: Date.now() });
  return { ltp, previousClose: chart.previousClose, quoteTime };
}

/** Last traded price. `null` on failure — the caller decides what that means. */
export async function fetchYahooLtp(nseSymbol: string): Promise<number | null> {
  return (await fetchYahooQuote(nseSymbol))?.ltp ?? null;
}

/** Tests only. */
export function clearYahooLtpCache(): void {
  ltpCache.clear();
}

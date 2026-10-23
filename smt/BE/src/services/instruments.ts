/**
 * NSE listed-company master, stocks and ETFs.
 *
 * Source: NSE's own equity master, `EQUITY_L.csv` — every listed company with
 * symbol, name, series, ISIN, listing date and face value. ~2,500 rows. This is
 * the exchange's list, not a scraped or third-party one.
 *
 * Loaded once at boot (or when the cache is older than a day), parsed here,
 * cached in the store so a restart with NSE unreachable still has a list.
 * nseindia.com fronts some paths with Akamai that 403s datacenter IPs; the
 * archives host has been reachable in practice, and a failure here is
 * non-fatal — the app keeps whatever list it last had.
 *
 * EQUITY_L.csv does not list ETFs. They come from a second file,
 * `eq_etfseclist.csv` (~350 rows). Without it NIFTYBEES and BANKBEES, the only
 * way to hold NIFTY 50 or Bank NIFTY in the cash segment, were refused as
 * "not listed".
 */
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';

export interface Instrument {
  symbol: string;
  name: string;
  /** EQ = normal rolling settlement. BE/BZ = trade-for-trade (delivery only, no intraday). */
  series: string;
  isin: string;
  /** YYYY-MM-DD */
  listedOn: string;
  faceValue: number;
  /** When this row was fetched from NSE. */
  fetchedAt: number;
  /** Absent on rows cached before ETFs were loaded; treat absent as EQUITY. */
  kind?: 'EQUITY' | 'ETF';
  /** ETFs only: what the fund tracks, e.g. "Nifty 50", "Nifty Bank", "GOLD". */
  underlying?: string;
}

const MASTER_URL = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
const ETF_URL = 'https://archives.nseindia.com/content/equities/eq_etfseclist.csv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const STALE_MS = 24 * 3_600_000;

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/**
 * "13-AUG-1997" → "1997-08-13"; the ETF file's "08-Jan-02" → "2002-01-08"
 * (two-digit years: 00–69 are 20xx, NSE opened in 1994). Anything unparseable
 * comes back unchanged.
 */
function isoDate(nse: string): string {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{2}|\d{4})$/.exec(nse.trim().toUpperCase());
  if (!m) return nse.trim();
  const year = m[3].length === 4 ? m[3] : `${Number(m[3]) < 70 ? '20' : '19'}${m[3]}`;
  return `${year}-${MONTHS[m[2]] ?? '01'}-${m[1].padStart(2, '0')}`;
}

/** Split a CSV into non-blank lines, CRLF or LF. */
function csvLines(csv: string): string[] {
  return csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/** Parse the master CSV. Pure — tested without the network. */
export function parseEquityMaster(csv: string, fetchedAt = Date.now()): Instrument[] {
  const lines = csvLines(csv);
  if (lines.length < 2) return [];

  // Header cells carry stray spaces ("NAME OF COMPANY, SERIES, …"); normalise.
  const header = lines[0].split(',').map((h) => h.trim().toUpperCase());
  const col = (name: string): number => header.indexOf(name);
  const iSym = col('SYMBOL');
  const iName = col('NAME OF COMPANY');
  const iSeries = col('SERIES');
  const iListed = col('DATE OF LISTING');
  const iIsin = col('ISIN NUMBER');
  const iFace = col('FACE VALUE');
  if (iSym < 0 || iName < 0) {
    throw new Error(`Unrecognised equity master header: ${lines[0].slice(0, 120)}`);
  }

  const out: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    const symbol = (cells[iSym] ?? '').toUpperCase();
    if (!symbol) continue;
    out.push({
      symbol,
      name: cells[iName] ?? symbol,
      series: (cells[iSeries] ?? 'EQ').toUpperCase(),
      isin: cells[iIsin] ?? '',
      listedOn: isoDate(cells[iListed] ?? ''),
      faceValue: Number(cells[iFace]) || 0,
      fetchedAt,
      kind: 'EQUITY',
    });
  }
  return out;
}

/**
 * Parse NSE's ETF list. Pure — tested without the network.
 *
 * The file has no series column; every ETF trades in EQ series. Its
 * SecurityName is a squashed code ("NIPINDETFNIFTYBEES"), so the name leads
 * with the underlying ("Nifty 50 ETF · …") unless that column already holds
 * the fund's full name. Either way a search for "nifty bank" finds it.
 */
export function parseEtfMaster(csv: string, fetchedAt = Date.now()): Instrument[] {
  const lines = csvLines(csv);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim().toUpperCase());
  const col = (name: string): number => header.indexOf(name);
  const iSym = col('SYMBOL');
  const iAsset = col('UNDERLYING ASSET');
  const iName = col('SECURITYNAME');
  const iListed = col('DATEOFLISTING');
  const iIsin = col('ISINNUMBER');
  const iFace = col('FACEVALUE');
  const iKey = col('UNDERLYING KEY');
  if (iSym < 0 || iAsset < 0) {
    throw new Error(`Unrecognised ETF master header: ${lines[0].slice(0, 120)}`);
  }

  const out: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    const symbol = (cells[iSym] ?? '').toUpperCase();
    if (!symbol) continue;
    const asset = cells[iAsset] ?? '';
    const underlying = (iKey >= 0 && cells[iKey]) || asset;
    out.push({
      symbol,
      name: /\bETF\b/i.test(asset) ? asset : `${asset || underlying} ETF · ${cells[iName] || symbol}`,
      series: 'EQ',
      isin: cells[iIsin] ?? '',
      listedOn: isoDate(cells[iListed] ?? ''),
      faceValue: Number(cells[iFace]) || 0,
      fetchedAt,
      kind: 'ETF',
      underlying,
    });
  }
  return out;
}

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch both lists from NSE and update the cache. The two are independent: a
 * failure of one keeps that half of the cache and still loads the other.
 */
export async function refreshInstruments(): Promise<number> {
  const load = async (label: string, url: string, parse: (csv: string) => Instrument[], min: number) => {
    try {
      const rows = parse(await fetchCsv(url));
      if (rows.length < min) throw new Error(`only ${rows.length} rows — refusing to replace the list`);
      for (const r of rows) store.instruments.set(r.symbol, r);
      logger.info(`Loaded ${rows.length} NSE ${label}`);
    } catch (e) {
      logger.warn(`NSE ${label} list unavailable (${e instanceof Error ? e.message : e}); keeping the cached rows`);
    }
  };
  await load('listed companies', MASTER_URL, parseEquityMaster, 100);
  await load('ETFs', ETF_URL, parseEtfMaster, 50);
  if (store.instruments.size === 0) logger.warn('No instrument list loaded');
  return store.instruments.size;
}

/** Load at boot: hydrate from the store, refresh from NSE if empty, stale, or missing the ETFs. */
export async function ensureInstruments(): Promise<void> {
  const rows = [...store.instruments.values()];
  const newest = rows.reduce((m, i) => Math.max(m, i.fetchedAt), 0);
  // A cache written before ETFs were loaded is fresh but incomplete.
  const hasEtfs = rows.some((i) => i.kind === 'ETF');
  if (rows.length > 0 && hasEtfs && Date.now() - newest < STALE_MS) {
    logger.info(`Using ${rows.length} cached NSE instruments`);
    return;
  }
  await refreshInstruments();
}

/**
 * Search by symbol or company name. Symbol-prefix matches rank first, then
 * name matches, so "sci" gives SCI before "Scientific …".
 */
export function searchInstruments(query: string, limit = 25): Instrument[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const prefix: Instrument[] = [];
  const rest: Instrument[] = [];
  for (const i of store.instruments.values()) {
    if (i.symbol.startsWith(q)) prefix.push(i);
    else if (i.symbol.includes(q) || i.name.toUpperCase().includes(q)) rest.push(i);
    if (prefix.length >= limit) break;
  }
  prefix.sort((a, b) => a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol));
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...rest].slice(0, limit);
}

export function getInstrument(symbol: string): Instrument | undefined {
  return store.instruments.get(symbol.toUpperCase());
}

/** The cost schedule a symbol trades under. Unknown symbols are charged as stocks, the dearer schedule. */
export function instrumentKind(symbol: string): 'EQUITY' | 'ETF' {
  return getInstrument(symbol)?.kind === 'ETF' ? 'ETF' : 'EQUITY';
}

/**
 * Sector and theme classification for NSE stocks.
 *
 * TWO LAYERS, because one is authoritative and one is useful, and they are not
 * the same thing.
 *
 *   SECTOR — NSE's own industry classification, pulled from the free NIFTY 500
 *            constituent file. Twenty buckets, maintained by the exchange, and
 *            the right thing to enforce concentration limits against. This is
 *            fact, not opinion.
 *
 *   THEME  — a curated overlay for the categories people actually think in:
 *            defence, semiconductors, renewable energy, banking, agriculture.
 *            NSE has no such classification. Its taxonomy puts Hindustan
 *            Aeronautics, Bharat Electronics and Syrma SGS in one bucket called
 *            "Capital Goods", which is true and useless — a defence order book,
 *            a defence electronics maker and a contract electronics manufacturer
 *            behave nothing alike.
 *
 * THE THEME MAP IS HAND-WRITTEN AND THEREFORE OPINIONATED. It is labelled that
 * way everywhere it surfaces. A company can carry several themes (Tata Power is
 * both Power and Renewable Energy) because that is how the businesses actually
 * are, and forcing one label would lose the useful half.
 *
 * Concentration limits are enforced on SECTOR, never on theme: sectors are
 * exhaustive and mutually exclusive, themes are neither, so a cap on themes
 * would be arithmetic nonsense.
 */

import { logger } from '../../utils/logger';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const NIFTY500 = 'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv';
/** The constituent list changes on index review, not intraday. */
const TTL_MS = 24 * 3_600_000;

export const UNCLASSIFIED = 'Unclassified';

/**
 * Sectors for symbols the NIFTY 500 file does not carry. Small by design: a
 * long list here means the file is the wrong source, not that it needs patching.
 */
const SECTOR_FALLBACK: Record<string, string> = {
  LTIM: 'Information Technology',
  TMPV: 'Automobile and Auto Components',
  TMCV: 'Automobile and Auto Components',
};

export interface Classification {
  symbol: string;
  /** NSE's own industry. Authoritative; `Unclassified` when the stock is outside the NIFTY 500. */
  sector: string;
  /** Curated, possibly several, possibly none. */
  themes: string[];
}

/**
 * Curated themes. Symbol → themes.
 *
 * Hand-maintained, which means it will drift as companies change. It is here
 * because the alternative is showing a defence order book as "Capital Goods".
 * Entries are grouped by theme for legibility, then inverted at load.
 */
const THEME_MEMBERS: Record<string, string[]> = {
  Defence: ['HAL', 'BEL', 'BHEL', 'BDL', 'MAZDOCK', 'COCHINSHIP', 'DATAPATTNS', 'PARAS', 'ZENTEC', 'MIDHANI'],
  'Semiconductors & Electronics': ['SYRMA', 'DIXON', 'KAYNES', 'CGPOWER', 'AMBER', 'MOSCHIP', 'SPEL', 'TATAELXSI'],
  Banking: [
    'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK', 'BANKBARODA',
    'PNB', 'CANBK', 'FEDERALBNK', 'IDFCFIRSTB', 'AUBANK', 'BANDHANBNK', 'RBLBANK',
  ],
  'Non-bank finance': ['BAJFINANCE', 'BAJAJFINSV', 'SHRIRAMFIN', 'CHOLAFIN', 'MUTHOOTFIN', 'PFC', 'RECLTD', 'LICHSGFIN', 'M&MFIN'],
  Insurance: ['HDFCLIFE', 'SBILIFE', 'ICICIGI', 'ICICIPRULI', 'LICI', 'GICRE', 'NIACL'],
  'Renewable & green energy': ['TATAPOWER', 'NHPC', 'SJVN', 'INOXWIND', 'SUZLON', 'IREDA', 'ADANIGREEN', 'JSWENERGY', 'WAAREEENER', 'PREMIERENE'],
  'Oil & gas': ['RELIANCE', 'ONGC', 'BPCL', 'IOC', 'HINDPETRO', 'GAIL', 'OIL', 'PETRONET', 'IGL', 'MGL'],
  Power: ['NTPC', 'POWERGRID', 'TATAPOWER', 'ADANIPOWER', 'JSWENERGY', 'NHPC', 'SJVN', 'TORNTPOWER'],
  FMCG: ['HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR', 'GODREJCP', 'MARICO', 'TATACONSUM', 'COLPAL', 'VBL', 'EMAMILTD'],
  Automobile: ['MARUTI', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'ASHOKLEY', 'TATAMOTORS', 'TMPV', 'TMCV', 'BOSCHLTD', 'MOTHERSON'],
  'Electric vehicles': ['OLAELEC', 'TVSMOTOR', 'M&M', 'EXIDEIND', 'AMARARAJA', 'ARE&M'],
  Pharma: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'LUPIN', 'AUROPHARMA', 'TORNTPHARM', 'ALKEM', 'ZYDUSLIFE', 'GLENMARK'],
  Healthcare: ['APOLLOHOSP', 'MAXHEALTH', 'FORTIS', 'NARAYANA', 'METROPOLIS', 'LALPATHLAB'],
  'Information technology': ['TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'LTIM', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'LTTS'],
  Infrastructure: ['LT', 'ADANIPORTS', 'GMRAIRPORT', 'IRB', 'NBCC', 'RVNL', 'IRCON', 'NCC', 'KEC', 'PNCINFRA'],
  'Metals & mining': ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'JINDALSTEL', 'NMDC', 'SAIL', 'HINDZINC', 'NATIONALUM', 'COALINDIA'],
  Cement: ['ULTRACEMCO', 'GRASIM', 'SHREECEM', 'AMBUJACEM', 'ACC', 'DALBHARAT', 'JKCEMENT'],
  Agriculture: ['UPL', 'COROMANDEL', 'CHAMBLFERT', 'RCF', 'GNFC', 'PIIND', 'DHANUKA', 'RALLIS', 'KAVERISEED', 'BAYERCROP'],
  Chemicals: ['SRF', 'PIDILITIND', 'DEEPAKNTR', 'AARTIIND', 'NAVINFLUOR', 'ATUL', 'VINATIORGA', 'TATACHEM'],
  'Consumer & retail': ['TITAN', 'TRENT', 'DMART', 'ASIANPAINT', 'PAGEIND', 'BATAINDIA', 'ABFRL', 'VMART'],
  Telecom: ['BHARTIARTL', 'IDEA', 'INDUSTOWER', 'TATACOMM', 'HFCL'],
  'Capital goods': ['SIEMENS', 'ABB', 'CUMMINSIND', 'THERMAX', 'AIAENG', 'GRINDWELL', 'TIMKEN', 'SCHAEFFLER'],
  Shipping: ['SCI', 'GESHIP', 'SEAMECLTD'],
  'New-age tech': ['ETERNAL', 'PAYTM', 'NYKAA', 'POLICYBZR', 'DELHIVERY', 'SWIGGY'],
  Diversified: ['ADANIENT', 'GRASIM', 'ITC'],
  Ports: ['ADANIPORTS', 'JSWINFRA'],
};

/** Inverted at module load: symbol → themes. */
const THEMES_BY_SYMBOL = ((): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const [theme, symbols] of Object.entries(THEME_MEMBERS)) {
    for (const s of symbols) {
      const cur = m.get(s) ?? [];
      if (!cur.includes(theme)) cur.push(theme);
      m.set(s, cur);
    }
  }
  return m;
})();

export const ALL_THEMES = Object.keys(THEME_MEMBERS).sort();

let cache: { at: number; bySymbol: Map<string, string> } | null = null;

/** Parse the NIFTY 500 constituent CSV. Pure, so it is testable offline. */
export function parseConstituents(csv: string): Map<string, string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return new Map();
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iInd = header.indexOf('industry');
  const iSym = header.indexOf('symbol');
  if (iInd < 0 || iSym < 0) return new Map();

  const out = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    // Company names contain commas inside quotes; only the trailing columns are
    // needed, so read from the END where the layout is stable.
    const cells = lines[i].split(',');
    if (cells.length < 3) continue;
    const symbol = cells[cells.length - 3]?.trim().toUpperCase();
    const industry = cells[cells.length - 4]?.trim();
    if (symbol && industry) out.set(symbol, industry);
  }
  return out;
}

/** NSE's industry per symbol, cached for a day. Empty map on failure — never a guess. */
export async function loadSectors(now = Date.now()): Promise<Map<string, string>> {
  if (cache && now - cache.at < TTL_MS && cache.bySymbol.size) return cache.bySymbol;
  try {
    const res = await fetch(NIFTY500, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bySymbol = parseConstituents(await res.text());
    if (bySymbol.size) {
      cache = { at: now, bySymbol };
      logger.info(`Sector map loaded: ${bySymbol.size} symbols from the NIFTY 500 list`);
      return bySymbol;
    }
    throw new Error('constituent file parsed to nothing');
  } catch (e) {
    logger.warn(`sector map: ${e instanceof Error ? e.message : e}`);
    return cache?.bySymbol ?? new Map();
  }
}

/** Classify one symbol against an already-loaded sector map. Pure. */
export function classify(symbol: string, sectors: Map<string, string>): Classification {
  const s = symbol.toUpperCase();
  return {
    symbol: s,
    sector: sectors.get(s) ?? SECTOR_FALLBACK[s] ?? UNCLASSIFIED,
    themes: THEMES_BY_SYMBOL.get(s) ?? [],
  };
}

export const themesFor = (symbol: string): string[] => THEMES_BY_SYMBOL.get(symbol.toUpperCase()) ?? [];

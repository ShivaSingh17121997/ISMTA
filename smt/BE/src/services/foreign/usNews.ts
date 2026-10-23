/**
 * US headlines per company, and the news veto, for the foreign-stock page.
 *
 * Source: Google News RSS, US edition (`hl=en-US&gl=US`), verified 2026-10-14
 * with real Reuters/Barron's headlines for Nvidia. Parsing and scoring reuse
 * the Indian recommender (recommender/news.ts), with the word lists EXTENDED
 * for US phrasing ("guidance cut", "Chapter 11", "short seller") — every
 * addition below has a test.
 *
 * WHAT NEWS IS ALLOWED TO DO: withhold money, or explain. Never rank. The
 * evidence (Tetlock) puts the headline-tone effect at a few basis points that
 * reverse within a week, under trading costs. The veto is the Indian one,
 * unchanged: mean tone ≤ −0.4 across at least 3 scored headlines in 7 days.
 *
 * WRONG-COMPANY HEADLINES are the main failure (the Indian broker-call build
 * found most errors were the right story about the wrong company). A headline
 * counts only if it names the company: its cleaned full name, a distinctive
 * first word matched case-sensitively ("Apple", not "apple"), a curated alias
 * (Google for Alphabet), or the ticker in capitals. A first word followed by a
 * sibling word ("Apple Hospitality", "American Express" for "American
 * Airlines") does not count.
 */
import { parseGoogleNews, toneWith, _internal, type Headline } from '../recommender/news';
import { cachedFetch, safeName } from './http';

export const NEWS_VETO_TONE = -0.4;
export const NEWS_VETO_MIN = 3;
const DAYS = 7;

const US_LEXICON: Record<string, number> = {
  ..._internal.LEXICON,
  downgraded: -2, plunges: -2, plummets: -2, tanks: -2, crashes: -2, restatement: -2,
  delisting: -2, subpoena: -2, sued: -1, tumbles: -1, sinks: -1, slides: -1,
  antitrust: -1, tariff: -1, tariffs: -1, halted: -1, layoff: -1, lowers: -1,
  upgraded: 2, soars: 2, skyrockets: 2, raises: 1, tops: 1, rebounds: 1, rebound: 1,
};

const US_BIGRAMS: Record<string, number> = {
  ..._internal.BIGRAMS,
  'guidance cut': -2, 'cuts guidance': -2, 'lowers guidance': -2, 'lowers outlook': -2, 'cuts outlook': -2,
  'weak guidance': -2, 'chapter 11': -2, 'going concern': -2, 'short seller': -2, 'class action': -2,
  'sec probe': -2, 'for chapter': -2, 'chapter protection': -2, 'bankruptcy protection': -2, 'doj probe': -2, 'misses expectations': -2, 'price target': 0,
  'raises guidance': 2, 'guidance raised': 2, 'raises outlook': 2, 'beats expectations': 2, 'tops estimates': 2,
  'strong guidance': 2, 'time high': 2, 'record revenue': 2,
};

export function usTone(title: string): { tone: number; matched: string[] } {
  return toneWith(title, US_LEXICON, US_BIGRAMS);
}

/** Curated aliases headlines use instead of the legal name. */
const ALIASES: Record<string, string[]> = {
  GOOGL: ['Google', 'Alphabet'],
  GOOG: ['Google', 'Alphabet'],
  META: ['Meta', 'Facebook', 'Instagram'],
  'BRK-B': ['Berkshire'],
  JPM: ['JPMorgan', 'JP Morgan'],
  KO: ['Coca-Cola', 'Coke'],
  NWSA: ['News Corp'],
  NWS: ['News Corp'],
  TSM: ['TSMC', 'Taiwan Semiconductor'],
  ASML: ['ASML'],
  NVO: ['Novo Nordisk', 'Novo'],
  TM: ['Toyota'],
  MUFG: ['Mitsubishi UFJ', 'MUFG'],
  XOM: ['Exxon'],
  // One-word names that are also ordinary words: only these forms count.
  TGT: ['Target Corp', "Target's", 'Target stores', 'TGT'],
  BALL: ['Ball Corp'],
  GLW: ['Corning Inc', 'Corning'],
  MTCH: ['Match Group'],
  FOXA: ['Fox Corp'],
  FOX: ['Fox Corp'],
  XYZ: ['Block Inc', 'Square'],
  PGR: ['Progressive Corp'],
  PFG: ['Principal Financial'],
  PRU: ['Prudential Financial'],
};

/** Words too generic to identify a company on their own. */
const GENERIC = new Set([
  'american', 'united', 'general', 'first', 'international', 'national', 'global', 'public', 'southern', 'northern',
  'western', 'eastern', 'pacific', 'atlantic', 'texas', 'consolidated', 'universal', 'federal', 'digital', 'advanced',
  'applied', 'best', 'dollar', 'energy', 'health', 'life', 'new', 'the', 'royal', 'central', 'capital', 'state', 'target',
  'match', 'ball', 'corning', 'news', 'fox', 'block', 'gap', 'progressive', 'principal', 'prudential', 'insulet',
]);
/** Second words that turn a shared first word into a different company. */
const SIBLINGS = /^(?:Consolidated|Hospitality|Bancorp|Bank|Bankshares|Financial|Capital|Realty|REIT|Energy|Pharma|Pharmaceuticals|Airlines|Express|Water|Gas|Insurance|Trust|Holdings|Tower|Homes|Motors|Foods|Resources|Minerals|Therapeutics|Biosciences)\b/;
/** Partners whose name prefixes a US brand in a different company ("PNB MetLife", an Indian joint venture). */
const PREFIX_SIBLINGS = /(?:PNB|HDFC|ICICI|SBI|Kotak|Bajaj|Tata|Max|Aditya Birla|Star)\s+$/;

/** Tickers that are ordinary English words in capitals ("IT", "ALL", "NOW"). */
const WORD_TICKERS = new Set(['A', 'ALL', 'IT', 'ON', 'KEY', 'NOW', 'ARE', 'O', 'L', 'D', 'C', 'T', 'F', 'K', 'J', 'V', 'BALL', 'CAT', 'LOW', 'MO', 'PM', 'HAS', 'DAY', 'CARR', 'COST', 'FAST', 'GEN', 'BEN', 'TECH', 'WELL', 'PEAK', 'HD', 'ED', 'DG', 'CF', 'GE', 'UPS', 'AI', 'EA', 'ES', 'TT', 'DD', 'BR', 'CE', 'PH', 'BA']);

const SUFFIX = /\s*(?:,?\s*(?:Inc\.?|Incorporated|Corporation|Corp\.?|Company|Co\.?|Holdings?|Group|plc|PLC|Ltd\.?|Limited|N\.V\.|S\.A\.|SE|AG|\(The\)|\(Class [A-C]\)|Class [A-C]|& Co\.?))+\s*$/;

/** The plain name headlines use: legal suffixes and "(The)" removed. Pure. */
export function cleanName(name: string): string {
  let s = name.trim().replace(/\.com\b/i, '');
  for (let k = 0; k < 4; k++) s = s.replace(SUFFIX, '').trim();
  return s.replace(/,$/, '').trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One name form found in a headline? Multi-word forms match case-insensitively.
 * Single words match case-sensitively ("apple" in a recipe is not Apple) and
 * not when the next word makes it another company ("Apple Hospitality").
 */
function hasForm(title: string, form: string, ownName: string): boolean {
  if (/\s/.test(form)) return new RegExp(`(^|[^A-Za-z])${esc(form)}(?![A-Za-z])`, 'i').test(title);
  const re = new RegExp(`(^|[^A-Za-z])${esc(form)}(?:'s|’s)?(?![A-Za-z])(\\s+[A-Za-z]+)?`, 'g');
  for (const m of title.matchAll(re)) {
    const next = (m[2] ?? '').trim();
    if (next && SIBLINGS.test(next) && !ownName.includes(next)) continue;
    if (PREFIX_SIBLINGS.test(title.slice(0, m.index! + m[1].length))) continue;
    return true;
  }
  return false;
}

/** Does this headline name this company? Pure. */
export function namesCompany(title: string, companyName: string, ticker: string): boolean {
  const clean = cleanName(companyName);
  const words = clean.split(/\s+/);
  const generic = (w: string) => GENERIC.has(w.toLowerCase());
  const forms = new Set<string>(ALIASES[ticker] ?? []);
  // A one-word name that is also an ordinary word ("Target") counts only through its aliases.
  if (words.length > 1 || !generic(clean)) forms.add(clean);
  // A distinctive first word ("Exxon" of "Exxon Mobil", "Nvidia" of "Nvidia Corp").
  if (words.length > 1 && words[0].length >= 4 && !generic(words[0])) forms.add(words[0]);
  for (const f of forms) if (f && hasForm(title, f, clean)) return true;
  if (ticker.length >= 2 && !WORD_TICKERS.has(ticker) && new RegExp(`(^|[^A-Za-z])${esc(ticker)}(?![A-Za-z])`).test(title)) return true;
  return false;
}

export interface UsNewsRead {
  headlines: Headline[];
  /** Dropped as being about another company, for the audit. */
  offTopic: number;
  sentiment: number;
  scored: number;
  veto: boolean;
  note: string;
}

/** Score a feed's headlines for one company: relevance first, then tone. Pure. */
export function readHeadlines(all: Headline[], companyName: string, ticker: string): UsNewsRead {
  const seen = new Set<string>();
  const unique = all.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)));
  const on = unique.filter((h) => namesCompany(h.title, companyName, ticker)).map((h) => ({ ...h, ...usTone(h.title) }));
  const scoredOnes = on.filter((h) => h.tone !== 0);
  const sentiment = scoredOnes.length ? scoredOnes.reduce((s, h) => s + h.tone, 0) / scoredOnes.length : 0;
  const veto = sentiment <= NEWS_VETO_TONE && scoredOnes.length >= NEWS_VETO_MIN;
  const dir = sentiment > 0.2 ? 'leaning positive' : sentiment < -0.2 ? 'leaning negative' : 'mixed or neutral';
  const note = !on.length
    ? `No headlines naming the company in ${DAYS} days.`
    : `${on.length} headlines in ${DAYS} days, ${scoredOnes.length} with a scored word: ${dir}${scoredOnes.length < 3 ? ' (too few to mean much)' : ''}.`;
  return { headlines: on.slice(0, 8), offTopic: unique.length - on.length, sentiment, scored: scoredOnes.length, veto, note };
}

export function newsQuery(companyName: string, ticker: string): string {
  const clean = cleanName(companyName);
  const alias = ALIASES[ticker]?.[0];
  if (!/\s/.test(clean) && GENERIC.has(clean.toLowerCase()) && alias) return `"${alias}" stock when:${DAYS}d`;
  const names = [...new Set([clean, alias].filter(Boolean) as string[])].map((n) => `"${n}"`).join(' OR ');
  return `(${names}) stock when:${DAYS}d`;
}

export async function loadUsNews(companyName: string, ticker: string, opts: { force?: boolean } = {}): Promise<UsNewsRead | null> {
  const q = encodeURIComponent(newsQuery(companyName, ticker));
  const xml = await cachedFetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, `news/${safeName(ticker)}.xml`, {
    ttlMs: 6 * 3_600_000,
    gapMs: 700,
    force: opts.force,
  });
  if (xml == null) return null;
  return readHeadlines(parseGoogleNews(xml, 20), companyName, ticker);
}

/** Stock-picking listicles ("1 S&P 500 Stock … and 2 We Avoid") are not market news. */
export const isListicle = (title: string): boolean =>
  /^\s*\d+\s.*\bstocks?\b|\b\d+\s+(?:[A-Z&\d-]+\s+){0,3}Stocks?\b|We (?:Avoid|Brush Off|Like)|to Buy (?:Now|and Hold)|Should You Buy/i.test(title);

/** Market-wide headlines: context only, never a ranking input. */
export async function loadMarketHeadlines(): Promise<Headline[]> {
  const q = encodeURIComponent('("stock market" OR "Wall Street" OR "S&P 500") when:2d');
  const xml = await cachedFetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, 'news/_market.xml', { ttlMs: 3 * 3_600_000, gapMs: 700 });
  return xml ? parseGoogleNews(xml, 30).filter((h) => !isListicle(h.title)).slice(0, 10).map((h) => ({ ...h, ...usTone(h.title) })) : [];
}

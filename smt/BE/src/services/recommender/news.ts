/**
 * News and filings for one stock, and a deliberately modest read of them.
 *
 * TWO SOURCES, AND THEY ARE NOT EQUALLY GOOD
 *
 *   NSE corporate announcements — the primary source. These are the company's
 *   own filings: results, board meetings, orders won, credit-rating actions,
 *   pledges. Structured, per-symbol, and not somebody's paraphrase.
 *
 *   Google News RSS — headlines. Per-symbol, India-scoped, and the only free
 *   per-stock news feed that actually works. Yahoo's search endpoint was
 *   checked and REJECTED: for `.NS` tickers it returns a generic global wire
 *   dump, byte-identical for RELIANCE and TCS, including consumer-electronics
 *   PR tagged to AAPL. It looks like news and is not.
 *
 * HOW MUCH TO BELIEVE THE SENTIMENT NUMBER: not much, and the caller weights
 * it accordingly. Counting words in headlines cannot read negation ("not a
 * concern"), sarcasm, or context, and the same story syndicated across six
 * outlets counts six times. It is a weak signal reported as a weak signal.
 *
 * The word lists are written here from scratch and tuned to Indian market
 * headlines. The obvious alternative — the Loughran-McDonald financial
 * dictionary — is licensed for academic use only, so it is not embedded. It is
 * also built from SEC filings, where "closing", "force" and "critical" are
 * negative for boilerplate reasons that do not hold in a headline.
 */

import { logger } from '../../utils/logger';
import { dedupeCalls, parseBrokerCalls, searchQuery, summarise, type BrokerSummary } from './brokerCalls';

/** Broker calls stay relevant for weeks; headlines for days. */
const BROKER_DAYS = 30;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export interface Headline {
  title: string;
  source: string;
  at: number;
  url: string;
  /** −1..+1 from the lexicon below. Zero when no scored word appears. */
  tone: number;
  /** The words that moved it, for showing the working. */
  matched: string[];
}

export interface Filing {
  /** NSE's announcement category, e.g. "Financial Results". */
  category: string;
  detail: string;
  at: number;
  /** True for the categories that reliably move a price. */
  material: boolean;
}

export interface NewsRead {
  symbol: string;
  headlines: Headline[];
  filings: Filing[];
  /** Mean tone across scored headlines, −1..+1. Zero when nothing scored. */
  sentiment: number;
  /** How many headlines actually contained a scored word. Low counts mean low confidence. */
  scored: number;
  /** Material filings in the window — a flag to read the news, not a direction. */
  materialFilings: number;
  /**
   * Broker calls parsed out of headlines — display only, never ranked and
   * never part of `sentiment` or the veto. See brokerCalls.ts for why.
   */
  brokers: BrokerSummary;
  note: string;
  errors: string[];
}

/**
 * A small, hand-written lexicon for Indian equity headlines.
 *
 * Weights are −2..+2. Words that are strong and unambiguous in a market
 * headline get 2; words that merely lean get 1. Deliberately short: a long
 * list of weak words produces confident-looking noise.
 */
const LEXICON: Record<string, number> = {
  // Strongly negative
  fraud: -2, probe: -2, raid: -2, default: -2, insolvency: -2, bankruptcy: -2,
  downgrade: -2, downgrades: -2, resign: -2, resigns: -2, resignation: -2,
  scam: -2, penalty: -2, fined: -2, ban: -2, banned: -2, lawsuit: -2,
  writeoff: -2, impairment: -2, fraudulent: -2, embezzlement: -2, defaults: -2,
  // Leaning negative
  falls: -1, fell: -1, slips: -1, slumps: -1, drops: -1, declines: -1,
  weak: -1, loss: -1, losses: -1, cut: -1, cuts: -1, warning: -1, warns: -1,
  miss: -1, misses: -1, missed: -1, delay: -1, delayed: -1, concern: -1,
  concerns: -1, pressure: -1, headwinds: -1, sell: -1, selling: -1,
  underperform: -1, layoffs: -1, shutdown: -1, recall: -1, dispute: -1,
  investigation: -1, notice: -1, pledge: -1, pledged: -1, stake_sale: -1,
  // Leaning positive
  rises: 1, rose: 1, gains: 1, gained: 1, jumps: 1, climbs: 1, surges: 1,
  beat: 1, beats: 1, strong: 1, growth: 1, profit: 1, profits: 1,
  expansion: 1, expands: 1, launch: 1, launches: 1, partnership: 1,
  contract: 1, deal: 1, approval: 1, approved: 1, dividend: 1, bonus: 1,
  buyback: 1, outperform: 1, momentum: 1, demand: 1, orders: 1,
  // Strongly positive
  upgrade: 2, upgrades: 2, record: 2, highest: 2, wins: 2, won: 2,
  breakthrough: 2, acquisition: 2, acquires: 2, surge: 2, multibagger: 2,
  doubles: 2, tripled: 2, rally: 2, outperformed: 2,
};

/**
 * Two-word phrases checked BEFORE single words, because several of them invert
 * the meaning of a word the lexicon scores the other way.
 *
 * These are not hypothetical. Testing against live headlines produced
 * "Reliance Industries Slips 0.30% as Profit-Taking Sets In" scored POSITIVE,
 * because "profit" is a positive word and the phrase it appeared in was not
 * read. Every entry below is a trap of that shape.
 */
const BIGRAMS: Record<string, number> = {
  'profit taking': -2,
  'profit booking': -2,
  'profit warning': -2,
  'record low': -2,
  'target cut': -2,
  'cuts target': -2,
  'rating cut': -2,
  'stake sale': -1,
  'block deal': -1,
  'shares pledged': -2,
  'promoter pledge': -2,
  'below expectations': -2,
  'misses estimates': -2,
  'record high': 2,
  'raises target': 2,
  'target raised': 2,
  'beats estimates': 2,
  'above expectations': 2,
  'order win': 2,
  'order book': 1,
  'all time high': 2,
};

/** NSE announcement categories that reliably matter to a price. */
const MATERIAL = [
  'financial result', 'board meeting', 'dividend', 'bonus', 'split',
  'buy back', 'buyback', 'acquisition', 'amalgamation', 'merger',
  'credit rating', 'resignation', 'appointment', 'order', 'award of',
  'investor presentation', 'earnings call', 'takeover', 'open offer',
];

/** Score one headline against the lexicon. Returns −1..+1 and the words used. */
export function toneOf(title: string): { tone: number; matched: string[] } {
  return toneWith(title, LEXICON, BIGRAMS);
}

/**
 * The same scoring with a caller's word lists. US headlines use this with the
 * Indian lists extended (foreign/usNews.ts); the Indian lists are untouched.
 */
export function toneWith(title: string, LEXICON: Record<string, number>, BIGRAMS: Record<string, number>): { tone: number; matched: string[] } {
  const words = title.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  let sum = 0;
  const matched: string[] = [];
  // Phrases first, and the words they consume are removed so a bigram cannot
  // be double-counted by its own halves.
  const used = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    const score = BIGRAMS[phrase];
    if (score === undefined) continue;
    sum += score;
    matched.push(phrase);
    used[i] = true;
    used[i + 1] = true;
  }
  for (let i = 0; i < words.length; i++) {
    if (used[i]) continue;
    const w = words[i];
    const score = LEXICON[w];
    if (score === undefined) continue;
    // The cheapest possible negation handling: a preceding "no"/"not"/"never"
    // flips the sign. It catches "no fraud found" and misses plenty else,
    // which is why the whole signal is weighted low.
    const prev = words[i - 1];
    const negated = prev === 'no' || prev === 'not' || prev === 'never' || prev === 'without';
    sum += negated ? -score : score;
    matched.push(negated ? `not ${w}` : w);
  }
  if (!matched.length) return { tone: 0, matched };
  // Normalise by the strongest possible reading of this many words, then clamp.
  return { tone: Math.max(-1, Math.min(1, sum / (matched.length * 2))), matched };
}

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();

const tag = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

/**
 * Parse a Google News RSS body. Pure, so it is testable without the network.
 *
 * Google appends " - Publisher" to every title; it is stripped, because left
 * in it feeds publisher names to the lexicon.
 */
export function parseGoogleNews(xml: string, limit = 12): Headline[] {
  const items = xml.split(/<item>/i).slice(1);
  const out: Headline[] = [];
  for (const raw of items.slice(0, limit)) {
    const block = raw.split(/<\/item>/i)[0];
    const source = tag(block, 'source');
    let title = tag(block, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (!title) continue;
    const at = Date.parse(tag(block, 'pubDate'));
    const { tone, matched } = toneOf(title);
    out.push({
      title,
      source: source || 'unknown',
      at: Number.isFinite(at) ? at : Date.now(),
      url: tag(block, 'link'),
      tone,
      matched,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Parse NSE's corporate-announcements array. Pure. */
export function parseFilings(body: unknown, limit = 10): Filing[] {
  if (!Array.isArray(body)) return [];
  const out: Filing[] = [];
  for (const row of body as Record<string, unknown>[]) {
    const category = String(row.desc ?? '').trim();
    if (!category) continue;
    const at = Date.parse(String(row.sort_date ?? '').replace(' ', 'T') + 'Z');
    const lower = category.toLowerCase();
    out.push({
      category,
      detail: String(row.attchmntText ?? '').trim().slice(0, 300),
      at: Number.isFinite(at) ? at : 0,
      material: MATERIAL.some((k) => lower.includes(k)),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

const ddmmyyyy = (t: number): string => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
};

async function get(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Headlines and filings for one stock over the last `days`.
 *
 * Best-effort on both legs: a failure returns what the other leg produced
 * rather than nothing, and the error is reported rather than swallowed. News
 * is an enrichment here, never a gate — a stock is not disqualified because a
 * feed timed out.
 */
export async function fetchNews(
  symbol: string,
  companyName: string,
  days = 7,
  timeoutMs = 12_000,
): Promise<NewsRead> {
  const errors: string[] = [];
  let headlines: Headline[] = [];
  let filings: Filing[] = [];

  // Quote the company name so the search does not drift onto unrelated stories
  // — but the names headlines use ("TCS", "HDFC Bank"), not NSE's "… Limited".
  const name = searchQuery(companyName, symbol);
  const q = encodeURIComponent(`${name} stock when:${days}d`);
  try {
    const xml = await get(
      `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`,
      timeoutMs,
    );
    headlines = parseGoogleNews(xml);
  } catch (e) {
    errors.push(`headlines: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const now = Date.now();
    const url =
      `https://www.nseindia.com/api/corporate-announcements?index=equities` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&from_date=${ddmmyyyy(now - 30 * 86_400_000)}&to_date=${ddmmyyyy(now)}`;
    filings = parseFilings(JSON.parse(await get(url, timeoutMs)));
  } catch (e) {
    errors.push(`filings: ${e instanceof Error ? e.message : e}`);
  }

  // A second, broker-shaped search over a longer window. Broker notes live
  // longer than a day's headlines, and the general search above rarely surfaces
  // them. Its headlines feed ONLY the broker parser — adding them to
  // `headlines` would tilt the sentiment and the veto towards whatever the
  // brokers happened to say.
  let brokerHeadlines: Headline[] = [];
  const bq = encodeURIComponent(
    `${name} (target OR upgrade OR downgrade OR rating OR coverage OR brokerage) when:${BROKER_DAYS}d`,
  );
  try {
    const xml = await get(
      `https://news.google.com/rss/search?q=${bq}&hl=en-IN&gl=IN&ceid=IN:en`,
      timeoutMs,
    );
    brokerHeadlines = parseGoogleNews(xml, 40);
  } catch (e) {
    errors.push(`broker calls: ${e instanceof Error ? e.message : e}`);
  }
  const seen = new Set<string>();
  const calls = dedupeCalls(
    [...headlines, ...brokerHeadlines]
      .filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)))
      .flatMap((h) => parseBrokerCalls(h, companyName, symbol)),
  );

  const scoredOnes = headlines.filter((h) => h.tone !== 0);
  const sentiment = scoredOnes.length
    ? scoredOnes.reduce((s, h) => s + h.tone, 0) / scoredOnes.length
    : 0;
  const materialFilings = filings.filter((f) => f.material).length;

  return {
    symbol,
    headlines,
    filings,
    sentiment,
    scored: scoredOnes.length,
    materialFilings,
    brokers: summarise(calls, BROKER_DAYS),
    note: buildNote(headlines.length, scoredOnes.length, sentiment, materialFilings, days),
    errors,
  };
}

function buildNote(total: number, scored: number, sentiment: number, material: number, days: number): string {
  if (!total) return `No headlines found in the last ${days} days.`;
  const dir = sentiment > 0.2 ? 'leaning positive' : sentiment < -0.2 ? 'leaning negative' : 'mixed or neutral';
  const conf = scored < 3 ? ' — too few scored words to mean much' : '';
  const filings = material ? `, ${material} material filing${material === 1 ? '' : 's'} in 30 days` : '';
  return `${total} headlines in ${days} days, ${scored} carrying a scored word: ${dir}${conf}${filings}.`;
}

/** Log once at startup so the source of this data is never a mystery. */
export function describeSources(): string {
  return (
    'Headlines: Google News RSS (India edition), per stock. Filings: NSE corporate announcements. ' +
    'Broker calls (e.g. Jefferies, CLSA, Morgan Stanley) are parsed from headlines over 30 days and shown ' +
    'for reading — they do not affect the ranking or the news veto. ' +
    'Yahoo news is deliberately not used — it returns a generic global feed for NSE tickers.'
  );
}

export const _internal = { LEXICON, BIGRAMS, MATERIAL, logger };

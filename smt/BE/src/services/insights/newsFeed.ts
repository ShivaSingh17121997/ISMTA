/**
 * Google News RSS reader.
 *
 * There is no official Google News API. The public RSS endpoint at
 * `news.google.com/rss/search` is what the app row on news.google.com renders
 * from and is stable enough for a daily scan — a browser UA is required, and
 * every call is best-effort: a failure returns an empty array rather than a
 * fabricated headline, because "no news" is a valid signal and inventing one
 * would poison the sentiment score.
 *
 * The window is deliberately narrow (24h by default) — the point of this
 * module is *today's* news, not a rolling archive. The output is a bounded
 * list, decoded to plain text (no HTML), so downstream sentiment scoring can
 * pattern-match on words without stripping markup itself.
 */
import { logger } from '../../utils/logger';

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/**
 * Decode the small set of HTML entities Google News actually emits in RSS
 * titles. A full HTML decoder is overkill; the feed carries `&amp; &#39; &quot;
 * &lt; &gt;` and little else.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Pull the inner text of the first `<tag>…</tag>` in `xml`. */
function pick(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  let inner = m[1].trim();
  // Titles may arrive wrapped in CDATA; strip it before entity decoding.
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  if (cdata) inner = cdata[1];
  return decodeEntities(inner).trim();
}

/**
 * Parse a Google News RSS body into items. Pure — tested without the network.
 *
 * The `<source>` tag on each item carries the publisher name (e.g. "Reuters").
 * Missing pieces are tolerated: an item with no pubDate falls back to `now` so
 * it is still counted, but is placed last when items are sorted by time.
 */
export function parseGoogleNewsRss(xml: string, now = Date.now()): NewsItem[] {
  const out: NewsItem[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const raw = m[1];
    const title = pick(raw, 'title');
    if (!title) continue;
    const link = pick(raw, 'link');
    const source = pick(raw, 'source') || 'Google News';
    const pub = pick(raw, 'pubDate');
    const t = pub ? Date.parse(pub) : NaN;
    out.push({
      title,
      link,
      source,
      publishedAt: Number.isFinite(t) ? t : now,
    });
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * Fetch news for a company/symbol.
 *
 *   `query`     the term to search — usually the company name, not the ticker,
 *               because ".NS" and Indian tickers alone (e.g. "SBIN") match
 *               generic hits like schools and airports on Google News.
 *   `withinDays` clamps the window Google filters on. Default 1 = "today".
 *   `limit`     hard-cap items so a viral story does not flood one book.
 *
 * Returns [] on any error. Logs, does not throw.
 */
export async function fetchGoogleNews(
  query: string,
  withinDays = 1,
  limit = 8,
  timeoutMs = 8_000,
): Promise<NewsItem[]> {
  const q = query.trim();
  if (!q) return [];
  const win = Math.max(1, Math.min(30, Math.floor(withinDays)));
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${win}d`)}` +
    `&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    return parseGoogleNewsRss(body).slice(0, Math.max(1, limit));
  } catch (e) {
    logger.warn(`Google News "${q}": ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/**
 * A single call for the overall market. Broad Indian-market queries help the
 * page show a "market mood" card without needing a specific stock. Same
 * failure semantics as fetchGoogleNews.
 */
export async function fetchMarketNews(limit = 12): Promise<NewsItem[]> {
  return fetchGoogleNews('Nifty OR Sensex OR "Indian stock market"', 1, limit);
}

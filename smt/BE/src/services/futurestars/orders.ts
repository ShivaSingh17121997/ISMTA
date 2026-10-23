/**
 * Order and contract wins, read from the company's own exchange filings.
 *
 * This is the pillar with the best evidence behind it. Under SEBI's listing
 * regulations a company must disclose a material order win, and NSE files that
 * disclosure under its own category — "Bagging/Receiving of orders/contracts".
 * So the order book is not something we infer from a newspaper: it is a dated,
 * mandatory, machine-readable filing.
 *
 * The trap, found the first time this was run against real data: NSE also has
 * a category called "Action(s) taken or orders passed", which is a REGULATORY
 * order — a fine. Matching on the word "order" turns a penalty from the
 * exchange into a bullish signal. RVNL's two NSE/BSE fines for the June 2026
 * quarter were caught doing exactly that in testing. Categories are therefore
 * matched exactly, and the regulatory ones are routed to the risk flags.
 *
 * The parsers here are pure and tested against saved filings; only `fetchOrderFlow`
 * touches the network.
 */
import { logger } from '../../utils/logger';
import { OrderFlow, OrderWin, RiskFlag } from './types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** NSE categories that mean "we won work". Matched exactly, lower-cased. */
const WIN_CATEGORIES = [
  'bagging/receiving of orders/contracts',
  'awarding of order(s)/contract(s)',
];

/** Categories that mean a regulator acted against the company. Never a win. */
const REGULATORY_CATEGORIES = [
  'action(s) taken or orders passed',
  'action(s) initiated or orders passed',
];

/** Free-text that indicates a win when the category is generic ("Updates"). */
const WIN_TEXT =
  /\b(bag(?:s|ged|ging)?|receiv\w*|secur\w*|win(?:s|ning)?|won|award\w*)\b[^.]{0,80}\b(order|contract|letter of (?:award|acceptance|intent)|loa|lo[ai]|work order|purchase order|tender)\b/i;

/** Free-text that looks like a win but is not one. */
const NOT_A_WIN =
  /\b(fine|penalt\w*|impos\w*|show cause|adjudicat\w*|non[- ]compliance|delay in|clarification|withdraw\w*|cancell?\w*|terminat\w*)\b/i;

export interface RawAnnouncement {
  /** "10-Sep-2026 20:23:14" */
  an_dt?: string;
  desc?: string;
  attchmntText?: string;
  attchmntFile?: string;
  smIndustry?: string;
}

/** "10-Sep-2026 20:23:14" → epoch ms (IST). Returns null when unparseable. */
export function parseNseDate(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const [, d, , y, hh = '0', mm = '0', ss = '0'] = m;
  // The filing timestamp is IST; build it as UTC then shift back.
  return Date.UTC(Number(y), mon, Number(d), Number(hh), Number(mm), Number(ss)) - 5.5 * 3_600_000;
}

/**
 * Pull a rupee value out of filing prose.
 *
 * Indian filings write money a dozen ways: "Rs. 1,234.56 crore", "₹1234 Cr",
 * "INR 45.6 million", "Rs 2.3 lakh crore", sometimes with "approximately" or a
 * range. We take the LARGEST value in the text, because a filing that mentions
 * both the order value and some incidental figure (a fee, a share count) puts
 * the order value first in size far more often than not.
 *
 * Returns rupees. Null when the text carries no recognisable amount, which is
 * common — many filings put the value only in the attached PDF.
 */
export function parseOrderValue(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/,/g, ' ').replace(/\s+/g, ' ');
  const unit: Record<string, number> = {
    'lakh crore': 1e12,
    crore: 1e7,
    cr: 1e7,
    lakh: 1e5,
    lac: 1e5,
    million: 1e6,
    mn: 1e6,
    billion: 1e9,
    bn: 1e9,
  };
  // number, optional spaces, then a unit word. The currency marker is optional
  // because plenty of filings write "value of 1234 crore".
  const re =
    /(?:(?:rs|inr|₹)\.?\s*)?(\d{1,3}(?:\s\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(lakh crore|crore|cr\b|lakh|lac|million|mn\b|billion|bn\b)/gi;
  let best: number | null = null;
  for (const m of t.matchAll(re)) {
    const n = Number(m[1].replace(/\s/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = m[2].toLowerCase().replace(/\b$/, '').trim();
    const mult = unit[key] ?? unit[key.replace(/\.$/, '')];
    if (!mult) continue;
    const value = n * mult;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * Who placed the order, when the filing names them.
 *
 * Strict on purpose. A first attempt matched "from|by|of" anywhere in the text
 * and confidently reported that RVNL's customer was "SEBI" — it had matched
 * "…of SEBI (LODR) Regulations…" in the boilerplate every filing opens with.
 * A wrong customer is worse than no customer, so the name must follow an
 * award phrase ("Letter of Award from X", "order received from X"), and any
 * candidate containing regulatory boilerplate is discarded.
 */
const BOILERPLATE =
  /\b(sebi|lodr|regulation|disclosure|listing obligation|exchange board|stock exchange|circular|annexure|schedule|para)\b/i;

export function parseCustomer(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');
  const re =
    /(?:letter of (?:award|acceptance|intent)|work order|purchase order|order|contract|loa)\s*(?:\([^)]*\)\s*)?(?:has been\s+)?(?:received\s+)?(?:from|by)\s+((?:M\/s\.?\s*)?[A-Z][\w&.'()-]*(?:\s+[A-Z(][\w&.'()-]*){0,7})/i;
  const m = re.exec(t);
  if (!m) return null;
  const raw = m[1]
    .replace(/\b(?:for|dated|under|vide|towards|amounting|worth|valued)\b.*$/i, '')
    .replace(/[.,;:()\s]+$/, '')
    .trim();
  if (raw.length < 4 || raw.length > 90) return null;
  if (BOILERPLATE.test(raw)) return null;
  // At least one word that is not a single capital letter or a number.
  if (!/[A-Za-z]{3}/.test(raw)) return null;
  return raw;
}

/** Is this filing a genuine order win? */
export function classifyAnnouncement(a: RawAnnouncement): 'win' | 'regulatory' | 'other' {
  const desc = (a.desc ?? '').trim().toLowerCase();
  const text = `${a.desc ?? ''} ${a.attchmntText ?? ''}`;
  if (REGULATORY_CATEGORIES.some((c) => desc.includes(c.toLowerCase()))) return 'regulatory';
  if (WIN_CATEGORIES.some((c) => desc === c || desc.startsWith(c.slice(0, 24)))) return 'win';
  // Generic categories still carry wins in their text; require the win phrasing
  // AND the absence of penalty language.
  if (WIN_TEXT.test(text) && !NOT_A_WIN.test(text)) return 'win';
  return 'other';
}

export function toOrderWin(a: RawAnnouncement): OrderWin | null {
  const at = parseNseDate(a.an_dt);
  if (at === null) return null;
  const detail = (a.attchmntText ?? a.desc ?? '').replace(/\s+/g, ' ').trim();
  return {
    at,
    category: (a.desc ?? '').trim(),
    detail: detail.slice(0, 400),
    valueInr: parseOrderValue(detail),
    customer: parseCustomer(detail),
    url: a.attchmntFile ?? null,
  };
}

const WINDOW_MS = 180 * 86_400_000;

/**
 * Split wins into a recent and a prior window and summarise. Pure.
 *
 * @param ttmRevenue trailing revenue, for book-to-bill. Null skips that ratio.
 */
export function summariseOrders(
  symbol: string,
  announcements: RawAnnouncement[],
  now: number,
  ttmRevenue: number | null,
): { flow: OrderFlow; regulatory: RiskFlag[] } {
  const wins: OrderWin[] = [];
  const regulatory: RiskFlag[] = [];
  for (const a of announcements) {
    const kind = classifyAnnouncement(a);
    if (kind === 'win') {
      const w = toOrderWin(a);
      if (w) wins.push(w);
    } else if (kind === 'regulatory') {
      const at = parseNseDate(a.an_dt);
      // Only recent regulatory action counts against a company.
      if (at !== null && now - at < WINDOW_MS) {
        regulatory.push({
          kind: 'regulatory',
          detail: (a.attchmntText ?? a.desc ?? 'regulatory action').replace(/\s+/g, ' ').slice(0, 200),
          severity: 0.4,
          at,
        });
      }
    }
  }

  const recent = wins.filter((w) => now - w.at <= WINDOW_MS).sort((a, b) => b.at - a.at);
  const prior = wins.filter((w) => now - w.at > WINDOW_MS && now - w.at <= 2 * WINDOW_MS);
  const sum = (xs: OrderWin[]): number => xs.reduce((s, w) => s + (w.valueInr ?? 0), 0);
  const recentValueInr = sum(recent);
  const priced = recent.filter((w) => w.valueInr !== null).length;
  const valueCoverage = recent.length ? priced / recent.length : 0;

  return {
    flow: {
      symbol: symbol.toUpperCase(),
      recent,
      prior,
      recentCount: recent.length,
      priorCount: prior.length,
      recentValueInr,
      priorValueInr: sum(prior),
      valueCoverage: Math.round(valueCoverage * 100) / 100,
      // Only when most wins carried a value. Annualise the half-year of wins
      // before comparing against a year of revenue.
      bookToBill:
        ttmRevenue && ttmRevenue > 0 && recentValueInr > 0 && valueCoverage >= 0.6
          ? Math.round(((recentValueInr * 2) / ttmRevenue) * 100) / 100
          : null,
      daysSinceLast: recent.length ? Math.floor((now - recent[0].at) / 86_400_000) : null,
      unpriced: recent.length - priced,
    },
    regulatory,
  };
}

/** DD-MM-YYYY, which is what the NSE endpoint wants. */
function nseDay(ts: number): string {
  const d = new Date(ts + 5.5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * Twelve months of filings for a symbol.
 *
 * Verified 2026-09-11: this endpoint answers with a browser User-Agent alone,
 * no cookie needed — but ONLY when the date range is supplied. Without it the
 * server streams the company's entire history.
 */
export async function fetchAnnouncements(
  symbol: string,
  now: number,
  months = 12,
  timeoutMs = 20_000,
): Promise<RawAnnouncement[]> {
  const from = nseDay(now - months * 30 * 86_400_000);
  const to = nseDay(now);
  const url =
    `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol.toUpperCase())}` +
    `&from_date=${from}&to_date=${to}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`NSE announcements HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('NSE announcements: unexpected payload');
  return body as RawAnnouncement[];
}

/** Order flow for one symbol. Never throws: a failure returns an empty flow with the reason. */
export async function fetchOrderFlow(
  symbol: string,
  now: number,
  ttmRevenue: number | null,
): Promise<{ flow: OrderFlow; regulatory: RiskFlag[] }> {
  try {
    const raw = await fetchAnnouncements(symbol, now);
    return summariseOrders(symbol, raw, now, ttmRevenue);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn(`order flow ${symbol}: ${error}`);
    return {
      flow: {
        symbol: symbol.toUpperCase(),
        recent: [],
        prior: [],
        recentCount: 0,
        priorCount: 0,
        recentValueInr: 0,
        priorValueInr: 0,
        bookToBill: null,
        valueCoverage: 0,
        daysSinceLast: null,
        unpriced: 0,
        error,
      },
      regulatory: [],
    };
  }
}

/**
 * Broker calls — "Jefferies upgrades X to buy, target ₹1,450" — pulled out of
 * headlines and turned into structured records: who, what changed, the rating,
 * the target.
 *
 * DISPLAY ONLY. NOT A RANKING INPUT.
 *
 *   The US evidence (Womack 1996, and much since) is that prices keep drifting
 *   after a rating CHANGE — downgrades more than upgrades — while initiations
 *   and reiterations carry far less. Nobody has shown that for NSE mid-caps
 *   read off free headlines, and a headline parser misses and misreads calls.
 *   So calls are attached to a recommendation for the user to read, and they
 *   neither move a rank nor feed the news veto. Promote them only after a test
 *   on logged calls shows they predict returns net of costs.
 *
 * WHY HEADLINES: there is no free, structured feed of broker ratings for Indian
 * stocks. Trendlyne, MarketsMojo and the terminals have them behind a paywall
 * or a scrape. Brokerage notes reliably make the Indian financial press within
 * hours, with the broker's name, the rating and usually the target in the
 * title — that shape is what this parses.
 *
 * FALSE POSITIVES THIS GUARDS AGAINST, each seen or near-certain:
 *
 *   - Brokers that share a name with a listed bank. "Kotak", "ICICI", "HDFC"
 *     and "Axis" alone are the BANKS; only the brokerage arms count
 *     ("Kotak Institutional Equities", "ICICI Securities", …).
 *   - A broker that is itself the stock. On Motilal Oswal's own feed, "Motilal
 *     Oswal shares jump" is company news, not a call; the covered company's
 *     name excludes a matching broker.
 *   - A broker name with no call attached ("Jefferies' Chris Wood on India
 *     flows"). A record needs a broker AND a rating, an action or a target.
 *   - Explainer headlines ("buy, sell or hold?"). Two conflicting ratings with
 *     no from/to structure yield no rating rather than a guess.
 *   - Ambiguous English. "buy", "sell", "hold", "add", "neutral" and "reduce"
 *     are everyday words ("FIIs sell"); they count as ratings only in rating
 *     position ("to hold", "maintains add", "Buy rating", "…: Buy").
 */

export type BrokerAction =
  | 'upgrade'
  | 'downgrade'
  | 'initiate'
  | 'target-raise'
  | 'target-cut'
  | 'reiterate';

export type BrokerStance = 'bullish' | 'neutral' | 'bearish';

export interface BrokerCall {
  /** Canonical broker name, e.g. "Jefferies". */
  broker: string;
  /** What changed. Null when a rating or target is stated with no verb we recognise. */
  action: BrokerAction | null;
  /** The rating now in force, as the broker words it ("buy", "overweight"). */
  rating: string | null;
  stance: BrokerStance | null;
  /** Target price in rupees. Null when absent or failed the sanity check. */
  target: number | null;
  /** Upside the headline itself states ("sees 30% upside"); negative for downside. */
  statedUpsidePct: number | null;
  /** Target vs the last close, percent. Set by the engine, which knows the price. */
  upsidePct: number | null;
  /** Named in a list of picks ("top 10 stocks…") rather than a call on this stock alone. */
  basket: boolean;
  title: string;
  source: string;
  at: number;
  url: string;
  /** How many near-identical headlines this record stands for (syndication). */
  echoes: number;
}

export interface BrokerSummary {
  calls: BrokerCall[];
  /** Latest call per broker, bucketed. Counts brokers, not headlines. */
  bullish: number;
  neutral: number;
  bearish: number;
  note: string;
}

interface BrokerDef {
  name: string;
  pattern: RegExp;
}

/**
 * Houses that publish on Indian stocks and get reported by name. Bank-named
 * houses are matched only with their brokerage suffix — see the header.
 */
const BROKERS: BrokerDef[] = [
  { name: 'Jefferies', pattern: /\bjefferies\b/i },
  { name: 'Morgan Stanley', pattern: /\bmorgan stanley\b/i },
  { name: 'JPMorgan', pattern: /\bj\.?\s?p\.?\s?morgan\b/i },
  { name: 'Goldman Sachs', pattern: /\bgoldman(?: sachs)?\b/i },
  { name: 'CLSA', pattern: /\bclsa\b/i },
  { name: 'Nomura', pattern: /\bnomura\b/i },
  { name: 'Citi', pattern: /\bciti(?:group)?\b/i },
  { name: 'Macquarie', pattern: /\bmacquarie\b/i },
  { name: 'Bernstein', pattern: /\bbernstein\b/i },
  { name: 'UBS', pattern: /\bubs\b/i },
  { name: 'HSBC', pattern: /\bhsbc\b/i },
  { name: 'BofA', pattern: /\b(?:bofa|bank of america)\b/i },
  { name: 'BNP Paribas', pattern: /\bbnp paribas\b/i },
  { name: 'Deutsche', pattern: /\bdeutsche\b/i },
  { name: 'Investec', pattern: /\binvestec\b/i },
  { name: 'Kotak Institutional Equities', pattern: /\bkotak (?:institutional equities|securities|equities)\b/i },
  { name: 'ICICI Securities', pattern: /\bicici (?:securities|direct)\b|\bicicidirect\b/i },
  { name: 'HDFC Securities', pattern: /\bhdfc securities\b/i },
  { name: 'Axis Securities', pattern: /\baxis (?:securities|capital)\b/i },
  { name: 'Motilal Oswal', pattern: /\bmotilal oswal\b/i },
  { name: 'Nuvama', pattern: /\bnuvama\b/i },
  { name: 'Emkay', pattern: /\bemkay\b/i },
  { name: 'Elara', pattern: /\belara\b/i },
  { name: 'Ambit', pattern: /\bambit\b/i },
  { name: 'InCred', pattern: /\bincred\b/i },
  { name: 'Antique', pattern: /\bantique stock broking\b/i },
  { name: 'Prabhudas Lilladher', pattern: /\bprabhudas lilladher\b/i },
  { name: 'JM Financial', pattern: /\bjm financial\b/i },
  { name: 'PhillipCapital', pattern: /\bphillip ?capital\b/i },
  { name: 'Sharekhan', pattern: /\bsharekhan\b/i },
  { name: 'Anand Rathi', pattern: /\banand rathi\b/i },
  { name: 'Centrum', pattern: /\bcentrum\b/i },
  { name: 'Systematix', pattern: /\bsystematix\b/i },
  { name: 'IIFL', pattern: /\biifl (?:securities|capital)\b/i },
  { name: 'Yes Securities', pattern: /\byes securities\b/i },
  { name: 'Mirae Asset', pattern: /\bmirae asset (?:sharekhan|securities|capital)\b/i },
  { name: 'Geojit', pattern: /\bgeojit\b/i },
  { name: 'Choice Broking', pattern: /\bchoice broking\b/i },
  { name: 'DAM Capital', pattern: /\bdam capital\b/i },
  { name: 'Equirus', pattern: /\bequirus\b/i },
  { name: 'Dolat Capital', pattern: /\bdolat capital\b/i },
];

/** Rating vocabulary → stance. Multi-word forms first so "strong buy" beats "buy". */
const RATINGS: [string, BrokerStance][] = [
  ['strong buy', 'bullish'],
  ['market outperform', 'bullish'],
  ['sector outperform', 'bullish'],
  ['market perform', 'neutral'],
  ['sector perform', 'neutral'],
  ['equal weight', 'neutral'],
  ['in-line', 'neutral'],
  ['overweight', 'bullish'],
  ['outperform', 'bullish'],
  ['accumulate', 'bullish'],
  ['buy', 'bullish'],
  ['add', 'bullish'],
  ['underweight', 'bearish'],
  ['underperform', 'bearish'],
  ['sell', 'bearish'],
  ['reduce', 'bearish'],
  ['hold', 'neutral'],
  ['neutral', 'neutral'],
];

/** Everyday English words that count as ratings only in rating position. */
const NEEDS_CONTEXT = new Set(['buy', 'sell', 'add', 'hold', 'neutral', 'reduce', 'in-line']);
/** "Buy, sell or hold?" — an explainer, not a call. */
const EXPLAINER = /\b(?:buy|sell|hold)\s*(?:,|or|\/)\s*(?:buy|sell|hold)\b/i;
const RATING_LEAD = String.raw`(?:to|with(?: an?)?|at|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|reiterat(?:es?|ed|ing)|keeps?|kept|keeping|an?|says|rates?)`;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface RatingHit {
  rating: string;
  stance: BrokerStance;
  index: number;
}

function findRatings(text: string): RatingHit[] {
  const hits: RatingHit[] = [];
  if (EXPLAINER.test(text)) return hits;
  const taken: [number, number][] = [];
  for (const [word, stance] of RATINGS) {
    const w = esc(word).replace(/[ -]/g, '[ -]');
    const bare = new RegExp(String.raw`(?<![\w-])['"‘’“”]?${w}['"‘’“”]?(?![\w-])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = bare.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (NEEDS_CONTEXT.has(word)) {
        const before = text.slice(Math.max(0, start - 60), start);
        const after = text.slice(end, end + 25);
        // Start of headline and "…: Buy" count as rating position too.
        const led =
          start === 0 ||
          new RegExp(String.raw`\b${RATING_LEAD}\s*$`, 'i').test(before) ||
          /[:;|]\s*$/.test(before);
        const quoted = /['"‘’“”]/.test(m[0]);
        const labelled = /^\s*(?:rating|call|recommendation)\b/i.test(after);
        if (!led && !quoted && !labelled) continue;
      }
      taken.push([start, end]);
      hits.push({ rating: word === 'equal weight' ? 'equal-weight' : word, stance, index: start });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * The rating in force. "from hold to buy" and "to buy from hold" both read as
 * buy; several unrelated ratings with no from/to read as none.
 */
function pickRating(text: string, hits: RatingHit[]): RatingHit | null {
  if (!hits.length) return null;
  const distinct = new Set(hits.map((h) => h.stance));
  if (distinct.size === 1) return hits[0];
  for (const h of hits) {
    const before = text.slice(Math.max(0, h.index - 8), h.index);
    if (/\bto\s*['"‘’“”]?$/i.test(before)) return h;
  }
  return null;
}

const MONEY = String.raw`(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)`;

const num = (s: string): number => Number(s.replace(/,/g, ''));

/** Target price in rupees, preferring the NEW target when old and new both appear. */
export function parseTarget(text: string): number | null {
  const t = text.toLowerCase();
  const fromTo = new RegExp(String.raw`\bfrom\s*${MONEY}\s*(?:to|→)\s*${MONEY}`, 'i').exec(t);
  if (fromTo && /\b(?:target|tp)\b/.test(t)) return num(fromTo[2]);
  const toFrom = new RegExp(String.raw`\bto\s*${MONEY}\s*from\s*${MONEY}`, 'i').exec(t);
  if (toFrom && /\b(?:target|tp)\b/.test(t)) return num(toFrom[1]);
  const after = new RegExp(String.raw`\b(?:target|tp)\b(?:\s+price)?[^₹\d]{0,25}?${MONEY}`, 'i').exec(t);
  if (after) return num(after[1]);
  const before = new RegExp(String.raw`${MONEY}\s*(?:/share\s*)?(?:price\s*)?(?:target|tp)\b`, 'i').exec(t);
  if (before) return num(before[1]);
  return null;
}

function parseStatedUpside(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(?:%|per ?cent)\s*(upside|downside)/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2].toLowerCase() === 'downside' ? -v : v;
}

function parseAction(text: string, hasRating: boolean): BrokerAction | null {
  const t = text.toLowerCase();
  if (/\bupgrade[sd]?\b|\bupgrading\b/.test(t)) return 'upgrade';
  if (/\bdowngrade[sd]?\b|\bdowngrading\b/.test(t)) return 'downgrade';
  if (/\b(?:initiat(?:es?|ed|ing)|begins?|starts?|launch(?:es)?)\b[^.]{0,30}\bcoverage\b/.test(t)) return 'initiate';
  if (
    /\b(?:raises?|raised|hikes?|hiked|ups|upped|lifts?|lifted|increases?|increased|revises? up)\b[^.]{0,25}\b(?:target|tp)\b/.test(t) ||
    /\b(?:target|tp)\b(?: price)?[^.]{0,15}\b(?:raised|hiked|increased|upped|lifted)\b/.test(t)
  ) return 'target-raise';
  if (
    /\b(?:cuts?|lowers?|lowered|slash(?:es|ed)?|trims?|trimmed|reduces|reduced|revises? down)\b[^.]{0,25}\b(?:target|tp)\b/.test(t) ||
    /\b(?:target|tp)\b(?: price)?[^.]{0,15}\b(?:cut|lowered|slashed|trimmed|reduced)\b/.test(t)
  ) return 'target-cut';
  if (hasRating && /\b(?:maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|reiterat(?:es?|ed|ing)|keeps?|kept|keeping|stays|remains?|continues?)\b/.test(t)) {
    return 'reiterate';
  }
  return null;
}

/**
 * The name to search news for. NSE's master says "HDFC Bank Limited" and
 * "ETERNAL LIMITED"; headlines say "HDFC Bank" and "Eternal". Quoting the
 * master name verbatim was measured to return 3–7× fewer headlines.
 */
export function searchName(companyName: string): string {
  let n = companyName.replace(/\s*\b(?:limited|ltd\.?)\s*$/i, '').trim();
  if (n && n === n.toUpperCase() && /[A-Z]{2}/.test(n)) {
    n = n.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return n || companyName;
}

const STOP = new Set(['of', 'and', '&', 'the', 'for']);

/**
 * Ways a headline names the company. The full search name; its first two
 * words for long names ("Tata Consultancy", "Motilal Oswal"), unless the
 * second is a connective ("Bank of Baroda" stays whole); the initials form
 * of "X & Y" names ("L&T", "M&M"); and the NSE symbol, case-sensitive, when
 * it is long enough not to be a word.
 */
export function nameForms(companyName: string, symbol = ''): { names: string[]; symbol: string | null } {
  const base = searchName(companyName);
  const names = [base];
  const words = base.split(/\s+/);
  if (words.length >= 3 && !STOP.has(words[1].toLowerCase())) names.push(words.slice(0, 2).join(' '));
  const amp = /^(\w)\w*\s*&\s*(\w)\w*$/.exec(base);
  if (amp) names.push(`${amp[1]}&${amp[2]}`.toUpperCase());
  // HDFCBANK is never written in a headline; TCS, INFY and TMPV are.
  const sym =
    symbol.length >= 3 && symbol.length <= 6 && /^[A-Z&]+$/.test(symbol) && !names.includes(symbol) ? symbol : null;
  return { names: [...new Set(names.filter(Boolean))], symbol: sym };
}

/**
 * Words that turn a group name into a DIFFERENT listed company: "Tata Motors
 * Finance", "L&T Finance", "Tata Motors CV", "HDFC Life". Seen live: a Tata
 * Capital note mentioning "Tata Motors Finance" was credited to Tata Motors.
 */
const SIBLING_WORDS = [
  'finance', 'financial', 'capital', 'tech', 'technologies', 'securities', 'housing', 'life',
  'insurance', 'general', 'power', 'energy', 'green', 'holdings', 'investments?', 'ventures',
  'consumer', 'chemicals', 'steel', 'motors', 'bank', 'pharma', 'realty', 'infra\\w*', 'cv',
  'amc', 'mutual', 'elxsi', 'communications', 'ports', 'gas', 'wilmar', 'total',
];

export function aliasesOf(companyName: string, symbol = ''): RegExp[] {
  const { names, symbol: sym } = nameForms(companyName, symbol);
  const own = companyName.toLowerCase();
  const siblings = SIBLING_WORDS.filter((w) => !new RegExp(String.raw`\b${w}\b`).test(own));
  // Spelled out as [fF][iI]… so the check stays case-insensitive inside the
  // case-sensitive symbol pattern too.
  const anyCase = (s: string) => s.replace(/(?<!\\)[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
  const notSibling = siblings.length ? String.raw`(?!\s+(?:${siblings.map(anyCase).join('|')})\b)` : '';
  const word = (s: string, flags: string) =>
    new RegExp(
      String.raw`(?<![\w&])${esc(s).replace(/\s+/g, String.raw`\s+`).replace(/&/g, String.raw`\s?&\s?`)}(?![\w&])${notSibling}`,
      flags,
    );
  return [...names.map((n) => word(n, 'i')), ...(sym ? [word(sym, '')] : [])];
}

/** A Google News query term matching any of the company's name forms. */
export function searchQuery(companyName: string, symbol = ''): string {
  const { names, symbol: sym } = nameForms(companyName, symbol);
  const terms = [...names.map((n) => `"${n}"`), ...(sym ? [sym] : [])];
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
}

/** "Top picks", "15 stocks to buy", "stocks like TCS, Infosys and Wipro". */
const BASKET =
  /\b(?:top picks?|stocks? to (?:buy|sell|watch)|\d+\s+(?:\w+\s+){0,2}(?:stocks|shares|ideas|picks|names)|among|including|such as|list)\b/i;
/**
 * A headline that OPENS with a list of short names: "TCS, Infosys, HCL Tech
 * maintained at hold". Anchored at the start, because title-case headlines
 * are full of commas ("L&T Gearing For Growth, Valuation Attractive, Says
 * JPMorgan") that are not lists.
 */
const LEADING_LIST = /^\s*(?:[^\s,:;]+(?:\s+[^\s,:;]+){0,2}\s*,\s*){2,}/;
const isBasket = (text: string): boolean =>
  BASKET.test(text) || LEADING_LIST.test(text.replace(/(\d),(\d)/g, '$1$2'));

/** Business Today's column name, not an explainer. */
const COLUMN_PREFIX = /^\s*buy\s*,?\s*sell\s*(?:,|or)\s*hold\s*[:|–—-]\s*/i;

interface BrokerHit {
  def: BrokerDef;
  index: number;
  end: number;
}

function brokersIn(text: string, company: string): BrokerHit[] {
  const hits: BrokerHit[] = [];
  for (const def of BROKERS) {
    if (def.pattern.test(company)) continue;
    const m = def.pattern.exec(text);
    if (m && !hits.some((h) => h.def.name === def.name)) hits.push({ def, index: m.index, end: m.index + m[0].length });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Which brokers made the call. One named: that one. Several: the group
 * nearest the rating or target, where a group is names joined only by
 * commas/and ("Jefferies, CLSA upgrade X" credits both; "JPMorgan Neutral
 * ₹1,050 target and INFY 4th in CLSA AI" credits JPMorgan alone).
 */
function credited(text: string, hits: BrokerHit[], anchor: number): BrokerHit[] {
  if (hits.length <= 1) return hits;
  const groups: BrokerHit[][] = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && /^\s*(?:,|&|and|,\s*and)\s*$/i.test(text.slice(prev.end, h.index))) last.push(h);
    else groups.push([h]);
  }
  const dist = (g: BrokerHit[]) => Math.min(...g.map((h) => (anchor < h.index ? h.index - anchor : Math.max(0, anchor - h.end))));
  return groups.reduce((best, g) => (dist(g) < dist(best) ? g : best));
}

function firstIndex(text: string, res: RegExp[]): number {
  const found = res.map((r) => r.exec(text)?.index ?? -1).filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

/**
 * One headline → the broker calls it reports on THIS company, possibly none.
 *
 * `companyName`/`symbol` identify the covered company. When given, a call
 * counts only if the headline (or, for a multi-clause headline, the clause)
 * names the company — the live feed for Tata Motors carried calls on Tata
 * Capital, Tata Tech and M&M, each of which would otherwise be misattributed.
 */
export function parseBrokerCalls(
  h: { title: string; source: string; at: number; url: string },
  companyName = '',
  symbol = '',
): BrokerCall[] {
  const title = h.title.replace(COLUMN_PREFIX, '');
  const company = companyName.toLowerCase();
  const aliases = companyName ? aliasesOf(companyName, symbol) : [];

  // "Goldman maintains buy on X; Morgan Stanley retains equal weight on Y" is
  // two calls on two companies. Clauses are parsed alone when more than one
  // names a broker; otherwise the whole headline is one unit, because
  // "Buy HDFC Bank; target of Rs 950: Prabhudas Lilladher" splits badly.
  const clauses = title.split(/\s*;\s*/);
  const units = clauses.filter((c) => brokersIn(c, company).length).length >= 2 ? clauses : [title];

  const out: BrokerCall[] = [];
  for (const unit of units) {
    const hits = brokersIn(unit, company);
    if (!hits.length) continue;
    const mention = aliases.length ? firstIndex(unit, aliases) : 0;
    if (mention < 0) continue;

    const ratings = findRatings(unit);
    let hit = pickRating(unit, ratings);
    // "maintains 'BUY' on Groww, 'Underperform' on BSE": conflicting ratings,
    // resolved by the one sitting next to this company's name.
    if (!hit && ratings.length > 1 && aliases.length) {
      const near = ratings
        .map((r) => ({ r, d: Math.abs(r.index - mention) }))
        .sort((a, b) => a.d - b.d)[0];
      if (near.d <= 30) hit = near.r;
    }
    const action = parseAction(unit, hit !== null);
    const target = parseTarget(unit);
    const statedUpsidePct = parseStatedUpside(unit);
    if (!hit && !action && target === null && statedUpsidePct === null) continue;
    // A lone "maintains" with no rating and no price is too thin to show.
    if (!hit && target === null && statedUpsidePct === null && action === 'reiterate') continue;

    const anchor = hit?.index ?? firstIndex(unit, [/\b(?:target|tp)\b/i, /upside|downside/i, /upgrad|downgrad|coverage/i]);
    for (const b of credited(unit, hits, Math.max(0, anchor))) {
      out.push({
        broker: b.def.name,
        action,
        rating: hit?.rating ?? null,
        stance: hit?.stance ?? null,
        target,
        statedUpsidePct,
        upsidePct: null,
        basket: isBasket(unit),
        title: h.title,
        source: h.source,
        at: h.at,
        url: h.url,
        echoes: 1,
      });
    }
  }
  return out;
}

/**
 * Collapse syndication. The same note is carried by five outlets within a day;
 * it is one call, newest copy kept, with `echoes` counting the rest.
 */
export function dedupeCalls(calls: BrokerCall[], windowMs = 3 * 86_400_000): BrokerCall[] {
  const sorted = [...calls].sort((a, b) => b.at - a.at);
  const out: BrokerCall[] = [];
  for (const c of sorted) {
    const twin = out.find(
      (o) =>
        o.broker === c.broker &&
        Math.abs(o.at - c.at) <= windowMs &&
        (o.rating === c.rating || o.rating === null || c.rating === null) &&
        (o.target === c.target || o.target === null || c.target === null) &&
        (o.action === c.action || o.action === null || c.action === null),
    );
    if (!twin) {
      out.push({ ...c });
      continue;
    }
    twin.echoes += 1;
    // Keep the newest headline but fill blanks the older copy had.
    twin.rating ??= c.rating;
    twin.stance ??= c.stance;
    twin.target ??= c.target;
    twin.action ??= c.action;
    twin.statedUpsidePct ??= c.statedUpsidePct;
  }
  return out;
}

/**
 * Target vs price, with a sanity bound. A target under 0.3× or over 3× the
 * last close is almost certainly a misparse (an index level, a different share
 * class, a pre-split figure) and is dropped rather than shown as 200% upside.
 */
export function withUpside(calls: BrokerCall[], lastClose: number): BrokerCall[] {
  return calls.map((c) => {
    if (c.target === null || !(lastClose > 0)) return { ...c, upsidePct: null };
    const ratio = c.target / lastClose;
    if (ratio < 0.3 || ratio > 3) return { ...c, target: null, upsidePct: null };
    return { ...c, upsidePct: (ratio - 1) * 100 };
  });
}

export function summarise(calls: BrokerCall[], days: number): BrokerSummary {
  // Stance is tallied from each broker's latest SINGLE-STOCK call. A name in a
  // "top 15 picks" list is a weaker statement and is shown, not counted.
  const sorted = [...calls].sort((a, b) => b.at - a.at);
  const latest = new Map<string, BrokerCall>();
  for (const c of sorted) {
    if (!c.basket && !latest.has(c.broker)) latest.set(c.broker, c);
  }
  let bullish = 0;
  let neutral = 0;
  let bearish = 0;
  for (const c of latest.values()) {
    if (c.stance === 'bullish') bullish++;
    else if (c.stance === 'bearish') bearish++;
    else if (c.stance === 'neutral') neutral++;
  }
  const n = latest.size;
  const lists = new Set(sorted.filter((c) => c.basket && !latest.has(c.broker)).map((c) => c.broker)).size;
  const parts: string[] = [];
  if (n) {
    parts.push(
      `${n} broker${n === 1 ? '' : 's'} with a call in ${days} days` +
        (bullish + neutral + bearish ? ` — latest: ${bullish} bullish, ${neutral} neutral, ${bearish} bearish` : ''),
    );
  }
  if (lists) parts.push(`${lists} more only in a list of picks`);
  const note = parts.length
    ? `${parts.join('; ')}. Shown for reading; not used in the ranking.`
    : `No broker calls found in headlines over ${days} days.`;
  return { calls: sorted, bullish, neutral, bearish, note };
}

/**
 * Macro news → event types → what history says about that type.
 *
 * NEWS NEVER RAISES THE LEVEL ON ITS OWN. The research (MARKET_WEATHER.md)
 * measured 37 shock events: a war headline's median first day was −0.7% and
 * the index was back within about four sessions. What turned an event into a
 * real fall was a measurable escalator — oil staying above $90–100, foreign
 * money leaving — and those are tracked as numbers, not words. So a headline
 * only does two things here: it labels the event, and it pulls up that label's
 * history (median depth, recovery, the sectors that were hit and held).
 *
 * The labeller is keyword rules with conflict words, not sentiment. A day can
 * carry several labels (8 Oct 2026 was rates AND oil), because real shocks
 * overlap. A label is ACTIVE only when at least two different headlines in the
 * window carry it, so one stray story does not paint the screen.
 *
 * The per-label numbers are computed from EVENT_HISTORY by the calibration
 * script; the hit/held sector lists come from contemporaneous news reports and
 * are labelled as such.
 */
import { parseGoogleNews, type Headline } from '../recommender/news';
import { logger } from '../../utils/logger';
import { forwardReturn } from './series';

export type EventLabel =
  | 'war-indo-pak'
  | 'war-oil'
  | 'war-other'
  | 'oil-spike'
  | 'de-escalation'
  | 'rates'
  | 'fx'
  | 'election'
  | 'tax-policy'
  | 'positive-policy'
  | 'credit'
  | 'corporate'
  | 'trade'
  | 'global-financial'
  | 'sector-disruption';

interface Rule {
  label: EventLabel;
  /** Every group must match at least one pattern. */
  all: RegExp[];
  none?: RegExp[];
}

const CONFLICT = /\b(war|strike[sd]?|attack(s|ed)?|missiles?|drones?|bomb\w*|shell(ing)?|clash(es)?|escalat\w*|tension|retaliat\w*|military|troops|invasion|invades?|airstrikes?|terror\w*|hostilit\w*)\b/i;
/** Damage words: a shock label needs the headline to report harm, not just mention the topic. */
const DAMAGE = /\b(fall|falls|fell|slump\w*|plunge\w*|tumble\w*|crash\w*|sink\w*|slide\w*|drop\w*|tank\w*|rout|sell-?off|bloodbath|hit|hits|blow|fears?|worr\w+|jitters|lower|losses|lose|wipe\w*|bleed\w*|spooks?)\b/i;
/** A headline that reports gains is not a shock, whatever topic it names. */
const GAIN = /\b(rise|rises|rising|surge|surges|surged|rally|rallies|rallied|jump|jumps|jumped|gain|gains|gained|soar\w*|climb\w*|recover\w*|rebound\w*|cheer\w*|lifts?)\b/i;
const SPORT = /\b(cricket|hockey|football|match|tournament|trophy|squad|lineup|olympics?|asia cup|world cup)\b/i;
const TRUCE = /\b(cease-?fire|truce)\b/i;

const RULES: Rule[] = [
  { label: 'de-escalation', all: [/\b(cease-?fire|truce|peace (deal|talks|accord)|de-?escalat\w*|calm returns)\b/i], none: [SPORT] },
  {
    label: 'war-indo-pak',
    all: [/\b(pakistan|pak|loc|line of control|kashmir|pahalgam|pulwama|uri|balakot|operation sindoor)\b/i, CONFLICT],
    none: [SPORT, TRUCE],
  },
  {
    label: 'war-oil',
    all: [/\b(iran|israel|hormuz|gaza|hamas|hezbollah|houthis?|red sea|middle east|west asia|gulf|russia|ukraine)\b/i, CONFLICT],
    none: [SPORT, TRUCE],
  },
  { label: 'war-other', all: [/\b(china|taiwan|galwan|ladakh|arunachal)\b/i, CONFLICT], none: [SPORT, /\btrade war\b/i] },
  {
    // The oil word and the spike word must sit close together: "GIFT Nifty jumps … crude oil" is not an oil spike.
    label: 'oil-spike',
    all: [
      /\b(crude|brent|oil prices?)\W+(?:\w+\W+){0,4}?(surge[sd]?|spike[sd]?|jump(s|ed)?|soar(s|ed|ing)?|hits? (a )?record|highest|tops? \$?\d{2,3}|above \$?\d{2,3})|\b(surge|spike|jump|soar)\w*\W+(?:\w+\W+){0,3}?(in )?(crude|brent|oil prices?)\b/i,
    ],
  },
  {
    label: 'rates',
    all: [/\b(rbi|repo rate|monetary policy|mpc|rate hikes?|rate cuts?|hikes rates?|cuts rates?|fed|federal reserve|powell)\b/i],
  },
  {
    label: 'fx',
    all: [/\b(rupee|inr|forex reserves?)\b/i, /\b(record low|all-time low|lifetime low|slump\w*|plunge\w*|weakens?|depreciat\w*|falls?|tumbles?|slides?)\b/i],
    none: [/\brupee (gains|rises|recovers|strengthens|rebounds)\b/i],
  },
  {
    label: 'election',
    all: [/\b(election results?|exit polls?|poll results?|lok sabha (polls?|results?|elections?)|vote count(ing)?|hung (house|parliament))\b/i],
    none: [/\b(israel|us|american|trump)\b/i],
  },
  {
    label: 'tax-policy',
    // A tax going UP is the shock itself, so "hiked" / "raised" count as damage here.
    all: [
      /\b(budget|ltcg|stcg|capital gains tax|securities transaction tax|stt|demoneti[sz]ation|sebi (curbs?|rules?|ban|norms)|f&o (curbs?|rules?|norms))\b/i,
      new RegExp(`${DAMAGE.source}|\\b(hike[sd]?|raised?|increase[sd]?)\\b`, 'i'),
    ],
  },
  { label: 'positive-policy', all: [/\b(corporate tax cut|gst (rate )?cuts?|stimulus|relief package|tax relief)\b/i] },
  {
    label: 'credit',
    all: [/\b(default(s|ed)?|insolvency|bankrupt\w*|liquidity crisis|il&fs|ilfs|nbfc crisis|bad loans|rating downgrade)/i],
    none: [/\bby default\b/i],
  },
  { label: 'corporate', all: [/\b(hindenburg|short[- ]sellers?|accounting fraud|ed raids?|sebi probe|governance concerns?)\b/i] },
  {
    label: 'trade',
    all: [
      /\b(tariffs?|trade war|export curbs?|import duty|sanctions?)\b/i,
      new RegExp(`${DAMAGE.source}|\\b(announces?|imposes?|slaps?|\\d+% tariffs?)\\b`, 'i'),
    ],
  },
  {
    label: 'global-financial',
    all: [/\b(wall street|dow jones|nasdaq|s&p 500|global (sell-?off|markets?|rout)|recession|banking crisis|bank collapse|yen carry|contagion|lehman)\b/i, DAMAGE],
    none: [GAIN],
  },
  {
    label: 'sector-disruption',
    all: [
      /\b(ai|artificial intelligence|automation|h-?1b|visa fee)\b/i,
      /\b(it stocks|it services|it sector|nifty it|tcs|infosys|wipro|hcl|tech mahindra|outsourcing)\b/i,
      DAMAGE,
    ],
    none: [GAIN],
  },
];

/** Labels for one headline. Pure. */
export function classifyHeadline(title: string): EventLabel[] {
  const out: EventLabel[] = [];
  for (const r of RULES) {
    if (r.none?.some((x) => x.test(title))) continue;
    if (r.all.every((x) => x.test(title))) out.push(r.label);
  }
  return out;
}

export interface LabelledHeadline extends Pick<Headline, 'title' | 'source' | 'at' | 'url'> {
  labels: EventLabel[];
}

export interface ActiveEvent {
  label: EventLabel;
  headlines: LabelledHeadline[];
}

export const MIN_HEADLINES = 2;

/** Labels carried by at least MIN_HEADLINES distinct headlines. Pure. */
export function activeEvents(headlines: LabelledHeadline[], min = MIN_HEADLINES): ActiveEvent[] {
  const by = new Map<EventLabel, LabelledHeadline[]>();
  const seen = new Set<string>();
  for (const h of headlines) {
    const key = h.title.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const l of h.labels) by.set(l, [...(by.get(l) ?? []), h]);
  }
  return [...by]
    .filter(([, hs]) => hs.length >= min)
    .map(([label, hs]) => ({ label, headlines: hs.sort((a, b) => b.at - a.at) }))
    .sort((a, b) => b.headlines.length - a.headlines.length);
}

// ── History ────────────────────────────────────────────────────────────────

export interface HistoricEvent {
  date: string;
  label: EventLabel;
  name: string;
}

/**
 * First trading day of impact for each catalogued event (research agent's
 * catalogue, 2026-10-09; weekend and after-hours news moved to the next
 * session). Where a date was uncertain, the more widely cited day is used.
 */
export const EVENT_HISTORY: HistoricEvent[] = [
  { date: '1999-05-26', label: 'war-indo-pak', name: 'Kargil (Operation Vijay)' },
  { date: '2001-09-12', label: 'global-financial', name: '9/11 attacks' },
  { date: '2001-12-13', label: 'war-indo-pak', name: 'Parliament attack' },
  { date: '2003-03-20', label: 'war-oil', name: 'Iraq invasion' },
  { date: '2004-05-14', label: 'election', name: '2004 election surprise' },
  { date: '2008-09-15', label: 'global-financial', name: 'Lehman collapse' },
  { date: '2008-11-28', label: 'war-indo-pak', name: '26/11 Mumbai attacks' },
  { date: '2009-05-18', label: 'election', name: '2009 clear majority' },
  { date: '2011-08-08', label: 'global-financial', name: 'US credit downgrade' },
  { date: '2013-05-23', label: 'rates', name: 'Taper tantrum' },
  { date: '2013-08-28', label: 'fx', name: 'Rupee record low 68.85' },
  { date: '2015-08-24', label: 'global-financial', name: 'China devaluation sell-off' },
  { date: '2016-09-29', label: 'war-indo-pak', name: 'Uri surgical strikes' },
  { date: '2016-11-09', label: 'tax-policy', name: 'Demonetisation' },
  { date: '2018-02-02', label: 'tax-policy', name: 'LTCG tax in Budget' },
  { date: '2018-09-21', label: 'credit', name: 'IL&FS / DHFL' },
  { date: '2019-02-15', label: 'war-indo-pak', name: 'Pulwama attack' },
  { date: '2019-02-26', label: 'war-indo-pak', name: 'Balakot strike' },
  { date: '2019-09-20', label: 'positive-policy', name: 'Corporate tax cut' },
  { date: '2020-03-23', label: 'global-financial', name: 'COVID lockdown' },
  { date: '2020-06-16', label: 'war-other', name: 'Galwan clash' },
  { date: '2022-02-24', label: 'war-oil', name: 'Russia invades Ukraine' },
  { date: '2023-01-27', label: 'corporate', name: 'Hindenburg on Adani' },
  { date: '2023-03-13', label: 'global-financial', name: 'SVB collapse' },
  { date: '2023-10-09', label: 'war-oil', name: 'Hamas attack on Israel' },
  { date: '2024-04-15', label: 'war-oil', name: 'Iran drones on Israel' },
  { date: '2024-06-04', label: 'election', name: '2024 result' },
  { date: '2024-07-23', label: 'tax-policy', name: 'Budget capital gains / STT hike' },
  { date: '2024-08-05', label: 'global-financial', name: 'Yen carry unwind' },
  { date: '2024-10-03', label: 'war-oil', name: 'Iran missiles + SEBI F&O curbs' },
  { date: '2025-04-07', label: 'trade', name: 'US "Liberation Day" tariffs' },
  { date: '2025-04-23', label: 'war-indo-pak', name: 'Pahalgam attack' },
  { date: '2025-05-07', label: 'war-indo-pak', name: 'Operation Sindoor' },
  { date: '2025-05-12', label: 'de-escalation', name: 'India–Pakistan ceasefire' },
  { date: '2025-06-13', label: 'war-oil', name: 'Israel strikes Iran' },
  { date: '2025-08-28', label: 'trade', name: 'US 50% tariff on India' },
  { date: '2025-09-22', label: 'sector-disruption', name: 'US $100k H-1B fee' },
  { date: '2026-02-24', label: 'sector-disruption', name: 'AI scare hits Indian IT' },
  { date: '2026-03-02', label: 'war-oil', name: 'US/Israel–Iran war' },
  { date: '2026-04-08', label: 'de-escalation', name: 'US–Iran ceasefire' },
  { date: '2026-07-08', label: 'war-oil', name: 'Truce collapses' },
  { date: '2026-10-08', label: 'rates', name: 'RBI surprise hike, Brent $104' },
];

/**
 * Labels with no catalogued events of their own borrow the closest type's
 * history, and the screen says so. A crude spike is how an oil-region war
 * reaches Indian prices, so it reads the war-oil record.
 */
export const HISTORY_ALIAS: Partial<Record<EventLabel, EventLabel>> = { 'oil-spike': 'war-oil' };

/** What contemporaneous reports said moved on impact day. Qualitative. */
export const SECTOR_REPORTS: Record<EventLabel, { title: string; hit: string; held: string }> = {
  'war-indo-pak': { title: 'India–Pakistan / terror', hit: 'Aviation, tourism (weak evidence)', held: 'Defence: HAL, BEL, BDL (strong since 2019)' },
  'war-oil': { title: 'Middle East / oil-region war', hit: 'Oil marketing (BPCL, HPCL, IOC), aviation, paints, tyres, chemicals, autos', held: 'ONGC, Oil India, defence' },
  'war-other': { title: 'China border', hit: 'Briefly broad', held: 'Defence' },
  'oil-spike': { title: 'Crude spike', hit: 'Oil marketing, aviation, paints, tyres', held: 'Upstream oil (ONGC, Oil India)' },
  'de-escalation': { title: 'Ceasefire / de-escalation', hit: 'Defence (gives back gains)', held: 'Aviation, banks, autos lead the relief rally' },
  rates: { title: 'Rate hike / yields', hit: 'Banks, NBFCs, realty, autos', held: 'IT, pharma when the rupee is weak' },
  fx: { title: 'Rupee slide', hit: 'Importers, oil marketing, NBFCs', held: 'IT, pharma (exporters)' },
  election: { title: 'Election surprise', hit: 'PSUs, power, defence, capital goods (policy themes)', held: 'FMCG, consumer' },
  'tax-policy': { title: 'Tax / market-rule change', hit: 'Brokers, exchanges, depositories; the directly taxed', held: 'Index mostly flat' },
  'positive-policy': { title: 'Pro-growth policy', hit: 'IT, pharma lag', held: 'Banks, autos, consumer lead' },
  credit: { title: 'Credit event', hit: 'NBFCs, housing finance, realty', held: 'IT, pharma' },
  corporate: { title: 'Corporate governance shock', hit: 'The named group, its lenders', held: 'IT, FMCG' },
  trade: { title: 'Tariffs / trade', hit: 'Exporters: textiles, shrimp, gems, auto parts', held: 'Domestic consumption' },
  'global-financial': { title: 'Global financial shock', hit: 'Banks, NBFCs, metals, realty', held: 'FMCG, pharma, IT (relatively)' },
  'sector-disruption': { title: 'US / AI hit to IT', hit: 'IT services', held: 'Domestic sectors' },
};

/**
 * Which stocks a type of shock usually hit or helped ON IMPACT, by symbol and
 * by NSE industry, with the reason in plain words. Drawn from the same reports
 * as SECTOR_REPORTS. This is a description of past impact days, used as one tag
 * among several in the stock lists; it is never a trade on its own.
 */
export interface Impact {
  symbols: string[];
  industries: string[];
  why: string;
}
export const EVENT_IMPACT: Partial<Record<EventLabel, { hit?: Impact; held?: Impact }>> = {
  'war-oil': {
    hit: {
      symbols: ['BPCL', 'IOC', 'HINDPETRO', 'INDIGO', 'ASIANPAINT', 'BERGEPAINT', 'MRF', 'APOLLOTYRE', 'CEATLTD', 'PIDILITIND'],
      industries: [],
      why: 'they buy crude or crude-based raw materials, so a war that lifts oil raises their costs',
    },
    held: {
      symbols: ['ONGC', 'OIL', 'HAL', 'BEL', 'BDL', 'MAZDOCK', 'COALINDIA'],
      industries: [],
      why: 'they sell oil or fuel, or supply defence, so the same war tends to help them',
    },
  },
  'oil-spike': {
    hit: {
      symbols: ['BPCL', 'IOC', 'HINDPETRO', 'INDIGO', 'ASIANPAINT', 'BERGEPAINT', 'MRF', 'APOLLOTYRE', 'CEATLTD'],
      industries: [],
      why: 'costlier crude squeezes companies that buy it',
    },
    held: { symbols: ['ONGC', 'OIL'], industries: [], why: 'they sell crude, so a higher price lifts their earnings' },
  },
  'war-indo-pak': {
    hit: { symbols: ['INDIGO'], industries: [], why: 'airspace closures and travel fears hit airlines' },
    held: { symbols: ['HAL', 'BEL', 'BDL', 'MAZDOCK', 'COCHINSHIP', 'DATAPATTNS'], industries: [], why: 'defence makers have rallied on India–Pakistan tension since 2019' },
  },
  rates: {
    hit: {
      symbols: ['BAJFINANCE', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'BAJAJFINSV'],
      industries: ['Realty'],
      why: 'higher interest rates raise borrowing costs for lenders and make home loans and project funding dearer',
    },
    held: { symbols: [], industries: ['Healthcare', 'Fast Moving Consumer Goods'], why: 'demand for medicines and daily essentials barely depends on loan rates' },
  },
  fx: {
    hit: { symbols: ['BPCL', 'IOC', 'HINDPETRO', 'INDIGO'], industries: [], why: 'a weaker rupee makes imported fuel dearer' },
    held: { symbols: [], industries: ['Information Technology', 'Healthcare'], why: 'they earn in dollars, so a weaker rupee raises their rupee income' },
  },
  credit: {
    hit: { symbols: ['BAJFINANCE', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'PFC', 'RECLTD'], industries: ['Realty'], why: 'lenders and builders suffer first when credit dries up' },
  },
  trade: { hit: { symbols: [], industries: ['Textiles'], why: 'tariffs hit exporters directly' } },
  'global-financial': {
    hit: { symbols: [], industries: ['Metals & Mining', 'Realty'], why: 'global sell-offs hit commodity and property stocks hardest' },
    held: { symbols: [], industries: ['Fast Moving Consumer Goods', 'Healthcare'], why: 'people keep buying essentials and medicines in any market' },
  },
  'sector-disruption': {
    hit: { symbols: [], industries: ['Information Technology'], why: 'the shock is aimed at IT services itself' },
  },
};

export interface EventMove {
  date: string;
  label: EventLabel;
  name: string;
  firstDayPct: number;
  d20Pct: number | null;
  worst60Pct: number;
  /** Trading days until the index closed back at its pre-event level; null if it has not. */
  recoveryDays: number | null;
}

export interface LabelHistory {
  label: EventLabel;
  events: number;
  medianFirstDayPct: number | null;
  medianWorst60Pct: number | null;
  medianRecoveryDays: number | null;
  /** Share of events where the index was higher 60 sessions later. */
  higherAfter60: number | null;
}

/** Measure each historic event on an index. Pure. */
export function measureEvents(dates: string[], close: number[], events = EVENT_HISTORY): EventMove[] {
  const out: EventMove[] = [];
  for (const e of events) {
    const i = dates.findIndex((d) => d >= e.date);
    if (i < 1) continue;
    const before = close[i - 1];
    let low = close[i];
    for (let j = i; j < Math.min(close.length, i + 60); j++) low = Math.min(low, close[j]);
    let rec: number | null = null;
    for (let j = i; j < close.length; j++) {
      if (close[j] >= before) {
        rec = j - i;
        break;
      }
    }
    const d20 = forwardReturn(close, i - 1, 20);
    out.push({
      ...e,
      firstDayPct: r1((close[i] / before - 1) * 100),
      d20Pct: d20 == null ? null : r1(d20 * 100),
      worst60Pct: r1((low / before - 1) * 100),
      recoveryDays: rec,
    });
  }
  return out;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

export function labelHistory(moves: EventMove[], dates: string[], close: number[]): LabelHistory[] {
  const labels = [...new Set(moves.map((m) => m.label))];
  return labels.map((label) => {
    const ms = moves.filter((m) => m.label === label);
    const after60 = ms
      .map((m) => {
        const i = dates.findIndex((d) => d >= m.date);
        return forwardReturn(close, i - 1, 60);
      })
      .filter((x): x is number => x != null);
    return {
      label,
      events: ms.length,
      medianFirstDayPct: median(ms.map((m) => m.firstDayPct)),
      medianWorst60Pct: median(ms.map((m) => m.worst60Pct)),
      // An event not yet recovered counts as the longest wait, not as missing.
      medianRecoveryDays: median(ms.map((m) => m.recoveryDays ?? 10_000)),
      higherAfter60: after60.length ? after60.filter((x) => x > 0).length / after60.length : null,
    };
  });
}

// ── Live feed ──────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export const MACRO_QUERIES = [
  'Sensex Nifty',
  'RBI repo rate',
  'crude oil price India',
  'India Pakistan',
  'Iran Israel war',
  'rupee dollar',
  'FPI selling India',
  'US tariff India',
  'SEBI F&O OR capital gains tax',
  'NBFC default OR liquidity',
  'IT stocks AI',
  'Wall Street sell-off',
];

/** Headlines for every macro query over the last `days`, labelled. Failed queries are reported, not retried. */
export async function fetchMacroHeadlines(days = 3): Promise<{ headlines: LabelledHeadline[]; errors: string[] }> {
  const headlines: LabelledHeadline[] = [];
  const errors: string[] = [];
  for (const q of MACRO_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const h of parseGoogleNews(await res.text(), 20)) {
        const labels = classifyHeadline(h.title);
        if (labels.length) headlines.push({ title: h.title, source: h.source, at: h.at, url: h.url, labels });
      }
    } catch (e) {
      errors.push(`${q}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (errors.length) logger.warn(`macro news: ${errors.length} of ${MACRO_QUERIES.length} queries failed`);
  return { headlines: headlines.sort((a, b) => b.at - a.at), errors };
}

// ── FII / DII flows ────────────────────────────────────────────────────────

export interface FlowDay {
  date: string;
  fiiNet: number | null;
  diiNet: number | null;
}

/**
 * NSE's daily FII/DII cash-market figure (₹ crore). NSE serves only the latest
 * day, so history accumulates forward from when this first ran. FII flows
 * mostly FOLLOW returns in India (MARKET_WEATHER.md), so this describes a fall
 * while it happens; it is not an early warning. Pure.
 */
export function parseFiiDii(body: unknown, nseDate: (s: unknown) => string | null): FlowDay | null {
  if (!Array.isArray(body)) return null;
  let date: string | null = null;
  let fii: number | null = null;
  let dii: number | null = null;
  for (const r of body as Record<string, unknown>[]) {
    const cat = String(r.category ?? '').toUpperCase();
    const net = Number(String(r.netValue ?? '').replace(/,/g, ''));
    date = date ?? nseDate(r.date);
    if (!Number.isFinite(net)) continue;
    if (cat.includes('FII') || cat.includes('FPI')) fii = net;
    else if (cat.includes('DII')) dii = net;
  }
  return date ? { date, fiiNet: fii, diiNet: dii } : null;
}

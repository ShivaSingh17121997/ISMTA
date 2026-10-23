/**
 * NSE market events: surveillance lists (ASM, GSM, ESM) and each book's
 * results calendar. Feeds the engine's entry blocks (`accumulator/events.ts`)
 * and the per-symbol warnings the UI shows.
 *
 * Verified 2026-10-06: all four endpoints answer a browser User-Agent with
 * a Referer, no cookie:
 *   /api/reportASM    { longterm: { data: [...] }, shortterm: { data: [...] } }
 *   /api/reportGSM    [ { symbol, gsmStage, survDesc } ]
 *   /api/reportESM    [ { symbol, esmSurvIndicator, survDesc } ]
 *   /api/event-calendar?index=equities&symbol=X
 *                     [ { symbol, purpose, bm_desc, date: "29-Jul-2026" } ]
 *
 * Fails safe in the useful direction: if NSE cannot be read, the last good
 * lists are kept; with none at all, nothing is blocked (and the UI says the
 * data is missing) rather than every buy stopping on a network error.
 */
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { istParts } from './session';
import type { Surveillance } from './accumulator/events';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/' };
const LISTS_TTL_MS = 6 * 3_600_000;
const CALENDAR_TTL_MS = 12 * 3_600_000;

export interface CalendarEvent {
  /** YYYY-MM-DD */
  date: string;
  purpose: string;
  detail: string;
  results: boolean;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "29-Jul-2026" (or "29-Jul-2026 08:07:02") → "2026-07-29"; null if unreadable. */
export function nseDate(s: unknown): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s ?? '').trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

/** Merge the three surveillance payloads into one map by symbol. Pure. */
export function parseSurveillance(asm: unknown, gsm: unknown, esm: unknown): Map<string, Surveillance> {
  const out = new Map<string, Surveillance>();
  const put = (symbol: unknown, key: keyof Surveillance, label: unknown) => {
    const sym = String(symbol ?? '').trim().toUpperCase();
    const text = String(label ?? '').trim();
    if (!sym || !text) return;
    const prev = out.get(sym) ?? {};
    out.set(sym, { ...prev, [key]: prev[key] ? `${prev[key]}; ${text}` : text });
  };
  const a = asm as { longterm?: { data?: unknown[] }; shortterm?: { data?: unknown[] } } | null;
  for (const [term, rows] of [['long-term', a?.longterm?.data], ['short-term', a?.shortterm?.data]] as const) {
    for (const r of (rows ?? []) as Record<string, unknown>[]) put(r.symbol, 'asm', `${term} ${r.asmSurvIndicator ?? r.survCode ?? ''}`.trim());
  }
  for (const r of (Array.isArray(gsm) ? gsm : []) as Record<string, unknown>[]) put(r.symbol, 'gsm', r.gsmStage ?? r.survCode);
  for (const r of (Array.isArray(esm) ? esm : []) as Record<string, unknown>[]) put(r.symbol, 'esm', r.esmSurvIndicator ?? r.survCode);
  return out;
}

/** Board-meeting events for one symbol, newest first. Pure. */
export function parseCalendar(body: unknown, symbol: string): CalendarEvent[] {
  if (!Array.isArray(body)) return [];
  const sym = symbol.toUpperCase();
  const out: CalendarEvent[] = [];
  for (const r of body as Record<string, unknown>[]) {
    if (String(r.symbol ?? '').toUpperCase() !== sym) continue;
    const date = nseDate(r.date);
    if (!date) continue;
    const purpose = String(r.purpose ?? '').trim();
    const detail = String(r.bm_desc ?? '').trim();
    out.push({ date, purpose, detail, results: /result/i.test(purpose) || /financial result/i.test(detail) });
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}

/** Latest results day on or before `today`. Pure. */
export function lastResultsDay(events: CalendarEvent[], today: string): string | undefined {
  return events.find((e) => e.results && e.date <= today)?.date;
}

/** Events from `today` to `today + days`, soonest first. Pure. */
export function upcoming(events: CalendarEvent[], today: string, days = 14): CalendarEvent[] {
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return events.filter((e) => e.date >= today && e.date <= until).sort((x, y) => x.date.localeCompare(y.date));
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`https://www.nseindia.com${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NSE ${path} HTTP ${res.status}`);
  return res.json();
}

/** One symbol's board-meeting calendar straight from NSE (no cache). For the backtest. */
export async function fetchCalendar(symbol: string): Promise<CalendarEvent[]> {
  return parseCalendar(await getJson(`/api/event-calendar?index=equities&symbol=${encodeURIComponent(symbol.toUpperCase())}`), symbol);
}

export class MarketEventsService {
  private lists: Map<string, Surveillance> | null = null;
  private listsAt = 0;
  private calendars = new Map<string, { at: number; events: CalendarEvent[] }>();
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  start(everyMs = 30 * 60_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read whatever is stale: the lists every 6h, each book's calendar every 12h. */
  async refresh(now = Date.now()): Promise<void> {
    if (now - this.listsAt > LISTS_TTL_MS) {
      try {
        const [asm, gsm, esm] = await Promise.all([getJson('/api/reportASM'), getJson('/api/reportGSM'), getJson('/api/reportESM')]);
        const parsed = parseSurveillance(asm, gsm, esm);
        // An empty read is a failed read, not a market where nothing is watched.
        if (parsed.size === 0) throw new Error('surveillance lists came back empty');
        this.lists = parsed;
        this.listsAt = now;
        this.lastError = null;
        logger.info(`Market events: ${parsed.size} symbols under NSE surveillance`);
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        logger.warn(`Market events: surveillance lists not refreshed (${this.lastError}); keeping the last good copy`);
      }
    }
    const symbols = [...new Set([...store.accumulatorBooks.values()].map((b) => b.symbol.toUpperCase()))];
    for (const sym of symbols) {
      const hit = this.calendars.get(sym);
      if (hit && now - hit.at < CALENDAR_TTL_MS) continue;
      await this.calendar(sym, now);
    }
  }

  /** One symbol's board-meeting calendar, cached. Never throws. */
  async calendar(symbol: string, now = Date.now()): Promise<CalendarEvent[]> {
    const sym = symbol.toUpperCase();
    const hit = this.calendars.get(sym);
    if (hit && now - hit.at < CALENDAR_TTL_MS) return hit.events;
    try {
      const events = parseCalendar(await getJson(`/api/event-calendar?index=equities&symbol=${encodeURIComponent(sym)}`), sym);
      this.calendars.set(sym, { at: now, events });
      return events;
    } catch (e) {
      logger.warn(`Market events: calendar for ${sym} not read (${e instanceof Error ? e.message : e})`);
      return hit?.events ?? [];
    }
  }

  /** Surveillance stages for a symbol, from the last good read. */
  surveillance(symbol: string): Surveillance | undefined {
    return this.lists?.get(symbol.toUpperCase());
  }

  /** Latest results day on or before `now`, from the cached calendar. */
  lastResultsDay(symbol: string, now = Date.now()): string | undefined {
    const events = this.calendars.get(symbol.toUpperCase())?.events ?? [];
    return lastResultsDay(events, istParts(now).date);
  }

  /** Everything the UI shows for one symbol. */
  async flags(symbol: string, now = Date.now()) {
    const sym = symbol.toUpperCase();
    const events = await this.calendar(sym, now);
    const today = istParts(now).date;
    const s = this.surveillance(sym);
    const next = upcoming(events, today);
    const warnings: string[] = [];
    if (s?.asm) warnings.push(`On NSE ASM (${s.asm})`);
    if (s?.gsm) warnings.push(`On NSE GSM (stage ${s.gsm})`);
    if (s?.esm) warnings.push(`On NSE ESM (${s.esm})`);
    for (const e of next) warnings.push(`${e.results ? 'Results' : e.purpose || 'Board meeting'} on ${e.date}`);
    return {
      symbol: sym,
      ...(s?.asm ? { asm: s.asm } : {}),
      ...(s?.gsm ? { gsm: s.gsm } : {}),
      ...(s?.esm ? { esm: s.esm } : {}),
      lastResultsDay: lastResultsDay(events, today) ?? null,
      upcoming: next.map((e) => ({ kind: e.results ? 'results' : 'other', date: e.date, detail: e.purpose || e.detail })),
      warnings,
      listsReadAt: this.listsAt || null,
      error: this.lists ? null : this.lastError ?? 'surveillance lists not loaded yet',
    };
  }
}

export const marketEvents = new MarketEventsService();

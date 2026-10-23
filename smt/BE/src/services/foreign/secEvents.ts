/**
 * Company events from SEC 8-K filings, read from the structured item codes in
 * `data.sec.gov/submissions/CIK##########.json` (`filings.recent.items`),
 * verified 2026-10-14 (NVDA: 2.02 results, 5.02 officer change, 1.01 material
 * agreement). Item codes are the company's own legal classification of the
 * event, so nothing is guessed from text.
 *
 * RED items withhold money (the same role as the news veto): they are the
 * events after which a "cheap" price is usually information, not a discount.
 *   1.03 bankruptcy or receivership
 *   2.04 an event that accelerates a debt obligation
 *   3.01 notice of delisting or failing a listing rule
 *   4.02 past financial statements should no longer be relied on
 * AMBER items are shown, never acted on: they need reading, not a rule.
 *
 * Foreign companies listed through ADRs file 6-K/20-F instead, so they have no
 * 8-K items; the card says so rather than showing "no events".
 */
import { cachedJson, SEC_UA } from './http';

export type EventLevel = 'red' | 'amber' | 'info';

export const ITEMS: Record<string, { text: string; level: EventLevel }> = {
  '1.01': { text: 'signed a material agreement', level: 'info' },
  '1.02': { text: 'ended a material agreement', level: 'amber' },
  '1.03': { text: 'bankruptcy or receivership', level: 'red' },
  '1.05': { text: 'material cybersecurity incident', level: 'amber' },
  '2.01': { text: 'completed an acquisition or sale of assets', level: 'info' },
  '2.02': { text: 'reported results', level: 'info' },
  '2.03': { text: 'took on a material new debt', level: 'info' },
  '2.04': { text: 'an event that speeds up repayment of a debt', level: 'red' },
  '2.05': { text: 'restructuring or exit costs', level: 'amber' },
  '2.06': { text: 'material write-down (impairment)', level: 'amber' },
  '3.01': { text: 'delisting notice or failed a listing rule', level: 'red' },
  '3.02': { text: 'sold new shares privately (dilution)', level: 'amber' },
  '3.03': { text: 'changed shareholders’ rights', level: 'amber' },
  '4.01': { text: 'changed auditor', level: 'amber' },
  '4.02': { text: 'past accounts can no longer be relied on', level: 'red' },
  '5.01': { text: 'change in control', level: 'amber' },
  '5.02': { text: 'director or senior officer joined or left', level: 'amber' },
  '5.03': { text: 'changed its articles or bylaws', level: 'info' },
  '5.07': { text: 'shareholder vote results', level: 'info' },
  '7.01': { text: 'investor disclosure (Reg FD)', level: 'info' },
  '8.01': { text: 'other event', level: 'info' },
};

export interface SecEvent {
  date: string;
  item: string;
  text: string;
  level: EventLevel;
}

export interface SecEventsRead {
  /** Newest first, within the window; exhibits-only (9.01) dropped. */
  events: SecEvent[];
  red: SecEvent[];
}

interface Submissions {
  filings?: { recent?: { form?: string[]; filingDate?: string[]; items?: string[] } };
}

/** Parse a submissions body into events since `since` (YYYY-MM-DD). Pure. */
export function parseSubmissions(body: Submissions | null, since: string): SecEventsRead {
  const r = body?.filings?.recent;
  const events: SecEvent[] = [];
  if (r?.form && r.filingDate && r.items) {
    for (let i = 0; i < r.form.length; i++) {
      if (!/^8-K/.test(r.form[i]) || r.filingDate[i] < since) continue;
      for (const raw of String(r.items[i] ?? '').split(',')) {
        const item = raw.trim();
        if (!item || item === '9.01') continue;
        const def = ITEMS[item] ?? { text: `item ${item}`, level: 'info' as const };
        events.push({ date: r.filingDate[i], item, text: def.text, level: def.level });
      }
    }
  }
  events.sort((a, b) => b.date.localeCompare(a.date));
  return { events, red: events.filter((e) => e.level === 'red') };
}

export async function loadSecEvents(cik: number, days = 90, opts: { force?: boolean } = {}): Promise<SecEventsRead | null> {
  const id = String(cik).padStart(10, '0');
  const body = await cachedJson<Submissions>(`https://data.sec.gov/submissions/CIK${id}.json`, `sec/sub_${id}.json`, {
    ttlMs: 24 * 3_600_000,
    headers: { 'User-Agent': SEC_UA },
    gapMs: 150,
    force: opts.force,
  });
  if (!body) return null;
  return parseSubmissions(body, new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
}

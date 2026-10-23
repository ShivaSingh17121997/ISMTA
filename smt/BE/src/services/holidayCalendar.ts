/**
 * NSE's published trading-holiday list, merged into the session calendar.
 *
 * The built-in list in services/session is one year long and goes stale every
 * January. This reads NSE's own holiday master (capital-market segment) at boot
 * and daily, so a new year's calendar arrives as soon as NSE publishes it. If
 * NSE is unreachable the built-in list still stands; if the CURRENT year has no
 * known closures at all, a human is told once a day — a missing calendar makes
 * the bot sit out nothing on a real holiday (harmless: no ticks) but it should
 * not go unnoticed.
 */
import { logger } from '../utils/logger';
import { notifier } from './Notifier';
import { addHolidays, holidayCalendarKnown, istParts } from './session';

const URL = 'https://www.nseindia.com/api/holiday-master?type=trading';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const REFRESH_MS = 24 * 3_600_000;
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** NSE's `CM` rows (`tradingDate: "15-Jan-2026"`) → YYYY-MM-DD. Pure; unparseable rows are dropped. */
export function parseNseHolidays(body: unknown): string[] {
  const cm = (body as { CM?: unknown })?.CM;
  if (!Array.isArray(cm)) return [];
  const out: string[] = [];
  for (const row of cm) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String((row as { tradingDate?: unknown })?.tradingDate ?? '').trim());
    const month = m && MONTHS[m[2].toLowerCase()];
    if (m && month) out.push(`${m[3]}-${month}-${m[1].padStart(2, '0')}`);
  }
  return out;
}

class HolidayCalendar {
  private timer: NodeJS.Timeout | null = null;

  async refresh(now = Date.now()): Promise<void> {
    try {
      const res = await fetch(URL, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const dates = parseNseHolidays(await res.json());
      const added = addHolidays(dates);
      logger.info(`NSE holiday calendar: ${dates.length} closures read, ${added} new`);
    } catch (e) {
      logger.warn(`NSE holiday calendar unavailable (${e instanceof Error ? e.message : e}) — using the built-in list`);
    }
    const year = Number(istParts(now).date.slice(0, 4));
    if (!holidayCalendarKnown(year)) {
      void notifier.alert(
        'warn',
        `holidays:${year}`,
        `No NSE holiday calendar is loaded for ${year}. Add closures with NSE_HOLIDAYS in BE/.env until NSE's list loads.`,
        REFRESH_MS,
      );
    }
  }

  start(): void {
    // The boot refresh is awaited by the caller; this only schedules the daily ones.
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const holidayCalendar = new HolidayCalendar();

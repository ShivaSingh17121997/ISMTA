/**
 * NSE trading session — the concept the NTB spec does not have.
 *
 * NTB was built for a 24/7 crypto market. NSE intraday is DEFINED by its
 * session, and ignoring that costs real money:
 *
 *  - An MIS position still open at 15:25 is force-closed by the broker at an
 *    uncontrolled price, outside the engine's knowledge, for ₹50 + 18% GST
 *    (₹59) per order. The trailing stop never gets to fire.
 *  - From 2026-08-03 the Closing Auction Session blocks fresh order entry
 *    15:15–15:20 and FREEZES MARKET ORDERS 15:25–15:30 for F&O-eligible scrips.
 *    A market exit at 15:25 on RELIANCE would simply be rejected.
 *
 * So the engine must flatten on its own terms, early, and never enter a position
 * it has no time to manage.
 *
 * All times are IST (UTC+5:30, no DST — India does not observe daylight saving).
 * Pure except for `config`; every function takes an explicit timestamp so
 * backtest and live behave identically.
 *
 * Sources (verified July 2026): NSE market timings; Zerodha auto square-off
 * timings (equity 15:25, revised from 15:20 in Dec 2025); NSE Closing Auction
 * Session circular effective 2026-08-03; NSE 2026 trading holidays.
 */
import { config } from '../config';
import { isFnoEligible } from './nse';

const IST_OFFSET_MS = 5.5 * 3_600_000;

export type MarketPhase =
  | 'closed' // weekend, holiday, or outside all sessions
  | 'pre_open' // 09:00–09:15 — order entry/matching, no continuous trading
  | 'open' // 09:15–15:30 — continuous trading
  | 'post_close'; // 15:40–16:00 — market orders only

export interface IstParts {
  /** YYYY-MM-DD in IST */
  date: string;
  /** 0=Sun … 6=Sat, in IST */
  dayOfWeek: number;
  /** minutes since IST midnight */
  minutes: number;
}

/** Decompose a UTC epoch into IST parts. */
export function istParts(time: number): IstParts {
  // Shift into IST, then read UTC getters — avoids any host-timezone dependency,
  // so this behaves the same on a Mumbai laptop and a UTC container.
  const d = new Date(time + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    dayOfWeek: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** "HH:MM" → minutes since midnight. */
export function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

const toHHMM = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// ─── Fixed NSE session boundaries ──────────────────────────────────────
const PRE_OPEN_START = hhmm('09:00');
const MARKET_OPEN = hhmm('09:15');
const MARKET_CLOSE = hhmm('15:30');
const POST_CLOSE_START = hhmm('15:40');
const POST_CLOSE_END = hhmm('16:00');

// ─── Closing Auction Session (effective 2026-08-03, F&O-eligible only) ──
/** First IST date the CAS applies. Before this, these rules are inert. */
const CAS_EFFECTIVE_DATE = '2026-08-03';
const CAS_ENTRY_BLOCKED_FROM = hhmm('15:15'); // fresh order entry blocked
const CAS_ENTRY_BLOCKED_TO = hhmm('15:20');
const CAS_MKT_FROZEN_FROM = hhmm('15:25'); // market orders frozen
const CAS_MKT_FROZEN_TO = hhmm('15:30');

/**
 * NSE equity trading holidays.
 *
 * ⚠️ THIS LIST GOES STALE. It is the 2026 calendar; NSE publishes a new one each
 * year and adds ad-hoc closures (elections, national mourning). Override or
 * extend with NSE_HOLIDAYS="YYYY-MM-DD,YYYY-MM-DD". A wrong entry here means the
 * bot either trades a closed market (harmless — no ticks) or sits out a real
 * session (costly). Refresh it every January.
 */
const HOLIDAYS_2026 = [
  '2026-01-15', // Municipal Corporation Election - Maharashtra
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali - Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
];

// NSE_HOLIDAYS EXTENDS the built-in list (an ad-hoc closure is an addition,
// never a reason to forget the published calendar). NSE's own holiday master
// is merged in at runtime by services/holidayCalendar.
const holidays = new Set(
  [...HOLIDAYS_2026, ...(process.env.NSE_HOLIDAYS ? process.env.NSE_HOLIDAYS.split(',') : [])]
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Merge more YYYY-MM-DD closures into the calendar. Returns how many were new. */
export function addHolidays(dates: string[]): number {
  let added = 0;
  for (const d of dates) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !holidays.has(d)) {
      holidays.add(d);
      added++;
    }
  }
  return added;
}

/** True when at least one closure is known for `year` — i.e. its calendar has been loaded. */
export function holidayCalendarKnown(year: number): boolean {
  const prefix = `${year}-`;
  for (const d of holidays) if (d.startsWith(prefix)) return true;
  return false;
}

export function isHoliday(time: number): boolean {
  return holidays.has(istParts(time).date);
}

/**
 * Weekday and not a listed holiday.
 *
 * Muhurat trading (a one-hour evening session on Diwali, often a weekend or a
 * listed holiday) is deliberately NOT traded: the day reads as closed, so the
 * engine sits it out. That is the safe side — a skipped hour costs nothing,
 * while trading a thin, unusual session under no-loss rules buys nothing.
 */
export function isTradingDay(time: number): boolean {
  const { dayOfWeek } = istParts(time);
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return !isHoliday(time);
}

/**
 * When money from a sale on `time` becomes spendable.
 *
 * Indian equities and ETFs settle T+1 — the NEXT TRADING day, which is why this
 * walks the calendar instead of adding 24 hours: T+1 across a Friday is Monday,
 * and across a Friday before a Monday holiday it is Tuesday. Treating unsettled
 * proceeds as spendable lets a strategy buy with money the exchange has not
 * delivered, which flatters a backtest and cannot be reproduced live.
 */
export function nextTradingDayStart(time: number): number {
  const DAY_MS = 24 * 3_600_000;
  // Midnight IST of the day containing `time`, expressed as a UTC epoch.
  let cursor = Date.parse(`${istParts(time).date}T00:00:00Z`) - IST_OFFSET_MS;
  for (let i = 0; i < 30; i++) {
    cursor += DAY_MS;
    if (isTradingDay(cursor)) return cursor;
  }
  throw new Error(
    `No trading day within 30 days of ${istParts(time).date} — the holiday list is wrong`,
  );
}

export function phaseAt(time: number): MarketPhase {
  if (!isTradingDay(time)) return 'closed';
  const { minutes } = istParts(time);
  if (minutes >= PRE_OPEN_START && minutes < MARKET_OPEN) return 'pre_open';
  if (minutes >= MARKET_OPEN && minutes < MARKET_CLOSE) return 'open';
  if (minutes >= POST_CLOSE_START && minutes < POST_CLOSE_END) return 'post_close';
  return 'closed';
}

export function isMarketOpen(time: number): boolean {
  return phaseAt(time) === 'open';
}

export interface Gate {
  ok: boolean;
  reason?: string;
}

/**
 * May a NEW position be opened now?
 *
 * Three reasons to say no, all of them about time rather than price:
 *  1. The market isn't in continuous trading.
 *  2. We're inside the opening spike — the first minutes are the widest spreads
 *     and the least trustworthy prints of the day.
 *  3. We're close enough to the flatten time that the trade would be closed on
 *     the clock rather than on its merits. Entering there is paying a round trip
 *     to hold a lottery ticket for a few minutes.
 */
export function canEnter(time: number): Gate {
  const phase = phaseAt(time);
  if (phase !== 'open') return { ok: false, reason: `market ${phase}` };

  const { minutes } = istParts(time);
  const open = hhmm(config.session.entryOpensAt);
  const close = hhmm(config.session.entryClosesAt);

  if (minutes < open) {
    return { ok: false, reason: `opening volatility window (entries from ${config.session.entryOpensAt})` };
  }
  if (minutes >= close) {
    return { ok: false, reason: `too close to square-off (entries stop at ${config.session.entryClosesAt})` };
  }
  return { ok: true };
}

/**
 * Must open MIS positions be flattened NOW, on our terms?
 *
 * True from `flattenAt` until the close. Default 15:10 — deliberately ahead of
 * both the CAS entry block (15:15) and the broker's square-off (15:25), because
 * being late costs ₹59/order AND surrenders the exit price to the broker.
 */
export function mustFlatten(time: number): boolean {
  if (!isTradingDay(time)) return false;
  const { minutes } = istParts(time);
  return minutes >= hhmm(config.session.flattenAt) && minutes < MARKET_CLOSE;
}

/** Is the CAS in force for this symbol at this time? */
function casActive(time: number, symbol: string): boolean {
  const { date } = istParts(time);
  // String compare is safe for ISO dates.
  return date >= CAS_EFFECTIVE_DATE && isFnoEligible(symbol);
}

/**
 * Can we place a MARKET order for `symbol` right now?
 *
 * The CAS freezes market orders 15:25–15:30 for F&O-eligible scrips, which is
 * exactly when a naive bot would be scrambling to beat the 15:25 square-off. The
 * flatten window (15:10) exists to keep us out of this entirely; this is the
 * backstop that stops us firing an order the exchange will reject.
 */
export function canPlaceMarketOrder(time: number, symbol: string): Gate {
  if (!casActive(time, symbol)) return { ok: true };
  const { minutes } = istParts(time);
  if (minutes >= CAS_MKT_FROZEN_FROM && minutes < CAS_MKT_FROZEN_TO) {
    return {
      ok: false,
      reason: `closing auction: market orders frozen ${toHHMM(CAS_MKT_FROZEN_FROM)}–${toHHMM(CAS_MKT_FROZEN_TO)} for F&O scrips`,
    };
  }
  return { ok: true };
}

/** Is fresh order entry blocked by the CAS (15:15–15:20)? */
export function orderEntryBlocked(time: number, symbol: string): Gate {
  if (!casActive(time, symbol)) return { ok: true };
  const { minutes } = istParts(time);
  if (minutes >= CAS_ENTRY_BLOCKED_FROM && minutes < CAS_ENTRY_BLOCKED_TO) {
    return {
      ok: false,
      reason: `closing auction: order entry blocked ${toHHMM(CAS_ENTRY_BLOCKED_FROM)}–${toHHMM(CAS_ENTRY_BLOCKED_TO)}`,
    };
  }
  return { ok: true };
}

/**
 * Would the broker auto-square-off an MIS position at this time?
 * Used by the backtester to charge the penalty a bot that overstays would pay.
 */
export function pastSquareOff(time: number): boolean {
  return istParts(time).minutes >= hhmm(config.session.squareOffAt);
}

/** Human-readable session state, for logs and the risk dashboard. */
export function describe(time: number): string {
  const { date, minutes } = istParts(time);
  return `${date} ${toHHMM(minutes)} IST (${phaseAt(time)})`;
}

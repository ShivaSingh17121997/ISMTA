/**
 * Entry blocks from market events. Pure.
 *
 * A dip-buyer with no stop-loss must be careful about WHICH dips it buys.
 * Price moves that come with news tend to continue; moves without news tend to
 * reverse (Chan, JFE 2003; Dai, Medhat, Novy-Marx & Rizova, FAJ 2024, who
 * exclude earnings windows from reversal trades for this reason). And a stock
 * that NSE puts under surveillance is a red flag for a strategy that can never
 * cut a loss. So three things block NEW rungs, never exits:
 *
 *   surveillance  the stock is on NSE's ASM, GSM or ESM list
 *   results       a results board meeting happened today or in the last N
 *                 sessions: the news is still being priced
 *   gap-down      the stock opened gapPct or more under the previous close,
 *                 most likely on news, today or in the last N sessions
 *
 * Buying BEFORE results is deliberately not blocked: returns are higher on
 * average in announcement months (Barber et al., JFE 2013), so a blanket
 * pre-results blackout would give that up.
 */
import { istParts, isTradingDay } from '../session';

export interface EventVetoParams {
  /** Block new rungs while the stock is on an NSE surveillance list. */
  surveillance: boolean;
  /** Sessions after a results board meeting to wait (the day itself always counts). 0 = off. */
  resultsSessions: number;
  /** Opening this far under the previous close, percent, counts as a gap-down. 0 = off. */
  gapPct: number;
  /** Sessions after a gap-down to wait. */
  gapSessions: number;
}

/** Surveillance stage labels, as NSE prints them. Absent = not on that list. */
export interface Surveillance {
  asm?: string;
  gsm?: string;
  esm?: string;
}

const DAY_MS = 86_400_000;

/**
 * Trading sessions from `fromDay` (YYYY-MM-DD, IST) to `now`: 0 on the day
 * itself, 1 on the next trading day, and so on. Weekends and NSE holidays do
 * not count. Negative when `fromDay` is in the future.
 */
export function sessionsSince(fromDay: string, now: number): number {
  const start = Date.parse(`${fromDay}T06:00:00Z`); // noon IST: safely inside the day
  if (!Number.isFinite(start)) return Number.POSITIVE_INFINITY;
  if (start > now + DAY_MS) return -1;
  let n = 0;
  for (let t = start + DAY_MS; t <= now + DAY_MS / 2; t += DAY_MS) {
    if (isTradingDay(t)) n++;
    if (n > 60) break;
  }
  return n;
}

/** Did today's first price open at least `gapPct` under the previous close? */
export function isGapDown(previousClose: number | undefined, price: number, gapPct: number): boolean {
  return gapPct > 0 && !!previousClose && previousClose > 0 && price <= previousClose * (1 - gapPct / 100);
}

/**
 * The first 15 minutes of the session (09:15–09:30 IST). Only a first price
 * seen in this window stands for the open: one first seen at 13:00 (a late
 * start, a feed outage) is an intraday fall, and calling it a gap would block
 * entries on a move that may have had no news at all.
 */
export const OPENING_WINDOW = { from: 9 * 60 + 15, to: 9 * 60 + 30 };

export function inOpeningWindow(now: number): boolean {
  const m = istParts(now).minutes;
  return m >= OPENING_WINDOW.from && m <= OPENING_WINDOW.to;
}

/** One line naming the surveillance stage, or null when the stock is clean. */
export function surveillanceLabel(s: Surveillance | undefined): string | null {
  if (!s) return null;
  const parts = [s.asm && `ASM ${s.asm}`, s.gsm && `GSM ${s.gsm}`, s.esm && `ESM ${s.esm}`].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Why new rungs are blocked right now, or null. */
export function entryBlock(input: {
  now: number;
  params: EventVetoParams;
  surveillance?: Surveillance;
  /** Latest results board meeting on or before today, YYYY-MM-DD. */
  lastResultsDay?: string;
  /** Latest day the stock gapped down at the open, YYYY-MM-DD. */
  gapDownDay?: string;
}): string | null {
  const { now, params: p } = input;
  if (p.surveillance) {
    const label = surveillanceLabel(input.surveillance);
    if (label) return `On NSE surveillance (${label}): no new rungs until it is lifted`;
  }
  if (p.resultsSessions > 0 && input.lastResultsDay) {
    const n = sessionsSince(input.lastResultsDay, now);
    if (n >= 0 && n <= p.resultsSessions) {
      return `Results on ${input.lastResultsDay}: waiting ${p.resultsSessions} session(s) for the news to be priced before buying a dip`;
    }
  }
  if (p.gapPct > 0 && p.gapSessions >= 0 && input.gapDownDay) {
    const n = sessionsSince(input.gapDownDay, now);
    if (n >= 0 && n <= p.gapSessions) {
      return `Opened ${p.gapPct}%+ down on ${input.gapDownDay}, likely on news: waiting ${p.gapSessions} session(s) before buying`;
    }
  }
  return null;
}

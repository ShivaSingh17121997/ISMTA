'use client';

import { useEffect, useState } from 'react';
import { IST_OFFSET_MS, istYmd } from './ist';
import type { SessionPhase } from './types';

/**
 * A clock that is safe to read during render.
 *
 * `Date.now()` in a component body is impure — two renders of identical props
 * disagree — and this project's `react-hooks/purity` rule rejects it. That is
 * not pedantry here: "held for 14d" is derived from the clock, and a value
 * that changes on every incidental re-render is exactly the class of bug the
 * rule exists to catch.
 *
 * So the clock is read in an effect and re-read on an interval. Every render
 * within one tick sees the same instant.
 *
 * Returns 0 until the first tick lands, one frame after mount. Callers must
 * treat 0 as "not measured yet" rather than as the epoch — a 1970 date is the
 * one wrong answer this hook can produce if that is ignored.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    // Both writes sit in timer callbacks: a synchronous setState in an effect
    // body is what `react-hooks/set-state-in-effect` forbids.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}

// ─── IST wall clock ───────────────────────────────────────
//
// The exchange runs on IST and so does every timestamp this app shows. These
// helpers shift by the fixed offset and read UTC getters, so they give the
// same answer on a Mumbai laptop and a UTC container. No `Date.now()` here:
// every function takes the instant explicitly, so they are pure and safe to
// call during render with a `useNow()` value.

const DAY_MS = 86_400_000;
const PRE_OPEN_START = 9 * 60; // 09:00
const MARKET_OPEN = 9 * 60 + 15; // 09:15
const MARKET_CLOSE = 15 * 60 + 30; // 15:30
const POST_CLOSE_START = 15 * 60 + 40; // 15:40
const POST_CLOSE_END = 16 * 60; // 16:00

export interface IstClock {
  /** YYYY-MM-DD */
  date: string;
  /** 0=Sun … 6=Sat */
  dayOfWeek: number;
  /** minutes since IST midnight */
  minutes: number;
  hh: number;
  mm: number;
  ss: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function istClock(ts: number): IstClock {
  const d = new Date(ts + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    dayOfWeek: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

/** "11:02:45" (or "11:02" without seconds). */
export function istTime(ts: number, seconds = true): string {
  const c = istClock(ts);
  return seconds ? `${pad(c.hh)}:${pad(c.mm)}:${pad(c.ss)}` : `${pad(c.hh)}:${pad(c.mm)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "11 Sep 2026, 11:02:45" */
export function istDateTime(ts: number, seconds = true): string {
  const { y, m, d } = istYmd(ts);
  return `${d} ${MONTHS[m]} ${y}, ${istTime(ts, seconds)}`;
}

/** "Fri 11 Sep" */
export function istDayLabel(ts: number): string {
  const { m, d } = istYmd(ts);
  return `${DAYS[istClock(ts).dayOfWeek]} ${d} ${MONTHS[m]}`;
}

/** Epoch ms of IST midnight of the day containing `ts`. */
export function istMidnight(ts: number): number {
  const { y, m, d } = istYmd(ts);
  return Date.UTC(y, m, d) - IST_OFFSET_MS;
}

/**
 * The session phase at `ts`, given whether the day is a trading day (only the
 * server knows the holiday list; the boundaries are fixed NSE timings).
 */
export function phaseFor(ts: number, tradingDay: boolean): SessionPhase {
  if (!tradingDay) return 'closed';
  const { minutes } = istClock(ts);
  if (minutes >= PRE_OPEN_START && minutes < MARKET_OPEN) return 'pre_open';
  if (minutes >= MARKET_OPEN && minutes < MARKET_CLOSE) return 'open';
  if (minutes >= POST_CLOSE_START && minutes < POST_CLOSE_END) return 'post_close';
  return 'closed';
}

/**
 * Epoch ms of the next 09:15 IST open. Skips weekends; future holidays are not
 * known client-side, so the answer can be a day early across one. Today's own
 * holiday status comes from the server via `tradingDay`.
 */
export function nextOpenAt(ts: number, tradingDay: boolean): number {
  const { minutes } = istClock(ts);
  const midnight = istMidnight(ts);
  if (tradingDay && minutes < MARKET_OPEN) return midnight + MARKET_OPEN * 60_000;
  let cursor = midnight + DAY_MS;
  for (let i = 0; i < 10; i++) {
    const dow = istClock(cursor).dayOfWeek;
    if (dow !== 0 && dow !== 6) break;
    cursor += DAY_MS;
  }
  return cursor + MARKET_OPEN * 60_000;
}

/** "2d 4h", "5h 12m", "42m", "30s" — for countdowns and ages. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

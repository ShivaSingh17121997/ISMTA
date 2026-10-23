/**
 * IST calendar helpers.
 *
 * Every date in this app is an NSE trading day, and an NSE trading day is an
 * IST day: the backend's day highs, the allocator's trading day and T+1
 * settlement are all computed in IST. The frontend must bucket the same way,
 * or a 15:20 IST sale lands on the wrong square for anyone whose browser is
 * not in India.
 *
 * Shift by the offset, then read UTC getters. No dependency on the host
 * timezone, which is exactly the point.
 */

export const IST_OFFSET_MS = 5.5 * 3_600_000;

export interface Ymd {
  y: number;
  /** 0-based, like `Date#getMonth`. */
  m: number;
  d: number;
}

/** Calendar fields of a timestamp in IST. */
export function istYmd(ts: number): Ymd {
  const t = new Date(ts + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

export function sameDay(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

export function sameMonth(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m;
}

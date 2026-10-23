// Display formatting helpers (INR-aware).

export function inr(n: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function num(n: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function pct(n: number, decimals = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

export function pnlColor(n: number): string {
  if (n > 0) return 'text-emerald-500';
  if (n < 0) return 'text-rose-500';
  return 'text-zinc-400';
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString('en-IN', { hour12: false });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * '2026-09-11' → '11 Sep' (or '11 Sep 26' when `withYear`).
 *
 * Lives here rather than in NavChart so a page can format a day without pulling
 * Recharts in with it. NavChart re-exports it, so existing callers are
 * unaffected.
 */
export function dayLabel(day: string, withYear = false): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${String(y).slice(2)}` : ''}`;
}

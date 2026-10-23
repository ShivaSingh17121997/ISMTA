/**
 * Execution quality — what happened between "decided" and "filled".
 *
 * Fill and rejection counts, slippage against the reference price, broker
 * latency, and rejection reasons grouped by their leading clause so that
 * "market closed" on Monday and "market closed" on Tuesday are one row.
 * Guard and risk refusals never become orders, so they come from the audit
 * trail, not the order book; without them the fill rate would flatter a bot
 * whose every attempt was turned away before it reached the broker.
 *
 * Pure: orders, audit entries and the clock are inputs.
 */
import { AuditEntry, Order } from '../../types';
import { istParts } from '../session';

const DAY_MS = 86_400_000;

export interface ExecutionReport {
  totals: {
    orders: number;
    filled: number;
    rejected: number;
    cancelled: number;
    pending: number;
    /** orders whose quantity the risk gate trimmed or a repair touched */
    adjusted: number;
    /** refusals that never became orders (guards + risk gate) */
    refused: number;
    /** filled / (filled + rejected + refused); null with nothing to measure */
    fillRatePct: number | null;
  };
  /** last 30 IST days, oldest first, zero days included */
  byDay: { day: string; filled: number; rejected: number; cancelled: number; refused: number }[];
  byTag: { tag: string; n: number; filled: number; rejected: number; cancelled: number }[];
  slippage: { n: number; meanBps: number | null; medianBps: number | null; p90Bps: number | null; worstBps: number | null };
  latency: { n: number; meanMs: number | null; p90Ms: number | null; maxMs: number | null };
  rejections: { reason: string; n: number; fromOrders: number; fromGuards: number; fromRisk: number; example: string }[];
  adjusted: { id: string; symbol: string; side: string; requested: number | null; quantity: number; adjustment: string; createdAt: number }[];
}

const round = (n: number, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
  return s[rank - 1];
}

/** 'accumulator:e0l3' → 'accumulator'; undefined → 'untagged'. */
export function tagFamily(tag: string | undefined): string {
  const t = (tag ?? '').trim();
  if (!t) return 'untagged';
  return t.split(':')[0].toLowerCase();
}

/**
 * The leading clause of a rejection, numbers stripped, so variants of one
 * cause collapse into one row: "3 consecutive losses — halted" and "4
 * consecutive losses — halted" both key to "consecutive losses".
 */
export function reasonKey(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^(BUY|SELL)\s+\d+\s+(refused|rejected)\s*:\s*/i, '');
  s = s.replace(/^broker threw\s*:\s*/i, '');
  s = s.split(/[:;(—]|\s-\s/)[0];
  s = s
    .replace(/[₹$]?\d[\d,.%]*[a-z]?/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const words = s.split(' ').filter(Boolean).slice(0, 6);
  return words.join(' ') || 'unspecified';
}

function auditReasonKey(e: AuditEntry): string {
  const code = e.data && typeof e.data.code === 'string' ? e.data.code : '';
  if (e.kind === 'guard' && code) return code.replace(/_/g, ' ');
  return reasonKey(e.detail);
}

export function computeExecution(orders: Order[], audit: AuditEntry[], now: number): ExecutionReport {
  const filledOrders = orders.filter((o) => o.status === 'FILLED');
  const rejectedOrders = orders.filter((o) => o.status === 'REJECTED');
  const cancelled = orders.filter((o) => o.status === 'CANCELLED').length;
  const pending = orders.filter((o) => o.status === 'PENDING').length;
  const refusals = audit.filter((e) => e.kind === 'guard' || e.kind === 'risk');
  const measured = filledOrders.length + rejectedOrders.length + refusals.length;

  // ── by day, last 30 IST days ──
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(istParts(now - i * DAY_MS).date);
  const dayIdx = new Map(days.map((d, i) => [d, i] as const));
  const byDay = days.map((day) => ({ day, filled: 0, rejected: 0, cancelled: 0, refused: 0 }));
  for (const o of orders) {
    const i = dayIdx.get(istParts(o.createdAt).date);
    if (i === undefined) continue;
    if (o.status === 'FILLED') byDay[i].filled++;
    else if (o.status === 'REJECTED') byDay[i].rejected++;
    else if (o.status === 'CANCELLED') byDay[i].cancelled++;
  }
  for (const e of refusals) {
    const i = dayIdx.get(istParts(e.at).date);
    if (i !== undefined) byDay[i].refused++;
  }

  // ── by tag family ──
  const tagMap = new Map<string, { tag: string; n: number; filled: number; rejected: number; cancelled: number }>();
  for (const o of orders) {
    const tag = tagFamily(o.tag);
    const row = tagMap.get(tag) ?? { tag, n: 0, filled: 0, rejected: 0, cancelled: 0 };
    row.n++;
    if (o.status === 'FILLED') row.filled++;
    else if (o.status === 'REJECTED') row.rejected++;
    else if (o.status === 'CANCELLED') row.cancelled++;
    tagMap.set(tag, row);
  }
  const byTag = [...tagMap.values()].sort((a, b) => b.n - a.n);

  // ── slippage, signed against the trader (positive = worse) ──
  const slips = filledOrders
    .map((o) => o.slippageBps)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  const slippage = {
    n: slips.length,
    meanBps: slips.length ? round(mean(slips), 2) : null,
    medianBps: slips.length ? round(median(slips), 2) : null,
    p90Bps: slips.length ? round(percentile(slips, 90), 2) : null,
    worstBps: slips.length ? round(Math.max(...slips), 2) : null,
  };

  // ── latency: submitted → acknowledged ──
  const lats = orders
    .filter((o) => typeof o.submittedAt === 'number' && typeof o.ackAt === 'number' && o.ackAt! >= o.submittedAt!)
    .map((o) => o.ackAt! - o.submittedAt!);
  const latency = {
    n: lats.length,
    meanMs: lats.length ? round(mean(lats), 1) : null,
    p90Ms: lats.length ? round(percentile(lats, 90), 1) : null,
    maxMs: lats.length ? Math.max(...lats) : null,
  };

  // ── rejection reasons, grouped ──
  const reasons = new Map<string, ExecutionReport['rejections'][number]>();
  const bump = (key: string, from: 'orders' | 'guard' | 'risk', example: string) => {
    const row = reasons.get(key) ?? { reason: key, n: 0, fromOrders: 0, fromGuards: 0, fromRisk: 0, example };
    row.n++;
    if (from === 'orders') row.fromOrders++;
    else if (from === 'guard') row.fromGuards++;
    else row.fromRisk++;
    reasons.set(key, row);
  };
  for (const o of rejectedOrders) bump(reasonKey(o.rejectionReason ?? ''), 'orders', o.rejectionReason ?? 'no reason given');
  for (const e of refusals) bump(auditReasonKey(e), e.kind === 'guard' ? 'guard' : 'risk', e.detail);
  const rejections = [...reasons.values()].sort((a, b) => b.n - a.n);

  // ── adjusted orders ──
  const adjustedOrders = orders.filter((o) => typeof o.adjustment === 'string' && o.adjustment.trim() !== '');
  const adjusted = adjustedOrders.slice(0, 20).map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    requested: o.requestedQuantity ?? null,
    quantity: o.quantity,
    adjustment: o.adjustment!,
    createdAt: o.createdAt,
  }));

  return {
    totals: {
      orders: orders.length,
      filled: filledOrders.length,
      rejected: rejectedOrders.length,
      cancelled,
      pending,
      adjusted: adjustedOrders.length,
      refused: refusals.length,
      fillRatePct: measured ? round((filledOrders.length / measured) * 100, 1) : null,
    },
    byDay,
    byTag,
    slippage,
    latency,
    rejections,
    adjusted,
  };
}

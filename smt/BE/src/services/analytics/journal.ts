/**
 * Trade journal — every outcome in one table, with the two questions a
 * journal exists to answer kept front and centre: which setups pay, and
 * whether the operator's overrides beat the system they override.
 *
 * Rows come from two books that never net against each other: the strategy
 * engine's trades (valid AND invalid — an artefact is kept and struck through,
 * never deleted) and the accumulator's closed lots, each tagged 'accumulator'
 * so they sit in the by-tag report beside the strategies.
 *
 * R-multiple is P&L over the rupees the stop put at risk. It is only defined
 * when a stop was known; a lot has no stop by construction, so it is null there
 * and the average R for 'accumulator' reads null rather than a flattering 0.
 *
 * Pure: trades, books, notes and the lookup for an order's tag are inputs.
 */
import { JournalNote, Trade } from '../../types';
import type { AccumulatorBook, ClosedLot } from '../accumulator/types';
import { istParts } from '../session';

const DAY_MS = 86_400_000;

export interface JournalRow {
  id: string;
  source: 'trade' | 'lot';
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'OPEN' | 'CLOSED';
  entry: number;
  exit: number | null;
  quantity: number;
  /** net of charges; null while open */
  pnl: number | null;
  charges: number;
  tags: string[];
  openedAt: number;
  closedAt: number | null;
  holdMs: number | null;
  maePct: number | null;
  mfePct: number | null;
  stopLoss: number | null;
  rMultiple: number | null;
  exitReason: string | null;
  invalid: boolean;
  invalidReason: string | null;
  note: JournalNote | null;
}

export interface TagSummary {
  tag: string;
  n: number;
  pnl: number;
  winRatePct: number;
  avgR: number | null;
  avgHoldDays: number;
}

export interface OverrideSummary {
  n: number;
  pnl: number;
  winRatePct: number;
}

export interface JournalFilter {
  tag?: string;
  /** YYYY-MM-DD, IST, inclusive */
  from?: string;
  to?: string;
}

export interface JournalReport {
  rows: JournalRow[];
  /** every tag seen in the date range, before the tag filter */
  tags: string[];
  byTag: TagSummary[];
  overridesVsSystem: { manual: OverrideSummary; system: OverrideSummary };
  filter: JournalFilter;
  counts: { total: number; closed: number; open: number; invalid: number; lots: number; shown: number };
}

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** What left the account beyond the shares' price, both legs. */
export function lotCharges(l: ClosedLot): number {
  return Math.max(0, l.quoteSpent - l.fillPrice * l.quantity) + Math.max(0, l.sellPrice * l.quantity - l.proceeds);
}

/** P&L per rupee the stop put at risk. Null when no stop was known. */
export function rMultiple(pnl: number, entry: number, stopLoss: number | undefined, quantity: number): number | null {
  if (stopLoss == null || !(stopLoss > 0) || !(entry > 0) || !(quantity > 0)) return null;
  const risk = Math.abs(entry - stopLoss) * quantity;
  if (!(risk > 0)) return null;
  return round(pnl / risk, 2);
}

/** An operator override: a manual ticket, or a flatten the operator forced. */
export function isOverride(tags: string[]): boolean {
  return tags.some((t) => /manual|flatten/i.test(t));
}

export function tagMatches(rowTag: string, filterTag: string): boolean {
  return rowTag === filterTag || rowTag.startsWith(`${filterTag}:`);
}

export function tradeRow(t: Trade, note: JournalNote | undefined, entryTag: string | undefined): JournalRow {
  const closed = t.status === 'CLOSED';
  const closedAt = closed ? (t.closedAt ?? null) : null;
  const tags = t.tags && t.tags.length ? t.tags : [entryTag ?? 'manual'];
  return {
    id: t.id,
    source: 'trade',
    symbol: t.symbol,
    side: t.side,
    status: t.status,
    entry: t.entryPrice,
    exit: closed ? (t.exitPrice ?? null) : null,
    quantity: t.quantity,
    pnl: closed ? t.pnl : null,
    charges: t.charges ?? 0,
    tags,
    openedAt: t.openedAt,
    closedAt,
    holdMs: closedAt != null ? closedAt - t.openedAt : null,
    maePct: t.maePct ?? null,
    mfePct: t.mfePct ?? null,
    stopLoss: t.stopLoss ?? null,
    rMultiple: closed ? rMultiple(t.pnl, t.entryPrice, t.stopLoss, t.quantity) : null,
    exitReason: t.exitReason ?? null,
    invalid: !!t.invalid,
    invalidReason: t.invalidReason ?? null,
    note: note ?? null,
  };
}

export function lotRow(symbol: string, l: ClosedLot, note: JournalNote | undefined): JournalRow {
  return {
    id: `lot:${l.id}`,
    source: 'lot',
    symbol,
    side: 'BUY',
    status: 'CLOSED',
    entry: l.fillPrice,
    exit: l.sellPrice,
    quantity: l.quantity,
    pnl: l.pnl,
    charges: round(lotCharges(l), 2),
    tags: ['accumulator'],
    openedAt: l.openedAt,
    closedAt: l.closedAt,
    holdMs: l.closedAt - l.openedAt,
    maePct: null,
    mfePct: null,
    stopLoss: null,
    rMultiple: null,
    exitReason: l.armed ? 'trailing' : 'take_profit',
    invalid: false,
    invalidReason: null,
    note: note ?? null,
  };
}

function summarise(rows: JournalRow[]): OverrideSummary {
  const n = rows.length;
  const wins = rows.filter((r) => (r.pnl ?? 0) > 0).length;
  return {
    n,
    pnl: round(rows.reduce((s, r) => s + (r.pnl ?? 0), 0), 2),
    winRatePct: n ? round((wins / n) * 100, 1) : 0,
  };
}

export function buildJournal(args: {
  trades: Trade[];
  books: AccumulatorBook[];
  noteFor: (id: string) => JournalNote | undefined;
  entryTagFor: (orderId: string) => string | undefined;
  filter?: JournalFilter;
}): JournalReport {
  const filter = args.filter ?? {};
  const all: JournalRow[] = [];
  for (const t of args.trades) all.push(tradeRow(t, args.noteFor(t.id), args.entryTagFor(t.entryOrderId)));
  for (const b of args.books) for (const l of b.closedLots) all.push(lotRow(b.symbol, l, args.noteFor(`lot:${l.id}`)));
  all.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));

  // The date window applies to everything; the tag only narrows the table, so
  // the by-tag report and the override comparison stay comparable across tags.
  const inWindow = all.filter((r) => {
    const day = istParts(r.closedAt ?? r.openedAt).date;
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
    return true;
  });
  const rows = filter.tag ? inWindow.filter((r) => r.tags.some((t) => tagMatches(t, filter.tag!))) : inWindow;

  const scored = inWindow.filter((r) => r.status === 'CLOSED' && !r.invalid);
  const tagSet = new Set<string>();
  for (const r of inWindow) for (const t of r.tags) tagSet.add(t);

  const byTag: TagSummary[] = [...tagSet]
    .map((tag) => {
      const rs = scored.filter((r) => r.tags.includes(tag));
      const wins = rs.filter((r) => (r.pnl ?? 0) > 0).length;
      const rValues = rs.map((r) => r.rMultiple).filter((x): x is number => x != null);
      const holds = rs.map((r) => r.holdMs).filter((x): x is number => x != null);
      return {
        tag,
        n: rs.length,
        pnl: round(rs.reduce((s, r) => s + (r.pnl ?? 0), 0), 2),
        winRatePct: rs.length ? round((wins / rs.length) * 100, 1) : 0,
        avgR: rValues.length ? round(rValues.reduce((s, x) => s + x, 0) / rValues.length, 2) : null,
        avgHoldDays: holds.length ? round(holds.reduce((s, x) => s + x, 0) / holds.length / DAY_MS, 2) : 0,
      };
    })
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));

  return {
    rows,
    tags: [...tagSet].sort(),
    byTag,
    overridesVsSystem: {
      manual: summarise(scored.filter((r) => isOverride(r.tags))),
      system: summarise(scored.filter((r) => !isOverride(r.tags))),
    },
    filter,
    counts: {
      total: all.length,
      closed: all.filter((r) => r.status === 'CLOSED').length,
      open: all.filter((r) => r.status === 'OPEN').length,
      invalid: all.filter((r) => r.invalid).length,
      lots: all.filter((r) => r.source === 'lot').length,
      shown: rows.length,
    },
  };
}

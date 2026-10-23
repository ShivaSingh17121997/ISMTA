/**
 * Corporate actions. Mandatory for this engine, not an edge case.
 *
 * The accumulator holds lots for months or years. Over that horizon a split,
 * a bonus issue or a dividend is not a possibility, it is a certainty. And an
 * unadjusted split is uniquely dangerous HERE, in a way it is not for a normal
 * strategy:
 *
 *   A 1:5 split turns a ₹1,000 share into five ₹200 shares. A lot recorded as
 *   "75 shares bought at ₹1,000" now marks against a ₹200 price and shows an
 *   80% loss that never happened. A strategy with a stop-loss would book that
 *   fake loss and move on. This one refuses to sell below cost, so the fake
 *   loss does not book a loss — it locks the lot up FOREVER, on an accounting
 *   error rather than a market move.
 *
 * So when an adjustment cannot be applied confidently, this halts the book
 * rather than let it trade on a corrupt cost basis.
 *
 * Ported from the standalone prototype, with the price fields this engine has
 * that the prototype did not: the ratchet's high-water mark, the start gate's
 * recorded day highs, and the previous close used for the circuit band. Every
 * one of those is a PRICE, and a price that survives a split unadjusted is
 * another way to strand a lot.
 */

import type { AccumulatorBook, Epoch, Lot } from './types';

export type CorporateActionType = 'SPLIT' | 'BONUS' | 'DIVIDEND';

export interface CorporateAction {
  type: CorporateActionType;
  /** Ex-date, epoch ms. */
  exDate: number;
  /**
   * SPLIT: face-value ratio. A 1:5 split is `{ from: 1, to: 5 }` — one share
   * becomes five.
   * BONUS: entitlement ratio. A 1:1 bonus is `{ from: 1, to: 1 }` — one extra
   * share per one held, so the holding doubles.
   */
  ratio?: { from: number; to: number };
  /** DIVIDEND only: rupees per share. */
  dividendPerShare?: number;
  /** Where this came from, for the audit trail. */
  source?: 'yahoo' | 'manual';
}

export class CorporateActionHaltError extends Error {
  constructor(
    readonly symbol: string,
    readonly action: CorporateAction,
    detail: string,
  ) {
    super(
      `HALT ${symbol}: cannot confidently apply a ${action.type} corporate action — ${detail}. ` +
        `Trading is stopped for this book rather than continue on a corrupt cost basis. ` +
        `Resolve the adjustment manually, then release the halt.`,
    );
    this.name = 'CorporateActionHaltError';
  }
}

/** Shares held after the action, per share held before it. */
export function adjustmentFactor(action: CorporateAction): number {
  if (action.type === 'DIVIDEND') return 1;
  const r = action.ratio;
  if (!r || !(r.from > 0) || !(r.to > 0)) {
    throw new Error(`A ${action.type} corporate action needs a positive ratio { from, to }`);
  }
  // SPLIT 1:5 → one share becomes five.
  if (action.type === 'SPLIT') return r.to / r.from;
  // BONUS 1:1 → one extra per one held, so the holding doubles.
  return (r.to + r.from) / r.from;
}

/** A quantity this far from a whole number is treated as exact. */
const QTY_TOLERANCE = 1e-9;

/**
 * Apply a corporate action to a book. Pure.
 *
 * Splits and bonuses are economically neutral: no money moves, so `quoteSpent`
 * and therefore every lot's breakeven are unchanged. Quantity scales up and
 * every per-share price scales down by the same factor, so the ladder keeps
 * pointing at the same economic prices and the invariant is untouched.
 *
 * Closed lots are deliberately NOT rewritten. They record prices actually
 * transacted; editing them would falsify the trade history.
 *
 * Throws `CorporateActionHaltError` when the adjustment is not exact. The
 * caller is expected to halt the book on that.
 */
export function applyCorporateAction(book: AccumulatorBook, action: CorporateAction): AccumulatorBook {
  if (action.type === 'DIVIDEND') {
    const dps = action.dividendPerShare;
    if (dps === undefined || !Number.isFinite(dps) || dps < 0) {
      throw new CorporateActionHaltError(book.symbol, action, 'dividendPerShare is missing or invalid');
    }
    const shares = book.openLots.reduce((s, l) => s + l.quantity, 0);
    // Cost basis is deliberately NOT reduced. An Indian dividend is taxed as
    // income in the holder's hands, and the ex-date price drop is a real,
    // permanent move the ladder absorbs like any other decline. Reducing the
    // basis would let a lot sell below what it actually cost.
    return {
      ...book,
      cash: book.cash + dps * shares,
      corporateActions: [...(book.corporateActions ?? []), action],
      lastCorporateActionAt: Math.max(book.lastCorporateActionAt ?? 0, action.exDate),
    };
  }

  const factor = adjustmentFactor(action);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new CorporateActionHaltError(book.symbol, action, `adjustment factor ${factor} is not usable`);
  }

  const openLots: Lot[] = book.openLots.map((lot) => {
    const raw = lot.quantity * factor;
    const rounded = Math.round(raw);
    if (Math.abs(raw - rounded) > QTY_TOLERANCE) {
      throw new CorporateActionHaltError(
        book.symbol,
        action,
        `lot ${lot.id} holds ${lot.quantity} shares, which a factor of ${factor} turns into ` +
          `${raw} — not a whole number of shares`,
      );
    }
    return {
      ...lot,
      quantity: rounded,
      // No money moved, so quoteSpent — and every breakeven derived from it —
      // is unchanged. Per-share price scales down so quantity × fillPrice is
      // still the original notional.
      fillPrice: lot.fillPrice / factor,
      // The ratchet's high-water mark is a price. Left unscaled, an armed lot
      // would compare a post-split price to a pre-split high and its trailing
      // stop would sit five times too high — unreachable forever.
      ...(lot.hwm !== undefined ? { hwm: lot.hwm / factor } : {}),
    };
  });

  const epochs: Epoch[] = book.epochs.map((e) =>
    e.status === 'OPEN'
      ? { ...e, anchorPrice: e.anchorPrice / factor, levels: e.levels.map((p) => p / factor) }
      : e,
  );

  // The start gate's recorded highs are prices too. Unscaled, the rolling high
  // stays at pre-split levels and the gate would read every post-split price as
  // an 80% crash, anchoring a new ladder immediately.
  const dayHighs: Record<string, number> = {};
  for (const [day, high] of Object.entries(book.dayHighs)) dayHighs[day] = high / factor;

  return {
    ...book,
    openLots,
    epochs,
    dayHighs,
    ...(book.previousClose !== undefined ? { previousClose: book.previousClose / factor } : {}),
    ...(book.lastPrice !== undefined ? { lastPrice: book.lastPrice / factor } : {}),
    corporateActions: [...(book.corporateActions ?? []), action],
    lastCorporateActionAt: Math.max(book.lastCorporateActionAt ?? 0, action.exDate),
  };
}

/** One line describing an action, for the log and the UI. */
export function describeAction(a: CorporateAction): string {
  const on = new Date(a.exDate).toISOString().slice(0, 10);
  if (a.type === 'DIVIDEND') return `dividend ₹${a.dividendPerShare?.toFixed(2)} per share, ex ${on}`;
  const r = a.ratio;
  return `${a.type.toLowerCase()} ${r?.from}:${r?.to} (×${adjustmentFactor(a).toFixed(4)} shares), ex ${on}`;
}

/**
 * The actions a book has not yet absorbed, oldest first.
 *
 * Filtered by ex-date against `lastCorporateActionAt`, so re-reading the same
 * Yahoo history is idempotent — applying a split twice would be as destructive
 * as never applying it.
 */
export function pendingActions(
  book: Pick<AccumulatorBook, 'lastCorporateActionAt' | 'createdAt'>,
  actions: CorporateAction[],
  now: number,
): CorporateAction[] {
  // Nothing before the book existed: those prices were never on its books.
  const after = Math.max(book.lastCorporateActionAt ?? 0, book.createdAt);
  return actions
    .filter((a) => a.exDate > after && a.exDate <= now)
    .sort((a, b) => a.exDate - b.exDate);
}

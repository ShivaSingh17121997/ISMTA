/**
 * Clear a book's paper lots before going live. Pure.
 *
 * Paper lots are simulated shares that are not in the demat account. Live, the
 * engine would try to sell them and Kite would refuse (or worse, sell real
 * shares bought by hand), so the live switch is blocked while any exist. This
 * closes them on paper only: no order, no broker, no no-loss sale.
 *
 * It is NOT a trade, so it never enters `closedLots` (win rate, trade stats,
 * the tax ledger). Each lot is moved to `clearedLots`, marked at the given
 * price, and the book's cash is credited with that market value, so the book's
 * value (cash + shares) is unchanged at the moment of clearing and the paper
 * equity curve does not jump.
 */
import type { AccumulatorBook, ClearedLot } from './types';

export function clearPaperLots(
  book: AccumulatorBook,
  markPrice: number,
  at: number,
): { book: AccumulatorBook; cleared: ClearedLot[] } {
  if ((book.venue ?? 'paper') !== 'paper') throw new Error(`${book.symbol} holds live lots; only paper lots can be cleared`);
  if (!(markPrice > 0)) throw new Error(`${book.symbol}: no price to mark the paper lots at`);
  // Paper sale proceeds still settling (T+1) are paper money too: move them to
  // cash now, so nothing simulated settles into the book after going live.
  const settling = book.unsettled.reduce((s, c) => s + c.amount, 0);
  if (book.openLots.length === 0) {
    return settling > 0
      ? { book: { ...book, unsettled: [], cash: book.cash + settling, updatedAt: at }, cleared: [] }
      : { book, cleared: [] };
  }

  const cleared: ClearedLot[] = book.openLots.map((l) => {
    const value = l.quantity * markPrice;
    return { ...l, clearedAt: at, markPrice, value, pnl: value - l.quoteSpent };
  });
  const value = cleared.reduce((s, l) => s + l.value, 0);
  return {
    book: {
      ...book,
      openLots: [],
      clearedLots: [...(book.clearedLots ?? []), ...cleared],
      cash: book.cash + value + settling,
      unsettled: [],
      // Every ladder ends with its lots: the next buy anchors a fresh one.
      epochs: book.epochs.map((e) => (e.status === 'OPEN' ? { ...e, status: 'CLOSED' as const, closedAt: at } : e)),
      updatedAt: at,
    },
    cleared,
  };
}

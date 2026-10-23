/**
 * Ladder state: which rung is where, and which side of cost a held lot sits on.
 *
 * Pure and free of JSX so it can be tested directly — `LadderList.tsx` renders
 * what this decides. The split follows the same rule the backend uses for
 * `metrics.ts` / `score.ts`: the module that MEASURES holds no opinion about
 * presentation, and the one that presents holds no arithmetic.
 *
 * THE COLOUR RULE, because the obvious version of it is wrong.
 *
 * "Green if in profit, red if in loss" needs a definition of profit, and this
 * engine has two that disagree:
 *
 *   paper-even   quantity × mark − quoteSpent  (the lot's `unrealised`)
 *                Counts charges paid on the BUY. Turns positive as soon as the
 *                mark clears what was spent.
 *
 *   breakeven    the price at which a SALE actually clears cost, so it also
 *                carries the sell side: brokerage, STT, exchange, GST, SEBI,
 *                stamp duty and the FLAT DP charge.
 *
 * Between them is a dead zone where `unrealised` reads positive and selling
 * would still book a loss. Measured with this project's own cost model it runs
 * from 0.11% of the lot at ₹2,00,000 to **1.70% at ₹1,000** — the flat DP
 * charge is what blows it out at small sizes. It is exactly the trap `math.ts`
 * warns about: "a percentage-only breakeven books 'profits' that are losses on
 * the contract note."
 *
 * Colouring on `unrealised` would paint a lot GREEN that the engine will refuse
 * to sell, on a screen whose whole promise is that it never sells at a loss.
 * Hence three states rather than two.
 */

import type { AccumulatorBook, AccumulatorClosedLot, AccumulatorLot } from './types';

export type LotState =
  /** A sale would clear cost including sell-side charges. The engine may sell. */
  | 'clears'
  /** Up on what was spent, but a sale still loses once charges land. It holds. */
  | 'deadzone'
  /** Down on the spend too. */
  | 'down';

/** The price at which `unrealised` crosses zero — buy-side charges only. */
export function paperEven(lot: Pick<AccumulatorLot, 'quantity' | 'quoteSpent'>): number {
  return lot.quantity > 0 ? lot.quoteSpent / lot.quantity : 0;
}

/**
 * Which side of cost a held lot is on.
 *
 * A lot with no served breakeven falls back to the paper figure rather than
 * claiming a clearance it cannot evidence — an open lot should always carry
 * one, and inventing a floor is how the no-loss guarantee gets quietly broken.
 */
export function lotState(
  mark: number,
  lot: Pick<AccumulatorLot, 'quantity' | 'quoteSpent' | 'breakeven'>,
): LotState {
  const paper = paperEven(lot);
  const be = lot.breakeven ?? paper;
  if (mark >= be) return 'clears';
  if (mark >= paper) return 'deadzone';
  return 'down';
}

export type LadderRow =
  | { kind: 'held'; level: number; price: number; lot: AccumulatorLot }
  | { kind: 'sold'; level: number; price: number; lot: AccumulatorClosedLot }
  | { kind: 'waiting'; level: number; price: number };

export interface LadderView {
  rows: LadderRow[];
  epochIndex: number;
  anchorPrice: number;
  held: number;
  sold: number;
  waiting: number;
  /** The shallowest unfilled rung — the one the engine would buy next. */
  next: LadderRow | null;
}

/**
 * One row per rung of the OPEN epoch, newest ladder only.
 *
 * A rung whose lot has been SOLD is shown as `sold` while the engine still
 * counts it filled (`filledLevels`), because it will not buy again in this
 * ladder. With re-armed rungs on, the engine frees a sold deeper rung, and it
 * is `waiting` again: it will buy on the next dip to it. The engine's own
 * `filledLevels` decides, so the screen never promises a buy that cannot
 * happen. A new ladder anchors only after the last open lot of this one closes.
 *
 * Lots are matched on epoch AND level, never level alone: a book that has run
 * several ladders holds closed lots at the same rung numbers from earlier
 * epochs, and matching on level would attribute an old sale to the live rung.
 *
 * Returns null when no epoch is open, which is a normal state — the start gate
 * has not passed yet — not an error.
 */
export function buildLadder(book: AccumulatorBook, openLots: AccumulatorLot[]): LadderView | null {
  const epoch = book.epochs.find((e) => e.status === 'OPEN');
  if (!epoch) return null;

  const heldAt = new Map<number, AccumulatorLot>();
  for (const l of openLots) if (l.epoch === epoch.index) heldAt.set(l.level, l);
  const soldAt = new Map<number, AccumulatorClosedLot>();
  for (const l of book.closedLots) if (l.epoch === epoch.index) soldAt.set(l.level, l);

  const rows: LadderRow[] = epoch.levels.map((price, level) => {
    const h = heldAt.get(level);
    if (h) return { kind: 'held', level, price, lot: h };
    const s = soldAt.get(level);
    if (s && epoch.filledLevels.includes(level)) return { kind: 'sold', level, price, lot: s };
    return { kind: 'waiting', level, price };
  });

  return {
    rows,
    epochIndex: epoch.index,
    anchorPrice: epoch.anchorPrice,
    held: rows.filter((r) => r.kind === 'held').length,
    sold: rows.filter((r) => r.kind === 'sold').length,
    waiting: rows.filter((r) => r.kind === 'waiting').length,
    next: rows.find((r) => r.kind === 'waiting') ?? null,
  };
}

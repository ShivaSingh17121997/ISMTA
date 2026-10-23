/**
 * What a hand-set amount and rung count would actually do to a book. Pure.
 *
 * Built from the engine's own functions (`syncLadder`, `nextTrancheSize`,
 * `trancheSize`, `paramsFor`) on the would-be book, so the preview the user
 * sees is exactly the rupees the engine will put into each rung. Nothing here
 * re-implements ladder maths.
 *
 * The engine has no minimum-rung check when it buys (one share is enough), so
 * this is where a rung too small for the flat DP charge is refused.
 */
import { nextTrancheSize, openEpoch, paramsFor, syncLadder } from './engine';
import { trancheSize } from './math';
import type { AccumulatorBook, AccumulatorParams } from './types';

export interface RungPlan {
  /** Total budget the book would run on: the amount, or what is already in it if more. */
  budget: number;
  reservePct: number;
  rungs: number;
  /** Rungs of the open ladder that already hold shares. */
  bought: number;
  /** Rungs still to buy. */
  toBuy: number;
  /** Rupees each rung still to buy gets. */
  perRung: number;
  /** Fewest rungs allowed: a rung that holds shares is never removed. */
  minRungs: number;
  /** Most rungs that keep every rung to buy at or above `minPerRung`; 0 if none fits. */
  maxRungs: number;
  minPerRung: number;
  error: string | null;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function evaluate(book: AccumulatorBook, budget: number, rungs: number, params: AccumulatorParams) {
  const hyp = syncLadder({ ...book, budget, tranches: rungs }, params);
  const p = paramsFor(hyp, params);
  const epoch = openEpoch(hyp);
  if (!epoch) return { toBuy: rungs, perRung: trancheSize(budget, p), reservePct: p.reservePct };
  return {
    toBuy: epoch.levels.length - epoch.filledLevels.length,
    perRung: nextTrancheSize(hyp, p),
    reservePct: p.reservePct,
  };
}

export function planRungs(
  book: AccumulatorBook,
  amount: number,
  rungs: number,
  params: AccumulatorParams,
  limits: { minPerRung: number; maxRungs: number },
): RungPlan {
  const held = book.openLots.reduce((s, l) => s + l.quoteSpent, 0) + book.unsettled.reduce((s, c) => s + c.amount, 0);
  const budget = Math.max(amount, held);
  const epoch = openEpoch(book);
  const bought = epoch ? epoch.filledLevels.length : 0;
  const deepest = epoch ? epoch.filledLevels.reduce((m, k) => Math.max(m, k), -1) : -1;
  const minRungs = Math.max(1, deepest + 1);

  // The most rungs this budget can carry with every rung to buy above the floor.
  let maxRungs = 0;
  for (let r = minRungs; r <= limits.maxRungs; r++) {
    const e = evaluate(book, budget, r, params);
    if (e.toBuy === 0 || e.perRung >= limits.minPerRung) maxRungs = r;
  }

  const e = Number.isInteger(rungs) && rungs >= 1 ? evaluate(book, budget, rungs, params) : { toBuy: 0, perRung: 0, reservePct: params.reservePct };
  let error: string | null = null;
  if (!Number.isInteger(rungs) || rungs < 1) error = 'Enter a whole number of rungs, 1 or more.';
  else if (rungs > limits.maxRungs) error = `At most ${limits.maxRungs} rungs.`;
  else if (rungs < minRungs) {
    error = `This ladder's deepest bought rung is rung ${deepest + 1}, and a rung that has bought is never removed. Choose ${minRungs} or more.`;
  } else if (e.toBuy > 0 && e.perRung < limits.minPerRung) {
    error =
      `${rungs} rungs leaves ${inr(e.perRung)} per rung, under the ${inr(limits.minPerRung)} minimum that keeps the flat DP charge small. ` +
      (maxRungs >= minRungs ? `With this amount, choose at most ${maxRungs}.` : 'This amount is too small for another rung; raise it.');
  }

  return {
    budget,
    reservePct: e.reservePct,
    rungs,
    bought,
    toBuy: e.toBuy,
    perRung: e.perRung,
    minRungs,
    maxRungs,
    minPerRung: limits.minPerRung,
    error,
  };
}

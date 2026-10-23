/**
 * Scalping mode — a PROFILE on the accumulator, not a second engine.
 *
 * Ported from the NTB bot's `strategy/scalp.ts`, with the numbers re-derived for
 * NSE cash delivery. The idea is the same and is worth stating plainly: scalp
 * mode does not introduce new buy or sell machinery. It rewrites the swing knobs
 * into a tight, fast configuration and hands the result to the exact same
 * ladder, lot and sell code. One engine, two parameter sets.
 *
 * That matters because the no-loss invariant lives in `sellLot`, below every
 * profile. A scalp still cannot sell a lot under its fee-inclusive cost. A
 * scalp that goes wrong is not a small loss — it is a lot that stays open and
 * becomes a swing hold. Scalping here changes the CADENCE of entries and the
 * SIZE of the profit taken, never the floor.
 *
 * What flips when scalp mode is on:
 *
 *   target        4%  → 1.5%   small, but still ~3.5x the delivery round trip
 *   ladder step   6%  → 2%     and the growth flattens to 1.0, so rungs are even
 *   buy brake     24h → 2h     multiple rungs can fill inside one session
 *   dip gate      3% below the 45-day high → 2% below the 7-day high
 *   deploy cap    100% → 60%   of budget in open lots at once
 *
 * WHY THE NUMBERS DIFFER FROM NTB
 *
 * NTB scalps crypto at a 1% target with a 35% deploy cap. Two things about the
 * Indian cash segment move those:
 *
 *   1. The flat DP charge (₹13.5 + GST = ₹15.93 per SELL) does not shrink with
 *      the order, so the round-trip cost of a small delivery tranche is ~0.41%
 *      against crypto's ~0.2%. A 1% target would clear the 1.5x cost floor by
 *      too little to survive a tick of slippage; 1.5% clears it ~3.5x.
 *   2. The capital allocator sizes most books at 3 rungs, where one tranche is
 *      ~28% of the budget. NTB's 35% cap would permit exactly one lot and there
 *      would be no ladder at all. 60% permits two, and scales up with the rung
 *      count on bigger books.
 *
 * WHAT SCALPING CANNOT DO HERE
 *
 * T+1. Sale proceeds are not spendable until the next trading day, so a book
 * cannot recycle the same rupee twice in one session however tight the target
 * is. Scalp mode raises the number of round trips per month, not per day.
 */

import { roundTripCostPct } from '../costs';
import { trancheSize } from './math';
import { DEFAULT_ACCUMULATOR_PARAMS, type AccumulatorBook, type AccumulatorParams } from './types';

export interface ScalpProfile {
  /** Resting profit above net breakeven, percent. */
  targetPct: number;
  /** Gap between ladder rungs, percent. */
  stepPct: number;
  /** Rung-gap multiplier. 1.0 = even rungs, the scalp default. */
  stepGrowth: number;
  /** Minimum gap between two ladder buys, ms. */
  minBuyGapMs: number;
  /** Dip below the rolling high required to anchor an epoch, percent. */
  startDiscountPct: number;
  /** Rolling-high lookback, trading days. */
  hiLookbackDays: number;
  /** Ceiling on cost basis held in open lots, percent of budget. */
  maxDeployPct: number;
}

export const DEFAULT_SCALP_PROFILE: ScalpProfile = {
  targetPct: 1.5,
  stepPct: 2,
  stepGrowth: 1.0,
  minBuyGapMs: 2 * 60 * 60 * 1000,
  startDiscountPct: 2,
  hiLookbackDays: 7,
  maxDeployPct: 60,
};

/** True when this book is running the scalp profile. */
export function scalpActive(book: Pick<AccumulatorBook, 'scalp'>): boolean {
  return book.scalp === true;
}

/**
 * The swing params rewritten for scalping. Returns the SAME object when scalp
 * is off, so the tick path allocates nothing in the common case.
 *
 * `reservePct` and `slippageBufferPct` are deliberately NOT overlaid. The
 * reserve is a capital rule and the slippage buffer feeds the breakeven floor;
 * moving either with a UI toggle would move a lot's floor under it, and a
 * floor that moves is not a floor.
 */
export function applyScalpOverlay(
  params: AccumulatorParams,
  profile: ScalpProfile = DEFAULT_SCALP_PROFILE,
): AccumulatorParams {
  return {
    ...params,
    targetPct: profile.targetPct,
    stepPct: profile.stepPct,
    stepGrowth: profile.stepGrowth,
    minBuyGapMs: profile.minBuyGapMs,
    startDiscountPct: profile.startDiscountPct,
    hiLookbackDays: profile.hiLookbackDays,
    maxDeployPct: profile.maxDeployPct,
  };
}

/**
 * Refuse a scalp that only pays the exchange.
 *
 * The target has to clear 1.5x the round-trip cost at THIS book's tranche size,
 * because the DP charge is flat rupees: the same 1.5% target is comfortable on a
 * ₹22,000 tranche and marginal on a ₹5,000 one. Returns the reasons, empty when
 * the profile is economic.
 */
export function validateScalp(
  book: AccumulatorBook,
  params: AccumulatorParams,
  markPrice: number,
  profile: ScalpProfile = DEFAULT_SCALP_PROFILE,
): string[] {
  const errors: string[] = [];
  const tranche = trancheSize(book.budget, params);

  if (!(tranche > 0)) {
    errors.push(
      `${book.symbol} has no budget to scalp with. The allocator funds the strongest books; ` +
        `this one is sized at ₹0.`,
    );
    return errors;
  }

  if (markPrice > 0) {
    const qty = Math.floor(tranche / markPrice);
    if (qty < 1) {
      errors.push(
        `A ₹${tranche.toFixed(0)} tranche does not buy one share of ${book.symbol} at ` +
          `₹${markPrice.toFixed(2)}.`,
      );
      return errors;
    }
    const cost = roundTripCostPct(markPrice, qty, { product: 'CNC', instrument: book.instrument });
    if (profile.targetPct < 1.5 * cost) {
      errors.push(
        `Scalp target ${profile.targetPct}% is below 1.5x the round-trip cost of ${cost.toFixed(2)}% ` +
          `on a ₹${tranche.toFixed(0)} tranche of ${book.symbol}. At that size the scalp pays the ` +
          `exchange more than it keeps — the flat ₹15.93 DP charge is the reason. Raise the budget ` +
          `or leave this book on the 4% swing target.`,
      );
    }
  }

  return errors;
}

/** One line describing the profile in force, for the UI and the event log. */
export function describeProfile(on: boolean, profile: ScalpProfile = DEFAULT_SCALP_PROFILE): string {
  return on
    ? `scalp: +${profile.targetPct}% targets, ${profile.stepPct}% even rungs, ` +
        `${profile.minBuyGapMs / 3_600_000}h buy gap, ${profile.startDiscountPct}% dip / ` +
        `${profile.hiLookbackDays}d high, max ${profile.maxDeployPct}% deployed`
    : `swing: +${DEFAULT_ACCUMULATOR_PARAMS.targetPct}% targets, ${DEFAULT_ACCUMULATOR_PARAMS.stepPct}% compounding rungs, 24h buy gap, ${DEFAULT_ACCUMULATOR_PARAMS.startDiscountPct}% dip / ${DEFAULT_ACCUMULATOR_PARAMS.hiLookbackDays}d high`;
}

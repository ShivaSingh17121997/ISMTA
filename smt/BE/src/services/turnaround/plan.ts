/**
 * When to buy a turnaround. Pure.
 *
 * Three differences from the future-stars plan, each of them deliberate:
 *
 * 1. NOTHING IS BOUGHT AT MARKET. The whole premise of this category is that
 *    the stock has been falling, and the strongest anomaly in equities says
 *    losers keep losing for three to twelve months. So entry is on a TRIGGER —
 *    a price that confirms the base has held — and if the trigger never fires,
 *    nothing is ever bought. An unfired trigger is a success, not a miss.
 *
 * 2. THERE IS A REAL STOP. A turnaround is bought on a base, and the base has a
 *    low. If the stock loses it, the thesis is simply wrong, and unlike a
 *    multi-year growth hold there is no argument for sitting through it. That
 *    makes proper risk-based sizing possible: quantity is derived from the
 *    distance to the stop, so every idea risks the same rupees.
 *
 * 3. THERE IS A TIME STOP. The characteristic failure of this category is not
 *    the stock that halves again — that one gets stopped out. It is the one
 *    that does nothing for three years while the capital could have been in an
 *    index. A thesis that has not started working in a year has not been proved
 *    wrong; it has been proved uninteresting, which costs the same.
 */
import { Growth } from '../futurestars/types';
import { TurnEntry } from './types';
import { TurnPrice, TurnVerdict } from './score';

export interface TurnPlanParams {
  capital: number;
  /** share of capital the whole turnaround category may hold, % */
  categoryCapPct: number;
  /** share of capital risked if the stop is hit, % */
  riskPerIdeaPct: number;
  /** hard ceiling on any one position, % of capital */
  maxPositionPct: number;
  minPositionValue: number;
  maxTurnoverPct: number;
}

export const DEFAULT_TURN_PARAMS: TurnPlanParams = {
  capital: 200_000,
  // Smaller than the future-stars sleeve. These are, by construction, stocks
  // the market has already decided against.
  categoryCapPct: 15,
  riskPerIdeaPct: 1,
  maxPositionPct: 6,
  minPositionValue: 15_000,
  maxTurnoverPct: 1,
};

/** The quarter the company is next due to report, and roughly when. */
function nextResults(g: Growth, now: number): string {
  const last = g.quarters[g.quarters.length - 1];
  const lastEnd = last ? Date.parse(last.end) : now - 120 * 86_400_000;
  let next = lastEnd;
  while (next <= now - 20 * 86_400_000) next += 91 * 86_400_000;
  const filing = new Date(next + 50 * 86_400_000);
  return `${new Date(next).toISOString().slice(0, 10)} results, around ${filing.toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

export function buildTurnEntry(input: {
  score: number;
  verdict: TurnVerdict;
  price: TurnPrice;
  growth: Growth;
  params: TurnPlanParams;
  now: number;
  budget: number | null;
  unfundedReason?: string;
}): TurnEntry {
  const { price, growth, params, now } = input;
  const warnings: string[] = [];
  const unfunded = input.budget === null;

  // ── the levels ──
  //
  // The stop sits below the base, not below the 52-week low: a stop at the very
  // low of a year-long decline is so far away that it stops being a risk
  // control and becomes a hope. The 20-day low is the base this is being bought
  // on, with a small buffer for noise.
  const stop = Math.round(price.low20 * 0.96 * 100) / 100;
  const stopDistancePct = price.last > 0 ? ((price.last - stop) / price.last) * 100 : 0;

  // The trigger is the level that says the base held: a close above the 50-day
  // average, or above the last month's high if price is already through it.
  const alreadyTurning = price.ema20Above50 && price.last > price.ema50;
  const triggerPrice = alreadyTurning ? null : Math.round(price.ema50 * 100) / 100;

  // ── size, from the stop ──
  const byRisk =
    stopDistancePct > 0 ? ((params.capital * params.riskPerIdeaPct) / 100) / (stopDistancePct / 100) : 0;
  const byCap = (params.capital * params.maxPositionPct) / 100;
  const byLiquidity = (price.medianTurnover * params.maxTurnoverPct) / 100;
  let amount = unfunded ? 0 : Math.min(byRisk, byCap, byLiquidity, input.budget ?? 0);
  amount = Math.max(0, Math.round(amount));

  if (!unfunded) {
    if (byRisk < byCap && byRisk === amount) {
      warnings.push(
        `Sized by the stop: risking ${params.riskPerIdeaPct}% of capital over a ${stopDistancePct.toFixed(0)}% stop ` +
          `gives ₹${Math.round(byRisk).toLocaleString('en-IN')}.`,
      );
    }
    if (byLiquidity < Math.min(byRisk, byCap)) {
      warnings.push(
        `Cut to ₹${Math.round(byLiquidity).toLocaleString('en-IN')} by liquidity — ${params.maxTurnoverPct}% of a typical day's turnover.`,
      );
    }
    if (amount > 0 && amount < params.minPositionValue) {
      warnings.push(
        `₹${amount.toLocaleString('en-IN')} is below the ₹${params.minPositionValue.toLocaleString('en-IN')} floor where charges stop mattering.`,
      );
    }
    if (stopDistancePct > 25) {
      warnings.push(
        `The base is ${stopDistancePct.toFixed(0)}% below the current price, which is a wide stop — the position is small because of it.`,
      );
    }
  } else if (input.unfundedReason) {
    warnings.push(input.unfundedReason);
  }

  if (price.aboveSma200) {
    warnings.push('Already back above its 200-day average — much of the recovery may have happened.');
  }
  if ((growth.ageDays ?? 0) > 150) {
    warnings.push(`The latest results are ${growth.ageDays} days old; the next filing may change the picture entirely.`);
  }

  let quantity = price.last > 0 ? Math.floor(amount / price.last) : 0;

  // A position that cannot buy a single share is not a small position, it is no
  // position. Say so rather than printing "0 shares" next to a rupee figure.
  const unaffordable = !unfunded && amount > 0 && quantity < 1;
  if (unaffordable) {
    warnings.push(
      `One share costs ₹${price.last.toFixed(0)}, more than the ₹${amount.toLocaleString('en-IN')} this idea is ` +
        `allowed at ${params.riskPerIdeaPct}% risk over a ${stopDistancePct.toFixed(0)}% stop. Buying it anyway would mean ` +
        `either risking ₹${Math.round((price.last * stopDistancePct) / 100).toLocaleString('en-IN')} on one share — ` +
        `${(((price.last * stopDistancePct) / 100 / params.capital) * 100).toFixed(1)}% of capital — or abandoning the stop. ` +
        `At this account size this company is not investable on this plan.`,
    );
    amount = 0;
    quantity = 0;
  }

  return {
    trigger: unfunded
      ? 'Watchlist only — no capital is allocated today. If a funded idea is stopped out or triggers, this is next in line.'
      : unaffordable
        ? `Not investable here: one share costs more than the position this plan allows.`
        : triggerPrice === null
        ? `Now. The 20-day average is already above the 50-day and the price is above both, so the base has confirmed.`
        : `On a daily close above ₹${triggerPrice.toFixed(2)} (the 50-day average). Until then the fall has not demonstrably stopped and nothing is bought — if it never closes above, nothing is ever bought, and that is the plan working.`,
    triggerPrice,
    stop,
    stopDistancePct: Math.round(stopDistancePct * 10) / 10,
    amount,
    quantity,
    pctOfCapital: params.capital > 0 ? Math.round((amount / params.capital) * 1000) / 10 : 0,
    riskAmount: Math.round((amount * stopDistancePct) / 100),
    timeStop:
      'If it has not made a higher high within 12 months, sell it. A turnaround that does not turn is not a cheap stock, it is dead money with an opportunity cost.',
    nextCheck: nextResults(growth, now),
    holdLabel: '1–2 years, or until the base breaks',
    warnings,
  };
}

/** Which candidates the budget can actually fund. Same logic as the other category. */
export function turnFundingPlan(
  ranked: { symbol: string; score: number }[],
  params: TurnPlanParams,
): { budgets: Map<string, number | null>; funded: number; note: string } {
  const cap = (params.capital * params.categoryCapPct) / 100;
  const maxFunded = Math.max(1, Math.min(4, Math.floor(cap / params.minPositionValue)));
  const funded = Math.min(maxFunded, ranked.length);
  const budgets = new Map<string, number | null>();
  const per = funded > 0 ? cap / funded : 0;
  ranked.forEach((r, i) => budgets.set(r.symbol, i < funded ? per : null));
  const note =
    ranked.length === 0
      ? `Nothing qualified, so none of the ₹${Math.round(cap).toLocaleString('en-IN')} turnaround budget is committed.`
      : `₹${Math.round(cap).toLocaleString('en-IN')} (${params.categoryCapPct}% of capital) is split between the top ${funded} ` +
        `of ${ranked.length} qualifying ${ranked.length === 1 ? 'idea' : 'ideas'}. The rest carry a thesis and a trigger but no money.`;
  return { budgets, funded, note };
}

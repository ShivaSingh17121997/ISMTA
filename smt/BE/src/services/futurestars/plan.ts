/**
 * When to invest — the staged entry plan. Pure.
 *
 * A ranking without a plan is the thing that loses money in this category. The
 * failure mode of "future stars" is not picking the wrong company; it is
 * putting a full position into the right company at the wrong moment, on the
 * day the story is loudest, and then having no rule for what to do next.
 *
 * So every star comes with tranches, each attached to a CONDITION rather than a
 * date, an invalidation level that says what would prove the thesis wrong, and
 * the date of the next real test, which for this category is always the next
 * results filing.
 *
 * Three design decisions worth defending:
 *
 * 1. STAGED, NOT LUMP SUM — and this is against the general evidence. Lump-sum
 *    investing beats averaging in about two thirds of historical windows simply
 *    because markets rise (Vanguard's studies, and Constantinides 1979 shows
 *    fixed-schedule averaging is dominated). We stage anyway, for a reason that
 *    does not apply to an index: the later tranches are CONDITIONAL on the
 *    thesis being confirmed by new information — a results filing, another
 *    order win. That is not market timing, it is refusing to pay for evidence
 *    that has not arrived. The cost of being wrong falls; the cost of being
 *    right is a smaller position, which is the trade being made deliberately.
 *
 * 2. THE FIRST TRANCHE IS NEVER THE WHOLE POSITION, however good the score.
 *
 * 3. THE CATEGORY IS CAPPED as a whole, not just per name. These companies are
 *    correlated — they are the same trade in different clothes, usually
 *    "government capex continues".
 */
import { EntryPlan, FutureStar, Growth, OrderFlow, Tranche, Verdict } from './types';
import { PriceContext } from './score';

export interface PlanParams {
  capital: number;
  /** share of capital the whole future-stars category may hold, % */
  categoryCapPct: number;
  /** share of capital any single future star may hold, % */
  maxPositionPct: number;
  /** smallest position worth opening, rupees — below this charges dominate */
  minPositionValue: number;
  /** share of a day's median turnover a position may represent, % */
  maxTurnoverPct: number;
}

export const DEFAULT_PLAN_PARAMS: PlanParams = {
  capital: 200_000,
  // Four names at 5% each. This category is speculative and correlated; it is
  // the satellite, never the core.
  categoryCapPct: 20,
  maxPositionPct: 6,
  minPositionValue: 15_000,
  maxTurnoverPct: 1,
};

/** The quarter end the company is next due to report, and roughly when. */
export function nextResultsDue(g: Growth, now: number): { quarterEnd: string; expected: string } {
  const last = g.quarters[g.quarters.length - 1];
  const lastEnd = last ? Date.parse(last.end) : now - 120 * 86_400_000;
  // Quarters end Mar/Jun/Sep/Dec; results land six to eight weeks later.
  let nextEnd = lastEnd;
  while (nextEnd <= now - 20 * 86_400_000) nextEnd += 91 * 86_400_000;
  const d = new Date(nextEnd);
  const filing = new Date(nextEnd + 50 * 86_400_000);
  const month = (x: Date): string =>
    x.toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { quarterEnd: d.toISOString().slice(0, 10), expected: `around ${month(filing)}` };
}

/**
 * Build the staged plan.
 *
 * Sizing is by CONVICTION and liquidity, not by a stop distance: these
 * positions are held through drawdowns that would take out any sensible stop,
 * so pretending there is a 1%-risk stop would be a lie. The honest risk number
 * is what it costs if the thesis breaks and the position is sold at the
 * invalidation level.
 */
export function buildEntryPlan(input: {
  score: number;
  verdict: Verdict;
  price: PriceContext;
  growth: Growth;
  orders: OrderFlow;
  params: PlanParams;
  now: number;
  /**
   * Capital this idea may actually have. Null means it made the list but not
   * the budget — a watchlist entry with a thesis and no position.
   */
  budget: number | null;
  /** why it is watchlist-only, when it is */
  unfundedReason?: string;
}): EntryPlan {
  const { price, growth, orders, params, now } = input;
  const warnings: string[] = [];

  // ── total position size ──
  const byConviction = ((params.capital * params.maxPositionPct) / 100) * Math.min(1, input.score / 75);
  const byLiquidity = (price.medianTurnover * params.maxTurnoverPct) / 100;
  let amount = input.budget === null ? 0 : Math.min(byConviction, byLiquidity, input.budget);
  if (input.budget !== null && byLiquidity < Math.min(byConviction, input.budget)) {
    warnings.push(
      `Sized down to ₹${Math.round(byLiquidity).toLocaleString('en-IN')} by liquidity: ` +
        `${params.maxTurnoverPct}% of a typical day's turnover.`,
    );
  }
  amount = Math.max(0, Math.round(amount));
  const unfunded = amount <= 0;
  if (unfunded && input.unfundedReason) warnings.push(input.unfundedReason);

  // ── the level that says the thesis is wrong ──
  // The 200-day average with a band: a growth company below its long trend for
  // a sustained period is one the market has stopped believing. The band exists
  // because these shares are volatile and a single spike below is not a verdict.
  const sma = price.sma200 ?? price.last * 0.85;
  const invalidationPrice = Math.round(sma * 0.92 * 100) / 100;
  const lossPct = price.last > 0 ? ((invalidationPrice - price.last) / price.last) * 100 : 0;
  const riskAmount = Math.round((amount * Math.abs(lossPct)) / 100);

  const due = nextResultsDue(growth, now);

  // ── how many tranches this position can actually carry ──
  //
  // The binding constraint is the SHARE PRICE, not the rupee slice. Buying in
  // three parts is nearly free on delivery: brokerage is ₹0 at Zerodha and ₹5–20
  // at Groww, and the flat ₹15.34 depository fee is charged per SELL day, which
  // happens once however many times you bought. What cannot be split is a share:
  // a ₹7,300 share inside an ₹11,000 position is one purchase and pretending
  // otherwise produces a tranche of zero shares.
  // ₹3,000 and two shares. At Zerodha's ₹0 delivery brokerage three buys cost
  // the same as one (stamp duty is proportional either way); at Groww the ₹5
  // minimum makes it about ₹10 more on a ₹11,000 position, under 0.1%.
  const MIN_TRANCHE = 3_000;
  const MIN_SHARES = 2;
  const affordable = (n: number): boolean =>
    amount / n >= MIN_TRANCHE && (price.last <= 0 || Math.floor(amount / n / price.last) >= MIN_SHARES);
  const stages = unfunded ? 3 : affordable(3) ? 3 : affordable(2) ? 2 : 1;
  if (!unfunded && stages < 3) {
    warnings.push(
      stages === 1
        ? `Too small to stage: at ₹${Math.round(amount).toLocaleString('en-IN')} and ₹${price.last.toFixed(0)} a share, the whole position is one purchase. Wait for the confirmation in tranche 1 before buying any of it.`
        : `Staged in two rather than three: a third slice would be under ₹${MIN_TRANCHE.toLocaleString('en-IN')} and the fixed charges would eat it.`,
    );
  }
  const SHARES: Record<number, number[]> = { 1: [100], 2: [55, 45], 3: [40, 35, 25] };
  const split = SHARES[stages];

  // ── tranches ──
  const tranches: Tranche[] = [];
  const q = (rupees: number, atPrice: number): number => (atPrice > 0 ? Math.floor(rupees / atPrice) : 0);

  // 1. Now, but only if the market already agrees. If it does not, the whole
  //    position waits for a trend rather than averaging into a falling stock —
  //    "buying the dip" on a story stock with no trend is how this category
  //    turns into dead money.
  const firstNow = price.aboveSma200;
  const a1 = Math.round((amount * split[0]) / 100);
  tranches.push({
    n: 1,
    sharePct: split[0],
    amount: a1,
    quantity: q(a1, price.last),
    price: price.last,
    trigger: unfunded
      ? `Watchlist only — no capital is allocated to this idea today. If one of the funded names is sold or invalidated, this is the next in line.`
      : firstNow
        ? 'Now. The shares are above their 200-day average, so the market is already paying for some of this.'
        : `Not yet — wait for a close above the 200-day average (₹${sma.toFixed(2)}). Until then the story has no confirmation and there is no hurry.`,
    timing: unfunded ? 'not now' : firstNow ? 'today' : 'when the trend turns',
  });

  // 2. On the next results, conditional on the numbers continuing.
  const a2 = stages >= 2 ? Math.round((amount * split[1]) / 100) : 0;
  const bar =
    growth.revenueYoYPct !== null
      ? `revenue still growing year on year (it was ${growth.revenueYoYPct > 0 ? '+' : ''}${growth.revenueYoYPct}%)` +
        (growth.marginPct !== null ? ` and the margin no worse than ${Math.max(0, growth.marginPct - 2).toFixed(1)}%` : '')
      : 'the first readable results showing year-on-year growth';
  if (stages >= 2) {
    tranches.push({
      n: 2,
      sharePct: split[1],
      amount: a2,
      quantity: q(a2, price.last),
      price: price.last,
      trigger: `When the ${due.quarterEnd} quarter is filed with ${bar}. If growth has stalled, this tranche is never bought.`,
      timing: due.expected,
    });
  }

  // 3. On further evidence the order book is still filling.
  if (stages >= 3) {
    const a3 = amount - a1 - a2;
    tranches.push({
      n: 3,
      sharePct: split[2],
      amount: a3,
      quantity: q(a3, price.last),
      price: price.last,
      trigger:
        orders.recentCount > 0
          ? `After at least two more order wins are filed (there have been ${orders.recentCount} in six months), with the shares still above ₹${invalidationPrice.toFixed(2)}.`
          : `After the first order win is filed with the exchange, with the shares still above ₹${invalidationPrice.toFixed(2)}.`,
      timing: 'as the evidence arrives',
    });
  }

  // ── warnings that belong to the category, not the company ──
  if (!unfunded && amount < params.minPositionValue) {
    warnings.push(
      `A position this small (₹${amount.toLocaleString('en-IN')}) is eaten by charges — the flat ` +
        `depository fee alone is ₹15.34 on every sell day, before the spread.`,
    );
  }
  if (!price.aboveSma200) {
    warnings.push('Below the 200-day average: nothing is bought today under this plan.');
  }
  if (price.pctOf52wRange > 92) {
    warnings.push(
      'Within a few percent of the 52-week high. Paying up for the loudest version of a story is this category’s most reliable way to lose.',
    );
  }
  if ((growth.ageDays ?? 0) > 150) {
    warnings.push(`The latest results are ${growth.ageDays} days old; the next filing may change the picture entirely.`);
  }
  if (orders.error) warnings.push(`Order filings could not be read (${orders.error}).`);

  return {
    amount,
    pctOfCapital: params.capital > 0 ? Math.round((amount / params.capital) * 1000) / 10 : 0,
    tranches,
    invalidation:
      `A monthly close below ₹${invalidationPrice.toFixed(2)} (8% under the 200-day average), or two consecutive ` +
      `quarters of falling revenue, or six months with no new orders. Any one of those means the reason for owning ` +
      `it has gone, and the position is sold rather than held in hope.`,
    invalidationPrice,
    riskAmount,
    nextCheck: `${due.quarterEnd} results, ${due.expected}`,
    holdLabel: '1–3 years, reviewed every quarter',
    warnings,
  };
}

/**
 * How the category budget is divided, decided BEFORE any plan is built.
 *
 * The first version of this sized every idea independently and then trimmed
 * whatever overflowed the cap. On a ₹2 lakh account that produced eleven
 * qualifying names, four with money and seven with a "buy now" plan for ₹0 —
 * an interface telling you to buy nothing. Worse, spreading a 20% budget over
 * eleven names gives each about ₹3,600, which is under the charge floor before
 * it is anything else.
 *
 * So the budget funds a FEW ideas properly instead of all of them badly. How
 * many is arithmetic, not taste: the cap divided by the smallest position worth
 * opening, capped at four because past that a satellite sleeve is just an index
 * with extra steps.
 */
export function fundingPlan(
  ranked: { symbol: string; score: number }[],
  params: PlanParams,
): { budgets: Map<string, number | null>; funded: number; note: string } {
  const cap = (params.capital * params.categoryCapPct) / 100;
  const maxFunded = Math.max(1, Math.min(4, Math.floor(cap / params.minPositionValue)));
  const funded = Math.min(maxFunded, ranked.length);
  const budgets = new Map<string, number | null>();
  const per = funded > 0 ? cap / funded : 0;
  ranked.forEach((r, i) => budgets.set(r.symbol, i < funded ? per : null));

  const note =
    ranked.length === 0
      ? `Nothing qualified, so none of the ₹${Math.round(cap).toLocaleString('en-IN')} category budget is committed.`
      : `₹${Math.round(cap).toLocaleString('en-IN')} (${params.categoryCapPct}% of capital) is split between the top ` +
        `${funded} of ${ranked.length} qualifying ${ranked.length === 1 ? 'idea' : 'ideas'}, about ` +
        `₹${Math.round(per).toLocaleString('en-IN')} each. The rest are watchlist entries with a thesis and no position — ` +
        `spreading the same budget over all ${ranked.length} would put roughly ` +
        `₹${Math.round(cap / ranked.length).toLocaleString('en-IN')} in each, which the fixed charges would eat.`;
  return { budgets, funded, note };
}

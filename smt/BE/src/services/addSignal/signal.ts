/**
 * "Should I add money to this stock now?" — one light per stock. Pure.
 *
 *   green   ADD NOW          buy the planned amount today
 *   yellow  ADD SMALLER      buy today, but a smaller amount — a risky stock
 *   red     WAIT             pause NEW money; what you own is untouched
 *   grey    NO READ          not enough data to say
 *
 * THERE IS NO "WAIT FOR A DIP". The first version had one (yellow = part now,
 * the rest at a dip price or after N sessions). Tested point-in-time on 90
 * large caps, 2017–2025, ~13,000 signals (ADD_SIGNAL.md):
 *
 *                       vs buying all now     worst 5%      P(loss > 20%)
 *   stock dip likely      −0.5% / −0.7%       +1.0 / +0.6   6.3 → 5.9%
 *   market in correction  −1.4% / −2.0%       +1.0 / +0.7   1.7 → 1.8%
 *                         (63 / 252 sessions, negative in both halves)
 *
 * It gave up upside for almost no protection, as "wait for a 1×ATR dip"
 * already had in WARNING_ENGINE.md. So the expected dip and the market's
 * "invest in steps" are now NOTES on the light, each with that cost, and
 * never change the amount.
 *
 * WHAT IS NOT A REASON TO WAIT — each measured in this codebase and lost money:
 *
 *   "near its high / ran up"     hottest names beat the index by MORE
 *   "downtrend / far off high"   positive mean forward return even so
 *   "results are coming"         the results-month premium mostly accrues
 *                                BEFORE the announcement (info note only)
 *
 * WHAT CAN TURN IT RED — the market sign that passed its test in both halves
 * of history, or a structural fact the engine itself obeys:
 *
 *   market HOLD      the breadth-divergence sign (MARKET_WEATHER.md)
 *   surveillance     NSE ASM / GSM / ESM — the engine's own entry block
 *   news veto        >=3 scored headlines strongly negative (recommender rule)
 *   event block      the book's own results / gap-down block, when switched on
 *   halted / kill    the engine will not buy anyway
 *   full             the stock already holds the per-stock cap of capital
 *
 * WHAT TURNS IT YELLOW — size, never timing:
 *
 *   very volatile    ATR >= 5% of price: trailed NIFTY by >20 points over three
 *                    months 13% of the time vs 4% for an average stock — the
 *                    sturdiest finding in the turbulence study (ATR persists at
 *                    0.81 across five-year halves)
 *   thin trading     median turnover < ₹2 crore/day: the exit is the risk
 *
 * Yellow buys SMALLER_FRACTION of the plan now and does not ask you to wait
 * for anything. The fraction is a judgement, not a fitted number: it brings
 * the very-volatile tail (13%) to roughly the size of an ordinary stock's.
 */
import type { Turbulence } from '../recommender/turbulence';

export type Light = 'green' | 'yellow' | 'red' | 'grey';

/** The market-level verdict, as much of it as this needs. */
export interface MarketRead {
  action: 'invest' | 'invest-in-steps' | 'hold';
  steps: 'standard' | 'smaller' | 'front-loaded';
  title: string;
  /** Why, in one line. */
  reason?: string;
}

export interface AddSignalInput {
  symbol: string;
  /** Price a share is bought at (live price for a book, the card's entry for a recommendation). */
  price: number;
  /** Rupees the user could sensibly add (room under the cap, or the card's size). */
  planned: number;
  turbulence: Turbulence | null;
  market: MarketRead | null;
  /** NSE surveillance label ("ASM Stage 1"), or null when clean. */
  surveillance?: string | null;
  /** Why the news veto fired, or null. */
  newsVeto?: string | null;
  /** The book's own entry block, as the engine words it. */
  entryBlock?: string | null;
  /** 'halted' or 'kill' when the engine will not buy at all. */
  stopped?: 'halted' | 'kill' | null;
  /** Set when the stock is already at its per-stock limit. */
  full?: { heldPct: number; capPct: number } | null;
  /** Next results date, YYYY-MM-DD, if one is announced. Information only. */
  resultsOn?: string | null;
  /** Smallest amount worth buying in one go (DP-charge floor). */
  minAmount?: number;
}

export interface AddSignal {
  symbol: string;
  light: Light;
  /** Two or three words for the pill: "Add now", "Add smaller", "Wait". */
  label: string;
  /** Rupees the plan allows. */
  planned: number;
  /** Rupees to add now — whole shares when the price is known; 0 when red or grey. */
  nowAmount: number;
  /** The same in shares; null when no price was known. */
  nowShares: number | null;
  /** nowAmount as a share of the plan, 0..100. */
  nowPct: number;
  /** The plain-English instruction, one sentence. */
  action: string;
  /** Why the light is this colour, most important first. */
  reasons: string[];
  /** Things worth knowing that did NOT change the colour or the amount. */
  notes: string[];
}

/** Share of the plan a yellow buys. A judgement — see the header. */
export const SMALLER_FRACTION = 0.5;
/** ATR% at which a stock counts as very volatile (turbulence.ts HIGH_ATR_PCT). */
export const VERY_VOLATILE_ATR_PCT = 5;

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const sh = (n: number | null): string => (n === null ? '' : ` (${n} share${n === 1 ? '' : 's'})`);

export function addSignal(i: AddSignalInput): AddSignal {
  const notes: string[] = [];
  const base = {
    symbol: i.symbol,
    planned: Math.max(0, Math.round(i.planned)),
    notes,
  };
  const none = { nowAmount: 0, nowShares: 0, nowPct: 0 };

  // ── red: pause new money ──
  const red: string[] = [];
  if (i.stopped === 'halted') red.push('The engine has halted this stock, so it is not buying at any price.');
  if (i.stopped === 'kill') red.push('The kill switch is on for this stock, so no new rungs are bought.');
  if (i.market?.action === 'hold') {
    red.push(`Market sign says HOLD — pause new money everywhere.${i.market.reason ? ` ${i.market.reason}` : ''}`);
  }
  if (i.surveillance) red.push(`NSE has this stock under surveillance (${i.surveillance}). Wait until it is lifted.`);
  if (i.newsVeto) red.push(i.newsVeto);
  if (i.entryBlock) red.push(`The engine is pausing buys: ${i.entryBlock}.`);
  if (i.full) {
    red.push(
      `Already ${i.full.heldPct.toFixed(0)}% of your capital is in this stock (limit ${i.full.capPct}%). Adding more puts too much in one name.`,
    );
  }
  if (i.resultsOn) {
    notes.push(`Results due on ${i.resultsOn}. Not a reason to wait: in past data most of the results-month gain came before the announcement.`);
  }
  if (red.length) {
    return { ...base, ...none, light: 'red', label: 'Wait', action: 'Do not add new money right now. Keep the shares you already have.', reasons: red };
  }

  const t = i.turbulence;
  if (!t) {
    return {
      ...base,
      ...none,
      nowShares: null,
      light: 'grey',
      label: 'No read',
      action: 'Not enough price history to judge this stock.',
      reasons: ['Needs about a year of daily prices to measure how bumpy this stock is.'],
    };
  }

  // ── notes: true, measured, and deliberately NOT allowed to change anything ──
  if (t.stageNowFraction < 1) {
    notes.push(
      `Expect a ~${t.forecast.expectedDipPct.toFixed(0)}% dip, typically within ${t.forecast.dipMedianDays} sessions (${Math.round(t.forecast.dipProbability * 100)}% of similar stocks). Normal. Waiting for it cost ~0.5% on average in a 10-year test, so this does not change the advice.`,
    );
  }
  if (i.market?.action === 'invest-in-steps') {
    notes.push(
      `Market page says "${i.market.title.toLowerCase()}". In a 10-year test, splitting a buy during market falls cost 1–2% vs buying at once, with almost no protection, so this light does not split.`,
    );
  }

  // ── yellow: size, never timing ──
  const yellow: string[] = [];
  const atrPct = (t.forecast.expectedDipPct / t.forecast.expectedDipAtr) || 0;
  if (atrPct >= VERY_VOLATILE_ATR_PCT) {
    yellow.push(
      `Very bumpy: moves ~${atrPct.toFixed(1)}% a day. Stocks like this badly trailed NIFTY ${Math.round(t.forecast.tailRisk * 100)}% of the time (vs 4% for an average stock), so take a smaller position. They also beat it on average, so this is not a reason to skip it.`,
    );
  }
  const thin = t.warnings.find((w) => w.kind === 'thin-liquidity' && w.severity === 'serious');
  if (thin) yellow.push(`${thin.headline} — thinly traded, so keep the position small: selling it may be hard.`);

  const fraction = yellow.length ? SMALLER_FRACTION : 1;
  const planned = base.planned;
  const price = i.price > 0 ? i.price : 0;
  // A buy below the DP floor or below one share is not a buy, so the smaller
  // amount is raised to that floor (never above the plan).
  const want = Math.min(Math.max(0, i.planned), Math.max(Math.max(0, i.planned) * fraction, i.minAmount ?? 0, price));
  let nowShares: number | null = null;
  let nowAmount: number;
  if (price > 0) {
    // Float-noise tolerance only: a plan of exactly 7 × ₹1,590.20 is 7 shares.
    nowShares = Math.floor(want / price + 1e-9);
    nowAmount = Math.round(nowShares * price);
  } else {
    nowAmount = Math.floor(want / 100) * 100;
  }
  const nowPct = planned > 0 ? Math.min(100, Math.round((nowAmount / planned) * 100)) : Math.round(fraction * 100);
  const light: Light = yellow.length ? 'yellow' : 'green';
  const reasons = yellow.length ? yellow : [`No tested warning is on for this stock.`];

  if (planned > 0 && price > 0 && nowShares === 0) {
    return {
      ...base,
      light,
      label: 'Under 1 share',
      nowAmount: 0,
      nowShares: 0,
      nowPct: 0,
      action: `${inr(planned)} does not buy one share at ${inr(price)}. Add at least ${inr(price)} if you want this stock.`,
      reasons,
    };
  }

  const action =
    planned === 0
      ? light === 'yellow'
        ? `Buy now, but only about ${Math.round(fraction * 100)}% of what you would normally put in one stock.`
        : 'Good time to add, if you have money for it.'
      : light === 'yellow'
        ? `Add ${inr(nowAmount)}${sh(nowShares)} now — about half of the ${inr(planned)} you could. Keep the rest for other stocks.`
        : `Add ${inr(nowAmount)}${sh(nowShares)} now.`;
  return { ...base, light, label: light === 'yellow' ? 'Add smaller' : 'Add now', nowAmount, nowShares, nowPct, action, reasons };
}

/** Colour order for sorting: what needs a decision first. */
export const LIGHT_ORDER: Record<Light, number> = { green: 0, yellow: 1, red: 2, grey: 3 };

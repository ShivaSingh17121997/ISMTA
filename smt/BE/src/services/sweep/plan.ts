/**
 * Idle-cash sweep — the pure half.
 *
 * WHY THIS EXISTS
 *
 * The accumulator waits for dips, so most of its money is waiting. Measured on
 * the live dashboard (2026-09-23): ₹1,39,806 of ₹1,98,034 — 71% — sat as
 * settled cash earning nothing. The 5-year simulation found the same thing
 * (capital at work 21–25%) and named parking that cash as the single biggest
 * lever available. This module parks it in a liquid ETF that tracks the
 * overnight rate, and pulls it back the moment a rung needs it.
 *
 * WHY LIQUIDCASE (Zerodha Nifty 1D Rate Liquid ETF)
 *
 *   - Growth NAV: the price rises daily with the overnight rate. LIQUIDBEES
 *     instead holds ₹1,000 and pays taxable daily dividends as fractional
 *     units, which cannot be sold and are taxed every year.
 *   - Expense ratio ~0.23% against LIQUIDBEES' ~0.69%.
 *   - Exchange-traded, so it is bought and sold through the same broker path,
 *     order gate and CNC product as every book.
 *
 * THE THREE FRICTIONS THIS IS SHAPED AROUND
 *
 *   1. The DP charge (₹15.34 + GST) is flat per scrip per SELL day. On ₹1L at
 *      ~5.5% a day's carry is ~₹15, so an in-and-out sweep every day would pay
 *      the depository its whole yield. Park in bulk, once a day; sell only what
 *      is needed; never park an amount too small to earn its exit back.
 *   2. The T1 rule. Proceeds of a sale are usable the same day ONLY for
 *      holdings that have settled — units bought yesterday (T1) sell into cash
 *      that cannot be spent today, and units bought today cannot be sold as
 *      delivery at all. So a lot is USABLE from the second trading day after
 *      its purchase, and the cash kept back must cover the one session in
 *      between — each book's rungs for a day, set by its own buy brake.
 *   3. Gains are taxed at slab rate whatever the holding period (debt-oriented
 *      units bought after 1 Apr 2023). Lots are consumed FIFO, which is also the
 *      order the tax law will match them in.
 *
 * WHAT IT NEVER DOES
 *
 *   - It never touches a lot, a ladder or a breakeven. Books keep their `cash`
 *     exactly as before; the sweep is a treasury layer UNDER them. A book's
 *     rupee is either in the account or in LIQUIDCASE, and the ledger here says
 *     which.
 *   - It never parks unsettled proceeds, and never parks the buffer.
 *   - It never lets a rung go unfunded when usable units could fund it.
 */

export const DEFAULT_SWEEP_SYMBOL = 'LIQUIDCASE';

export interface SweepParams {
  /** Exchange symbol of the parking instrument. */
  symbol: string;
  /** Floor on the cash buffer, whatever the books say. */
  minBufferRs: number;
  /**
   * Smallest amount worth parking. At ₹25,000 the round trip (DP charge + GST,
   * stamp, exchange) is ~₹26 against ~₹3.8/day of carry — about a week to earn
   * back. Anything smaller is paid to the depository.
   */
  minParkRs: number;
  /** Return cash to the books only when short of the buffer by at least this much. */
  minTopUpRs: number;
  /** Fraction of the parkable amount held back for the buy leg's charges. */
  chargePadPct: number;
  /**
   * Also park money the allocator left unassigned (no book holds it: above
   * the per-stock cap or the deployment ceiling, or waiting for the index core
   * to qualify). Without it that money earns nothing.
   */
  includeUnassigned: boolean;
  /** Park window, IST — opens after the accumulator's last possible entry. */
  parkFrom: string;
  parkUntil: string;
  /** Earliest morning top-up, IST — after the opening spike. */
  topUpFrom: string;
}

export const DEFAULT_SWEEP_PARAMS: SweepParams = {
  symbol: DEFAULT_SWEEP_SYMBOL,
  minBufferRs: 10_000,
  minParkRs: 25_000,
  minTopUpRs: 5_000,
  includeUnassigned: true,
  chargePadPct: 0.1,
  parkFrom: '15:01',
  parkUntil: '15:20',
  topUpFrom: '09:20',
};

/** One purchase of the parking ETF. Units are fungible; lots exist for T1 and FIFO. */
export interface SweepLot {
  id: string;
  quantity: number;
  /** Fill price per unit. */
  price: number;
  /** Buy charges paid on this lot, rupees (for its tax cost). */
  charges: number;
  boughtAt: number;
  /** IST date of the purchase. */
  boughtOn: string;
  /** First instant the lot's sale proceeds are spendable the same day (T+2 trading-day start). */
  usableFrom: number;
}

export interface SweepRealised {
  at: number;
  /** Where the units were held. Absent on rows from before this field, which were all paper. */
  venue?: 'paper' | 'live';
  quantity: number;
  /** Cost of the units sold, including their share of buy charges. */
  cost: number;
  /** Sale proceeds after sell charges. */
  proceeds: number;
  gain: number;
  /** Earliest purchase date among the units sold (for the tax view). */
  boughtOn: string;
}

export interface SweepState {
  userId: string;
  enabled: boolean;
  symbol: string;
  lots: SweepLot[];
  /**
   * Rupees currently away from the books' cash because of the sweep: every buy
   * (units + charges) adds to it, every sale's net proceeds subtract from it.
   * After a full unwind it is minus the income earned. The books' cash on hand
   * is always Σ book.cash − cashOut.
   */
  cashOut: number;
  /** Net gain realised by every redemption so far, after all charges. */
  realisedGain: number;
  chargesPaid: number;
  realised: SweepRealised[];
  /** Where the units are held. A sweep never trades lots on the other venue. */
  venue?: 'paper' | 'live';
  /** Set when a human must look; nothing parks or redeems while it is set. */
  haltedReason?: string;
  lastParkDay?: string;
  createdAt: number;
  updatedAt: number;
}

export function newSweepState(userId: string, now: number, symbol = DEFAULT_SWEEP_SYMBOL): SweepState {
  return {
    userId,
    enabled: false,
    symbol,
    lots: [],
    cashOut: 0,
    realisedGain: 0,
    chargesPaid: 0,
    realised: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const unitsHeld = (s: SweepState): number => s.lots.reduce((n, l) => n + l.quantity, 0);

export const usableUnits = (s: SweepState, now: number): number =>
  s.lots.filter((l) => now >= l.usableFrom).reduce((n, l) => n + l.quantity, 0);

export const marketValue = (s: SweepState, price: number): number => unitsHeld(s) * (price > 0 ? price : 0);

/** What the sweep has earned so far, realised and marked: value held + cash returned − cash taken. */
export const totalGain = (s: SweepState, price: number): number => marketValue(s, price) - s.cashOut;

/** The books' settled cash that is physically in the account (not parked). */
export const cashOnHand = (idle: number, s: SweepState): number => idle - s.cashOut;

/**
 * How many units to buy with today's surplus. Zero when the surplus is below
 * `minParkRs` — a small park pays the depository more than it earns.
 */
export function planPark(input: {
  idle: number;
  buffer: number;
  state: SweepState;
  price: number;
  params?: SweepParams;
}): { quantity: number; amount: number; surplus: number; reason: string } {
  const p = input.params ?? DEFAULT_SWEEP_PARAMS;
  const surplus = cashOnHand(input.idle, input.state) - input.buffer;
  if (!(input.price > 0)) return { quantity: 0, amount: 0, surplus, reason: 'no price for the parking ETF' };
  if (surplus < p.minParkRs) {
    return {
      quantity: 0,
      amount: 0,
      surplus,
      reason: `surplus ₹${Math.round(Math.max(0, surplus)).toLocaleString('en-IN')} is under the ₹${p.minParkRs.toLocaleString('en-IN')} minimum worth parking`,
    };
  }
  const quantity = Math.floor((surplus * (1 - p.chargePadPct / 100)) / input.price);
  return {
    quantity,
    amount: quantity * input.price,
    surplus,
    reason: `parking ₹${Math.round(quantity * input.price).toLocaleString('en-IN')} of ₹${Math.round(surplus).toLocaleString('en-IN')} surplus above a ₹${Math.round(input.buffer).toLocaleString('en-IN')} buffer`,
  };
}

/**
 * Units to sell to raise `need` rupees, from USABLE lots only. Rounded up to a
 * whole unit, capped at what is usable. `short` > 0 when usable units cannot
 * cover it — the caller then knows the rest is locked by the T1 rule.
 */
export function planRedeem(input: {
  need: number;
  state: SweepState;
  price: number;
  now: number;
  params?: SweepParams;
}): { quantity: number; amount: number; short: number } {
  const p = input.params ?? DEFAULT_SWEEP_PARAMS;
  if (!(input.need > 0) || !(input.price > 0)) return { quantity: 0, amount: 0, short: Math.max(0, input.need) };
  const usable = usableUnits(input.state, input.now);
  const wanted = Math.ceil((input.need * (1 + p.chargePadPct / 100)) / input.price);
  const quantity = Math.min(usable, wanted);
  const amount = quantity * input.price;
  return { quantity, amount, short: Math.max(0, input.need - amount) };
}

/** Book a buy fill. Adds a lot; the whole outlay leaves the books' cash. */
export function applyParkFill(
  s: SweepState,
  fill: { id: string; quantity: number; price: number; charges: number; at: number; boughtOn: string; usableFrom: number },
): SweepState {
  if (!(fill.quantity > 0)) return s;
  const outlay = fill.quantity * fill.price + fill.charges;
  return {
    ...s,
    lots: [
      ...s.lots,
      {
        id: fill.id,
        quantity: fill.quantity,
        price: fill.price,
        charges: fill.charges,
        boughtAt: fill.at,
        boughtOn: fill.boughtOn,
        usableFrom: fill.usableFrom,
      },
    ],
    cashOut: s.cashOut + outlay,
    chargesPaid: s.chargesPaid + fill.charges,
    updatedAt: fill.at,
  };
}

/**
 * Book a sell fill, consuming lots FIFO — oldest first, which is also the
 * only order that can be usable (a newer lot is never usable before an older
 * one). Throws if asked to sell more than is held: that would book a sale of
 * units the account does not have.
 */
export function applyRedeemFill(
  s: SweepState,
  fill: { quantity: number; price: number; charges: number; at: number },
): SweepState {
  if (!(fill.quantity > 0)) return s;
  const held = unitsHeld(s);
  if (fill.quantity > held) {
    throw new Error(`sweep: selling ${fill.quantity} units but only ${held} are held`);
  }
  let left = fill.quantity;
  let cost = 0;
  let boughtOn = '';
  const lots: SweepLot[] = [];
  for (const lot of [...s.lots].sort((a, b) => a.boughtAt - b.boughtAt)) {
    if (left <= 0) {
      lots.push(lot);
      continue;
    }
    const take = Math.min(left, lot.quantity);
    const share = take / lot.quantity;
    cost += take * lot.price + lot.charges * share;
    if (!boughtOn) boughtOn = lot.boughtOn;
    left -= take;
    if (take < lot.quantity) {
      lots.push({ ...lot, quantity: lot.quantity - take, charges: lot.charges * (1 - share) });
    }
  }
  const proceeds = fill.quantity * fill.price - fill.charges;
  const gain = proceeds - cost;
  const realised: SweepRealised = { at: fill.at, quantity: fill.quantity, cost, proceeds, gain, boughtOn, venue: s.venue ?? 'paper' };
  return {
    ...s,
    lots,
    cashOut: s.cashOut - proceeds,
    realisedGain: s.realisedGain + gain,
    chargesPaid: s.chargesPaid + fill.charges,
    // The full history lives in the audit log; the state keeps the recent tail.
    realised: [...s.realised, realised].slice(-200),
    updatedAt: fill.at,
  };
}

/**
 * How many rungs one book can fire in a single session: one at the first
 * chance, then one each time its buy brake expires inside the entry window.
 * Swing's 24h brake gives 1; scalp's 2h brake over 09:20–15:00 gives 3.
 */
export function rungsPerSession(minBuyGapMs: number, entryWindowMinutes: number): number {
  const gapMin = minBuyGapMs / 60_000;
  if (!(gapMin > 0)) return Math.max(1, Math.ceil(entryWindowMinutes / 60));
  return 1 + Math.floor(Math.max(0, entryWindowMinutes - 1) / gapMin);
}

/**
 * The cash to keep in the account.
 *
 * ONE session of rungs is the exposure. Units parked at 15:01 on day D fund a
 * rung from D+2, so D+1 is the only session they cannot fund — and units parked
 * earlier are usable by then. So each active book keeps what it could spend in
 * one session (`rungs` × its tranche), never more than its own cash, and the
 * total never falls under the floor.
 */
export function bufferNeed(
  books: ReadonlyArray<{ cash: number; tranche: number; rungs: number; active: boolean }>,
  params: SweepParams = DEFAULT_SWEEP_PARAMS,
): number {
  let need = 0;
  for (const b of books) {
    if (!b.active) continue;
    need += Math.min(Math.max(0, b.cash), Math.max(0, b.tranche) * Math.max(1, b.rungs));
  }
  return Math.max(params.minBufferRs, need);
}

/** What a scheduled pass should do, and why. Pure: the service carries it out. */
export type SweepAction =
  | { kind: 'none'; reason: string }
  | { kind: 'park'; quantity: number; reason: string }
  | { kind: 'redeem'; quantity: number; need: number; reason: string };

export function decideScheduled(input: {
  state: SweepState;
  idle: number;
  buffer: number;
  price: number;
  now: number;
  /** IST minutes since midnight and date — passed in so this stays pure. */
  minutes: number;
  today: string;
  params?: SweepParams;
}): SweepAction {
  const p = input.params ?? DEFAULT_SWEEP_PARAMS;
  const s = input.state;
  if (s.haltedReason) return { kind: 'none', reason: `halted: ${s.haltedReason}` };
  if (!(input.price > 0)) return { kind: 'none', reason: `no price for ${s.symbol}` };
  const hm = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const onHand = cashOnHand(input.idle, s);
  const held = unitsHeld(s);

  // Switched off: bring everything home, as fast as T1 allows.
  if (!s.enabled) {
    if (held === 0) return { kind: 'none', reason: 'sweep is off and nothing is parked' };
    const usable = usableUnits(s, input.now);
    if (usable === 0) return { kind: 'none', reason: 'sweep is off; the parked units are still T1-locked' };
    return { kind: 'redeem', quantity: usable, need: usable * input.price, reason: 'sweep switched off — returning parked cash to the books' };
  }

  // Short of the buffer — rungs spent it, a book came back on, or a book was
  // removed or de-funded (all the same arithmetic: buffer − (idle − cashOut)).
  // Refill it so the next dip is not waiting on a sale. Parking only ever
  // takes the surplus ABOVE the buffer, so this cannot churn against it.
  const shortfall = input.buffer - onHand;
  if (held > 0 && shortfall >= p.minTopUpRs && input.minutes >= hm(p.topUpFrom)) {
    const r = planRedeem({ need: shortfall, state: s, price: input.price, now: input.now, params: p });
    if (r.quantity > 0) {
      return {
        kind: 'redeem',
        quantity: r.quantity,
        need: shortfall,
        reason: `cash ₹${Math.round(onHand).toLocaleString('en-IN')} is under the ₹${Math.round(input.buffer).toLocaleString('en-IN')} buffer — returning ₹${Math.round(r.quantity * input.price).toLocaleString('en-IN')} to the books`,
      };
    }
  }

  // Park once a day, after the last possible rung of the session.
  if (input.minutes >= hm(p.parkFrom) && input.minutes < hm(p.parkUntil) && s.lastParkDay !== input.today) {
    const plan = planPark({ idle: input.idle, buffer: input.buffer, state: s, price: input.price, params: p });
    if (plan.quantity > 0) return { kind: 'park', quantity: plan.quantity, reason: plan.reason };
    return { kind: 'none', reason: plan.reason };
  }

  return { kind: 'none', reason: `holding — cash on hand ₹${Math.round(onHand).toLocaleString('en-IN')}, buffer ₹${Math.round(input.buffer).toLocaleString('en-IN')}` };
}

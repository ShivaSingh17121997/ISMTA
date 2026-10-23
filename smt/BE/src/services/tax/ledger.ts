/**
 * Capital-gains ledger for the accumulator's delivery trades. Pure.
 *
 * Indian tax treats every sale FIFO within a demat account (CBDT circular
 * 768/1998): the shares sold are the OLDEST held, whichever of the bot's lots
 * the engine closed. The engine sells its deepest (cheapest, newest) rung
 * first, so a sale the engine books as a +4% profit can be, for tax, the sale
 * of an older, dearer lot at a loss, and the reverse. This module rebuilds the
 * tax view from every buy and sell, independent of the engine's lot accounting.
 *
 * Rules applied (Income-tax Act 2025, in force from 1 April 2026; same
 * substance as ss.111A/112A of the 1961 Act for sales after 23 July 2024):
 *   - Listed equity shares and equity-oriented ETFs: short-term if held 12
 *     months or less, taxed at 20%; long-term after that, taxed at 12.5% on
 *     gains above ₹1,25,000 a year.
 *   - STT is not deductible; brokerage, exchange, stamp, GST and DP charges
 *     are (as cost of acquisition or transfer expenses).
 *   - Set-off: a short-term loss offsets short- or long-term gains; a
 *     long-term loss offsets only long-term gains. What is left carries
 *     forward 8 years (only if the return is filed on time).
 *   - 4% health and education cess. Surcharge is ignored (it depends on total
 *     income), so the tax figure is an estimate.
 *
 * Not in this ledger: the liquid-ETF sweep (a debt fund, taxed at the slab
 * rate; reported separately) and intraday trades (speculative business income).
 */
import { charges } from '../costs';
import type { AccumulatorBook } from '../accumulator/types';

export const STCG_RATE = 0.2;
export const LTCG_RATE = 0.125;
export const LTCG_EXEMPTION = 125_000;
export const CESS = 0.04;
const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;

export interface TaxBuy {
  symbol: string;
  at: number;
  quantity: number;
  /** Deductible cost: everything paid except STT. */
  cost: number;
}

export interface TaxSell {
  symbol: string;
  at: number;
  quantity: number;
  /** Consideration after deductible sale expenses: proceeds with STT added back. */
  proceeds: number;
  /** What the bot's own lot accounting booked for this sale, for comparison. */
  enginePnl: number;
}

export interface TaxMatch {
  symbol: string;
  quantity: number;
  boughtAt: number;
  soldAt: number;
  cost: number;
  proceeds: number;
  gain: number;
  longTerm: boolean;
  /** Financial year of the sale, e.g. "2026-27". */
  fy: string;
}

export interface TaxHolding {
  symbol: string;
  boughtAt: number;
  quantity: number;
  cost: number;
}

export interface FySummary {
  fy: string;
  shortTermGains: number;
  shortTermLosses: number;
  longTermGains: number;
  longTermLosses: number;
  /** Losses brought in from earlier years and used this year. */
  broughtForwardUsed: number;
  taxableShortTerm: number;
  /** Long-term gains after set-off, before the ₹1.25 lakh exemption. */
  netLongTerm: number;
  taxableLongTerm: number;
  estimatedTax: number;
  /** Losses left to carry into later years, by kind. */
  carryForward: { shortTerm: number; longTerm: number };
  /** What the bot's lot accounting booked in the same year, for comparison. */
  enginePnl: number;
  sales: number;
}

/** Financial year (April to March, IST) of an instant, e.g. "2026-27". */
export function financialYear(at: number): string {
  const d = new Date(at + IST);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Held for MORE than twelve months: sold after the same calendar date a year on. */
export function isLongTerm(boughtAt: number, soldAt: number): boolean {
  const b = new Date(boughtAt + IST);
  const y = b.getUTCFullYear() + 1;
  const m = b.getUTCMonth();
  let anniversary = Date.UTC(y, m, b.getUTCDate());
  // 29 Feb has no anniversary in a common year: twelve months end on 28 Feb,
  // not on the 1 Mar that Date.UTC rolls over to.
  if (new Date(anniversary).getUTCMonth() !== m) anniversary = Date.UTC(y, m + 1, 0);
  return soldAt >= anniversary - IST + DAY;
}

/** STT on one CNC leg, which is not deductible. */
function sttOn(side: 'BUY' | 'SELL', price: number, qty: number, instrument: 'EQUITY' | 'ETF'): number {
  return charges(side, price, qty, { product: 'CNC', instrument }).stt;
}

/** Every buy and sell in the books, in tax terms. */
export function transactionsFromBooks(
  books: AccumulatorBook[],
  /** Only lots bought on this venue. A book keeps its paper history after going live. Absent = all. */
  venue?: 'paper' | 'live',
): { buys: TaxBuy[]; sells: TaxSell[] } {
  const buys: TaxBuy[] = [];
  const sells: TaxSell[] = [];
  const on = <T extends { venue?: 'paper' | 'live' }>(l: T): boolean => !venue || (l.venue ?? 'paper') === venue;
  for (const b0 of books) {
    const b = {
      ...b0,
      openLots: b0.openLots.filter(on),
      closedLots: b0.closedLots.filter(on),
      clearedLots: (b0.clearedLots ?? []).filter(on),
    };
    const sym = b.symbol.toUpperCase();
    for (const l of [...b.openLots, ...b.closedLots]) {
      buys.push({ symbol: sym, at: l.openedAt, quantity: l.quantity, cost: l.quoteSpent - sttOn('BUY', l.fillPrice, l.quantity, b.instrument) });
    }
    // Paper lots cleared before going live (always paper lots; the venue
    // filter above keeps them out of a live report): a buy, and a disposal at
    // the marked price, so FIFO matching of earlier sales does not shift.
    for (const l of b.clearedLots ?? []) {
      buys.push({ symbol: sym, at: l.openedAt, quantity: l.quantity, cost: l.quoteSpent - sttOn('BUY', l.fillPrice, l.quantity, b.instrument) });
      sells.push({ symbol: sym, at: l.clearedAt, quantity: l.quantity, proceeds: l.value, enginePnl: l.pnl });
    }
    for (const l of b.closedLots) {
      sells.push({
        symbol: sym,
        at: l.closedAt,
        quantity: l.quantity,
        proceeds: l.proceeds + sttOn('SELL', l.sellPrice, l.quantity, b.instrument),
        enginePnl: l.pnl,
      });
    }
  }
  return { buys, sells };
}

/**
 * FIFO-match sells to buys per symbol. A buy and a sell at the same instant
 * are ordered buy first. Sells beyond what was bought are reported, not
 * guessed at.
 */
export function matchFifo(buys: TaxBuy[], sells: TaxSell[]): { matches: TaxMatch[]; holdings: TaxHolding[]; unmatched: TaxSell[] } {
  const matches: TaxMatch[] = [];
  const holdings: TaxHolding[] = [];
  const unmatched: TaxSell[] = [];
  const symbols = new Set([...buys.map((b) => b.symbol), ...sells.map((s) => s.symbol)]);
  for (const sym of symbols) {
    const queue = buys.filter((b) => b.symbol === sym).sort((a, b) => a.at - b.at).map((b) => ({ ...b }));
    for (const s of sells.filter((x) => x.symbol === sym).sort((a, b) => a.at - b.at)) {
      let left = s.quantity;
      while (left > 0 && queue.length && queue[0].at <= s.at) {
        const head = queue[0];
        const q = Math.min(left, head.quantity);
        const cost = (head.cost * q) / head.quantity;
        const proceeds = (s.proceeds * q) / s.quantity;
        matches.push({
          symbol: sym, quantity: q, boughtAt: head.at, soldAt: s.at, cost, proceeds,
          gain: proceeds - cost, longTerm: isLongTerm(head.at, s.at), fy: financialYear(s.at),
        });
        head.cost -= cost;
        head.quantity -= q;
        left -= q;
        if (head.quantity <= 0) queue.shift();
      }
      if (left > 0) unmatched.push({ ...s, quantity: left, proceeds: (s.proceeds * left) / s.quantity });
    }
    for (const h of queue) if (h.quantity > 0) holdings.push({ symbol: sym, boughtAt: h.at, quantity: h.quantity, cost: h.cost });
  }
  return { matches: matches.sort((a, b) => a.soldAt - b.soldAt), holdings, unmatched };
}

/** Tax for one year's gains after set-off, exemption and cess. */
export function taxFor(shortTerm: number, longTerm: number): number {
  return (Math.max(0, shortTerm) * STCG_RATE + Math.max(0, longTerm - LTCG_EXEMPTION) * LTCG_RATE) * (1 + CESS);
}

/**
 * Year-by-year summary with set-off and carry-forward, oldest year first.
 * `enginePnlByFy` is the bot's own booked P&L per year, shown alongside.
 */
export function summarise(matches: TaxMatch[], enginePnlByFy: Record<string, number> = {}): FySummary[] {
  const years = [...new Set([...matches.map((m) => m.fy), ...Object.keys(enginePnlByFy)])].sort();
  // Losses carried forward, by the year they arose: they may be set off for
  // the next 8 years only, oldest first.
  let carries: { from: number; st: number; lt: number }[] = [];
  const out: FySummary[] = [];
  for (const fy of years) {
    const year = Number(fy.slice(0, 4));
    carries = carries.filter((c) => year - c.from <= 8 && (c.st > 0 || c.lt > 0));
    const ms = matches.filter((m) => m.fy === fy);
    const stG = ms.filter((m) => !m.longTerm && m.gain > 0).reduce((s, m) => s + m.gain, 0);
    const stL = -ms.filter((m) => !m.longTerm && m.gain < 0).reduce((s, m) => s + m.gain, 0);
    const ltG = ms.filter((m) => m.longTerm && m.gain > 0).reduce((s, m) => s + m.gain, 0);
    const ltL = -ms.filter((m) => m.longTerm && m.gain < 0).reduce((s, m) => s + m.gain, 0);

    // This year's losses first: ST loss against ST then LT gains; LT loss against LT only.
    let st = stG - stL;
    let lt = ltG - ltL;
    if (st < 0 && lt > 0) {
      const use = Math.min(-st, lt);
      lt -= use;
      st += use;
    }
    // Then losses brought forward, oldest first: ST carry against ST then LT; LT carry against LT.
    let used = 0;
    for (const c of carries) {
      if (c.st > 0 && st > 0) { const u = Math.min(c.st, st); st -= u; c.st -= u; used += u; }
      if (c.st > 0 && lt > 0) { const u = Math.min(c.st, lt); lt -= u; c.st -= u; used += u; }
      if (c.lt > 0 && lt > 0) { const u = Math.min(c.lt, lt); lt -= u; c.lt -= u; used += u; }
    }
    // What is still negative carries forward from this year.
    const fresh = { from: year, st: 0, lt: 0 };
    if (st < 0) { fresh.st = -st; st = 0; }
    if (lt < 0) { fresh.lt = -lt; lt = 0; }
    if (fresh.st > 0 || fresh.lt > 0) carries.push(fresh);
    const carryST = carries.reduce((s, c) => s + c.st, 0);
    const carryLT = carries.reduce((s, c) => s + c.lt, 0);

    out.push({
      fy,
      shortTermGains: stG,
      shortTermLosses: stL,
      longTermGains: ltG,
      longTermLosses: ltL,
      broughtForwardUsed: used,
      taxableShortTerm: st,
      netLongTerm: lt,
      taxableLongTerm: Math.max(0, lt - LTCG_EXEMPTION),
      estimatedTax: taxFor(st, lt),
      carryForward: { shortTerm: carryST, longTerm: carryLT },
      enginePnl: enginePnlByFy[fy] ?? 0,
      sales: ms.length,
    });
  }
  return out;
}

export interface HarvestCandidate {
  symbol: string;
  quantity: number;
  price: number;
  /** Gain (negative = loss) realised by selling every share held, split by term. */
  shortTerm: number;
  longTerm: number;
  /** Tax this year with and without the harvest. */
  taxBefore: number;
  taxAfter: number;
  /** Round-trip charges to sell today and buy back tomorrow. */
  cost: number;
  /** taxBefore − taxAfter − cost. Only positive candidates are useful. */
  netBenefit: number;
}

/**
 * Tax-loss harvesting candidates for the current year: selling every share of
 * a symbol held at a loss and buying it back the NEXT day (a same-day rebuy is
 * intraday, speculative) realises the loss against this year's gains. India
 * has no wash-sale rule. A harvest only helps when there are gains to offset,
 * so the benefit is the drop in this year's tax, net of the round trip.
 */
export function harvestCandidates(
  holdings: TaxHolding[],
  prices: Record<string, number>,
  instruments: Record<string, 'EQUITY' | 'ETF'>,
  thisYear: FySummary | undefined,
  now: number,
): HarvestCandidate[] {
  const baseST = thisYear?.taxableShortTerm ?? 0;
  const baseLT = thisYear?.netLongTerm ?? 0;
  const taxBefore = taxFor(baseST, baseLT);
  const out: HarvestCandidate[] = [];
  for (const sym of new Set(holdings.map((h) => h.symbol))) {
    const price = prices[sym];
    if (!(price > 0)) continue;
    const lots = holdings.filter((h) => h.symbol === sym);
    const qty = lots.reduce((s, h) => s + h.quantity, 0);
    const inst = instruments[sym] ?? 'EQUITY';
    const sell = charges('SELL', price, qty, { product: 'CNC', instrument: inst });
    const buy = charges('BUY', price, qty, { product: 'CNC', instrument: inst });
    // Consideration after deductible sale expenses (STT is not deductible).
    const perShare = (price * qty - (sell.total - sell.stt)) / qty;
    let st = 0;
    let lt = 0;
    for (const h of lots) {
      const g = perShare * h.quantity - h.cost;
      if (isLongTerm(h.boughtAt, now)) lt += g;
      else st += g;
    }
    if (st + lt >= 0) continue;
    // Re-run this year's set-off with the harvest added.
    let s = baseST + st;
    let l = baseLT + lt;
    if (s < 0 && l > 0) { const u = Math.min(-s, l); l -= u; s += u; }
    const taxAfter = taxFor(s, l);
    const cost = sell.total + buy.total;
    out.push({ symbol: sym, quantity: qty, price, shortTerm: st, longTerm: lt, taxBefore, taxAfter, cost, netBenefit: taxBefore - taxAfter - cost });
  }
  return out.sort((a, b) => b.netBenefit - a.netBenefit);
}

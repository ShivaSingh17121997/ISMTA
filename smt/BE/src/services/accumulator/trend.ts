/**
 * Regime classification and the profile autopilot. Pure.
 *
 * The bot reads the trend and picks the profile that suits it:
 *
 *   sideways  → SCALP.  Chop is where tight targets earn their keep: price
 *                       oscillates through a range, so small round trips
 *                       complete repeatedly. A wide +4% target in a range
 *                       mostly waits.
 *   up        → SWING.  A trend is where a tight target does most damage. It
 *                       sells a rising position for 1.5% and the 2% dip gate
 *                       then refuses to re-enter, so the move is missed. Wide
 *                       targets plus the ratchet ride it instead.
 *   down      → SWING.  Not because swing profits in a downtrend — nothing
 *                       long-only does — but because scalp's 2% gate and 2h
 *                       brake would ladder into a falling market three times
 *                       faster. Under a rule that forbids selling at a loss,
 *                       the cadence into weakness IS the risk. Swing's 3% gate
 *                       and 24h brake are the conservative choice.
 *
 * TWO GUARDS AGAINST CHURN
 *
 * A regime read that flickers would flip the profile daily and each flip
 * changes the targets under open lots. So:
 *
 *   1. A NEUTRAL BAND. The EMAs must separate by more than `bandPct` before
 *      the state is called a trend at all. Without it, two EMAs crossing and
 *      re-crossing by a rupee would read as up/down/up.
 *   2. CONFIRMATION. The raw read must agree with itself for `confirmBars`
 *      consecutive bars before it counts. An unconfirmed read changes nothing.
 *
 * A flip is additionally rate-limited by the caller. This module only ever
 * reports what it sees and what it would do; it holds no state.
 *
 * WHAT THIS CANNOT DO. It cannot make a losing position profitable, and it
 * never touches the breakeven floor. Both profiles sell only above
 * fee-inclusive cost, so switching between them changes cadence and target
 * size, never the guarantee.
 */

import { ema } from '../../strategies/indicators';
import type { AccumulatorBook } from './types';

export type Regime = 'up' | 'down' | 'sideways';

export interface TrendOptions {
  fastPeriod: number;
  slowPeriod: number;
  /** EMA separation below this, as a percent of the slow EMA, reads as sideways. */
  bandPct: number;
  /** Consecutive bars the raw read must agree before it is acted on. */
  confirmBars: number;
  /** Minimum flip interval, ms. Daily bars: a regime cannot meaningfully change faster. */
  minFlipGapMs: number;
}

export const DEFAULT_TREND_OPTIONS: TrendOptions = {
  fastPeriod: 20,
  slowPeriod: 50,
  bandPct: 1.5,
  confirmBars: 3,
  minFlipGapMs: 24 * 60 * 60 * 1000,
};

export interface TrendRead {
  /** The confirmed regime, or null when the last `confirmBars` reads disagree. */
  regime: Regime | null;
  /** Today's read, regardless of confirmation. */
  raw: Regime;
  confirmed: boolean;
  bars: number;
  emaFast: number | null;
  emaSlow: number | null;
  /** (fast − slow) / slow, percent. Signed. */
  spreadPct: number;
  reason: string;
}

/** The regime implied by one pair of EMAs and the neutral band. */
function rawRegime(fast: number, slow: number, bandPct: number): Regime {
  if (!(slow > 0)) return 'sideways';
  const spread = ((fast - slow) / slow) * 100;
  if (spread > bandPct) return 'up';
  if (spread < -bandPct) return 'down';
  return 'sideways';
}

/**
 * Classify the regime from daily closes, oldest first.
 *
 * Returns `regime: null` when there is not enough history or the read has not
 * held for `confirmBars`. A null regime must leave the profile alone.
 */
export function classifyRegime(
  closes: number[],
  opts: TrendOptions = DEFAULT_TREND_OPTIONS,
): TrendRead {
  const bars = closes.length;
  const need = opts.slowPeriod + opts.confirmBars;
  const base: TrendRead = {
    regime: null, raw: 'sideways', confirmed: false, bars,
    emaFast: null, emaSlow: null, spreadPct: 0,
    reason: `insufficient history (${bars} bars, need ${need})`,
  };
  if (bars < need) return base;

  // The raw read at each of the last `confirmBars` bars, newest last.
  const reads: Regime[] = [];
  let emaFast: number | null = null;
  let emaSlow: number | null = null;
  let spreadPct = 0;
  for (let back = opts.confirmBars - 1; back >= 0; back--) {
    const window = closes.slice(0, bars - back);
    const f = ema(window, opts.fastPeriod);
    const s = ema(window, opts.slowPeriod);
    if (f === null || s === null) return base;
    reads.push(rawRegime(f, s, opts.bandPct));
    if (back === 0) {
      emaFast = f;
      emaSlow = s;
      spreadPct = ((f - s) / s) * 100;
    }
  }

  const raw = reads[reads.length - 1];
  const confirmed = reads.every((r) => r === raw);
  const spread = `EMA${opts.fastPeriod} is ${spreadPct >= 0 ? '' : '−'}${Math.abs(spreadPct).toFixed(2)}% ` +
    `${spreadPct >= 0 ? 'above' : 'below'} EMA${opts.slowPeriod} (band ±${opts.bandPct}%)`;

  return {
    regime: confirmed ? raw : null,
    raw,
    confirmed,
    bars,
    emaFast,
    emaSlow,
    spreadPct,
    reason: confirmed
      ? `${raw}: ${spread}, held ${opts.confirmBars} bars`
      : `unconfirmed (${reads.join('→')}): ${spread}`,
  };
}

/** The profile a confirmed regime calls for. See the header for the reasoning. */
export function profileForRegime(regime: Regime): 'scalp' | 'swing' {
  return regime === 'sideways' ? 'scalp' : 'swing';
}

export interface AutoProfileDecision {
  /** The scalp flag the autopilot wants. Null means leave it alone. */
  scalp: boolean | null;
  reason: string;
}

/**
 * What the autopilot would do to one book, given a regime read and the clock.
 * Pure: the caller applies it, and the caller's validation still gets the last
 * word on whether a scalp is economic at this book's tranche size.
 */
export function autoProfileDecision(
  book: Pick<AccumulatorBook, 'scalp' | 'autoProfile' | 'profileSwitchedAt'>,
  read: TrendRead,
  now: number,
  opts: TrendOptions = DEFAULT_TREND_OPTIONS,
): AutoProfileDecision {
  if (!book.autoProfile) return { scalp: null, reason: 'autopilot off — the profile is yours to set' };
  if (!read.confirmed || read.regime === null) {
    return { scalp: null, reason: `holding the current profile: ${read.reason}` };
  }

  const want = profileForRegime(read.regime) === 'scalp';
  if (want === (book.scalp === true)) {
    return {
      scalp: null,
      reason: `${read.regime} → ${want ? 'scalp' : 'swing'}, already there`,
    };
  }

  // Rate limit. Every flip re-targets open lots, so a regime that oscillates
  // around the band must not drag the profile with it.
  const since = now - (book.profileSwitchedAt ?? 0);
  if (book.profileSwitchedAt !== undefined && since < opts.minFlipGapMs) {
    const waitH = Math.ceil((opts.minFlipGapMs - since) / 3_600_000);
    return {
      scalp: null,
      reason: `${read.regime} calls for ${want ? 'scalp' : 'swing'}, but the profile switched ` +
        `${Math.floor(since / 3_600_000)}h ago — waiting ${waitH}h more`,
    };
  }

  return {
    scalp: want,
    reason: `${read.reason} → switching to ${want ? 'scalp' : 'swing'}`,
  };
}

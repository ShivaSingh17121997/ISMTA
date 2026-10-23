/**
 * Which venue's history a user is looking at.
 *
 * Going live does not erase paper history: books keep their sold paper lots,
 * snapshots keep their paper equity, and the tax report still needs both. But
 * a live account's numbers must not include money that was never in it — a
 * curve that runs from ₹2,00,000 of paper equity into a ₹0 Zerodha balance
 * reads as a total loss, and paper profit reads as profit the account made.
 *
 * So every live view is filtered here. Records that carry a venue are judged
 * by it; records from before the venue field existed were all paper. Snapshots
 * written before this field existed are judged by time: anything stamped after
 * the switch to live belongs to the live account.
 */
import { EquitySnapshot } from '../types';
import type { AccumulatorBook } from './accumulator/types';
import { brokerConnections } from './BrokerConnectionService';

export type Venue = 'paper' | 'live';

export interface VenueView {
  venue: Venue;
  /** When the user switched to live; null on paper. */
  liveSince: number | null;
}

export function venueViewFor(userId: string): VenueView {
  const conn = brokerConnections.get(userId);
  return conn?.tradingMode === 'live'
    ? { venue: 'live', liveSince: conn.liveSince ?? null }
    : { venue: 'paper', liveSince: null };
}

/** A lot or snapshot without a venue predates the field, and was paper. */
export function venueOfRecord(r: { venue?: Venue }): Venue {
  return r.venue ?? 'paper';
}

/** The snapshots that belong to the account being viewed. */
export function snapshotsForView(snaps: EquitySnapshot[], view: VenueView): EquitySnapshot[] {
  return snaps.filter((s) => {
    if (s.venue) return s.venue === view.venue;
    // Untagged rows predate the field: paper, unless written after going live.
    const afterSwitch = view.liveSince != null && s.at >= view.liveSince;
    return view.venue === 'live' ? afterSwitch : !afterSwitch;
  });
}

/** True when a record stamped `at` belongs to the live account being viewed. */
export function inLiveWindow(at: number, view: VenueView): boolean {
  return view.liveSince != null && at >= view.liveSince;
}

/**
 * For records with no venue field (orders, trades, audit entries): the
 * earliest timestamp a live view shows, or undefined on paper (show all).
 */
export function liveCutoff(view: VenueView): number | undefined {
  return view.venue === 'live' ? (view.liveSince ?? undefined) : undefined;
}

/**
 * A book as the viewed venue should report it: sold lots from the other venue
 * are left out, so banked profit, win rate and trade counts are that venue's
 * own. Lots cleared before going live are paper by definition. Open lots are
 * never hidden — a live lot held while back on paper is still real shares.
 */
export function bookForView(book: AccumulatorBook, view: VenueView): AccumulatorBook {
  const closedLots = book.closedLots.filter((l) => venueOfRecord(l) === view.venue);
  if (view.venue === 'paper') return closedLots.length === book.closedLots.length ? book : { ...book, closedLots };
  return { ...book, closedLots, clearedLots: [] };
}

'use client';

import { inr, num, pct } from '../lib/format';
import { buildLadder, lotState, type LadderRow, type LotState } from '../lib/ladder';
import type { AccumulatorBook, AccumulatorLot } from '../lib/types';

/**
 * The ladder, rung by rung: what has been bought, what it is worth, and what
 * the engine is still waiting to buy.
 *
 * Rendering only — which rung is in which state, and the three-way colour rule
 * behind it, live in `lib/ladder.ts` where they can be tested. The short
 * version: green means a sale would clear cost INCLUDING sell-side charges,
 * amber means the lot is up on what was spent but selling would still lose
 * once charges land, red means it is down either way. Colouring on `unrealised`
 * alone would paint a lot green that the engine will refuse to sell.
 */

const STATE_STYLE: Record<LotState, { text: string; dot: string; word: string }> = {
  clears: {
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    word: 'in profit',
  },
  deadzone: {
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    word: 'below breakeven',
  },
  down: { text: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-500', word: 'at a loss' },
};

export function LadderList({
  book,
  lots,
  mark,
  nextTranche,
  startDiscountPct,
  hiLookbackDays,
  killed,
  riding,
}: {
  book: AccumulatorBook;
  lots: AccumulatorLot[];
  mark: number;
  nextTranche: number;
  startDiscountPct: number;
  hiLookbackDays: number;
  killed?: boolean;
  /** Confirmed uptrend: a lot reaching its target rides on instead of selling. */
  riding?: boolean;
}) {
  const view = buildLadder(book, lots);

  if (!view) {
    return (
      <p className="text-sm text-zinc-500">
        No ladder is open. The engine anchors one only once price sits {startDiscountPct}% below its{' '}
        {hiLookbackDays}-day high — that gate is what stops a ladder anchoring at a top, which is
        the most expensive thing it can do.
      </p>
    );
  }

  const { rows, epochIndex, anchorPrice, held, sold, waiting, next: nextRung } = view;
  // A tranche under ₹1 buys nothing, so "~₹0" would be a lie of precision.
  // Say why instead: the allocator withheld cash, or the book's own budget is
  // already in open lots.
  const unfunded =
    nextTranche < 1
      ? book.allocatorPaused || !(book.budget > 0)
        ? 'not funded — the allocator has assigned this book no cash'
        : "not funded — this book's budget is fully deployed"
      : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span>
          Ladder {epochIndex} · anchored at{' '}
          <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
            {inr(anchorPrice)}
          </span>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {held} held · {sold} sold · {waiting} waiting
        </span>
        {nextRung && !killed && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              next buy at{' '}
              <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                {inr(nextRung.price)}
              </span>{' '}
              {unfunded ? (
                <span className="text-amber-600 dark:text-amber-400">({unfunded})</span>
              ) : (
                <>(~{inr(nextTranche, 0)})</>
              )}
            </span>
          </>
        )}
        {killed && (
          <span className="text-rose-600 dark:text-rose-400">
            · kill switch on — no rung will be bought
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {rows.map((row) => (
          <RungRow
            key={row.level}
            row={row}
            mark={mark}
            isNext={nextRung?.level === row.level && !killed}
            nextTranche={nextTranche}
            unfunded={unfunded !== null}
            riding={riding}
          />
        ))}
      </ul>

      <p className="mt-3 border-t border-zinc-200 pt-2 text-[11px] leading-snug text-zinc-500 dark:border-zinc-800">
        Green means a sale would clear cost <em>including</em> sell-side charges, so the engine may
        sell. Amber means the lot is up on what you spent but a sale would still lose money once
        charges land — the engine holds. A rung that has been sold is not bought again in this
        ladder; a new one anchors after the last lot closes.
      </p>
    </div>
  );
}

function RungRow({
  row,
  mark,
  isNext,
  nextTranche,
  unfunded,
  riding,
}: {
  row: LadderRow;
  mark: number;
  isNext: boolean;
  nextTranche: number;
  unfunded: boolean;
  riding?: boolean;
}) {
  const below = mark > 0 ? ((row.price / mark - 1) * 100) : 0;

  if (row.kind === 'waiting') {
    return (
      <li
        className={`flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 text-sm ${
          isNext
            ? 'border-blue-300 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/25'
            : 'border-dashed border-zinc-200 dark:border-zinc-800'
        }`}
      >
        <RungBadge level={row.level} tone={isNext ? 'next' : 'waiting'} />
        <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
          {inr(row.price)}
        </span>
        <span className="text-xs text-zinc-500">
          {below <= 0
            ? `${Math.abs(below).toFixed(1)}% below the mark`
            : `${below.toFixed(1)}% above the mark`}
        </span>
        <span className="ml-auto text-xs text-zinc-400">
          {isNext
            ? unfunded
              ? 'not funded — no cash to buy with'
              : `buys ~${inr(nextTranche, 0)} when price crosses`
            : 'waiting'}
        </span>
      </li>
    );
  }

  if (row.kind === 'sold') {
    const l = row.lot;
    return (
      <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
        <RungBadge level={row.level} tone="sold" />
        {/* Recessive, but still a PRICE — zinc-500 on the dark row background
            lands near 3.5:1, which is too thin for a number someone may need
            to read. One step lighter in dark, unchanged in light. */}
        <span className="font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
          {num(l.quantity, 0)} @ {inr(l.fillPrice)}
        </span>
        <span className="text-xs text-zinc-500">
          sold at <span className="font-mono tabular-nums">{inr(l.sellPrice)}</span>
        </span>
        {/* Realised P&L is positive by construction — the engine cannot sell
            below a lot's fee-inclusive floor — so this is green or nothing. */}
        <span
          className={`ml-auto font-mono text-sm tabular-nums ${
            l.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
          }`}
        >
          {l.pnl >= 0 ? '+' : ''}
          {inr(l.pnl)}
        </span>
      </li>
    );
  }

  const l = row.lot;
  const state = lotState(mark, l);
  const s = STATE_STYLE[state];
  const unrealised = l.unrealised ?? 0;
  const pctOnSpend = l.quoteSpent > 0 ? (unrealised / l.quoteSpent) * 100 : 0;
  const toBreakeven = l.breakeven && mark > 0 ? (l.breakeven / mark - 1) * 100 : null;

  return (
    <li
      className={`rounded-lg border px-3 py-2 text-sm ${
        state === 'clears'
          ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/60 dark:bg-emerald-950/20'
          : state === 'deadzone'
            ? 'border-amber-200 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20'
            : 'border-rose-200 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <RungBadge level={row.level} tone="held" />
        <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
          {num(l.quantity, 0)} @ {inr(l.fillPrice)}
        </span>
        {/* State as a dot AND a word: the colour is reinforcement, not the
            message, so this survives greyscale and colour blindness. */}
        <span className="flex items-center gap-1.5 text-xs">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${s.dot}`} />
          <span className={s.text}>{s.word}</span>
        </span>
        <span className={`ml-auto font-mono text-sm tabular-nums ${s.text}`}>
          {unrealised >= 0 ? '+' : ''}
          {inr(unrealised)} ({pct(pctOnSpend, 1)})
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-zinc-500">
        <span>
          spent <span className="font-mono tabular-nums">{inr(l.quoteSpent)}</span>
        </span>
        {l.breakeven !== undefined && (
          <span>
            breakeven <span className="font-mono tabular-nums">{inr(l.breakeven)}</span>
            {toBreakeven !== null && state !== 'clears' && (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}
                — needs {toBreakeven.toFixed(1)}% more
              </span>
            )}
          </span>
        )}
        {l.armed && l.trailStop !== undefined ? (
          <span className="text-blue-600 dark:text-blue-400">
            trailing · exits at <span className="font-mono tabular-nums">{inr(l.trailStop)}</span>
          </span>
        ) : (
          l.target !== undefined && (
            <span>
              {riding ? (
                <span title="Uptrend: at this price the lot starts trailing its high instead of selling, and never sells below it">
                  rides from <span className="font-mono tabular-nums">{inr(l.target)}</span>
                </span>
              ) : (
                <>
                  sells at <span className="font-mono tabular-nums">{inr(l.target)}</span>
                </>
              )}
            </span>
          )
        )}
      </div>
    </li>
  );
}

function RungBadge({ level, tone }: { level: number; tone: 'held' | 'sold' | 'waiting' | 'next' }) {
  const cls: Record<typeof tone, string> = {
    held: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
    sold: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
    waiting: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400',
    next: 'bg-blue-600 text-white',
  };
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${cls[tone]}`}
      title={level === 0 ? 'Rung 0 is the anchor — the buy that sets the ladder' : undefined}
    >
      r{level}
      {level === 0 && <span className="ml-1 font-sans font-normal opacity-70">anchor</span>}
    </span>
  );
}

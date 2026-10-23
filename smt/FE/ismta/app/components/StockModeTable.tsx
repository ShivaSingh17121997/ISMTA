'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, MiniStat, ToggleSwitch } from './ui';
import { ForceSellDialog } from './ForceSellDialog';
import { AddSignalPill, AddSignalSummary, useAddSignals } from './AddSignal';
import { api } from '../lib/api';
import { inr, pct, pnlColor } from '../lib/format';
import type { AccumulatorBook, AccumulatorParams, AccumulatorReport, AddSignal, ScalpProfile } from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * Every stock the bot is watching, with its two mode switches.
 *
 * Ported from the NTB bot's coin table, which is the layout the user asked to
 * reuse: one row per instrument, the live numbers on the left, the switches on
 * the right, and the actions last. Presentational: the page owning it polls
 * once and passes the rows in, so a page never fetches the same endpoint twice.
 *
 * The two modes are NOT peers, and the table is built to make that visible:
 *
 *   No-loss  the engine itself. Off means the scheduler ignores this stock
 *            entirely; open lots stay exactly as they are.
 *   Scalp    a PROFILE inside no-loss — tighter targets, faster entries. It
 *            does nothing while no-loss is off, so its switch is replaced by a
 *            dash rather than rendered as an independent choice.
 *
 * Neither switch can cause a loss to be booked. The sell floor is a lot's
 * fee-inclusive cost and no profile overlays it.
 */

export interface StockRow {
  book: AccumulatorBook;
  mark: number;
  report: AccumulatorReport;
}

export function StockModeTable({
  rows: input,
  profile,
  swing,
  loading,
  onAction,
  emptyMessage = 'No stocks yet. Search the NSE listed-company master on the no-loss page and switch one on.',
  summary = 'full',
}: {
  rows: StockRow[];
  profile?: ScalpProfile;
  /** The swing defaults, so the footnote never hardcodes a number the engine changed. */
  swing?: AccumulatorParams;
  loading: boolean;
  onAction: () => void;
  emptyMessage?: string;
  /**
   * Which figures the strip above the table shows. `'modes'` drops banked and
   * unrealised for a caller that already displays them — see the comment at
   * the strip itself. Defaults to `'full'`, so /accumulator is unchanged.
   */
  summary?: 'full' | 'modes';
}) {
  // The exchange session. Without it, "I pressed Evaluate and nothing happened"
  // has no visible answer, because the engine silently refuses to place orders
  // outside market hours and a no-op looks exactly like a broken button.
  const feed = usePolling(() => api.feed(), 60_000);
  const marketOpen = feed.data?.marketOpen;
  // "Add money now?" per stock. Its own slow poll: the first read can fetch
  // ten years of bars per stock, so it must never ride the fast book poll.
  const add = useAddSignals('books');
  const signalOf = (sym: string): AddSignal | undefined => add.data?.signals[sym.toUpperCase()];

  const rows = [...input].sort(byActivity);
  const on = rows.filter((r) => r.book.enabled);
  const scalping = rows.filter((r) => r.book.enabled && r.book.scalp);
  const banked = rows.reduce((s, r) => s + r.report.bankedProfit, 0);
  const unrealised = rows.reduce((s, r) => s + r.report.unrealisedPnl, 0);

  return (
    <Card
      title="Stocks — no-loss and scalping modes"
      action={
        <Link href="/accumulator" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          Add a stock →
        </Link>
      }
    >
      {marketOpen === false && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>The exchange is closed.</strong> The engine still prices, settles and reads the
          trend, but it will not place an order until the next session. Evaluate will run a pass and
          report back; it just cannot buy or sell right now.
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">{loading ? 'Loading…' : emptyMessage}</p>
      ) : (
        <>
          {/* The dashboard carries banked and unrealised in its own KPI row
              directly above this table, so it asks for the mode counts only —
              printing the same two figures twice on one screen makes a reader
              check whether they disagree. On /accumulator, where nothing sits
              above, the full strip is right and stays the default. */}
          <div className={`mb-4 grid gap-3 ${summary === 'full' ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2'}`}>
            <MiniStat label="No-loss mode on" value={`${on.length} of ${rows.length}`} sub="stocks the scheduler steps" />
            <MiniStat
              label="Scalping"
              value={`${scalping.length}`}
              sub={scalping.length ? scalping.map((r) => r.book.symbol).join(', ') : 'all on the swing profile'}
            />
            {summary === 'full' && (
              <>
                <MiniStat label="Banked profit" value={inr(banked, 0)} tone={banked} sub="closed lots, every one above cost" />
                <MiniStat label="Unrealised" value={inr(unrealised, 0)} tone={unrealised} sub="open lots at the mark" />
              </>
            )}
          </div>

          <AddSignalSummary data={add.data} error={add.error} onRefresh={() => void add.recheck()} refreshing={add.rechecking} />

          {/* Table on desktop, cards on phones — same switches behind both. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Stock</th>
                  <th
                    className="whitespace-nowrap px-2 py-2 text-left font-medium"
                    title="Is now a good time to add NEW money? Green: add now. Yellow: add now, but a smaller amount. Red: wait. Click a light for the reasons."
                  >
                    Add money?
                  </th>
                  <th className="whitespace-nowrap px-2 py-2 text-left font-medium">State</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Equity / banked</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Unrealised</th>
                  <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Holdings</th>
                  <th
                    className="whitespace-nowrap px-2 py-2 text-left font-medium"
                    title="Profile, and the short-term trend the regime autopilot last read (EMA20 vs EMA50). Not the allocator's long-term 50/200 filter."
                  >
                    Profile · trend (20/50)
                  </th>
                  <th
                    className="whitespace-nowrap px-2 py-2 text-center font-medium"
                    title="The no-loss ladder engine. Off = the scheduler leaves this stock alone; open lots stay put."
                  >
                    No-loss
                  </th>
                  <th
                    className="whitespace-nowrap px-2 py-2 text-center font-medium"
                    title="Regime autopilot: the bot reads the trend and picks the profile — sideways to scalp, trend to swing"
                  >
                    Auto
                  </th>
                  <th
                    className="whitespace-nowrap px-2 py-2 text-center font-medium"
                    title="Scalp profile: tighter targets and faster entries, inside no-loss mode. Read-only while autopilot owns it."
                  >
                    Scalp
                  </th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.book.id} row={r} profile={profile} onAction={onAction} signal={signalOf(r.book.symbol)} signalLoading={add.loading} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 gap-3 md:hidden">
            {rows.map((r) => (
              <StockCard key={r.book.id} row={r} profile={profile} onAction={onAction} signal={signalOf(r.book.symbol)} signalLoading={add.loading} />
            ))}
          </div>

          <p className="mt-4 text-xs text-zinc-500">
            <strong>No-loss</strong>{' '}is the engine: it ladders in on weakness and sells each lot only
            above its fee-inclusive cost.{' '}
            <strong>Sell</strong>{' '}is your override: it sells chosen lots at market straight away,
            even at a loss, after showing you the result.{' '}
            <strong>Scalping</strong>{' '}is a profile inside it
            {profile && swing
              ? `: +${profile.targetPct}% targets instead of +${swing.targetPct}%, ${profile.stepPct}% even rungs instead of ${swing.stepPct}% compounding, a ${profile.minBuyGapMs / 3_600_000}h buy gap instead of ${swing.minBuyGapMs / 3_600_000}h, anchoring on a ${profile.startDiscountPct}% dip from the ${profile.hiLookbackDays}-day high instead of ${swing.startDiscountPct}% from the ${swing.hiLookbackDays}-day high, and at most ${profile.maxDeployPct}% of the budget in open lots at once`
              : ''}
            . It changes how often the bot buys and how much profit it takes, never the floor.{' '}
            <strong>Auto</strong>{' '}hands the choice to the bot: it reads the trend from daily closes
            and switches a range-bound stock to scalp, a trending one to swing. A downtrend also uses
            swing, because scalp&apos;s shallower gate would ladder into weakness faster and those
            lots cannot be cut. While Auto is on, Scalp shows the bot&apos;s choice and is not yours
            to set.
          </p>
        </>
      )}
    </Card>
  );
}

/** Allocator-funded and running first, then by budget, then alphabetically. */
function byActivity(a: StockRow, b: StockRow): number {
  const live = (r: StockRow) => (r.book.enabled && !r.book.allocatorPaused ? 0 : r.book.enabled ? 1 : 2);
  return live(a) - live(b) || b.book.budget - a.book.budget || a.book.symbol.localeCompare(b.book.symbol);
}

/**
 * Busy flag plus the OUTCOME of the last action, shared by the row and the card.
 *
 * An action used to report only failures, which made a successful no-op —
 * pressing Evaluate outside market hours, the single most common case — look
 * identical to a dead button. Now an action may return a string, and that
 * string is shown. The engine already explains itself; this stops the interface
 * throwing the explanation away.
 */
function useBookActions(onAction: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  async function run(name: string, fn: () => Promise<string | void | unknown>) {
    setBusy(name);
    setMsg(null);
    try {
      const note = await fn();
      if (typeof note === 'string' && note) setMsg({ text: note, bad: false });
      onAction();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(null);
    }
  }
  return { busy, msg, run };
}

/** What the engine decided on this pass, in one line. */
function outcomeOf(events: { kind: string; detail: string }[] | undefined): string {
  const e = events?.[0];
  return e ? `${e.kind}: ${e.detail}` : 'Evaluated — the engine had nothing to say';
}

/**
 * Off means the bot leaves the book alone: no buys, and no sells either, so you
 * can manage those shares yourself. A book with open lots that should keep
 * selling at its targets wants the kill switch instead, so say so first.
 */
function confirmOff(book: AccumulatorBook): boolean {
  if (!book.enabled || book.openLots.length === 0) return true;
  return window.confirm(
    `Switch no-loss mode off for ${book.symbol}?\n\nIts ${book.openLots.length} open lot(s) will NOT sell while it is off: ` +
      'the bot leaves the book alone. To stop new buys but keep selling at the targets, cancel and use the Kill switch instead.',
  );
}

/** The kill switch halts NEW risk. Engaging it is worth a second look; releasing it is not. */
function confirmKill(book: AccumulatorBook): boolean {
  if (book.killSwitchEngaged) return true;
  return window.confirm(
    `Engage the kill switch on ${book.symbol}?\n\nNo new rungs will be bought. ` +
      `Open lots still sell at their targets — an exit is never blocked.`,
  );
}

/** The regime the autopilot last read, as one glyph. */
function regimeGlyph(r: 'up' | 'down' | 'sideways'): string {
  return r === 'up' ? '▲ up' : r === 'down' ? '▼ down' : '◆ range';
}
function regimeTone(r: 'up' | 'down' | 'sideways'): string {
  if (r === 'up') return 'text-emerald-600 dark:text-emerald-400';
  if (r === 'down') return 'text-rose-600 dark:text-rose-400';
  return 'text-zinc-500';
}

/**
 * Why a flat book is flat. "Waiting for a dip" is only true of a book that
 * could actually buy one — an off or unfunded book will not buy at any price,
 * so it says that instead.
 */
function flatReason(book: AccumulatorBook, startDiscountPct: number): string {
  if (book.haltedReason) return 'halted — not buying';
  if (!book.enabled) return 'no-loss off — not buying';
  if (book.killSwitchEngaged) return 'kill switch on — not buying';
  if (book.entryBlock) return `not buying: ${book.entryBlock}`;
  if (book.allocatorPaused || !(book.budget > 0)) return 'no cash assigned by the allocator';
  return `waiting for a ${startDiscountPct}% dip`;
}

function stateOf(book: AccumulatorBook): { text: string; cls: string } {
  if (book.haltedReason) return { text: '⛔ halted', cls: 'text-rose-600 dark:text-rose-400' };
  if (!book.enabled) return { text: '○ off', cls: 'text-zinc-400' };
  if (book.killSwitchEngaged) return { text: '⛔ kill switch', cls: 'text-rose-600 dark:text-rose-400' };
  if (book.entryBlock) return { text: '⏸ event block', cls: 'text-amber-600 dark:text-amber-400' };
  if (book.allocatorPaused) return { text: '◌ no capital', cls: 'text-amber-600 dark:text-amber-400' };
  return { text: '● running', cls: 'text-emerald-600 dark:text-emerald-400' };
}

interface SignalProps {
  signal?: AddSignal;
  signalLoading?: boolean;
}

function Row({ row, profile, onAction, signal, signalLoading }: { row: StockRow; profile?: ScalpProfile; onAction: () => void } & SignalProps) {
  const { book, mark, report } = row;
  const { busy, msg, run } = useBookActions(onAction);
  const [selling, setSelling] = useState(false);
  const st = stateOf(book);
  const on = !!book.enabled;
  const href = `/accumulator/${encodeURIComponent(book.symbol)}`;

  return (
    <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40">
      <td className="px-2 py-2">
        <Link href={href} className="font-medium hover:underline" title="Chart, trade history and the daily profit calendar">
          {book.symbol}
        </Link>
        {book.name && book.name !== book.symbol && (
          <span className="block max-w-[13rem] truncate text-[10px] text-zinc-500">{book.name}</span>
        )}
      </td>
      <td className="px-2 py-2">
        <AddSignalPill signal={signal} loading={signalLoading} />
      </td>
      <td className="px-2 py-2">
        <span className={`whitespace-nowrap font-mono text-xs ${st.cls}`}>{st.text}</span>
        <span className="block text-[10px] text-zinc-400">mark {mark > 0 ? inr(mark) : '—'}</span>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
        {inr(report.equity, 0)}
        <span className="block text-[10px] text-zinc-500">
          of {inr(book.budget, 0)} · banked {inr(report.bankedProfit, 0)}
        </span>
      </td>
      <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${pnlColor(report.unrealisedPnl)}`}>
        {report.openLots ? inr(report.unrealisedPnl, 0) : '—'}
        {report.openLots > 0 && <span className="block text-[10px] text-zinc-500">{pct(report.unrealisedPct, 1)}</span>}
      </td>
      <td className="px-2 py-2 text-xs">
        {report.openLots > 0 ? (
          <>
            {report.openLots} lot{report.openLots === 1 ? '' : 's'}
            <span className="block text-[10px] text-zinc-500">
              oldest {Math.round(report.oldestOpenLotDays)}d · worst {pct(report.worstOpenLotPct, 1)}
            </span>
          </>
        ) : (
          <span className="text-zinc-500">
            flat
            <span className="block text-[10px]">{flatReason(book, report.startDiscountPct)}</span>
          </span>
        )}
      </td>
      <td className="px-2 py-2 font-mono text-[11px]">
        <span className={report.scalpOn ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-500'}>
          {report.scalpOn ? '⚡ scalp' : '◼ swing'}
        </span>
        {book.regime && (
          <span
            className={`ml-1 ${regimeTone(book.regime)}`}
            title={`Short-term trend (EMA20 vs EMA50)${book.regimeNote ? ` — ${book.regimeNote}` : ''}`}
          >
            {regimeGlyph(book.regime)}
          </span>
        )}
        <span className="block text-[10px] text-zinc-400">
          +{report.targetPct}% · {report.tranches} rungs
        </span>
      </td>
      <td className="px-2 py-2 text-center">
        <ToggleSwitch
          on={on}
          busy={busy === 'enabled'}
          title={on ? 'Switch no-loss mode off: the book is left alone, and its open lots do not sell' : 'Switch no-loss mode on'}
          onToggle={() => { if (confirmOff(book)) void run('enabled', () => api.toggleAccumulator(book.symbol)); }}
        />
      </td>
      <td className="px-2 py-2 text-center">
        {on ? (
          <ToggleSwitch
            on={!!book.autoProfile}
            busy={busy === 'auto'}
            title={
              book.regimeNote
                ? `Regime autopilot. Last read — ${book.regimeNote}`
                : 'Regime autopilot: sideways switches to scalp, a confirmed trend switches to swing'
            }
            onToggle={() => run('auto', () => api.toggleAutopilot(book.symbol))}
          />
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-center">
        {!on ? (
          <span className="cursor-help text-zinc-400" title="Scalping is a profile inside no-loss mode. Switch no-loss on first.">
            —
          </span>
        ) : book.autoProfile ? (
          // One controller per knob: while the autopilot owns the profile, this
          // is a read-out, not a switch. A human and a bot fighting over the
          // same control is how a book flips profiles twice a day.
          <span
            className="cursor-help font-mono text-[10px] text-blue-600 dark:text-blue-400"
            title={`The autopilot owns this while it is on. ${book.regimeNote ?? ''}`}
          >
            {book.scalp ? 'on' : 'off'}·auto
          </span>
        ) : (
          <ToggleSwitch
            on={!!book.scalp}
            busy={busy === 'scalp'}
            title={
              profile
                ? `Scalp profile: +${profile.targetPct}% targets, ${profile.stepPct}% rungs, ${profile.minBuyGapMs / 3_600_000}h buy gap, max ${profile.maxDeployPct}% deployed`
                : 'Scalp profile'
            }
            onToggle={() => run('scalp', () => api.toggleScalp(book.symbol))}
          />
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center justify-end gap-1.5">
          {msg && (
            <span
              title={msg.text}
              className={`max-w-[16rem] truncate text-[10px] ${
                msg.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500'
              }`}
            >
              {msg.text}
            </span>
          )}
          {book.openLots.length > 0 && (
            <button
              onClick={() => setSelling(true)}
              disabled={busy !== null}
              title="Sell open lots now, at market, even below cost. Shows the result before anything is sent."
              className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-40 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
            >
              Sell
            </button>
          )}
          {selling && <ForceSellDialog symbol={book.symbol} onClose={() => setSelling(false)} onDone={onAction} />}
          <button
            onClick={() =>
              run('step', async () => outcomeOf((await api.stepAccumulator(book.symbol)).events))
            }
            title="Run one engine pass now instead of waiting for the next tick. Its decision appears here."
            disabled={busy !== null}
            className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Evaluate
          </button>
          <button
            onClick={() => {
              if (!confirmKill(book)) return;
              void run('kill', () => api.accumulatorKillSwitch(book.symbol, !book.killSwitchEngaged));
            }}
            disabled={busy !== null}
            className={`rounded-md px-2 py-1 text-[11px] disabled:opacity-40 ${
              book.killSwitchEngaged
                ? 'bg-rose-600 text-white hover:bg-rose-700'
                : 'border border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/40'
            }`}
            title="Halts new entries only. An exit above cost is never blocked."
          >
            {book.killSwitchEngaged ? 'Release' : 'Kill'}
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The same row as a card, for phones. Same switches, same handlers. */
function StockCard({ row, profile, onAction, signal, signalLoading }: { row: StockRow; profile?: ScalpProfile; onAction: () => void } & SignalProps) {
  const { book, mark, report } = row;
  const { busy, msg, run } = useBookActions(onAction);
  const [selling, setSelling] = useState(false);
  const st = stateOf(book);
  const on = !!book.enabled;

  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/accumulator/${encodeURIComponent(book.symbol)}`} className="font-medium hover:underline">
            {book.symbol}
          </Link>
          {book.name && book.name !== book.symbol && (
            <div className="truncate text-[10px] text-zinc-500">{book.name}</div>
          )}
        </div>
        <div className="text-right">
          <span className={`font-mono text-xs ${st.cls}`}>{st.text}</span>
          <span className="block text-[10px] text-zinc-400">mark {mark > 0 ? inr(mark) : '—'}</span>
        </div>
      </div>

      <div className="mt-2">
        <AddSignalPill signal={signal} loading={signalLoading} />
      </div>

      <div className="mt-2 grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 text-xs">
        <Num label="Equity" value={inr(report.equity, 0)} />
        <Num label="Banked" value={inr(report.bankedProfit, 0)} tone={report.bankedProfit} />
        <Num label="Unrealised" value={report.openLots ? inr(report.unrealisedPnl, 0) : '—'} tone={report.unrealisedPnl} />
      </div>

      <div className="mt-2 space-y-1.5">
        <ToggleRow
          label="No-loss mode"
          hint="ladders in on weakness, sells each lot only above its fee-inclusive cost"
          on={on}
          busy={busy === 'enabled'}
          onToggle={() => { if (confirmOff(book)) void run('enabled', () => api.toggleAccumulator(book.symbol)); }}
        />
        {on ? (
          <ToggleRow
            label="Scalping"
            hint={
              profile
                ? `+${profile.targetPct}% targets, ${profile.stepPct}% rungs, ${profile.minBuyGapMs / 3_600_000}h gap, max ${profile.maxDeployPct}% deployed`
                : 'tighter targets, faster entries'
            }
            on={!!book.scalp}
            busy={busy === 'scalp'}
            onToggle={() => run('scalp', () => api.toggleScalp(book.symbol))}
          />
        ) : (
          <div className="flex items-center justify-between rounded-md bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-900">
            <span className="text-xs text-zinc-500">Scalping</span>
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">needs no-loss on</span>
          </div>
        )}
      </div>

      {msg && (
        <p className={`mt-2 text-[10px] ${msg.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500'}`}>
          {msg.text}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Badge tone={report.scalpOn ? 'blue' : 'neutral'}>{report.scalpOn ? '⚡ scalp' : '◼ swing'}</Badge>
        <span className="text-[10px] text-zinc-500">
          +{report.targetPct}% target · {report.tranches} rungs
        </span>
        {book.openLots.length > 0 && (
          <button
            onClick={() => setSelling(true)}
            disabled={busy !== null}
            className="ml-auto rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 disabled:opacity-40 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
          >
            Sell
          </button>
        )}
        {selling && <ForceSellDialog symbol={book.symbol} onClose={() => setSelling(false)} onDone={onAction} />}
        <button
          onClick={() =>
            run('step', async () => outcomeOf((await api.stepAccumulator(book.symbol)).events))
          }
          disabled={busy !== null}
          className={`${book.openLots.length > 0 ? '' : 'ml-auto '}rounded-md border border-zinc-300 px-2 py-1 text-[11px] disabled:opacity-40 dark:border-zinc-700`}
        >
          {busy === 'step' ? '…' : 'Evaluate'}
        </button>
        <button
          onClick={() => {
            if (!confirmKill(book)) return;
            void run('kill', () => api.accumulatorKillSwitch(book.symbol, !book.killSwitchEngaged));
          }}
          disabled={busy !== null}
          className={`rounded-md px-2 py-1 text-[11px] disabled:opacity-40 ${
            book.killSwitchEngaged
              ? 'bg-rose-600 text-white'
              : 'border border-rose-300 text-rose-600 dark:border-rose-900'
          }`}
        >
          {book.killSwitchEngaged ? 'Release' : 'Kill'}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  busy,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-900">
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium">{label}</span>
        <span className="truncate text-[9px] text-zinc-500" title={hint}>
          {hint}
        </span>
      </div>
      <ToggleSwitch on={on} busy={busy} title={hint} onToggle={onToggle} />
    </div>
  );
}

/** Tiny stat for the phone card. `MiniStat` is the strip-sized one. */
function Num({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="flex flex-col rounded-md bg-zinc-100 px-2 py-1.5 dark:bg-zinc-900">
      <span className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={`font-mono text-xs tabular-nums ${tone !== undefined ? pnlColor(tone) : ''}`}>{value}</span>
    </div>
  );
}

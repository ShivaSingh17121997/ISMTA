'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Card, DlRow, PageHeader, StatCard, ToggleSwitch, eventKindColor } from '../../components/ui';
import { ClosedLotsTable } from '../../components/ClosedLotsTable';
import { LadderList } from '../../components/LadderList';
import { DailyPnlCalendar } from '../../components/DailyPnlCalendar';
import { PriceChart } from '../../components/PriceChart';
import type { PriceLine } from '../../components/CandleChart';
import { api } from '../../lib/api';
import { dateTime, inr, num, pct, pnlColor, time } from '../../lib/format';
import { usePolling } from '../../lib/usePolling';
import { useNow } from '../../lib/useNow';

/**
 * One stock's detail page: /accumulator/SYRMA
 *
 * The equivalent of the NTB bot's per-coin page — chart, performance, daily
 * P&L calendar, trade history — rebuilt around this engine's unit of account.
 * NTB has trades; this has LOTS, each with its own cost basis, and that is the
 * whole reason the no-loss guarantee holds. So every panel here is per-lot.
 *
 * The page is arranged so the flattering numbers cannot be read alone. Banked
 * profit and a ~100% win rate sit beside the lock-up age and the worst open
 * lot, because the first two are guaranteed by construction and the last two
 * are where the actual risk lives.
 */

const RANGES: { label: string; range: string; interval: string }[] = [
  { label: '1D', range: '1d', interval: '5m' },
  { label: '5D', range: '5d', interval: '15m' },
  { label: '1M', range: '1mo', interval: '1d' },
  { label: '3M', range: '3mo', interval: '1d' },
  { label: '1Y', range: '1y', interval: '1d' },
];

export default function StockDetailPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();

  const router = useRouter();
  const detail = usePolling(() => api.accumulatorBook(symbol), 4000);
  const now = useNow(60_000);
  const [rangeIdx, setRangeIdx] = useState(3);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const book = detail.data?.book;
  const report = detail.data?.report;
  const mark = detail.data?.mark ?? 0;
  const lots = detail.data?.lots ?? [];
  const events = detail.data?.events ?? [];
  const closed = book?.closedLots ?? [];

  // An action may return a string: the engine's own account of what it did.
  // Without this a successful no-op — Evaluate outside market hours — is
  // indistinguishable from a dead button.
  async function run(key: string, fn: () => Promise<string | void | unknown>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const out = await fn();
      if (typeof out === 'string' && out) setNote(out);
      detail.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (detail.error && !book) {
    return (
      <div>
        <PageHeader title={symbol} action={<BackLink />} />
        <Card>
          <p className="text-sm text-rose-500">{detail.error}</p>
          <p className="mt-2 text-sm text-zinc-500">
            No book exists for {symbol}. Switch no-loss mode on for it first.
          </p>
        </Card>
      </div>
    );
  }

  if (!book || !report) {
    return (
      <div>
        <PageHeader title={symbol} action={<BackLink />} />
        <Card>
          <p className="text-sm text-zinc-500">Loading…</p>
        </Card>
      </div>
    );
  }

  const on = !!book.enabled;
  const epoch = book.epochs.find((e) => e.status === 'OPEN');
  // What the engine is watching for, drawn on the price.
  const priceLines: PriceLine[] = [
    ...lots.flatMap((l) => [
      ...(l.breakeven
        ? [{ price: l.breakeven, color: '#f59e0b', title: `BE r${l.level}`, style: 'dashed' as const }]
        : []),
      ...(l.target
        ? [{ price: l.target, color: '#10b981', title: `Sell r${l.level}`, style: 'solid' as const }]
        : []),
    ]),
    ...(epoch
      ? epoch.levels
          // No axis tag for rungs: they are the least urgent lines and their
          // tags were covering the live price and the sell targets.
          .map((p, i) => ({
            price: p,
            color: '#3b82f6',
            title: `Rung ${i}`,
            style: 'dotted' as const,
            axisLabel: false,
          }))
          .filter((_, i) => !epoch.filledLevels.includes(i))
      : []),
  ];

  // Per-trade statistics. Only meaningful once something has been sold.
  const n = closed.length;
  const avgProfit = n ? closed.reduce((s, l) => s + l.pnl, 0) / n : 0;
  const avgHoldDays = n ? closed.reduce((s, l) => s + (l.closedAt - l.openedAt), 0) / n / 86_400_000 : 0;
  const bestTrade = n ? closed.reduce((b, l) => (l.pnl > b.pnl ? l : b)) : null;
  const longestHold = n
    ? closed.reduce((b, l) => (l.closedAt - l.openedAt > b.closedAt - b.openedAt ? l : b))
    : null;
  const turnover = closed.reduce((s, l) => s + l.quoteSpent, 0);
  const returnOnTurnover = turnover > 0 ? (report.bankedProfit / turnover) * 100 : 0;
  const r = RANGES[rangeIdx];

  return (
    <div>
      <PageHeader
        title={book.symbol}
        subtitle={book.name && book.name !== book.symbol ? book.name : undefined}
        action={<BackLink />}
      />

      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── modes and actions ── */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <ToggleSwitch
          on={on}
          busy={busy === 'enabled'}
          label={on ? 'No-loss mode ON' : 'No-loss mode OFF'}
          onToggle={() => run('enabled', () => api.toggleAccumulator(book.symbol))}
        />
        {on && (
          <ToggleSwitch
            on={!!book.autoProfile}
            busy={busy === 'auto'}
            label={book.autoProfile ? 'Autopilot ON' : 'Autopilot OFF'}
            title={book.regimeNote ?? 'Reads the trend and picks the profile: sideways to scalp, trend to swing'}
            onToggle={() => run('auto', () => api.toggleAutopilot(book.symbol))}
          />
        )}
        {on && !book.autoProfile && (
          <ToggleSwitch
            on={!!book.scalp}
            busy={busy === 'scalp'}
            label={book.scalp ? 'Scalping ON' : 'Scalping OFF'}
            title={report.profileNote}
            onToggle={() => run('scalp', () => api.toggleScalp(book.symbol))}
          />
        )}
        {on && book.autoProfile && (
          <span className="font-mono text-xs text-blue-600 dark:text-blue-400" title={book.regimeNote}>
            Scalping {book.scalp ? 'ON' : 'OFF'} · autopilot&apos;s choice
          </span>
        )}
        <Badge tone={report.scalpOn ? 'blue' : 'neutral'}>{report.scalpOn ? '⚡ scalp' : '◼ swing'}</Badge>
        <Badge tone={book.instrument === 'ETF' ? 'blue' : 'amber'}>
          {book.instrument === 'ETF' ? 'Index ETF' : 'Single stock'}
        </Badge>
        <Badge tone="neutral">CNC</Badge>
        {book.killSwitchEngaged && <Badge tone="red">Kill switch</Badge>}
        {book.haltedReason && <Badge tone="red">Halted</Badge>}
        {book.entryBlock && (
          <span title={book.entryBlock}>
            <Badge tone="amber">New rungs blocked</Badge>
          </span>
        )}
        {book.allocatorPaused && <Badge tone="amber">Allocator: paused</Badge>}
        <span className="text-sm text-zinc-500">mark {mark > 0 ? inr(mark) : '—'}</span>
        <div className="ml-auto flex gap-2">
          {book.openLots.length === 0 && (
            <button
              onClick={() => {
                if (!window.confirm(`Remove the ${book.symbol} book?\n\nIt holds no lots, so nothing is orphaned. Its history goes with it.`)) return;
                void run('remove', async () => {
                  await api.deleteAccumulator(book.symbol);
                  router.push('/dashboard');
                });
              }}
              disabled={busy !== null}
              title="Remove this book. Only possible while it holds no lots."
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Remove
            </button>
          )}
          <button
            onClick={() =>
              run('step', async () => {
                const r = await api.stepAccumulator(book.symbol);
                const e = r.events?.[0];
                return e ? `: ` : 'Evaluated — the engine had nothing to say';
              })
            }
            disabled={busy !== null}
            title="Run one engine pass now instead of waiting for the next tick. Its decision appears below."
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Evaluate now
          </button>
          <button
            onClick={() => {
              // Engaging halts new risk and deserves a second look. Releasing does not.
              if (
                !book.killSwitchEngaged &&
                !window.confirm(
                  `Engage the kill switch on ${book.symbol}?\n\nNo new rungs will be bought. Open lots still sell at their targets — an exit is never blocked.`,
                )
              ) {
                return;
              }
              void run('kill', () => api.accumulatorKillSwitch(book.symbol, !book.killSwitchEngaged));
            }}
            disabled={busy !== null}
            className={`rounded-md px-3 py-1.5 text-xs disabled:opacity-50 ${
              book.killSwitchEngaged
                ? 'bg-rose-600 text-white hover:bg-rose-700'
                : 'border border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/40'
            }`}
          >
            {book.killSwitchEngaged ? 'Release kill switch' : 'Kill switch'}
          </button>
        </div>
      </div>

      {/* What the last action actually did. The engine explains itself; this
          is where it gets read, so a no-op never looks like a dead button. */}
      {note && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          {note}
        </div>
      )}

      {book.allocatorNote && (
        <p className="mb-4 text-xs text-zinc-500">Allocator: {book.allocatorNote}</p>
      )}

      {/* ── headline numbers ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Equity" value={inr(report.equity)} sub={`of ${inr(book.budget, 0)} allocated`} />
        <StatCard
          label="Banked profit"
          value={inr(report.bankedProfit)}
          colored={report.bankedProfit}
          sub={n ? `${n} lot${n === 1 ? '' : 's'} sold` : 'nothing sold yet'}
        />
        <StatCard
          label="Unrealised"
          value={report.openLots ? inr(report.unrealisedPnl) : '—'}
          colored={report.unrealisedPnl}
          sub={report.openLots ? pct(report.unrealisedPct, 2) : 'no open lots'}
        />
        <StatCard
          label="Open lots"
          value={String(report.openLots)}
          sub={report.openLots ? `oldest ${Math.round(report.oldestOpenLotDays)}d` : 'flat'}
        />
      </div>

      {/* ── chart ── */}
      <Card
        title="Price, ladder rungs and sell targets"
        className="mb-6"
        action={
          <div className="flex gap-1">
            {RANGES.map((x, i) => (
              <button
                key={x.label}
                onClick={() => setRangeIdx(i)}
                className={`rounded px-2 py-1 text-xs ${
                  i === rangeIdx
                    ? 'bg-blue-600 text-white'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>
        }
      >
        <PriceChart
          symbol={book.symbol}
          livePrice={mark > 0 ? mark : undefined}
          range={r.range}
          interval={r.interval}
          height={360}
          showVolume
          priceLines={priceLines}
        />
        <p className="mt-2 text-xs text-zinc-500">
          <span className="text-blue-500">Blue dotted</span>: unfilled ladder rungs — a buy fires when price
          crosses one. <span className="text-amber-500">Amber dashed</span>: each open lot&apos;s fee-inclusive
          breakeven; it can never be sold below this. <span className="text-emerald-500">Green</span>: the
          resting sell target.
          {!epoch && ' No epoch is open yet, so there are no rungs to show.'}
        </p>
      </Card>

      {/* ── the ladder, rung by rung ──
          Directly under the chart because it is the same information read a
          different way: the chart shows WHERE the rungs are, this shows what
          each one has done. */}
      <Card title="The ladder — every rung" className="mb-6">
        <LadderList
          book={book}
          lots={lots}
          mark={mark}
          nextTranche={detail.data?.nextTranche ?? 0}
          startDiscountPct={report.startDiscountPct}
          hiLookbackDays={report.hiLookbackDays}
          killed={book.killSwitchEngaged}
          riding={report.ridingUptrend}
        />
      </Card>

      {/* ── performance and the honest numbers ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Per-trade performance">
          {n === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing sold yet, so there is nothing to measure. The engine anchors a ladder only once
              price sits {report.startDiscountPct}% below its {report.hiLookbackDays}-day high.
            </p>
          ) : (
            <dl className="space-y-2 text-sm">
              <DlRow label="Lots sold" value={String(n)} />
              <DlRow label="Average profit" value={inr(avgProfit)} valueClass={pnlColor(avgProfit)} />
              <DlRow
                label="Return on capital cycled"
                value={pct(returnOnTurnover, 2)}
                hint={`${inr(report.bankedProfit)} on ${inr(turnover, 0)} deployed and recovered`}
              />
              <DlRow label="Average hold" value={`${num(avgHoldDays, 1)} d`} hint="How long capital was tied up" />
              <DlRow
                label="Best trade"
                value={bestTrade ? inr(bestTrade.pnl) : '—'}
                hint={bestTrade ? `rung ${bestTrade.level}, ${dateTime(bestTrade.closedAt)}` : undefined}
              />
              <DlRow
                label="Longest hold"
                value={
                  longestHold
                    ? `${num((longestHold.closedAt - longestHold.openedAt) / 86_400_000, 0)} d`
                    : '—'
                }
                hint={longestHold ? `rung ${longestHold.level}, sold for ${inr(longestHold.pnl)}` : undefined}
              />
              <DlRow
                label="Win rate"
                value={`${report.winRatePct.toFixed(0)}%`}
                hint={report.winRateLabel}
              />
            </dl>
          )}
        </Card>

        <Card title="The honest numbers">
          <dl className="space-y-2 text-sm">
            <DlRow label="Settled cash" value={inr(report.cash)} />
            <DlRow
              label="Unsettled (T+1)"
              value={inr(report.unsettledCash)}
              hint="Sold, not yet settled — cannot fund a buy"
            />
            <DlRow label="Deployed in lots" value={inr(report.deployed)} />
            <DlRow
              label="Deployment ceiling"
              value={inr(report.deployCeiling, 0)}
              hint={report.scalpOn ? 'Scalp caps how much can sit in open lots' : 'Swing: reserve only'}
            />
            <DlRow label="Reserve, never deployed" value={inr(report.reserve)} />
            <DlRow
              label="Oldest open lot"
              value={report.openLots ? `${Math.round(report.oldestOpenLotDays)} d` : '—'}
              hint="How long capital has been locked up"
            />
            <DlRow
              label="Worst open lot"
              value={report.openLots ? pct(report.worstOpenLotPct) : '—'}
              valueClass={pnlColor(report.worstOpenLotPct)}
              hint="The real risk: it can never be sold at a loss to escape"
            />
          </dl>
        </Card>

        <Card title="Profile in force">
          <dl className="space-y-2 text-sm">
            <DlRow
              label="Profile"
              value={report.scalpOn ? '⚡ scalp' : '◼ swing'}
              hint={book.autoProfile ? "chosen by the autopilot from the trend" : 'set by you'}
            />
            <DlRow
              label="Regime"
              value={
                book.regime === 'up' ? '▲ uptrend' : book.regime === 'down' ? '▼ downtrend' : book.regime === 'sideways' ? '◆ range' : '—'
              }
              hint={book.regimeNote ?? 'no trend read yet'}
              valueClass={
                book.regime === 'up'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : book.regime === 'down'
                    ? 'text-rose-600 dark:text-rose-400'
                    : ''
              }
            />
            <DlRow
              label="Profit target"
              value={
                report.ridingUptrend
                  ? `+${report.targetPct}%, then rides`
                  : `+${report.targetPct}% over breakeven`
              }
              hint={
                report.ridingUptrend
                  ? `Uptrend: sells ${report.uptrendTrailPct}% below the high, never below the target`
                  : 'Sells at the target. In a confirmed uptrend lots ride past it instead'
              }
            />
            <DlRow label="Ladder rungs" value={`${report.tranches} × ${report.stepPct}%`} />
            <DlRow label="Buy brake" value={`${report.minBuyGapHours} h between rungs`} />
            <DlRow
              label="Anchors on"
              value={`${report.startDiscountPct}% dip / ${report.hiLookbackDays}d high`}
            />
            <DlRow label="Budget" value={inr(book.budget, 0)} />
          </dl>
          <p className="mt-3 text-xs text-zinc-500">{report.profileNote}</p>
        </Card>
      </div>

      {/* ── daily P&L calendar ── */}
      <div className="mb-6">
        <DailyPnlCalendar lots={closed} title={`Daily profit — ${book.symbol}`} />
      </div>

      {/* ── trade history ── */}
      <div className="mb-6">
        <ClosedLotsTable symbol={book.symbol} lots={closed} />
      </div>

      {/* ── open lots ── */}
      <Card title={`Open lots (${lots.length})`} className="mb-6">
        {lots.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No lots open. Each rung buys one tranche and is never netted with another — every lot carries
            its own cost basis, which is what the invariant rests on.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Rung</th>
                  <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Bought</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Qty</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Fill</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Cost</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Breakeven</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Target</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Value</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">P&amp;L</th>
                  <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Held</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => {
                  const value = lot.marketValue ?? lot.quantity * mark;
                  const pnl = lot.unrealised ?? value - lot.quoteSpent;
                  const days = now ? (now - lot.openedAt) / 86_400_000 : 0;
                  return (
                    <tr key={lot.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">
                        e{lot.epoch}·r{lot.level}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs text-zinc-500">
                        {dateTime(lot.openedAt)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{lot.quantity}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr(lot.fillPrice)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr(lot.quoteSpent)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {lot.breakeven ? inr(lot.breakeven) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {lot.armed && lot.trailStop ? (
                          <span title={`Ratchet armed. High ₹${(lot.hwm ?? 0).toFixed(2)}; exits on a ${lot.trailPct ?? report.trailRetracePct}% giveback, never below the ₹${(lot.target ?? 0).toFixed(2)} target.`}>
                            {inr(lot.trailStop)}
                            <span className="block text-[10px] text-blue-600 dark:text-blue-400">
                              ⤒ trailing
                            </span>
                          </span>
                        ) : lot.target ? (
                          inr(lot.target)
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr(value)}</td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${pnlColor(pnl)}`}>
                        {inr(pnl)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-zinc-500">
                        {!now ? '—' : days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(0)}d`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── engine log ── */}
      <Card title={`Engine log — ${book.symbol}`}>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing logged for this stock yet.</p>
        ) : (
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {events.map((e, i) => (
              <div
                key={i}
                className="flex gap-3 border-b border-zinc-100 py-1.5 text-xs last:border-0 dark:border-zinc-800"
              >
                <span className="shrink-0 font-mono text-zinc-400">{time(e.at)}</span>
                <span className={`w-20 shrink-0 font-mono uppercase ${eventKindColor(e.kind)}`}>{e.kind}</span>
                <span className="text-zinc-600 dark:text-zinc-300">{e.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/dashboard" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
      ← Back to dashboard
    </Link>
  );
}


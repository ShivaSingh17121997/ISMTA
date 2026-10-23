'use client';

import { useState } from 'react';
import { Badge, Card, MiniStat, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dayLabel, inr, pnlColor } from '../lib/format';
import type { TaxReport, TaxYear } from '../lib/types';
import { usePolling } from '../lib/usePolling';
import { useTradingLive } from '../lib/venue';

const DAY = 86_400_000;
const istDay = (ts: number) => new Date(ts + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Capital gains on the accumulator's delivery trades, the way the tax law
 * counts them: FIFO per stock, short- vs long-term, set-off and carry-forward.
 * Paper trades are not taxable; the paper view is for checking the numbers.
 */
export default function TaxPage() {
  // Opens on the venue being traded; a click overrides it.
  const live = useTradingLive();
  const [pickedVenue, setVenue] = useState<'paper' | 'live' | null>(null);
  const venue = pickedVenue ?? (live ? 'live' : 'paper');
  const state = usePolling(() => api.tax(venue), 60_000);
  const [pickedFy, setPickedFy] = useState<string | null>(null);
  const r = state.data && state.data.venue === venue ? state.data : null;

  const years = r?.years ?? [];
  const fy = pickedFy && years.some((y) => y.fy === pickedFy) ? pickedFy : (r?.currentFy ?? null);
  const year = years.find((y) => y.fy === fy);

  return (
    <div>
      <PageHeader
        title="Tax"
        subtitle="Capital gains on your no-loss trades, counted first-in-first-out as the tax law requires"
        action={
          <div className="flex items-center gap-2" role="group" aria-label="Which trades">
            {(['paper', 'live'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setVenue(v)}
                aria-pressed={venue === v}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  venue === v ? 'bg-blue-600 text-white' : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
                }`}
              >
                {v === 'paper' ? 'Paper trades' : 'Live trades'}
              </button>
            ))}
          </div>
        }
      />

      {venue === 'paper' && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Paper trades are not taxable. This shows what the tax would be if they had been real, so the numbers can be
          checked before real money is involved.
        </div>
      )}

      {state.error && (
        <div className="mb-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {state.error}
        </div>
      )}

      {!r ? (
        <p className="text-sm text-zinc-500">{state.loading ? 'Loading…' : 'No data.'}</p>
      ) : (
        <>
          <Card
            title={`Financial year ${fy ?? '—'}`}
            className="mb-6"
            action={
              years.length > 1 ? (
                <label className="flex items-center gap-2 text-xs text-zinc-500">
                  Year
                  <select
                    id="tax-fy"
                    value={fy ?? ''}
                    onChange={(e) => setPickedFy(e.target.value)}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    {[...years].reverse().map((y) => (
                      <option key={y.fy} value={y.fy}>
                        {y.fy}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
          >
            {year ? <YearSummary y={year} sweep={r.sweepSlabIncomeByFy[year.fy] ?? 0} /> : <p className="text-sm text-zinc-500">No sales in {fy}.</p>}
          </Card>

          <HarvestCard r={r} />

          <Card title={`Sales in ${fy ?? '—'}, matched first-in-first-out`} className="mb-6">
            <SalesTable r={r} fy={fy} />
          </Card>

          <Card title="Shares still held, oldest first (the next to be sold, for tax)" className="mb-6">
            <HoldingsTable r={r} />
          </Card>

          <Card title="How this is worked out">
            <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-500">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {r.unmatched.length > 0 && (
              <p className="mt-3 text-xs text-rose-600">
                {r.unmatched.length} sale(s) could not be matched to an earlier buy. The books may be missing a lot; check the
                audit log.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function YearSummary({ y, sweep }: { y: TaxYear; sweep: number }) {
  const shortNet = y.shortTermGains - y.shortTermLosses;
  const longNet = y.longTermGains - y.longTermLosses;
  const taxGain = shortNet + longNet;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <MiniStat label="Short-term, net" value={inr(shortNet, 0)} tone={shortNet} sub={`${inr(y.shortTermGains, 0)} gains, ${inr(y.shortTermLosses, 0)} losses`} />
        <MiniStat label="Long-term, net" value={inr(longNet, 0)} tone={longNet} sub={`${inr(y.longTermGains, 0)} gains, ${inr(y.longTermLosses, 0)} losses`} />
        <MiniStat label="Estimated tax" value={inr(y.estimatedTax, 0)} sub="20% short, 12.5% long over ₹1.25L, + cess" />
        <MiniStat
          label="Losses carried forward"
          value={inr(y.carryForward.shortTerm + y.carryForward.longTerm, 0)}
          sub={`${inr(y.carryForward.shortTerm, 0)} short, ${inr(y.carryForward.longTerm, 0)} long`}
        />
        <MiniStat label="Liquid-fund gains" value={inr(sweep, 0)} tone={sweep} sub="Taxed at your slab rate" />
      </div>
      <p className="text-xs text-zinc-500">
        For tax, these {y.sales} sale(s) made <span className={pnlColor(taxGain)}>{inr(taxGain, 0)}</span>; the bot&apos;s own lot
        accounting booked <span className={pnlColor(y.enginePnl)}>{inr(y.enginePnl, 0)}</span>. They differ because the bot sells
        its newest, cheapest rung first, while the tax law treats the oldest shares as sold first.
        {y.broughtForwardUsed > 0 && ` ${inr(y.broughtForwardUsed, 0)} of losses from earlier years were used.`}
      </p>
    </>
  );
}

function HarvestCard({ r }: { r: TaxReport }) {
  const useful = r.harvest.filter((h) => h.netBenefit > 0);
  return (
    <Card title={`Tax-loss harvesting, ${r.currentFy}`} className="mb-6">
      <p className="mb-3 text-xs text-zinc-500">
        Selling every share of a stock that is under water and buying it back the <strong>next</strong>{' '}day (a same-day
        rebuy counts as intraday) turns the paper loss into a realised one that offsets this year&apos;s gains. India has no
        wash-sale rule. It only pays when there are gains to offset, so it is shown only where the tax saved beats the round
        trip. Best done in March.
      </p>
      {useful.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing worth harvesting now{r.harvest.length ? `: ${r.harvest.length} holding(s) are under water, but there are no gains this year for the loss to offset` : ''}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Stock</th>
                <th className="px-2 py-2 text-right font-medium">Shares</th>
                <th className="px-2 py-2 text-right font-medium">Loss realised</th>
                <th className="px-2 py-2 text-right font-medium">Tax saved</th>
                <th className="px-2 py-2 text-right font-medium">Round trip</th>
                <th className="px-2 py-2 text-right font-medium">Net benefit</th>
              </tr>
            </thead>
            <tbody>
              {useful.map((h) => (
                <tr key={h.symbol} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-2 py-2 font-mono text-xs font-semibold">{h.symbol}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{h.quantity}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-rose-600">{inr(h.shortTerm + h.longTerm, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{inr(h.taxBefore - h.taxAfter, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{inr(h.cost, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-emerald-600">{inr(h.netBenefit, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
        The bot does not harvest for you yet. Selling these shares yourself in Kite would make the bot&apos;s reconciliation see
        missing shares and halt the book. Ask for the harvest action to be built before you trade this live.
      </p>
    </Card>
  );
}

function SalesTable({ r, fy }: { r: TaxReport; fy: string | null }) {
  const rows = r.matches.filter((m) => m.fy === fy).reverse();
  if (!rows.length) return <p className="text-sm text-zinc-500">No sales in this year.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-2 py-2 text-left font-medium">Sold</th>
            <th className="px-2 py-2 text-left font-medium">Stock</th>
            <th className="px-2 py-2 text-right font-medium">Shares</th>
            <th className="px-2 py-2 text-left font-medium">Bought</th>
            <th className="px-2 py-2 text-right font-medium">Held</th>
            <th className="px-2 py-2 text-left font-medium">Term</th>
            <th className="px-2 py-2 text-right font-medium">Cost</th>
            <th className="px-2 py-2 text-right font-medium">Proceeds</th>
            <th className="px-2 py-2 text-right font-medium">Gain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={`${m.symbol}-${m.soldAt}-${m.boughtAt}-${i}`} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="whitespace-nowrap px-2 py-2">{dayLabel(istDay(m.soldAt), true)}</td>
              <td className="px-2 py-2 font-mono text-xs font-semibold">{m.symbol}</td>
              <td className="px-2 py-2 text-right tabular-nums">{m.quantity}</td>
              <td className="whitespace-nowrap px-2 py-2">{dayLabel(istDay(m.boughtAt), true)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{Math.round((m.soldAt - m.boughtAt) / DAY)}d</td>
              <td className="px-2 py-2">
                <Badge tone={m.longTerm ? 'green' : 'neutral'}>{m.longTerm ? 'Long' : 'Short'}</Badge>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{inr(m.cost, 0)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{inr(m.proceeds, 0)}</td>
              <td className={`px-2 py-2 text-right tabular-nums ${pnlColor(m.gain)}`}>{inr(m.gain, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingsTable({ r }: { r: TaxReport }) {
  if (!r.holdings.length) return <p className="text-sm text-zinc-500">Nothing held.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-2 py-2 text-left font-medium">Stock</th>
            <th className="px-2 py-2 text-left font-medium">Bought</th>
            <th className="px-2 py-2 text-right font-medium">Shares</th>
            <th className="px-2 py-2 text-right font-medium">Cost</th>
            <th className="px-2 py-2 text-right font-medium">Value now</th>
            <th className="px-2 py-2 text-right font-medium">Unrealised</th>
          </tr>
        </thead>
        <tbody>
          {[...r.holdings]
            .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.boughtAt - b.boughtAt)
            .map((h, i) => {
              const value = h.price * h.quantity;
              return (
                <tr key={`${h.symbol}-${h.boughtAt}-${i}`} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-2 py-2 font-mono text-xs font-semibold">{h.symbol}</td>
                  <td className="whitespace-nowrap px-2 py-2">{dayLabel(istDay(h.boughtAt), true)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{h.quantity}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{inr(h.cost, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{h.price > 0 ? inr(value, 0) : '—'}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${pnlColor(value - h.cost)}`}>{h.price > 0 ? inr(value - h.cost, 0) : '—'}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

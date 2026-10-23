'use client';

import { useState } from 'react';
import { inr, num, pct, pnlColor } from '../lib/format';
import type { JournalReport, JournalRow, OverrideSummary } from '../lib/types';
import { formatDuration, istDateTime } from '../lib/useNow';
import { Badge } from './ui';

/**
 * The journal: every trade and every closed accumulator lot in one table, the
 * by-tag report, and — front and centre — whether the operator's overrides
 * (manual tickets, forced flattens) beat the system they override. That is the
 * one comparison a discretionary trader running a bot most needs and least
 * wants to see.
 *
 * Invalid trades (artefacts of bad data) stay in the table, struck through,
 * with their reason on hover. They are excluded from every figure.
 */

export interface JournalPatch {
  setup?: string;
  note?: string;
  ruleBreak?: boolean;
}

interface Draft {
  id: string;
  setup: string;
  note: string;
  ruleBreak: boolean;
}

export function JournalTable({
  report,
  tag,
  onTagChange,
  onSave,
}: {
  report: JournalReport;
  tag: string;
  onTagChange: (tag: string) => void;
  onSave: (id: string, patch: JournalPatch) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (r: JournalRow) =>
    setDraft({ id: r.id, setup: r.note?.setup ?? '', note: r.note?.note ?? '', ruleBreak: r.note?.ruleBreak ?? false });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.id, { setup: draft.setup, note: draft.note, ruleBreak: draft.ruleBreak });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const { manual, system } = report.overridesVsSystem;

  return (
    <div className="space-y-5">
      <OverridesVsSystem manual={manual} system={system} />

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">By tag</h4>
        {report.byTag.length === 0 ? (
          <p className="py-3 text-xs text-zinc-400">No tags yet — every trade and closed lot carries at least one once it exists.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-1.5 pr-3 font-medium">Tag</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Closed</th>
                  <th className="py-1.5 pr-3 text-right font-medium">P&amp;L</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Win rate</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Avg R</th>
                  <th className="py-1.5 text-right font-medium">Avg hold</th>
                </tr>
              </thead>
              <tbody>
                {report.byTag.map((t) => (
                  <tr
                    key={t.tag}
                    className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60 ${
                      tag === t.tag ? 'bg-blue-50 dark:bg-blue-950/30' : ''
                    }`}
                    onClick={() => onTagChange(tag === t.tag ? '' : t.tag)}
                    title="Click to filter the table by this tag"
                  >
                    <td className="py-1.5 pr-3">
                      <Badge tone={/manual|flatten/i.test(t.tag) ? 'amber' : t.tag === 'accumulator' ? 'green' : 'blue'}>{t.tag}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{t.n}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${pnlColor(t.pnl)}`}>{t.n ? inr(t.pnl) : '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{t.n ? `${num(t.winRatePct, 0)}%` : '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums" title={t.avgR == null ? 'No stop known, so R is undefined' : undefined}>
                      {t.avgR == null ? '—' : `${num(t.avgR, 2)}R`}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{t.n ? holdLabel(t.avgHoldDays) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            All outcomes
            <span className="ml-2 font-normal normal-case tracking-normal text-zinc-400">
              {report.counts.shown} of {report.counts.total} · {report.counts.open} open · {report.counts.invalid} invalid ·{' '}
              {report.counts.lots} lot{report.counts.lots === 1 ? '' : 's'}
            </span>
          </h4>
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            Tag
            <select
              value={tag}
              onChange={(e) => onTagChange(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">all</option>
              {report.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        {report.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-400">
            {report.counts.total === 0
              ? 'No trades or closed lots yet — a row appears when a strategy trade opens or an accumulator lot is sold.'
              : `Nothing tagged "${tag}" — pick another tag or clear the filter.`}
          </p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-2 pr-3 font-medium">Symbol</th>
                  <th className="py-2 pr-3 font-medium">Tags</th>
                  <th className="py-2 pr-3 text-right font-medium">Qty</th>
                  <th className="py-2 pr-3 text-right font-medium">Entry → Exit</th>
                  <th className="py-2 pr-3 text-right font-medium">Net P&amp;L</th>
                  <th className="py-2 pr-3 text-right font-medium">R</th>
                  <th className="py-2 pr-3 text-right font-medium">MAE / MFE</th>
                  <th className="py-2 pr-3 text-right font-medium">Hold</th>
                  <th className="py-2 pr-3 font-medium">Closed</th>
                  <th className="py-2 pr-3 font-medium">Setup &amp; note</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => {
                  const editing = draft?.id === r.id;
                  const struck = r.invalid ? 'line-through text-zinc-400 dark:text-zinc-500' : '';
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-zinc-100 align-top dark:border-zinc-900 ${r.invalid ? 'opacity-70' : ''}`}
                      title={r.invalid ? `INVALID — ${r.invalidReason ?? 'flagged as an artefact'}` : undefined}
                    >
                      <td className={`py-2 pr-3 whitespace-nowrap ${struck}`}>
                        <span className="font-medium">{r.symbol}</span>
                        <span className="ml-1.5 inline-flex gap-1 align-middle">
                          <Badge tone={r.side === 'BUY' ? 'green' : 'red'}>{r.side}</Badge>
                          {r.source === 'lot' && <Badge tone="neutral">lot</Badge>}
                          {r.status === 'OPEN' && <Badge tone="blue">open</Badge>}
                          {r.invalid && <Badge tone="amber">invalid</Badge>}
                          {r.note?.ruleBreak && <Badge tone="red">rule break</Badge>}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex max-w-48 flex-wrap gap-1">
                          {r.tags.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => onTagChange(t)}
                              className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                              title={`Filter by ${t}`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${struck}`}>{r.quantity}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${struck}`}>
                        {num(r.entry)} → {r.exit == null ? '—' : num(r.exit)}
                      </td>
                      <td
                        className={`py-2 pr-3 text-right tabular-nums ${r.invalid ? struck : r.pnl == null ? 'text-zinc-400' : pnlColor(r.pnl)}`}
                        title={`after ${inr(r.charges)} in charges`}
                      >
                        {r.pnl == null ? '—' : inr(r.pnl)}
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${struck}`} title={r.stopLoss == null ? 'No stop known' : `stop ${num(r.stopLoss)}`}>
                        {r.rMultiple == null ? '—' : `${num(r.rMultiple, 2)}R`}
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${struck}`}>
                        {r.maePct == null && r.mfePct == null ? (
                          '—'
                        ) : (
                          <>
                            <span className="text-rose-500">{r.maePct == null ? '—' : pct(r.maePct, 1)}</span>
                            <span className="text-zinc-400"> / </span>
                            <span className="text-emerald-500">{r.mfePct == null ? '—' : pct(r.mfePct, 1)}</span>
                          </>
                        )}
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${struck}`}>{r.holdMs == null ? 'open' : formatDuration(r.holdMs)}</td>
                      <td className={`py-2 pr-3 text-xs whitespace-nowrap ${r.invalid ? struck : 'text-zinc-400'}`}>
                        {r.closedAt == null ? `opened ${istDateTime(r.openedAt, false)}` : istDateTime(r.closedAt, false)}
                      </td>
                      <td className="py-2 pr-3 min-w-56">
                        {editing ? (
                          <div className="space-y-1">
                            <input
                              value={draft.setup}
                              onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
                              placeholder="setup (e.g. breakout, pullback)"
                              maxLength={200}
                              className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                            />
                            <textarea
                              value={draft.note}
                              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                              placeholder="what you saw, what you did, what you'd change"
                              rows={2}
                              maxLength={4000}
                              className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                            />
                            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <input
                                type="checkbox"
                                checked={draft.ruleBreak}
                                onChange={(e) => setDraft({ ...draft, ruleBreak: e.target.checked })}
                              />
                              broke a rule
                            </label>
                            {error && <p className="text-xs text-rose-500">{error}</p>}
                          </div>
                        ) : (
                          <div className="text-xs">
                            {r.note?.setup && <span className="mr-1 rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{r.note.setup}</span>}
                            {r.note?.note ? (
                              <span className="text-zinc-600 dark:text-zinc-300">{r.note.note}</span>
                            ) : !r.note?.setup ? (
                              <span className="text-zinc-400">—</span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {editing ? (
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void save()}
                              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                            >
                              {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => {
                                setDraft(null);
                                setError(null);
                              }}
                              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            {r.note ? 'Edit' : 'Annotate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[10px] text-zinc-400">
          Struck-through rows are trades flagged invalid (hover for why); they are kept for the record and excluded from
          every figure. R is P&amp;L over the rupees the stop put at risk; a lot has no stop by construction. Times are IST.
        </p>
      </div>
    </div>
  );
}

function holdLabel(days: number): string {
  return days >= 1 ? `${num(days, 1)}d` : formatDuration(days * 86_400_000);
}

/** The comparison a discretionary trader running a bot most needs: did the overrides help? */
function OverridesVsSystem({ manual, system }: { manual: OverrideSummary; system: OverrideSummary }) {
  const both = manual.n > 0 && system.n > 0;
  const perTradeManual = manual.n ? manual.pnl / manual.n : 0;
  const perTradeSystem = system.n ? system.pnl / system.n : 0;
  const gap = perTradeManual - perTradeSystem;
  const verdict = !both
    ? manual.n === 0 && system.n === 0
      ? 'Nothing closed yet — the comparison starts with the first closed trade or lot.'
      : manual.n === 0
        ? 'No overrides yet: every closed outcome so far came from the system.'
        : 'No system outcomes yet: every closed trade so far was a manual ticket or a forced flatten.'
    : gap >= 0
      ? `Your overrides are ahead of the system by ${inr(gap, 0)} per trade.`
      : `Your overrides are behind the system by ${inr(-gap, 0)} per trade — the bot would have done better left alone.`;

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Your overrides vs the system</h4>
        <span className="text-xs text-zinc-500">manual tickets and forced flattens, against everything the engines decided</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard title="Your overrides" tone="amber" s={manual} />
        <SideCard title="The system" tone="blue" s={system} />
      </div>
      <p className={`mt-3 text-sm ${both ? (gap >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400') : 'text-zinc-500'}`}>
        {verdict}
      </p>
    </div>
  );
}

function SideCard({ title, tone, s }: { title: string; tone: 'amber' | 'blue'; s: OverrideSummary }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone={tone}>{title}</Badge>
        <span className="text-xs text-zinc-400">
          {s.n} closed {s.n === 1 ? 'outcome' : 'outcomes'}
        </span>
      </div>
      <div className="flex items-baseline gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Net P&amp;L</div>
          <div className={`text-xl font-semibold ${s.n ? pnlColor(s.pnl) : 'text-zinc-400'}`}>{s.n ? inr(s.pnl, 0) : '—'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Win rate</div>
          <div className="text-xl font-semibold">{s.n ? `${num(s.winRatePct, 0)}%` : '—'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Per trade</div>
          <div className={`text-xl font-semibold ${s.n ? pnlColor(s.pnl / s.n) : 'text-zinc-400'}`}>{s.n ? inr(s.pnl / s.n, 0) : '—'}</div>
        </div>
      </div>
    </div>
  );
}

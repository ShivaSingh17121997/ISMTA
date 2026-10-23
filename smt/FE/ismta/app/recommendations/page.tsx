'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Badge, Card, PageHeader, StatCard } from '../components/ui';
import { FutureStars } from '../components/FutureStars';
import { Turnarounds } from '../components/Turnarounds';
import { AddSignalPill, AddSignalSummary, useAddSignals } from '../components/AddSignal';
import { api } from '../lib/api';
import { dateTime, inr, num, pct, pnlColor } from '../lib/format';
import type {
  AddSignalsResponse,
  BrokerAction,
  BrokerStance,
  BrokerSummary,
  Horizon,
  HorizonBucket,
  Recommendation,
  RecommendationRun,
  Turbulence,
  TurbulenceSeverity,
  TurbulenceWarning,
  Verdict,
} from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * Stock recommendations across three horizons.
 *
 * The page is arranged so a number is never shown without the reason it exists.
 * A score is a RANK against the universe scored today, so it appears beside the
 * signals that produced it. An entry, stop and target are levels, so each
 * carries the sentence explaining where it came from. A position size is
 * derived from the stop, so the rupees at risk sit next to the rupees invested.
 *
 * The one thing this page must never do is look like a forecast. It ranks what
 * has already happened; it does not know what happens next, and the layout says
 * so rather than burying it in a footer.
 */
/** The add-money lights, shared by every RecCard however the list is grouped. */
const AddSignals = createContext<{ data: AddSignalsResponse | null; loading: boolean }>({ data: null, loading: false });

export default function RecommendationsPage() {
  // The GET is cheap and never triggers a fetch, so polling it is safe.
  const state = usePolling(() => api.recommendations(), 20_000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capital, setCapital] = useState(200_000);
  const [risk, setRisk] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const run = state.data?.run ?? null;

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await api.runRecommendations({ capital, riskPerTradePct: risk });
      state.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Recommendations"
        subtitle="Ranked across three horizons, with an entry, a stop, a target and a size for each"
      />

      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        <span className="font-semibold">This ranks the past. It does not predict the future.</span>{' '}
        A score is a position in today&apos;s league table, not a probability. The stop marks where
        the idea is wrong, not where the price will stop falling. Momentum is the best-evidenced
        signal in equities and it still fails for years at a time.
      </div>

      {/* The future-stars section sits below three horizons of ideas, which is a
          long scroll. This is the only way to reach it without one. */}
      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Three questions on this page:</span>
        <span className="rounded-full bg-blue-100 px-2.5 py-1 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
          What has moved — three horizons, below
        </span>
        <a
          href="#future-stars"
          className="rounded-full bg-violet-100 px-2.5 py-1 font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:hover:bg-violet-900/60"
        >
          What has been won — future stars ↓
        </a>
        <a
          href="#turnarounds"
          className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
        >
          What has fallen but still works — turnarounds ↓
        </a>
      </div>

      <Card
        title="Settings"
        className="mb-6"
        action={
          <button
            onClick={runNow}
            disabled={running}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            title="Pulls two years of daily bars for the whole universe, then ranks. Takes a while."
          >
            {running ? 'Ranking…' : run ? 'Re-run ranking' : 'Run ranking'}
          </button>
        }
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Capital to size against (₹)
            <input
              type="number"
              min={10_000}
              step={10_000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
              className="w-44 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Risk per idea (% of capital)
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={risk}
              onChange={(e) => setRisk(Number(e.target.value))}
              title="How much of your capital is lost if a stop is hit. Position size is derived from this and the stop distance."
              className="w-44 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <p className="max-w-lg text-xs text-zinc-500">
            Size is derived from the stop: {inr((capital * risk) / 100, 0)} at risk per idea means a
            volatile stock with a wide stop gets fewer shares than a calm one, so every idea risks
            the same money.
          </p>
        </div>
      </Card>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {!run ? (
        <Card>
          <p className="text-sm text-zinc-500">
            {state.loading
              ? 'Loading…'
              : running
                ? 'Ranking — this pulls two years of daily bars for around a hundred stocks, so it takes a moment.'
                : `Nothing ranked yet. Press Run ranking to score ${state.data?.settings.universeSize ?? 'the'} liquid NSE names.`}
          </p>
        </Card>
      ) : (
        <RunView run={run} open={open} setOpen={setOpen} ranAt={run.at} />
      )}

      {/* A second, slower question: not "what has moved" but "what has been
          won". Kept below the horizons because it answers on a different
          clock — quarterly filings rather than daily prices — and carries
          weaker evidence, which its own header says out loud. */}
      <div id="future-stars" className="mt-8 scroll-mt-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <FutureStars />
      </div>

      {/* The mirror image of the section above it. Future stars gates on price
          confirmation and therefore discards every company whose shares have
          fallen; this one starts there. The two are mutually exclusive at the
          price gate, so a company can never be recommended twice for opposite
          reasons. */}
      <div id="turnarounds" className="mt-8 scroll-mt-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <Turnarounds />
      </div>
    </div>
  );
}

function RunView({
  run,
  open,
  setOpen,
  ranAt,
}: {
  run: RecommendationRun;
  open: string | null;
  setOpen: (k: string | null) => void;
  ranAt: number;
}) {
  const add = useAddSignals('recommendations');
  // A new ranking changes every size, so the lights are recomputed with it.
  const { recheck } = add;
  const seenRun = useRef(ranAt);
  useEffect(() => {
    if (seenRun.current === ranAt) return;
    seenRun.current = ranAt;
    void recheck();
  }, [ranAt, recheck]);
  // Two readings of the same ranking. By horizon answers "what should I hold and
  // for how long"; by category answers "what is the market actually rewarding,
  // and am I about to buy one bet five times". Neither reorders anything: the
  // highest-scoring idea is first in both.
  const [view, setView] = useState<'horizon' | 'category'>('horizon');

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Ideas"
          value={String(run.buckets.reduce((s, b) => s + b.recommendations.length, 0))}
          sub={`from ${run.eligible} eligible of ${run.measured} measured`}
        />
        <StatCard
          label="Capital deployed"
          value={inr(run.totalAllocated, 0)}
          sub={`${((run.totalAllocated / run.capital) * 100).toFixed(0)}% of ${inr(run.capital, 0)}`}
        />
        <StatCard
          label="At risk if every stop hits"
          value={inr(run.totalRiskIfAllStopped, 0)}
          sub={`${((run.totalRiskIfAllStopped / run.capital) * 100).toFixed(1)}% of capital — the honest downside`}
        />
        <StatCard
          label="Screened out"
          value={String(run.vetoed.length)}
          sub="downtrend, too thin, or too cheap"
        />
      </div>

      <SectorExposureCard run={run} />

      <AddSignalSummary data={add.data} error={add.error} onRefresh={() => void add.recheck()} refreshing={add.rechecking} />

      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-zinc-500">Group by</span>
        {(['horizon', 'category'] as const).map((v) => (
          <button
            key={v}
            onClick={() => {
              setView(v);
              setOpen(null);
            }}
            aria-pressed={view === v}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              view === v
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
            }`}
          >
            {v === 'horizon' ? 'Holding period' : 'Sector & theme'}
          </button>
        ))}
      </div>

      <AddSignals.Provider value={{ data: add.data, loading: add.loading }}>
        {view === 'horizon' ? (
          run.buckets.map((b) => (
            <BucketView key={b.horizon} bucket={b} run={run} open={open} setOpen={setOpen} />
          ))
        ) : (
          <CategoryView run={run} open={open} setOpen={setOpen} />
        )}
      </AddSignals.Provider>

      <ScreenedOutCard vetoed={run.vetoed} />

      <Card title="How to read this">
        <dl className="space-y-2 text-xs text-zinc-500">
          <div>
            <dt className="font-semibold text-zinc-700 dark:text-zinc-300">The score is a rank, not a probability.</dt>
            <dd>
              Every signal is converted to its percentile among the {run.measured} stocks measured
              today, then weighted. A 12% quarterly return is excellent in a flat market and
              ordinary in a roaring one; ranking removes the market from the comparison.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-700 dark:text-zinc-300">
              Momentum is ranked within a sector first.
            </dt>
            <dd>
              Ranking momentum across the whole market ranks sectors, not stocks — when pharma runs,
              every pharma name scores well and the list becomes one bet wearing five tickers. The
              return-based signals (shown in violet) are first standardised against the stock&apos;s
              own NSE sector, so what is compared globally is &quot;strong for its sector&quot;
              rather than &quot;in a strong sector&quot;. Sectors with fewer than four names here
              are measured against the whole universe instead, since a handful of stocks cannot
              define an average.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-700 dark:text-zinc-300">Momentum skips the last month.</dt>
            <dd>
              The classic momentum window runs from twelve months ago to one month ago, because the
              most recent month tends to run the other way. Including it measures two opposing
              effects and reports their average.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-700 dark:text-zinc-300">Size comes from the stop.</dt>
            <dd>
              Risk per idea is {run.sizing.riskPerTradePct}% of capital. A wider stop buys fewer
              shares, so each idea risks the same rupees. Capped at {run.sizing.maxPositionPct}% of
              capital per position and {run.sizing.maxTurnoverPct}% of a stock&apos;s median daily
              turnover.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-700 dark:text-zinc-300">News is context, not a signal.</dt>
            <dd>{run.sources}</dd>
          </div>
        </dl>
        <p className="mt-4 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
          {run.disclaimer}
        </p>
        <p className="mt-2 text-xs text-zinc-400">
          Ranked {dateTime(run.at)} ({run.tradingDay}). Universe {run.universeSize} symbols,{' '}
          {run.skipped.length} skipped for insufficient history.
        </p>
      </Card>
    </>
  );
}

function BucketView({
  bucket,
  run,
  open,
  setOpen,
}: {
  bucket: HorizonBucket;
  run: RecommendationRun;
  open: string | null;
  setOpen: (k: string | null) => void;
}) {
  const tone = bucket.horizon === 'long' ? 'blue' : bucket.horizon === 'medium' ? 'green' : 'amber';
  return (
    <Card
      title={`${bucket.label} — hold ${bucket.holdLabel}`}
      className="mb-6"
      action={
        <div className="flex items-center gap-3">
          <span
            className="cursor-help"
            title={bucket.evidence.note}
          >
            <Badge tone={bucket.evidence.grade === 'A' ? 'green' : bucket.evidence.grade === 'B' ? 'blue' : 'amber'}>
              evidence {bucket.evidence.grade}
            </Badge>
          </span>
          <span className="text-xs text-zinc-500">
            {inr(bucket.allocated, 0)} of a {bucket.budgetPct}% budget ({inr(bucket.budget, 0)})
          </span>
        </div>
      }
    >
      {bucket.recommendations.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing cleared the filters at this horizon.</p>
      ) : (
        <>
          <div className="space-y-3">
            {bucket.recommendations.map((r) => (
              <RecCard
                key={`${bucket.horizon}-${r.symbol}`}
                rec={r}
                tone={tone}
                capital={run.capital}
                expanded={open === `${bucket.horizon}-${r.symbol}`}
                onToggle={() =>
                  setOpen(open === `${bucket.horizon}-${r.symbol}` ? null : `${bucket.horizon}-${r.symbol}`)
                }
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-500">{bucket.note}</p>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="font-semibold">Evidence {bucket.evidence.grade}:</span>{' '}
            {bucket.evidence.note}
          </p>
        </>
      )}
    </Card>
  );
}

const verdictTone: Record<Verdict, 'green' | 'blue' | 'amber' | 'neutral'> = {
  strong: 'green',
  good: 'blue',
  watch: 'amber',
  weak: 'neutral',
};

function RecCard({
  rec,
  tone,
  capital,
  horizonLabel,
  place,
  expanded,
  onToggle,
}: {
  rec: Recommendation;
  tone: 'blue' | 'green' | 'amber';
  capital: number;
  /** Only set in the category view, where the enclosing card no longer says it. */
  horizonLabel?: string;
  /**
   * Position within the list being shown, when that is not the horizon rank.
   * The number must always mean "nth in the list you are looking at" — showing
   * horizon ranks down a category card reads 2, 1, 4, 5 and looks like a bug.
   */
  place?: { n: number; of: string };
  expanded: boolean;
  onToggle: () => void;
}) {
  const p = rec.plan;
  const dup = rec.duplicateOf !== null;
  const add = useContext(AddSignals);

  return (
    <div className={`rounded-lg border ${dup ? 'border-zinc-200 opacity-70 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-800'}`}>
      <div className="flex flex-wrap items-center gap-3 p-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 font-mono text-xs font-bold dark:bg-zinc-800"
          title={place ? `#${place.n} in ${place.of}` : `#${rec.rank} at this horizon`}
        >
          {place ? place.n : rec.rank}
        </span>
        <div className="min-w-0">
          <Link href={`/accumulator/${encodeURIComponent(rec.symbol)}`} className="font-semibold hover:underline">
            {rec.symbol}
          </Link>
          <span className="block max-w-[16rem] truncate text-[11px] text-zinc-500">{rec.name}</span>
          <CategoryChips rec={rec} />
        </div>

        <div className="flex items-center gap-2">
          <ScoreBar score={rec.score} tone={tone} />
          <Badge tone={verdictTone[rec.verdict]}>{rec.verdict}</Badge>
          {horizonLabel && <Badge tone={tone}>{horizonLabel}</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <Level label="Entry" value={inr(p.entry)} note={p.entryKind} />
          <Level label="Stop" value={inr(p.stop)} note={`−${p.stopDistancePct.toFixed(1)}%`} tone="rose" />
          <Level label="Target" value={inr(p.target)} note={`${p.rewardRisk}:1`} tone="emerald" />
        </div>

        <div className="ml-auto">
          <AddSignalPill signal={add.data?.signals[rec.symbol]} loading={add.loading} align="right" />
        </div>

        <div className="text-right">
          {rec.newsSuppressed ? (
            <span
              className="text-xs font-medium text-rose-600 dark:text-rose-400"
              title={rec.newsSuppressedReason}
            >
              capital withheld — negative news
            </span>
          ) : dup ? (
            <span className="text-xs text-zinc-500">
              already funded in the {rec.duplicateOf} bucket
            </span>
          ) : (
            <>
              <div className="font-semibold tabular-nums">{inr(rec.allocatedAmount, 0)}</div>
              <div className="text-[11px] text-zinc-500">
                {rec.allocatedPct.toFixed(1)}% of capital · {p.quantity} sh · risk{' '}
                {inr(p.riskAmount * (p.amount > 0 ? rec.allocatedAmount / p.amount : 0), 0)}
              </div>
            </>
          )}
        </div>

        <button
          onClick={onToggle}
          className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          aria-expanded={expanded}
        >
          {expanded ? 'Less' : 'Why'}
        </button>
      </div>

      {rec.newsSuppressed && rec.newsSuppressedReason && (
        <p className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          {rec.newsSuppressedReason}
        </p>
      )}

      {rec.sectorCapped && (
        <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <span className="font-semibold">Sector limit.</span> {rec.sectorCapped} The ranking is
          untouched — this is a limit on how much of one bet the book may hold, not a judgement on
          the idea.
        </p>
      )}

      {/* A one-liner on the collapsed card, but only when there is something
          worth saying. Every stock has SOME expected dip, and printing that on
          all fifteen rows would train the eye to skip the line entirely. */}
      {!expanded && rec.turbulence && rec.turbulence.warnings[0]?.severity !== 'note' && (
        <p
          className={`border-t px-3 py-1.5 text-[11px] ${
            rec.turbulence.warnings[0].severity === 'serious'
              ? 'border-rose-200 bg-rose-50/50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300'
              : 'border-amber-200 bg-amber-50/50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300'
          }`}
        >
          {rec.turbulence.summary}{' '}
          {/* How much to buy now is the add-money light's job; saying it here
              too would disagree with it whenever the market also says steps. */}
          <span className="font-medium">Keep the stop wide.</span>
        </p>
      )}

      {expanded && <RecDetail rec={rec} capital={capital} />}
    </div>
  );
}

function RecDetail({ rec, capital }: { rec: Recommendation; capital: number }) {
  const p = rec.plan;
  const m = rec.metrics;
  return (
    <div className="grid grid-cols-1 gap-4 border-t border-zinc-200 p-3 lg:grid-cols-3 dark:border-zinc-800">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Why it ranks here
        </h4>
        <div className="space-y-1.5">
          {rec.signals.map((s) => (
            <div key={s.name} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-zinc-600 dark:text-zinc-300" title={s.label}>
                  {s.label}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-500">
                  {(s.percentile * 100).toFixed(0)}th
                </span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-full rounded ${s.sectorRelative ? 'bg-violet-500' : 'bg-blue-500'}`}
                  style={{ width: `${s.percentile * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-400">
                raw {num(s.raw, 1)} · weight {(s.weight * 100).toFixed(0)}%
                {s.sectorRelative && (
                  // Saying this matters: "88th" against the whole market and
                  // "88th within Capital Goods" are different claims.
                  <span
                    className="ml-1 text-violet-500"
                    title={`Ranked against ${rec.sector} first, then across the market — so this measures strength within its sector, not the sector's own strength.`}
                  >
                    · vs {rec.sector}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">The plan</h4>
        <dl className="space-y-2 text-xs">
          <PlanRow label="Entry" value={inr(p.entry)} note={p.entryNote} />
          <PlanRow label="Stop" value={inr(p.stop)} note={p.stopNote} />
          <PlanRow label="Target" value={inr(p.target)} note={p.targetNote} />
          <PlanRow
            label="Size"
            value={`${p.quantity} shares`}
            note={
              `Risking ${inr(p.riskPerShare)} a share. ${inr(p.amount, 0)} committed ` +
              `(${((p.amount / capital) * 100).toFixed(1)}% of capital), sized by the ${p.sizedBy}. ` +
              `Hold ${p.holdLabel}.`
            }
          />
        </dl>
        {p.warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {p.warnings.map((w, i) => (
              <li key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
                ⚠ {w}
              </li>
            ))}
          </ul>
        )}

        {/* Sits under the plan because it explains the stop and the size, which
            are the two numbers directly above it. */}
        {rec.turbulence && <TurbulencePanel t={rec.turbulence} />}
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          The numbers, and the news
        </h4>
        <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <Stat label="12m momentum" value={pct(m.mom12_1, 1)} tone={m.mom12_1} />
          <Stat label="3m momentum" value={pct(m.mom3_1, 1)} tone={m.mom3_1} />
          <Stat label="Last month" value={pct(m.ret1m, 1)} tone={m.ret1m} />
          <Stat label="From 52w high" value={pct(m.fromHighPct, 1)} tone={m.fromHighPct} />
          <Stat label="Volatility (ann.)" value={`${m.volAnnualPct.toFixed(0)}%`} />
          <Stat label="Worst fall (1y)" value={`−${m.maxDrawdown1yPct.toFixed(0)}%`} />
          <Stat label="RSI" value={m.rsi14 ? m.rsi14.toFixed(0) : '—'} />
          <Stat label="Daily turnover" value={`₹${(m.medianTurnover / 1e7).toFixed(1)} cr`} />
        </dl>

        {rec.news ? (
          <>
            <p className="mb-1.5 text-[11px] text-zinc-500">{rec.news.note}</p>
            <ul className="space-y-1">
              {rec.news.headlines.slice(0, 4).map((h, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span
                    className={
                      h.tone > 0.1
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : h.tone < -0.1
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-zinc-400'
                    }
                    title={h.matched.length ? `matched: ${h.matched.join(', ')}` : 'no scored words'}
                  >
                    {h.tone > 0.1 ? '▲' : h.tone < -0.1 ? '▼' : '•'}
                  </span>{' '}
                  <span className="text-zinc-600 dark:text-zinc-300">{h.title}</span>{' '}
                  <span className="text-zinc-400">— {h.source}</span>
                </li>
              ))}
            </ul>
            {rec.news.filings.filter((f) => f.material).length > 0 && (
              <p className="mt-2 text-[11px] text-zinc-500">
                Recent filings:{' '}
                {rec.news.filings
                  .filter((f) => f.material)
                  .slice(0, 3)
                  .map((f) => f.category)
                  .join('; ')}
              </p>
            )}
            {rec.news.brokers && <BrokerCalls summary={rec.news.brokers} />}
          </>
        ) : (
          <p className="text-[11px] text-zinc-400">No news attached.</p>
        )}
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<BrokerAction, string> = {
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  initiate: 'Initiates',
  'target-raise': 'Target raised',
  'target-cut': 'Target cut',
  reiterate: 'Reiterates',
};

const STANCE_TONE: Record<BrokerStance, string> = {
  bullish: 'text-emerald-600 dark:text-emerald-400',
  neutral: 'text-zinc-500',
  bearish: 'text-rose-600 dark:text-rose-400',
};

const daysAgo = (at: number): string => {
  const d = Math.floor((Date.now() - at) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

/**
 * Broker calls read out of headlines. Deliberately set apart from the score:
 * the note says in words that they are not used in the ranking, and each row
 * links the headline it came from so a misread can be checked in one click.
 */
function BrokerCalls({ summary }: { summary: BrokerSummary }) {
  const calls = summary.calls.slice(0, 5);
  return (
    <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
      <p className="mb-1 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Broker calls</p>
      <p className="mb-1.5 text-[11px] text-zinc-500">{summary.note}</p>
      {calls.length > 0 && (
        <ul className="space-y-1">
          {calls.map((c, i) => {
            const upside = c.upsidePct ?? c.statedUpsidePct;
            return (
              <li key={i} className="text-[11px] leading-snug">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  title={c.title}
                  className="hover:underline"
                >
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">{c.broker}</span>
                  {c.action && <span className="text-zinc-500"> · {ACTION_LABEL[c.action]}</span>}
                  {c.rating && (
                    <span className={c.stance ? STANCE_TONE[c.stance] : 'text-zinc-500'}> · {c.rating}</span>
                  )}
                  {c.target !== null && <span className="text-zinc-600 dark:text-zinc-300"> · target {inr(c.target, 0)}</span>}
                  {upside !== null && (
                    <span className={upside >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                      {' '}
                      ({pct(upside, 0)}
                      {c.upsidePct === null ? ' stated' : ''})
                    </span>
                  )}
                </a>
                {c.basket && (
                  <span className="ml-1 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800">in a list</span>
                )}
                <span className="text-zinc-400">
                  {' '}
                  — {daysAgo(c.at)}
                  {c.echoes > 1 ? `, ${c.echoes} outlets` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Category labels on a card.
 *
 * The NSE sector is shown plainly because it is the exchange's own fact and it
 * is what the concentration limit counts. Themes are shown in a lighter style
 * and marked as a view, because they are hand-drawn: NSE has no "defence" or
 * "semiconductor" classification, so those labels are a judgement about what a
 * business actually is, and a label that is a judgement should not be dressed
 * up as data.
 */
function CategoryChips({ rec }: { rec: Recommendation }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <span
        className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        title="NSE's own industry classification — the exchange's fact, and what the sector limit counts."
      >
        {rec.sector}
      </span>
      {rec.themes.map((t) => (
        <span
          key={t}
          className="rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-500"
          title="A hand-maintained category, not an exchange classification."
        >
          {t}
        </span>
      ))}
    </span>
  );
}

interface CategoryGroup {
  category: string;
  /** A theme is opinion; a sector is the exchange's. The screen says which. */
  curated: boolean;
  rows: { rec: Recommendation; horizon: Horizon; label: string }[];
  best: number;
  allocated: number;
}

/**
 * Group every idea by category, best category first.
 *
 * A stock with several themes appears under each of them, which is deliberate:
 * Tata Power genuinely is both a power utility and a renewables play, and
 * hiding it from one list to keep the arithmetic tidy would lose the half the
 * reader came for. It also means the allocation figures here are NOT additive
 * across categories, which the panel says out loud.
 *
 * Stocks with no curated theme fall back to their NSE sector rather than
 * disappearing.
 */
function groupByCategory(run: RecommendationRun): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const b of run.buckets) {
    for (const rec of b.recommendations) {
      const curated = rec.themes.length > 0;
      for (const category of curated ? rec.themes : [rec.sector]) {
        const g =
          groups.get(category) ?? { category, curated, rows: [], best: 0, allocated: 0 };
        g.rows.push({ rec, horizon: b.horizon, label: b.label });
        g.best = Math.max(g.best, rec.score);
        g.allocated += rec.allocatedAmount;
        groups.set(category, g);
      }
    }
  }
  for (const g of groups.values()) g.rows.sort((a, b) => b.rec.score - a.rec.score);
  return [...groups.values()].sort((a, b) => b.best - a.best);
}

const horizonTone: Record<Horizon, 'blue' | 'green' | 'amber'> = {
  long: 'blue',
  medium: 'green',
  short: 'amber',
};

function CategoryView({
  run,
  open,
  setOpen,
}: {
  run: RecommendationRun;
  open: string | null;
  setOpen: (k: string | null) => void;
}) {
  const groups = groupByCategory(run);
  if (!groups.length) return <Card title="By category">Nothing cleared the filters today.</Card>;

  return (
    <>
      <p className="mb-4 text-xs text-zinc-500">
        Categories are ordered by their best-ranked stock, so the strongest sector or theme is at
        the top. A stock in two themes appears in both — the rupee figures below are therefore not
        additive across categories. Sector exposure, which is additive, is in the panel above.
      </p>
      {groups.map((g) => (
        <Card
          key={g.category}
          className="mb-6"
          title={g.category}
          action={
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>
                {g.rows.length} idea{g.rows.length === 1 ? '' : 's'} · top score{' '}
                {g.best.toFixed(0)}
              </span>
              <Badge tone={g.curated ? 'neutral' : 'blue'}>
                {g.curated ? 'curated theme' : 'NSE sector'}
              </Badge>
            </div>
          }
        >
          <div className="space-y-3">
            {g.rows.map((row, i) => (
              <RecCard
                key={`${g.category}-${row.horizon}-${row.rec.symbol}`}
                rec={row.rec}
                tone={horizonTone[row.horizon]}
                capital={run.capital}
                horizonLabel={row.label}
                place={{ n: i + 1, of: g.category }}
                expanded={open === `${g.category}-${row.horizon}-${row.rec.symbol}`}
                onToggle={() =>
                  setOpen(
                    open === `${g.category}-${row.horizon}-${row.rec.symbol}`
                      ? null
                      : `${g.category}-${row.horizon}-${row.rec.symbol}`,
                  )
                }
              />
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

/**
 * What the book is actually exposed to, and where the limit bound.
 *
 * This is the panel that answers "am I holding fifteen ideas or one idea
 * fifteen times". It counts SECTORS, never themes: sectors are exhaustive and
 * exclusive, so they add to the total, while a stock can carry two themes and
 * would be double-counted.
 */
/**
 * The stocks that were refused, and why.
 *
 * Searchable because the list is long — most runs screen out more names than
 * they recommend — and the question a reader actually arrives with is usually
 * about ONE stock: "why isn't Axis Bank in here?". Scrolling sixty rows to
 * answer that is the wrong shape of work.
 *
 * The query matches the reason as well as the symbol and name, so "turnover"
 * or "200-day" groups the list by cause, which is the other way people read it.
 */
function ScreenedOutCard({ vetoed }: { vetoed: RecommendationRun['vetoed'] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? vetoed.filter(
        (v) =>
          v.symbol.toLowerCase().includes(q) ||
          v.name.toLowerCase().includes(q) ||
          v.reason.toLowerCase().includes(q),
      )
    : vetoed;

  return (
    <Card
      title={`Screened out (${vetoed.length})`}
      className="mb-6"
      action={
        <div className="flex items-center gap-2">
          {q && (
            <span className="text-xs tabular-nums text-zinc-500">
              {shown.length} of {vetoed.length}
            </span>
          )}
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol, name or reason"
              aria-label="Search the screened-out list"
              className="w-56 rounded-md border border-zinc-300 bg-transparent py-1 pl-2 pr-6 text-xs placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-700"
            />
            {q && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear the search"
                className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-sm leading-none text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                ×
              </button>
            )}
          </div>
        </div>
      }
    >
      <p className="mb-3 text-xs text-zinc-500">
        Why a stock is not recommended is as useful as why one is. Nothing below its 200-day
        average is recommended at any horizon, whatever else it scores.
      </p>
      {shown.length === 0 ? (
        <p className="py-3 text-sm text-zinc-500">
          Nothing screened out matches &ldquo;{query.trim()}&rdquo;. A stock missing from both this
          list and the recommendations above was measured and simply did not rank high enough.
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {shown.map((v) => (
                <tr key={v.symbol} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs font-semibold">{v.symbol}</td>
                  <td className="max-w-[14rem] truncate px-2 py-1.5 text-xs text-zinc-500">{v.name}</td>
                  <td className="px-2 py-1.5 text-xs text-zinc-500">{v.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SectorExposureCard({ run }: { run: RecommendationRun }) {
  const rows = run.sectorExposure.filter((e) => e.amount > 0);
  if (!rows.length) return null;
  const widest = Math.max(run.maxSectorPct, ...rows.map((r) => r.pct));

  return (
    <Card
      title="Sector exposure"
      className="mb-6"
      action={<span className="text-xs text-zinc-500">limit {run.maxSectorPct}% of capital per sector</span>}
    >
      <div className="space-y-2">
        {rows.map((e) => (
          <div key={e.sector} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 truncate text-zinc-600 sm:w-44 dark:text-zinc-400" title={e.sector}>
              {e.sector}
            </span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full ${e.capped ? 'bg-amber-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, (e.pct / widest) * 100)}%` }}
              />
              <div
                className="absolute inset-y-0 w-px bg-rose-400"
                style={{ left: `${Math.min(100, (run.maxSectorPct / widest) * 100)}%` }}
                title={`${run.maxSectorPct}% limit`}
              />
            </div>
            <span className="w-28 shrink-0 text-right tabular-nums text-zinc-500 sm:w-32">
              {inr(e.amount, 0)} · {e.pct.toFixed(1)}%
            </span>
            <span className="hidden w-40 shrink-0 truncate font-mono text-[10px] text-zinc-400 sm:block">
              {e.symbols.join(' ')}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Ranking on momentum is systematically bad at diversifying — it buys whatever has been going
        up, and that is usually one theme at a time. No sector may hold more than{' '}
        {run.maxSectorPct}% of capital; when the limit binds, the sector keeps its highest-ranked
        ideas whole and the weakest is trimmed first. The red line is the limit.
        {rows.some((e) => e.capped) && ' An amber bar is a sector where it bound today.'}
      </p>
    </Card>
  );
}

function ScoreBar({ score, tone }: { score: number; tone: 'blue' | 'green' | 'amber' }) {
  const bar = tone === 'blue' ? 'bg-blue-500' : tone === 'green' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <span className="inline-flex items-center gap-1.5" title={`${score.toFixed(1)} of 100 — a rank, not a probability`}>
      <span className="inline-block h-1.5 w-14 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
        <span className={`block h-full rounded ${bar}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums">{score.toFixed(0)}</span>
    </span>
  );
}

function Level({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'rose' | 'emerald';
}) {
  const cls = tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : '';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className={`font-mono tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] text-zinc-400">{note}</div>
    </div>
  );
}

/**
 * How rough the hold is likely to be.
 *
 * The hardest thing about this panel is tone. Every number in it is a warning,
 * and the natural reading of a warning is "do not do this" — which is precisely
 * the conclusion the underlying study rejected. Extended stocks went on to BEAT
 * the index; a simulated rule that skipped them cut returns roughly in half.
 *
 * So the layout is built to make the counter-message unmissable rather than a
 * footnote: the expected-return line sits inside the panel, in green, at the
 * same weight as the risk figures, and the panel's own heading says what the
 * numbers are for. A user who reads only the headline should come away with
 * "size this smaller", never "avoid this".
 */
function TurbulencePanel({ t }: { t: Turbulence }) {
  const f = t.forecast;
  const worst = t.warnings[0]?.severity ?? 'note';
  return (
    <div className="mt-3 rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          How rough the ride is
        </h4>
        <span className={`text-[10px] font-medium ${severityText(worst)}`}>{f.bucket}</span>
      </div>

      {/* The three numbers that should drive the sizing decision. */}
      <dl className="mb-2 grid grid-cols-3 gap-2 text-center">
        <Turb
          label="Expect a dip of"
          value={`${f.expectedDipPct.toFixed(1)}%`}
          sub={`${f.expectedDipAtr}× ATR, to ${inr(f.expectedDipFrom)}`}
        />
        <Turb
          label="Likely within"
          value={`${f.dipMedianDays}d`}
          sub={`${(f.dipProbability * 100).toFixed(0)}% chance of −5%`}
        />
        <Turb
          label="Tail risk"
          value={`${f.tailRiskMultiple.toFixed(1)}×`}
          sub={`${(f.tailRisk * 100).toFixed(1)}% vs 4.0% normal`}
          tone={f.tailRiskMultiple >= 2 ? 'bad' : undefined}
        />
      </dl>

      {/* The counter-message. Deliberately the same visual weight as the risks. */}
      <p className="mb-2 rounded bg-emerald-50 px-2 py-1.5 text-[11px] leading-snug text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        <span className="font-semibold">Not a reason to skip it.</span> Stocks in this group still
        beat the index by {f.meanExcess63.toFixed(1)}% over the next three months on average
        (n={f.bucketN.toLocaleString('en-IN')}). Measured over ten years, waiting for a dip and
        skipping when none came roughly halved returns.{' '}
        {t.stageNowFraction < 1
          ? `Consider taking ${(t.stageNowFraction * 100).toFixed(0)}% now and the rest into weakness.`
          : 'Nothing here argues for staging the entry.'}
      </p>

      <ul className="space-y-1.5">
        {t.warnings.map((w, i) => (
          <TurbWarning key={i} w={w} />
        ))}
      </ul>

      {/* Stated as a requirement rather than "the stop was widened", because
          whether it actually bound depends on the horizon — and the stop's own
          note above already says so when it did. */}
      <p className="mt-2 text-[10px] leading-snug text-zinc-500">
        A stop on this name needs to sit at least {t.requiredStopAtr.toFixed(2)}× ATR below entry
        for that ordinary drawdown not to reach it. The plan above already accounts for this, which
        is why the position can be smaller than the risk budget alone would suggest.
      </p>
    </div>
  );
}

function Turb({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'bad';
}) {
  return (
    <div>
      <dt className="text-[10px] text-zinc-500">{label}</dt>
      <dd
        className={`font-mono text-sm tabular-nums ${
          tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-800 dark:text-zinc-200'
        }`}
      >
        {value}
      </dd>
      <dd className="text-[10px] leading-tight text-zinc-400">{sub}</dd>
    </div>
  );
}

function TurbWarning({ w }: { w: TurbulenceWarning }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="text-[11px] leading-snug">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
        aria-expanded={open}
      >
        <span className={`shrink-0 ${severityText(w.severity)}`}>{severityIcon(w.severity)}</span>
        <span className="flex-1 text-zinc-700 dark:text-zinc-300">{w.headline}</span>
        <span className="shrink-0 text-zinc-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-1">
          <p className="text-zinc-500">{w.detail}</p>
          {/* Every claim shows the base rate it rests on. A frequency without
              its baseline reads as a prediction, which is the failure mode
              this whole feature is trying to avoid. */}
          <p className="text-[10px] text-zinc-400">
            <span className="font-medium">{w.evidence.condition}</span>
            {w.evidence.n > 0 && ` · n=${w.evidence.n.toLocaleString('en-IN')}`} ·{' '}
            {w.evidence.stat} · baseline: {w.evidence.baseline}
          </p>
        </div>
      )}
    </li>
  );
}

const severityText = (s: TurbulenceSeverity): string =>
  s === 'serious'
    ? 'text-rose-600 dark:text-rose-400'
    : s === 'caution'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-zinc-500';

const severityIcon = (s: TurbulenceSeverity): string =>
  s === 'serious' ? '▲' : s === 'caution' ? '△' : '·';

function PlanRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="font-medium text-zinc-700 dark:text-zinc-300">{label}</dt>
        <dd className="font-mono tabular-nums">{value}</dd>
      </div>
      <p className="text-[10px] leading-snug text-zinc-500">{note}</p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`text-right font-mono tabular-nums ${tone !== undefined ? pnlColor(tone) : ''}`}>{value}</dd>
    </>
  );
}

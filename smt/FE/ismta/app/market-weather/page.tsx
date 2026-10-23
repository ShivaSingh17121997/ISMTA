'use client';

/**
 * Market Weather — the market-level risk read.
 *
 * Every number here comes from the backend's calibration against 1998–today
 * history (BE/src/services/marketWeather). The page's job is to show odds WITH
 * their baselines and sample sizes, and to keep the honest framing visible:
 * the level describes conditions today, it is not a forecast, and no date or
 * target is ever shown. See MARKET_WEATHER.md for the research behind it.
 */
import { useState } from 'react';
import { Badge, Card, PageHeader } from '../components/ui';
import { Glossary, NextMonthStrip, StockLists, VerdictPanel } from '../components/WeatherVerdict';
import { api } from '../lib/api';
import { dateTime, inr } from '../lib/format';
import type { MarketWeather, WeatherForward, WeatherGrade, WeatherLevel, WeatherSignal } from '../lib/types';
import { usePolling } from '../lib/usePolling';

const LEVEL_STYLE: Record<WeatherLevel, { label: string; icon: string; box: string; chip: string }> = {
  calm: {
    label: 'Calm',
    icon: '☀️',
    box: 'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30',
    chip: 'bg-emerald-600 text-white',
  },
  unsettled: {
    label: 'Unsettled',
    icon: '⛅',
    box: 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30',
    chip: 'bg-amber-500 text-zinc-950',
  },
  stormy: {
    label: 'Stormy',
    icon: '⛈️',
    box: 'border-orange-300 bg-orange-50 dark:border-orange-900 dark:bg-orange-950/30',
    chip: 'bg-orange-600 text-white',
  },
  severe: {
    label: 'Severe',
    icon: '🌪️',
    box: 'border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30',
    chip: 'bg-rose-600 text-white',
  },
};

const GRADE_TONE: Record<WeatherGrade, 'green' | 'blue' | 'neutral'> = { A: 'green', B: 'blue', C: 'neutral' };

const p0 = (x: number | null | undefined): string => (x == null ? '–' : `${Math.round(x * 100)}%`);
const p1 = (x: number | null | undefined): string => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const sgn = (x: number | null | undefined, dp = 1): string => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}%`);
const sgnFrac = (x: number | null | undefined): string => (x == null ? '–' : sgn(x * 100, 0));
const pp = (x: number | null | undefined): string => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} pp`);

function isReady(d: unknown): d is MarketWeather {
  return !!d && typeof d === 'object' && 'summary' in d;
}

export default function MarketWeatherPage() {
  const poll = usePolling(() => api.marketWeather(), 60_000);
  const [busy, setBusy] = useState(false);
  const d = poll.data;

  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshMarketWeather();
      poll.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Market Weather"
        subtitle="Market risk read against 28 years of Sensex history. It describes conditions, it does not forecast."
        action={
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      {poll.error && <p className="mb-4 text-sm text-rose-600">Could not load Market Weather: {poll.error}</p>}
      {!isReady(d) ? (
        <Card>
          <p className="text-sm text-zinc-500">
            {d && 'status' in d && d.status.lastError
              ? `The first read failed: ${d.status.lastError}`
              : 'Building the first read: loading index history, breadth for the NIFTY 500, valuation, news and flows. This takes under a minute when the history is cached.'}
          </p>
        </Card>
      ) : (
        <Weather d={d} />
      )}
    </div>
  );
}

function Weather({ d }: { d: MarketWeather }) {
  const lv = LEVEL_STYLE[d.summary.level];
  const s = d.state;
  return (
    <div className="space-y-6">
      {d.verdict && <VerdictPanel v={d.verdict} asOf={s.date} />}
      <NextMonthStrip d={d} />
      <StockLists d={d} />
      <Glossary d={d} />

      <h2 className="pt-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">The detail behind the answer</h2>
      {/* The read */}
      <section className={`rounded-xl border p-5 ${lv.box}`} aria-label="Today's read">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${lv.chip}`}>
            <span aria-hidden>{lv.icon}</span>
            {lv.label}
          </span>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{d.summary.headline.replace(/^[A-Za-z]+:\s*/, '')}</h2>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {d.summary.note} Data to {s.date} · updated {dateTime(d.computedAt)}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <ReadList title="What is driving it" items={d.summary.drivers} />
          <ReadList title="What history says about states like this" items={d.summary.odds} />
          <ReadList title="What the evidence supports doing" items={d.summary.guidance} />
        </div>
      </section>

      {/* Gauges */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Gauges">
        <Gauge label="NIFTY 50" value={s.close.toLocaleString('en-IN', { maximumFractionDigits: 0 })} sub={`${sgn(s.fromAthPct)} from its high · 12m ${sgn(s.ret12mPct)}`} />
        <Gauge label="vs 200-day average" value={sgn(s.vs200Pct)} sub={s.deathCross ? '50-day below 200-day' : '50-day above 200-day'} />
        <Gauge label="Breadth" value={s.breadthPct == null ? '–' : `${Math.round(s.breadthPct)}%`} sub={`of ${s.breadthCoverage} NIFTY 500 stocks above their 200-day`} />
        <Gauge label="India VIX" value={s.indiaVix == null ? '–' : s.indiaVix.toFixed(1)} sub={`5-day change ${sgn(s.indiaVix5dPct)}`} />
        <Gauge label="Brent crude" value={s.brent == null ? '–' : `$${s.brent.toFixed(0)}`} sub={`${s.brentDaysAbove90} sessions above $90 · 3m ${sgn(s.brent3mPct, 0)}`} />
        <Gauge label="S&P 500 vs 200-day" value={sgn(s.spxVs200Pct)} sub="previous US close" />
        <Gauge
          label="NIFTY valuation"
          value={d.valuation ? `PE ${d.valuation.pe.toFixed(1)} · PB ${d.valuation.pb.toFixed(2)}` : '–'}
          sub={
            d.valuation
              ? `PE rank since 2021: ${p0(d.valuation.pePctConsolidated)} · PB rank since 1999: ${p0(d.valuation.pbPctAll)}. Long-run context only.`
              : 'unavailable'
          }
        />
        <FlowGauge flows={d.escalation.flows} fii5={d.escalation.fiiNet5d} dii5={d.escalation.diiNet5d} />
      </section>

      {/* Your book */}
      <Card title="Your book if the market falls">
        {d.exposure && d.exposure.holdings.length ? (
          <>
            <div className="mb-4 flex flex-wrap gap-6 text-sm">
              <Big label="If NIFTY falls 10%" value={d.exposure.ifIndexMinus10Pct == null ? '–' : `${d.exposure.ifIndexMinus10Pct.toFixed(1)}%`} sub={`down-day beta ${d.exposure.downBeta ?? '–'}`} />
              <Big label="Defensive share" value={p0(d.exposure.defensiveShare)} sub={d.exposure.itDefensive ? 'FMCG, healthcare, telecom, IT, gold' : 'IT not counted: a US / AI / rates shock is active'} />
              <Big label="Book value" value={inr(d.exposure.totalValue, 0)} sub={`beta measured on ${p0(d.exposure.coverage)} of it`} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-3">Holding</th>
                    <th className="py-2 pr-3">Sector</th>
                    <th className="py-2 pr-3 text-right">Weight</th>
                    <th className="py-2 pr-3 text-right">Down-day beta</th>
                    <th className="py-2 text-right">If NIFTY −10%</th>
                  </tr>
                </thead>
                <tbody>
                  {d.exposure.holdings.map((h) => (
                    <tr key={h.symbol} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 pr-3 font-medium">
                        {h.symbol}
                        {h.defensive && (
                          <span className="ml-2">
                            <Badge tone="green">defensive</Badge>
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-zinc-500">{h.sector}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p0(h.weight)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{h.downBeta ?? '–'}</td>
                      <td className="py-2 text-right tabular-nums">{h.ifIndexMinus10Pct == null ? '–' : `${h.ifIndexMinus10Pct.toFixed(1)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Estimated from each holding&apos;s moves on NIFTY&apos;s down days over the last two years. An estimate, not a promise; a single
              stock&apos;s own news can move it far more.
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">No open holdings. When you hold stocks or ETFs, this shows how much the book has historically moved when NIFTY fell.</p>
        )}
      </Card>

      {/* Signals, in three kinds */}
      <SignalGroup
        title="Warning signs: a 10%+ fall within 3 months"
        note={`Odds are the share of days followed by a 10%+ fall within 3 months while the sign was on, next to the normal rate on days the sign could be read. The second figure is the recent half only: the market has been calmer since ${d.calibration.split.slice(0, 4)} (normal rate ${p1(d.calibration.baseline.halves[1].hitRate)}, against ${p1(d.calibration.baseline.all.hitRate)} over the full history). Grade A: more likely in both halves with 5+ episodes each. B: both halves, small sample. C: context only.`}
        rows={d.signals.filter((g) => g.kind === 'warning')}
        supported={d.supportedSignals}
        mode="warning"
      />
      <SignalGroup
        title="Turbulence signs: a 5%+ dip within the next month"
        note="These signal rough weeks, not crashes. Average returns after them stayed positive, so they make the buying steps smaller; they never stop buying. Odds are the share of days followed by a 5%+ dip within 21 sessions."
        rows={d.signals.filter((g) => g.kind === 'turbulence')}
        supported={d.supportedSignals}
        mode="turbulence"
      />
      <SignalGroup
        title="Calm signs: the next 3 months beat the normal return"
        note="When fear is priced high, the following 3 months have beaten the normal return in both halves of history. When one is on, the first buying step is bigger."
        rows={d.signals.filter((g) => g.kind === 'calm')}
        supported={d.supportedSignals}
        mode="calm"
      />

      {/* Analogs */}
      {d.analogs && (
        <Card title="Similar past states">
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
            {d.analogs.spec.describe}: {d.analogs.episodes.length} separate episodes on the Sensex.
          </p>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {d.analogs.episodes.map((e) => (
              <span key={e} className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {e.slice(0, 7)}
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-3">Next</th>
                  <th className="py-2 pr-3 text-right">Median</th>
                  <th className="py-2 pr-3 text-right">Worst tenth</th>
                  <th className="py-2 pr-3 text-right">Best tenth</th>
                  <th className="py-2 pr-3 text-right">Higher after</th>
                  <th className="py-2 text-right">All days, median</th>
                </tr>
              </thead>
              <tbody>
                {d.analogs.forward.map((f, i) => (
                  <ForwardRow key={f.horizonDays} f={f} base={d.analogs!.baselineForward[i]} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Another 10%+ fall within 3 months followed {p0(d.analogs.furtherFallOdds)} of these days (all days {p0(d.analogs.baselineFallOdds)}).
            {d.analogs.worstFurtherFallP10 != null && ` In the worst tenth of cases the index first fell a further ${p0(-d.analogs.worstFurtherFallP10)}.`} Days within an
            episode overlap, so the episode count is the real sample size.
          </p>
        </Card>
      )}

      {/* News */}
      <Card title="News and events">
        <p className="mb-3 text-xs text-zinc-500">
          Headlines only label an event and recall its history; they never change the level. A type is shown once at least two different headlines carry it.
          Of 37 past shocks, the ones that became real falls were those where oil stayed high or foreign money kept leaving.
        </p>
        {d.events.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {d.events.map((e) => (
              <div key={e.label} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="font-semibold text-zinc-800 dark:text-zinc-100">{e.title}</h4>
                  <span className="text-xs text-zinc-500">{e.headlines.length} headlines</span>
                </div>
                {e.history ? (
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {e.historyFrom ? `Using the ${e.historyFrom} record: ` : 'Past events of this type: '}
                    {e.history.events}, median first day {sgn(e.history.medianFirstDayPct)}, median worst within 60 sessions {sgn(e.history.medianWorst60Pct)},
                    higher 60 sessions later {p0(e.history.higherAfter60)}.
                    {e.history.events < 3 && <span className="font-medium text-amber-600 dark:text-amber-400"> Only {e.history.events} past event{e.history.events === 1 ? '' : 's'}, so treat this as an anecdote.</span>}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">No catalogued events of this type yet.</p>
                )}
                <p className="mt-2 text-xs">
                  <span className="font-medium text-rose-600 dark:text-rose-400">Usually hit:</span> {e.hit}
                </p>
                <p className="text-xs">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">Usually held:</span> {e.held}
                </p>
                <ul className="mt-2 space-y-1">
                  {e.headlines.slice(0, 3).map((h) => (
                    <li key={h.url || h.title} className="text-xs text-zinc-600 dark:text-zinc-400">
                      <a href={h.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {h.title}
                      </a>{' '}
                      <span className="text-zinc-400">· {h.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No macro event type is active in the last three days of headlines.</p>
        )}
        {d.health.newsErrors.length > 0 && <p className="mt-3 text-xs text-amber-600">{d.health.newsErrors.length} news queries failed this refresh.</p>}
      </Card>

      {/* Sectors */}
      <Card title="Sectors in past falls">
        <p className="mb-3 text-xs text-zinc-500">
          Equal-weight baskets of today&apos;s NIFTY 500 members by NSE industry, against the Sensex, over every 10%+ fall since {d.calibration.sectorFallsFrom?.slice(0, 4) ?? '2003'}.
          Survivors only, so every basket looks a little better than it was. This describes what to expect in a fall; trading sectors after a shock is visible tested as noise.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3">Sector</th>
                <th className="py-2 pr-3 text-right">During the fall</th>
                <th className="py-2 pr-3 text-right">Beat the index</th>
                <th className="py-2 pr-3 text-right">6 months after the bottom</th>
                <th className="py-2 pr-3 text-right">Beat the index</th>
                <th className="py-2 text-right">Down-day beta</th>
              </tr>
            </thead>
            <tbody>
              {d.sectors.map((x) => (
                <tr key={x.sector} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-3">
                    {x.sector} <span className="text-xs text-zinc-400">({x.members})</span>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Bar v={x.inFall.meanPp} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                    {x.inFall.beat}/{x.inFall.n}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Bar v={x.rebound.meanPp} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                    {x.rebound.beat}/{x.rebound.n}
                  </td>
                  <td className="py-2 text-right tabular-nums">{x.downBeta ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Rules */}
      <Card title="Does acting on a sign pay? Exposure rules, backtested">
        <p className="mb-3 text-xs text-zinc-500">
          Each rule against a plain mix holding the same average amount of stock with no timing, the rest in cash at 6%. Decided at the close, traded the next
          session, 0.2% per switch. Edge is the rule&apos;s yearly return minus that mix. Only a rule ahead in both halves can carry advice to slow new buying.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3">Rule</th>
                <th className="py-2 pr-3 text-right">Return / yr</th>
                <th className="py-2 pr-3 text-right">Worst fall</th>
                <th className="py-2 pr-3 text-right">Avg in stock</th>
                <th className="py-2 pr-3 text-right">Edge 1st half</th>
                <th className="py-2 text-right">Edge 2nd half</th>
              </tr>
            </thead>
            <tbody>
              {d.rules.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-3">{r.label}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p1(r.all.cagr)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p1(r.all.maxDD)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p0(r.all.avgExposure)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${edgeColor(r.halves[0].edgePp, r.id)}`}>{r.id === 'buyHold' ? '–' : pp(r.halves[0].edgePp)}</td>
                  <td className={`py-2 text-right tabular-nums ${edgeColor(r.halves[1].edgePp, r.id)}`}>{r.id === 'buyHold' ? '–' : pp(r.halves[1].edgePp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Event history */}
      <Card title="How past shocks played out (Sensex)">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-blue-600 dark:text-blue-400">Show all {d.eventHistory.length} events</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-3">First trading day</th>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3 text-right">Day</th>
                  <th className="py-2 pr-3 text-right">Worst within 60</th>
                  <th className="py-2 text-right">Sessions to regain</th>
                </tr>
              </thead>
              <tbody>
                {[...d.eventHistory].reverse().map((e) => (
                  <tr key={e.date + e.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.date}</td>
                    <td className="py-1.5 pr-3">{e.name}</td>
                    <td className="py-1.5 pr-3 text-xs text-zinc-500">{e.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{sgn(e.firstDayPct)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{sgn(e.worst60Pct)}</td>
                    <td className="py-1.5 text-right tabular-nums">{e.recoveryDays ?? 'not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <p className="text-xs text-zinc-500">
        Calibrated on the Sensex {d.calibration.from} to {d.calibration.to}. Gauges loaded: {d.health.gauges.length}. Breadth from {d.health.stocks} NIFTY 500 histories
        ({d.health.failedStocks} unavailable).{d.health.flowsError ? ` FII/DII: ${d.health.flowsError}.` : ''} For your own use; showing it to others as advice falls under
        SEBI&apos;s adviser rules.
      </p>
    </div>
  );
}

function edgeColor(v: number, id: string): string {
  if (id === 'buyHold') return 'text-zinc-400';
  return v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}

function ReadList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-200">
        {items.map((t) => (
          <li key={t} className="flex gap-2">
            <span aria-hidden className="text-zinc-400">
              •
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gauge({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

/** FII/DII: a 5-session sum once five days are recorded, the latest day until then (NSE serves only today). */
function FlowGauge({ flows, fii5, dii5 }: { flows: MarketWeather['escalation']['flows']; fii5: number | null; dii5: number | null }) {
  const last = flows[flows.length - 1];
  if (!last) return <Gauge label="Foreign flows" value="–" sub="NSE serves today only; history builds from now." />;
  const five = fii5 != null && flows.length >= 5;
  const fii = five ? fii5 : last.fiiNet;
  const dii = five ? dii5 : last.diiNet;
  return (
    <Gauge
      label={five ? 'Foreign flows, 5 sessions' : `Foreign flows, ${last.date.slice(5)}`}
      value={fii == null ? '–' : `${inr(fii, 0)} cr`}
      sub={`FII net · DII ${dii == null ? '–' : `${inr(dii, 0)} cr`}${five ? '' : ` · ${flows.length} of 5 days recorded`}. Flows follow the market more than they lead it.`}
    />
  );
}

function Big({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      <div className="text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

function SignalGroup({
  title,
  note,
  rows,
  supported,
  mode,
}: {
  title: string;
  note: string;
  rows: WeatherSignal[];
  supported: string[];
  mode: WeatherSignal['kind'];
}) {
  if (!rows.length) return null;
  return (
    <Card title={title}>
      <p className="mb-3 text-xs text-zinc-500">{note}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3">Sign</th>
              <th className="py-2 pr-3">Today</th>
              <th className="py-2 pr-3">Grade</th>
              <th className="py-2 pr-3 text-right">{mode === 'turbulence' ? 'Dip odds when on' : mode === 'calm' ? 'Next 3m return' : 'Odds when on'}</th>
              <th className="py-2 pr-3 text-right">{mode === 'turbulence' ? 'Normally' : mode === 'calm' ? '10% fall odds' : 'Recent half'}</th>
              <th className="py-2 pr-3 text-right">Lift (1st / 2nd half)</th>
              <th className="py-2 pr-3 text-right">Episodes</th>
              <th className="py-2">What history says</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <SignalRow key={g.id} g={g} supported={supported.includes(g.id)} mode={mode} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SignalRow({ g, supported, mode }: { g: WeatherSignal; supported: boolean; mode: WeatherSignal['kind'] }) {
  const onTone = mode === 'calm' ? 'green' : g.grade === 'C' ? 'amber' : 'red';
  const today = g.on == null ? <Badge>no data</Badge> : g.on ? <Badge tone={onTone}>on</Badge> : <span className="text-xs text-zinc-400">off</span>;
  const first =
    mode === 'turbulence' ? p0(g.dipOddsWhenOn) : mode === 'calm' ? sgnFrac(g.meanFwdRet) : `${p0(g.oddsWhenOn)} vs ${p0(g.baseline)}`;
  const second =
    mode === 'turbulence' ? p0(g.dipBaseline) : mode === 'calm' ? `${p0(g.oddsWhenOn)} vs ${p0(g.baseline)}` : `${p0(g.oddsRecent)} vs ${p0(g.baselineRecent)}`;
  return (
    <tr className={`border-t border-zinc-100 align-top dark:border-zinc-800 ${g.on ? 'bg-zinc-50 dark:bg-zinc-900/40' : ''}`}>
      <td className="py-2 pr-3">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">{g.label}</div>
        <div className="text-xs text-zinc-500">{g.detail}</div>
      </td>
      <td className="py-2 pr-3">{today}</td>
      <td className="py-2 pr-3">
        <Badge tone={GRADE_TONE[g.grade]}>{g.grade}</Badge>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{first}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{second}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{mode === 'calm' ? '–' : `${g.liftHalves[0] ?? '–'}× / ${g.liftHalves[1] ?? '–'}×`}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{g.episodes}</td>
      <td className="py-2 text-xs text-zinc-600 dark:text-zinc-400">
        {g.reason}
        {supported && <span className="mt-1 block text-emerald-700 dark:text-emerald-400">Acting on it (holding less) beat the matched mix in both halves.</span>}
      </td>
    </tr>
  );
}

function ForwardRow({ f, base }: { f: WeatherForward; base: WeatherForward }) {
  const label = f.horizonDays === 63 ? '3 months' : f.horizonDays === 126 ? '6 months' : '12 months';
  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-800">
      <td className="py-2 pr-3">{label}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{sgnFrac(f.median)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{sgnFrac(f.p10)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{sgnFrac(f.p90)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{p0(f.shareHigher)}</td>
      <td className="py-2 text-right tabular-nums text-zinc-500">{sgnFrac(base?.median)}</td>
    </tr>
  );
}

/** A small diverging bar: blue to the right when the sector did better than the index, red to the left when worse. */
function Bar({ v }: { v: number | null }) {
  if (v == null) return <span className="text-zinc-400">–</span>;
  const w = Math.min(100, (Math.abs(v) / 25) * 100);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tabular-nums">{pp(v)}</span>
      <span className="relative inline-block h-2 w-24 rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden>
        <span className="absolute left-1/2 top-0 h-2 w-px bg-zinc-300 dark:bg-zinc-600" />
        <span
          className={`absolute top-0 h-2 rounded ${v >= 0 ? 'left-1/2 bg-blue-500' : 'right-1/2 bg-rose-500'}`}
          style={{ width: `${w / 2}%` }}
        />
      </span>
    </span>
  );
}

'use client';

/**
 * Foreign Stocks — recommendations among US-listed companies (the S&P 500 plus
 * large foreign companies listed in the US), for an Indian investor buying
 * through LRS. Three tabs:
 *
 *   Top picks      the medium-horizon momentum list (v1), now with a plan per
 *                  stock (buy zone, review level, 6-month range), graded
 *                  reasons, the analysts' view, news and SEC filings
 *   Bouncing back  fallen 20–75% and turned up; a watch-list unless its
 *                  backtest passed (FOREIGN_RECS_PLAN_V2.md check B3)
 *   News & events  sector moves, market headlines, and every flagged headline
 *                  or filing on the names above. News never changes a rank.
 *
 * See FOREIGN_RECS_CHECKLIST.md for every check behind the page.
 */
import { Fragment, useState } from 'react';
import { Badge, Card, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import type { ForeignBounceRow, ForeignDetail, ForeignHeadline, ForeignRow, ForeignStocks } from '../lib/types';
import { usePolling } from '../lib/usePolling';

const pc = (x: number | null | undefined, dp = 0): string => {
  if (x == null) return '–';
  const s = Math.abs(x * 100).toFixed(dp);
  // A value that rounds to zero is shown unsigned ("0.0%", never "−0.0%").
  return Number(s) === 0 ? `${s}%` : `${x > 0 ? '+' : '−'}${s}%`;
};
/** Filings worth reading before buying. Officer changes (5.02) and bylaw/rights changes are routine and only shown on the card. */
const READ_FIRST = new Set(['1.02', '1.05', '2.05', '2.06', '3.02', '4.01', '5.01']);
const pl = (x: number | null | undefined, dp = 0): string => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`);
/** Colour for a fraction; `dp` matches the decimals shown, so a value displayed as 0% is never red or green. */
const tone = (x: number | null | undefined, dp = 1): string =>
  x == null || Math.abs(x) < 0.5 * 10 ** -(dp + 2) ? 'text-zinc-400' : x > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
const inr = (x: number | null | undefined): string => (x == null ? '–' : `₹${Math.round(x).toLocaleString('en-IN')}`);
const usd = (x: number | null | undefined): string => (x == null ? '–' : `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`);

function isReady(d: unknown): d is ForeignStocks {
  return !!d && typeof d === 'object' && 'picks' in d;
}

type Tab = 'picks' | 'bounce' | 'news';

export default function ForeignStocksPage() {
  const poll = usePolling(() => api.foreignStocks(), 120_000);
  const [busy, setBusy] = useState(false);
  const d = poll.data;
  return (
    <div>
      <PageHeader
        title="Foreign Stocks"
        subtitle="US-listed companies (S&P 500 and big foreign companies listed in the US) ranked for an Indian investor. Past strength, not a forecast."
        action={
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.refreshForeignStocks();
                poll.refresh();
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      {poll.error && <p className="mb-4 text-sm text-rose-600">Could not load: {poll.error}</p>}
      {!isReady(d) ? (
        <Card>
          <p className="text-sm text-zinc-500">
            {d && 'status' in d && d.status.lastError
              ? `The first build failed: ${d.status.lastError}`
              : 'Building the first list: about 530 companies’ price history, 15 years of SEC filings, analyst data and news. The first run takes a few minutes; later ones use the cache.'}
          </p>
        </Card>
      ) : (
        <View d={d} />
      )}
    </div>
  );
}

function View({ d }: { d: ForeignStocks }) {
  const [tab, setTab] = useState<Tab>('picks');
  const bt = d.backtest;
  const mom = bt?.lines.find((l) => l.id === 'momentum');
  const eq = bt?.lines.find((l) => l.id === 'equal');
  const flagged = [...d.picks, ...(d.bounce?.qualified ?? [])].filter(
    (r) => r.detail?.withheld || r.detail?.earningsSoon || r.detail?.events?.some((e) => e.level === 'red' || READ_FIRST.has(e.item)),
  );
  const tabs: [Tab, string][] = [
    ['picks', `Top picks (${d.picks.length})`],
    ['bounce', `Bouncing back (${d.bounce?.qualified.length ?? 0})`],
    ['news', `News & events${flagged.length ? ` (${flagged.length} to read)` : ''}`],
  ];
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-5 dark:border-sky-800 dark:bg-sky-950/30" aria-label="How this page works">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">How this page works · prices to {d.asOf}</div>
        <ul className="mt-3 space-y-2.5 text-sm text-zinc-800 dark:text-zinc-100">
          <li>
            <b>Top picks:</b>{' '}the {d.picks.length} strongest of {d.counts.measured} US-listed companies by 6- and 12-month momentum, only those above their 200-day
            average, at most 4 per sector.
            {mom && eq && (
              <>
                {' '}In a month-by-month test since {bt!.from.slice(0, 4)} it returned {pl(mom.cagr, 1)} a year against {pl(eq.cagr, 1)} for holding everything, ahead in
                both halves. A modest, real edge, not a fortune.
              </>
            )}
          </li>
          <li>
            <b>Each stock has a plan and targets:</b>{' '}a buy zone, a review level (below it, stop adding and re-check), and short (1 month), intermediate (6 months)
            and long-term (1 year) targets built from how past top picks actually did, scaled to the stock&apos;s own swings. Not a promise. The analysts&apos; target is
            shown separately, as theirs.
          </li>
          <li>
            <b>Reasons are graded:</b>{' '}<GradeChip g="A" /> backtested here, <GradeChip g="B" /> backed by published research, <GradeChip g="C" /> weak evidence, shown
            for reading only. News and analyst opinions never change the ranking; bad news or a red-flag SEC filing only holds new money back.
          </li>
          <li>
            <b>In rupees:</b>{' '}USD/INR is {d.usdInr?.toFixed(2) ?? '–'}; the dollar rose {pc(d.usdInr12m, 1)} against the rupee in the last year, which is added to every
            US return in rupees. A rupee recovery would work the other way.
          </li>
        </ul>
        <p className="mt-3 text-xs text-zinc-500">
          For your own use. Not advice from a SEBI-registered adviser. No list can say a stock will go up. Prices exclude dividends.
        </p>
      </section>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Sections">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              tab === k
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'picks' && <PicksTab d={d} />}
      {tab === 'bounce' && <BounceTab d={d} />}
      {tab === 'news' && <NewsTab d={d} flagged={flagged} />}

      <Glossary />

      <p className="text-xs text-zinc-500">
        Updated {dateTime(d.computedAt)}. {d.counts.measured} of {d.counts.universe} companies measured; {d.counts.noFundamentals} without SEC filings (foreign companies file
        elsewhere) carry no finance flag. Analyst and earnings data: Nasdaq. Filings and accounts: SEC. Headlines: Google News.
        {d.health.failed.length ? ` No price history: ${d.health.failed.join(', ')}.` : ''}
      </p>
    </div>
  );
}

// ───────────────────────────── Top picks ─────────────────────────────

function PicksTab({ d }: { d: ForeignStocks }) {
  const bt = d.backtest;
  return (
    <div className="space-y-6">
      <StartHere d={d} />
      <Card title="How to buy these from India, and how much">
        <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <ul className="space-y-1.5 text-zinc-700 dark:text-zinc-300">
            <li>
              • <b>Route:</b>{' '}an overseas account under LRS (Vested, INDmoney, ICICI Direct Global and others). Fractional shares let you buy ₹5,000 of a $500 stock.
            </li>
            <li>
              • <b>Size:</b>{' '}no more than about 5% of your total portfolio in any one of these, and keep all foreign stocks to a slice you are comfortable with (20–30% is common).
            </li>
            <li>
              • <b>Steps:</b>{' '}buy each in two or three parts a few weeks apart, inside its buy zone. A dip to the bottom of the zone is normal for that stock.
            </li>
            <li>
              • <b>Results due:</b>{' '}where a stock reports within 7 days the card says so. Waiting until after results costs little and avoids buying straight into a
              surprise.
            </li>
            <li>
              • <b>When to review:</b>{' '}monthly, or when a stock closes below its review level. A stock that drops below its 200-day average leaves the list; that is the
              moment to stop adding, not necessarily to sell.
            </li>
          </ul>
          <ul className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            {d.facts.map((f) => (
              <li key={f}>• {f}</li>
            ))}
          </ul>
        </div>
      </Card>

      <Card title={`Recommended now: top ${d.picks.length}`}>
        <p className="mb-3 text-xs text-zinc-500">Open any row for its plan, its reasons, the analysts&apos; view, recent headlines and SEC filings.</p>
        <StockTable rows={d.picks} usdInr={d.usdInr} kind="momentum" />
      </Card>

      {d.horizonStudy && <HorizonStudyCard s={d.horizonStudy} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Big foreign companies listed in the US">
          <p className="mb-2 text-xs text-zinc-500">TSMC, ASML, Novo Nordisk, Toyota and others trade in the US, so the same LRS account reaches them. Ranked the same way.</p>
          <MiniTable rows={d.adrs.slice(0, 12)} />
        </Card>
        <Card title="Famous names that are not recommended right now">
          <p className="mb-2 text-xs text-zinc-500">The most-traded US companies that fail a rule today, with the reason. Not a sell call: it means wait before adding new money.</p>
          {d.avoid.length ? (
            <ul className="space-y-1.5 text-sm">
              {d.avoid.map((a) => (
                <li key={a.ticker} className="border-t border-zinc-100 pt-1.5 first:border-t-0 dark:border-zinc-800">
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{a.name}</span> <span className="font-mono text-xs text-zinc-400">{a.ticker}</span>
                  <span className={`ml-2 tabular-nums ${tone(a.ret12mUsd)}`}>{pc(a.ret12mUsd)} in a year</span>
                  <div className="text-xs text-zinc-500">{a.vetoReason}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-500">All of the most-traded names pass today.</p>
          )}
        </Card>
      </div>

      <Card title="Best two in each sector, for spreading money out">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Object.entries(d.bySector)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([sec, rows]) => (
              <div key={sec} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{sec}</div>
                {rows.map((r) => (
                  <div key={r.ticker} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate">
                      {r.name} <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
                    </span>
                    <span className={`shrink-0 tabular-nums ${tone(r.ret12mUsd)}`}>{pc(r.ret12mUsd)}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </Card>

      {bt && (
        <Card title={`The test behind the top picks: monthly, ${bt.from} to ${bt.to}, in dollars`}>
          <p className="mb-3 text-xs text-zinc-500">
            Each month, every stock was measured using only prices up to that day and SEC filings at least 120 days old, and only stocks already in the S&amp;P 500 then were
            eligible. The chosen 20 were held for the next month with 0.1% cost per switch. Split at {bt.split}; an idea must beat holding everything in both halves.
          </p>
          <BtTable lines={bt.lines.map((l) => ({ ...l, edge: l.id === 'equal' ? null : l.edgeHalves }))} highlight="momentum" />
          <p className="mt-2 text-xs text-zinc-500">
            Still optimistic: companies that were dropped from the index after collapsing are missing, which flatters every line, the junk basket most.
          </p>
        </Card>
      )}
    </div>
  );
}

const HZ_SHORT: Record<string, string> = { short: '1 month', medium: '6 months', long: '1 year' };

const START_SHOWN = 20;

function StartHere({ d }: { d: ForeignStocks }) {
  const sh = d.startHere;
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!sh?.ready.length) return null;
  const pool = [...d.picks, ...(d.more ?? [])];
  const rows = sh.ready.map((t) => pool.find((p) => p.ticker === t)).filter((r): r is ForeignRow => !!r);
  const shown = showAll ? rows : rows.slice(0, START_SHOWN);
  const nameOf = (t: string) => pool.find((p) => p.ticker === t)?.name ?? t;
  const s1 = d.horizonStudy?.stats.find((s) => s.key === 'long');
  const s2 = d.horizonStudy?.stats2?.find((s) => s.key === 'long');
  return (
    <section className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-5 dark:border-emerald-800 dark:bg-emerald-950/30" aria-label="Start here">
      <div className="text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
        Start here: {rows.length} picks with nothing to wait for, best first
      </div>
      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
        Ranked picks with no results due this week, no bad news holding money back and no weak-finance flag. Ranks 1–20 are the top picks; ranks 21–40 are the second tier,
        measured separately and weaker
        {s1 && s2 ? ` (a year later: up ${pl(s1.upRate)} vs ${pl(s2.upRate)} of the time, average ${pc((s1.picksMean[0] + s1.picksMean[1]) / 2, 1)} vs ${pc((s2.picksMean[0] + s2.picksMean[1]) / 2, 1)})` : ''}
        . Targets: the middle figure is the typical outcome, the range below it held about half of past outcomes. Open <b>Why?</b>{' '}on any row for why it is suggested, why it may
        keep rising, and what could go wrong.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-1.5 pr-2">Rank</th>
              <th className="py-1.5 pr-3">Company</th>
              <th className="py-1.5 pr-3 text-right">Price</th>
              <th className="py-1.5 pr-3 text-right">Buy zone</th>
              {['short', 'medium', 'long'].map((k) => (
                <th key={k} className="py-1.5 pr-3 text-right">
                  {HZ_SHORT[k]}
                </th>
              ))}
              <th className="py-1.5 pr-3 text-right">Review below</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const o = r.detail?.outlook;
              const isOpen = open === r.ticker;
              return (
                <Fragment key={r.ticker}>
                  <tr className="border-t border-emerald-200/70 align-top dark:border-emerald-900/60">
                    <td className="py-2 pr-2 tabular-nums">
                      <span className={r.tier === 2 ? 'text-zinc-400' : 'font-semibold text-emerald-800 dark:text-emerald-300'}>#{r.rank}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-zinc-900 dark:text-zinc-50">
                        {r.name} <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
                      </div>
                      <div className="text-xs text-zinc-500">
                        {r.sector}
                        {r.tier === 2 && <span className="ml-2 text-zinc-400">second tier</span>}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      ${r.priceUsd.toFixed(2)}
                      <div className="text-xs text-zinc-400">{inr(r.priceInr)}</div>
                    </td>
                    <td className="py-2 pr-3 text-right text-xs tabular-nums">{r.detail ? `${usd(r.detail.levels.buyLow)}–${usd(r.detail.levels.buyHigh)}` : '–'}</td>
                    {(['short', 'medium', 'long'] as const).map((k) => {
                      const t = r.detail?.targets?.find((x) => x.key === k);
                      return (
                        <td key={k} className="py-2 pr-3 text-right tabular-nums">
                          {t ? (
                            <>
                              <span className="font-semibold">{usd(t.base)}</span> <span className={`text-xs ${tone(t.basePct)}`}>{pc(t.basePct, 1)}</span>
                              <div className="text-xs text-zinc-500">
                                {usd(t.low)}–{usd(t.high)}
                              </div>
                            </>
                          ) : (
                            '–'
                          )}
                        </td>
                      );
                    })}
                    <td className="py-2 pr-3 text-right text-xs tabular-nums">
                      {r.detail ? (
                        <>
                          {usd(r.detail.levels.review)}
                          <div className="text-zinc-400">{pc(r.detail.levels.reviewPct)}</div>
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="py-2">
                      {o && (
                        <button type="button" className="text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => setOpen(isOpen ? null : r.ticker)} aria-expanded={isOpen}>
                          {isOpen ? 'Hide' : 'Why?'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && o && (
                    <tr>
                      <td colSpan={9} className="pb-3">
                        <div className="sticky left-0 max-w-[calc(100vw-5.5rem)] md:max-w-none">
                          <OutlookPanel o={o} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > START_SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="mt-3 rounded-lg border border-emerald-400 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
        >
          {showAll ? `Show the first ${START_SHOWN} only` : `View more (${rows.length - START_SHOWN} more)`}
        </button>
      )}
      {sh.skipped.length > 0 && (
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          Left out for now: {sh.skipped.map((s) => `${nameOf(s.ticker)} (${s.why})`).join('; ')}. They stay in the full list below.
        </p>
      )}
      <p className="mt-2 text-xs text-zinc-500">
        Spread money across several, about 5% of your portfolio at most in any one, bought in 2–3 steps, and don&apos;t stack one sector. Nothing here can say a stock will
        go up.
      </p>
    </section>
  );
}

function OutlookPanel({ o }: { o: NonNullable<ForeignDetail['outlook']> }) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg bg-white p-3 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 md:grid-cols-3">
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Why it is suggested</div>
        <ul className="space-y-1">
          {o.why.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Why it may keep rising</div>
        <ul className="space-y-1.5">
          {o.growth.map((g) => (
            <li key={g.text} className="flex gap-2">
              <GradeChip g={g.grade} />
              <span>{g.text}</span>
            </li>
          ))}
          {!o.growth.length && <li className="text-zinc-500">Nothing beyond the trend itself.</li>}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">What could go wrong</div>
        <ul className="space-y-1">
          {o.risks.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function HorizonStudyCard({ s }: { s: NonNullable<ForeignStocks['horizonStudy']> }) {
  return (
    <Card title="Where the short, intermediate and long-term targets come from">
      <p className="mb-3 text-xs text-zinc-500">
        Every month from {s.from.slice(0, 4)}, the list was rebuilt using only what was known then, and each pick&apos;s return over the next 1, 6 and 12 months was recorded
        relative to its own swings (calm, middle and wild stocks fitted separately). A stock&apos;s targets apply those past results to its price and swings today. Split at{' '}
        {s.split}: the targets were fitted on the first half and checked on the second.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3">Horizon</th>
              <th className="py-2 pr-3 text-right">Past picks up</th>
              <th className="py-2 pr-3 text-right">Picks avg (1st / 2nd half)</th>
              <th className="py-2 pr-3 text-right">All stocks avg</th>
              <th className="py-2 pr-3 text-right">Edge</th>
              <th className="py-2 pr-3 text-right">Inside range (aim 50%)</th>
              <th className="py-2 text-right">Beat typical (aim 50%)</th>
            </tr>
          </thead>
          <tbody>
            {s.stats.map((h) => (
              <tr key={h.key} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-2 pr-3">{h.label}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{pl(h.upRate)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {pc(h.picksMean[0], 1)} / {pc(h.picksMean[1], 1)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {pc(h.allMean[0], 1)} / {pc(h.allMean[1], 1)}
                </td>
                <td className="py-2 pr-3 text-right">{h.edge ? <Badge tone="green">both halves</Badge> : <Badge tone="amber">none measured</Badge>}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{pl(h.oos.insideMiddle)}</td>
                <td className="py-2 text-right tabular-nums">{pl(h.oos.aboveBase)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        How to read it: in testing on years it had not seen, the typical-outcome figure was beaten a little less than half the time, so treat it as slightly optimistic, and
        the 1-year range caught fewer outcomes than intended, so real results spread wider. Monthly samples of 6- and 12-month returns overlap, so the evidence is thinner
        than the counts suggest. Prices exclude dividends.
      </p>
    </Card>
  );
}

// ───────────────────────────── Bouncing back ─────────────────────────────

function BounceTab({ d }: { d: ForeignStocks }) {
  const b = d.bounce;
  const bb = d.bounceBacktest;
  const [showRejected, setShowRejected] = useState(false);
  if (!b) return <Card><p className="text-sm text-zinc-500">Not built yet. Press Refresh.</p></Card>;
  const line = (id: string) => bb?.lines.find((l) => l.id === id);
  const eq = line('equal');
  const fallen = line('fallen');
  const price = line('bouncePrice');
  const gated = line('bounce');
  const cal = bb?.calibration;
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30" aria-label="About this list">
        <div className="text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
          {b.funded ? `Up to ${b.capPct}% of your foreign money, split across the top names` : 'Watch-list: no money plan'}
        </div>
        <ul className="mt-3 space-y-2.5 text-sm text-zinc-800 dark:text-zinc-100">
          <li>
            <b>What it shows:</b>{' '}companies 20–75% below their 1-year high that have stopped falling: back above their 50-day average, that average rising, and higher
            than 3 months ago. A fall alone is not a reason to buy; most stocks that fall keep falling for a while.
          </li>
          {eq && fallen && price && gated && (
            <li>
              <b>What the test found ({bb!.from.slice(0, 4)}–{bb!.to.slice(0, 4)}):</b>{' '}this pattern returned {pl(price.cagr, 1)} a year against {pl(eq.cagr, 1)} for
              holding everything and {pl(fallen.cagr, 1)} for any fallen stock, ahead in both halves. But it was uneven (see the year table), held about{' '}
              {price.avgHoldings.toFixed(0)} names, and had nothing to hold in {price.emptyMonths} of {bb!.months} months.
            </li>
          )}
          {gated && (
            <li>
              <b>Why there is no money plan:</b>{' '}the plan was to fund only profitable companies with sound finances. Tested, that version returned{' '}
              {pl(gated.cagr, 1)} a year and fell behind the plain fallen-stock basket in the second half ({pl(gated.halves[1], 1)} vs {pl(fallen?.halves[1], 1)}). The
              weakest companies bounced hardest, and that is exactly where this data is most flattered: companies that fell and went bust are missing from it. Neither
              version can be trusted to the decimal, so this is a list to research, with business problems marked ⚑. Clean businesses are listed first.
            </li>
          )}
          <li>
            <b>If you buy one anyway:</b>{' '}small amounts only, its review level is a real exit (the 20-day low less 4%), and give it 12 months at most. A turnaround that does
            not turn is dead money.
          </li>
        </ul>
      </section>

      <Card title="Fallen and turned up">
        {b.qualified.length ? (
          <StockTable rows={b.qualified} usdInr={d.usdInr} kind="bounce" />
        ) : (
          <p className="text-sm text-zinc-500">Nothing qualifies today. That is a normal result: the test had empty months too.</p>
        )}
        <button type="button" className="mt-3 text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => setShowRejected((v) => !v)} aria-expanded={showRejected}>
          {showRejected ? 'Hide' : 'Show'} the {b.rejected.length} fallen companies that did not qualify, and why
        </button>
        {showRejected && (
          <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
            {b.rejected.map((r) => (
              <li key={r.ticker} className="border-t border-zinc-100 pt-1 dark:border-zinc-800">
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.name}</span> <span className="font-mono text-zinc-400">{r.ticker}</span>{' '}
                <span className="tabular-nums text-rose-600 dark:text-rose-400">−{(r.fallPct * 100).toFixed(0)}%</span>
                <div className="text-zinc-500">{r.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {bb && (
        <Card title={`The test behind it: monthly, ${bb.from} to ${bb.to}, in dollars`}>
          <p className="mb-3 text-xs text-zinc-500">
            Same rules as the top-picks test: only prices up to each month end, SEC accounts at least 120 days old, only stocks already in the S&amp;P 500, held one month,
            0.1% per switch. The SEC-filing and news checks cannot be replayed (no history), so they are not in the test.
          </p>
          <BtTable lines={bb.lines.map((l) => ({ ...l, edge: l.id === 'equal' ? null : ([l.halves[0] - eq!.halves[0], l.halves[1] - eq!.halves[1]].map((x) => x * 100) as [number, number]) }))} highlight="bouncePrice" />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-zinc-500">
                  <th className="py-1 pr-3">Year</th>
                  <th className="py-1 pr-3 text-right">Fallen and turned up</th>
                  <th className="py-1 pr-3 text-right">…clean businesses only</th>
                  <th className="py-1 pr-3 text-right">Any fallen stock</th>
                  <th className="py-1 text-right">Everything</th>
                </tr>
              </thead>
              <tbody>
                {bb.years.map((y) => (
                  <tr key={y.year} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3">{y.year}</td>
                    <td className={`py-1 pr-3 text-right tabular-nums ${y.bouncePrice >= y.equal ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{pc(y.bouncePrice, 1)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{pc(y.bounce, 1)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{pc(y.fallen, 1)}</td>
                    <td className="py-1 text-right tabular-nums">{pc(y.equal, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Green: beat holding everything that year; red: lost to it. Survivorship flatters every fallen-stock line, so treat the levels as an upper bound.
            {cal && (
              <>
                {' '}The 6-month range on each card held about {Math.round((100 * cal.inside) / cal.observations)}% of {cal.observations.toLocaleString('en-US')} real outcomes
                (aimed at about 68%); outcomes above the range were {Math.round((100 * cal.above) / cal.observations)}%, below it{' '}
                {Math.round((100 * cal.below) / cal.observations)}%.
              </>
            )}
          </p>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────────── News & events ─────────────────────────────

function NewsTab({ d, flagged }: { d: ForeignStocks; flagged: ForeignRow[] }) {
  const m = d.market;
  const all = [...d.picks, ...(d.bounce?.qualified ?? [])];
  return (
    <div className="space-y-6">
      {m && (
        <Card title="What is moving US markets">
          <p className="mb-3 text-xs text-zinc-500">Context only: none of this changes a ranking. Sector funds (SPDR) show where money moved.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-1.5 pr-3">Sector</th>
                  <th className="py-1.5 pr-3 text-right">1 day</th>
                  <th className="py-1.5 pr-3 text-right">1 week</th>
                  <th className="py-1.5 text-right">1 month</th>
                </tr>
              </thead>
              <tbody>
                {m.sectors.map((s) => (
                  <tr key={s.ticker} className={`border-t border-zinc-100 dark:border-zinc-800 ${s.ticker === 'SPY' ? 'font-medium' : ''}`}>
                    <td className="py-1.5 pr-3">
                      {s.name} <span className="font-mono text-xs text-zinc-400">{s.ticker}</span>
                    </td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(s.ret1d)}`}>{pc(s.ret1d, 1)}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(s.ret1w)}`}>{pc(s.ret1w, 1)}</td>
                    <td className={`py-1.5 text-right tabular-nums ${tone(s.ret1m)}`}>{pc(s.ret1m, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {m.headlines.length > 0 && (
            <>
              <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Market headlines, last 2 days</div>
              <HeadlineList items={m.headlines} />
            </>
          )}
        </Card>
      )}

      <Card title="Read before buying">
        <p className="mb-3 text-xs text-zinc-500">
          Names on this page with something to read first: money held back (bad news or a red-flag filing), results due within 7 days, or a filing that needs reading
          (restructuring, write-down, new shares, auditor change, cyber incident, change of control). Routine officer changes are on each stock&apos;s card.
        </p>
        {flagged.length ? (
          <ul className="space-y-3">
            {flagged.map((r) => (
              <li key={r.ticker} className="border-t border-zinc-100 pt-2 first:border-t-0 dark:border-zinc-800">
                <div className="text-sm">
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.name}</span> <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
                </div>
                {r.detail?.withheld && <div className="text-xs font-medium text-rose-700 dark:text-rose-400">Hold new money: {r.detail.withheld}</div>}
                {r.detail?.earningsSoon && <div className="text-xs text-amber-700 dark:text-amber-400">Results on {r.detail.earningsDate}: wait until after them.</div>}
                {r.detail?.events
                  ?.filter((e) => e.level === 'red' || READ_FIRST.has(e.item))
                  .map((e) => (
                    <div key={`${e.date}-${e.item}`} className={`text-xs ${e.level === 'red' ? 'text-rose-700 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}`}>
                      SEC filing {e.date}: {e.text} (item {e.item})
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">Nothing flagged on the listed names today.</p>
        )}
      </Card>

      <Card title="Headline tone by company">
        <p className="mb-3 text-xs text-zinc-500">
          Last 7 days, headlines that name the company (others are dropped). The tone is a word count, so treat it as a pointer to what to read, not a verdict. Three or more
          strongly negative headlines hold new money back.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1.5 pr-3">Company</th>
                <th className="py-1.5 pr-3 text-right">Headlines</th>
                <th className="py-1.5 pr-3 text-right">Tone</th>
                <th className="py-1.5">Latest</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r) => {
                const n = r.detail?.news;
                return (
                  <tr key={r.ticker} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                    <td className="py-1.5 pr-3">
                      {r.name} <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{n ? n.headlines.length : '–'}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${n && n.scored ? tone(n.sentiment) : 'text-zinc-400'}`}>
                      {n && n.scored ? n.sentiment.toFixed(2) : '–'}
                      {n?.veto && <span className="ml-1"><Badge tone="red">veto</Badge></span>}
                    </td>
                    <td className="py-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                      {n?.headlines[0] ? (
                        <a href={n.headlines[0].url} target="_blank" rel="noreferrer" className="hover:underline">
                          {n.headlines[0].title}
                        </a>
                      ) : (
                        '–'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
}

// ───────────────────────────── shared pieces ─────────────────────────────

function GradeChip({ g }: { g: 'A' | 'B' | 'C' }) {
  const cls =
    g === 'A'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
      : g === 'B'
        ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300'
        : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  return <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold ${cls}`}>{g}</span>;
}

function StockTable({ rows, usdInr, kind }: { rows: (ForeignRow | ForeignBounceRow)[]; usdInr: number | null; kind: 'momentum' | 'bounce' }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-3">Company</th>
            <th className="py-2 pr-3 text-right">Price</th>
            <th className="py-2 pr-3 text-right">{kind === 'bounce' ? 'Fall from high' : '1 year ($)'}</th>
            <th className="py-2 pr-3 text-right">Buy zone</th>
            <th className="py-2 pr-3 text-right">Review below</th>
            <th className="py-2 pr-3 text-right">Analysts&apos; target</th>
            <th className="py-2 pr-3 text-right">{kind === 'bounce' ? 'Finances' : 'Score'}</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => {
            const d = r.detail;
            const br = kind === 'bounce' ? (r as ForeignBounceRow) : null;
            return (
              <Fragment key={r.ticker}>
                <tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-2 pr-2 tabular-nums text-zinc-400">{k + 1}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">
                      {r.name} <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-xs text-zinc-500">
                      <span>{r.sector}</span>
                      {r.kind === 'adr' && <span>{r.country}</span>}
                      {kind === 'momentum' && r.quality?.junk && <span className="font-medium text-amber-700 dark:text-amber-400">⚑ weak finances</span>}
                      {br && !br.clean && <span className="font-medium text-amber-700 dark:text-amber-400">⚑ {br.flags.filter((f) => !f.startsWith('down ')).length} business flag{br.flags.filter((f) => !f.startsWith('down ')).length === 1 ? '' : 's'}</span>}
                      {br?.deep && <span className="font-medium text-rose-700 dark:text-rose-400">higher risk: 40%+ fall</span>}
                      {d?.earningsSoon && <span className="font-medium text-amber-700 dark:text-amber-400">results {d.earningsDate}: wait</span>}
                      {d?.withheld && <span className="font-medium text-rose-700 dark:text-rose-400">hold new money</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    ${r.priceUsd.toFixed(2)}
                    <div className="text-xs text-zinc-400">{inr(r.priceInr)}</div>
                  </td>
                  <td className={`py-2 pr-3 text-right font-semibold tabular-nums ${br ? 'text-rose-600 dark:text-rose-400' : tone(r.ret12mUsd)}`}>
                    {br ? `−${(br.fallPct * 100).toFixed(0)}%` : pc(r.ret12mUsd)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-xs">{d ? `${usd(d.levels.buyLow)}–${usd(d.levels.buyHigh)}` : '–'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-xs">
                    {d ? (
                      <>
                        {usd(d.levels.review)}
                        <div className="text-zinc-400">{pc(d.levels.reviewPct)}</div>
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-xs">
                    {d?.analyst?.target != null ? (
                      <>
                        {usd(d.analyst.target)}
                        <div className={tone(d.analyst.upside, 0)}>{pc(d.analyst.upside)}</div>
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {br ? (
                      <Badge tone={br.clean ? 'green' : 'amber'}>{br.bounceScore.toFixed(0)}</Badge>
                    ) : (
                      <Badge tone={r.verdict === 'strong' ? 'green' : r.verdict === 'good' ? 'blue' : 'neutral'}>{r.score.toFixed(0)}</Badge>
                    )}
                  </td>
                  <td className="py-2">
                    <button type="button" className="text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => setOpen(open === r.ticker ? null : r.ticker)} aria-expanded={open === r.ticker}>
                      {open === r.ticker ? 'Hide' : 'Why & plan'}
                    </button>
                  </td>
                </tr>
                {open === r.ticker && (
                  <tr className="bg-zinc-50 dark:bg-zinc-900">
                    <td colSpan={9} className="p-3">
                      {/* On a phone the table scrolls sideways; the card stays pinned to the visible width. */}
                      <div className="sticky left-3 max-w-[calc(100vw-5.5rem)] md:max-w-none">
                        <DetailCard r={r} usdInr={usdInr} kind={kind} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailCard({ r, usdInr, kind }: { r: ForeignRow | ForeignBounceRow; usdInr: number | null; kind: 'momentum' | 'bounce' }) {
  const d: ForeignDetail | undefined = r.detail;
  if (!d) return <p className="text-xs text-zinc-500">No detail for this row.</p>;
  const L = d.levels;
  const a = d.analyst;
  const flags = 'flags' in r ? r.flags : [];
  return (
    <div className="grid grid-cols-1 gap-4 text-xs text-zinc-700 dark:text-zinc-300 lg:grid-cols-2">
      {d.outlook && (
        <div className="lg:col-span-2">
          <OutlookPanel o={d.outlook} />
        </div>
      )}
      <div className="space-y-3">
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Details behind it</div>
          <ul className="space-y-1.5">
            {d.reasons.map((w) => (
              <li key={w.text} className="flex gap-2">
                <GradeChip g={w.grade} />
                <span className={w.stance === 'bad' ? 'text-amber-800 dark:text-amber-300' : ''}>{w.text}</span>
              </li>
            ))}
            {flags.map((f) => (
              <li key={f} className="flex gap-2 text-amber-800 dark:text-amber-300">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">⚑</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">The plan</div>
          <ul className="space-y-1">
            <li>
              <b>Buy zone:</b>{' '}{usd(L.buyLow)} to {usd(L.buyHigh)}, in 2–3 steps. A ₹10,000 step is about {usdInr ? (10000 / usdInr / r.priceUsd).toFixed(3) : '–'} shares.
            </li>
            <li>
              <b>Review level:</b>{' '}{usd(L.review)} ({pc(L.reviewPct)}; {L.reviewBasis}).{' '}
              {kind === 'bounce' ? 'A close below it means the bounce failed: exit.' : 'A close below it means stop adding and re-check; below the 200-day average it leaves the list.'}
            </li>
            {!d.targets?.length && (
              <li>
                <b>Typical 6-month range:</b>{' '}{usd(L.rangeLow)} to {usd(L.rangeHigh)}. About two in three past outcomes landed inside a range built this way. Not a target.
              </li>
            )}
            {kind === 'bounce' && (
              <li>
                <b>Time limit:</b>{' '}12 months. If it has not recovered by then, the money is better elsewhere.
              </li>
            )}
            {d.earningsDate && (
              <li className={d.earningsSoon ? 'font-medium text-amber-800 dark:text-amber-300' : ''}>
                <b>Next results:</b>{' '}{d.earningsDate}
                {d.earningsSoon ? ': within 7 days, so wait until after them.' : '.'}
              </li>
            )}
            {d.withheld && (
              <li className="font-medium text-rose-700 dark:text-rose-400">
                <b>Hold new money:</b>{' '}{d.withheld}.
              </li>
            )}
          </ul>
        </div>
        {d.targets && d.targets.length > 0 ? (
          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Targets by horizon</div>
            <table className="w-full">
              <tbody>
                {d.targets.map((t) => (
                  <tr key={t.key} className="border-t border-zinc-200 first:border-t-0 dark:border-zinc-800">
                    <td className="py-1 pr-2">{t.label}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      <b>{usd(t.base)}</b> <span className={tone(t.basePct)}>{pc(t.basePct, 1)}</span>
                    </td>
                    <td className="py-1 text-right tabular-nums text-zinc-500">
                      {usd(t.low)}–{usd(t.high)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-zinc-500">
              Typical outcome, and the range that held about half of past top picks over that period. Past picks were up after 1 month{' '}
              {pl(d.targets.find((t) => t.key === 'short')?.upRate)}, 6 months {pl(d.targets.find((t) => t.key === 'medium')?.upRate)} and 1 year{' '}
              {pl(d.targets.find((t) => t.key === 'long')?.upRate)} of the time.
            </p>
          </div>
        ) : kind === 'bounce' ? (
          <p className="text-zinc-500">
            No horizon targets here: they come from how past top picks behaved, and a bounce-back is a different kind of stock. Use the review level and the 12-month limit.
          </p>
        ) : null}
        {a && (
          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Analysts&apos; view (theirs, not ours)</div>
            <p>
              {a.buy} buy, {a.hold} hold, {a.sell} sell. Consensus target {usd(a.target)} ({pc(a.upside)} from here), range {usd(a.targetLow)}–{usd(a.targetHigh)}.{' '}
              {a.upside != null && a.upside < 0 ? 'The price is already above the average target; momentum stocks often are.' : ''}
            </p>
          </div>
        )}
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Headlines, last 7 days</div>
          {d.news ? (
            <>
              <p className="mb-1 text-zinc-500">
                {d.news.note}
                {d.news.offTopic ? ` ${d.news.offTopic} about other companies dropped.` : ''}
              </p>
              <HeadlineList items={d.news.headlines.slice(0, 5)} />
            </>
          ) : (
            <p className="text-zinc-500">Could not load headlines.</p>
          )}
        </div>
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">SEC filings (8-K), last 90 days</div>
          {d.events == null ? (
            <p className="text-zinc-500">Foreign companies listed through ADRs file different forms (6-K), so there are no 8-K events to show.</p>
          ) : d.events.length ? (
            <ul className="space-y-0.5">
              {d.events.map((e) => (
                <li key={`${e.date}-${e.item}`} className={e.level === 'red' ? 'font-medium text-rose-700 dark:text-rose-400' : e.level === 'amber' ? 'text-amber-800 dark:text-amber-300' : ''}>
                  <span className="tabular-nums text-zinc-400">{e.date}</span> {e.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-500">None.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function HeadlineList({ items }: { items: ForeignHeadline[] }) {
  return (
    <ul className="space-y-1">
      {items.map((h) => (
        <li key={`${h.at}-${h.title}`} className="flex gap-2 text-xs">
          <span className={`w-10 shrink-0 text-right tabular-nums ${h.tone ? tone(h.tone) : 'text-zinc-400'}`}>{h.tone ? h.tone.toFixed(1) : '·'}</span>
          <span>
            <a href={h.url} target="_blank" rel="noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">
              {h.title}
            </a>{' '}
            <span className="text-zinc-400">· {h.source}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function BtTable({
  lines,
  highlight,
}: {
  lines: { id: string; label: string; cagr: number; maxDD: number; halves: [number, number]; edge: [number, number] | null }[];
  highlight: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="py-2 pr-3">Approach</th>
            <th className="py-2 pr-3 text-right">Return / yr</th>
            <th className="py-2 pr-3 text-right">Worst fall</th>
            <th className="py-2 pr-3 text-right">1st half</th>
            <th className="py-2 pr-3 text-right">2nd half</th>
            <th className="py-2 text-right">Edge 1st / 2nd</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className={`border-t border-zinc-100 dark:border-zinc-800 ${l.id === highlight ? 'bg-sky-50 font-medium dark:bg-sky-950/30' : ''}`}>
              <td className="py-2 pr-3">{l.label}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pl(l.cagr, 1)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pl(l.maxDD)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pl(l.halves[0], 1)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pl(l.halves[1], 1)}</td>
              <td className="py-2 text-right tabular-nums">
                {l.edge == null ? (
                  '–'
                ) : (
                  <>
                    <span className={tone(l.edge[0])}>{l.edge[0].toFixed(1)}</span> / <span className={tone(l.edge[1])}>{l.edge[1].toFixed(1)}</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniTable({ rows }: { rows: ForeignRow[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => (
          <tr key={r.ticker} className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
            <td className="py-1.5 pr-2">
              <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.name}</span> <span className="font-mono text-xs text-zinc-400">{r.ticker}</span>
              <div className="text-xs text-zinc-500">{r.country}</div>
            </td>
            <td className={`py-1.5 pr-2 text-right tabular-nums ${tone(r.ret12mUsd)}`}>{pc(r.ret12mUsd)}</td>
            <td className="py-1.5 text-right">{r.vetoed ? <Badge tone="red">not now</Badge> : <Badge tone="green">{r.score.toFixed(0)}</Badge>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Glossary() {
  const items: [string, string][] = [
    ['Momentum (the score)', 'How strongly a stock has risen over the past 6 and 12 months, leaving out the last month and adjusting for how much it swings, compared with others in its sector. Stocks that were strong have tended to keep outperforming for some months; in our test that added about 1–3 points a year.'],
    ['200-day average', 'The average closing price over about ten months. Below it, a stock is in a downtrend and is not recommended.'],
    ['Buy zone', 'From today’s price down to one typical monthly dip for this stock (about 1.75× its average daily range). Buying in steps inside it means a normal dip does not catch you all at once.'],
    ['Review level', 'Top picks: the higher of the 200-day average and 3× the daily range below the price. Bouncing back: the 20-day low less 4%. Never more than 25% below the price.'],
    ['Targets: 1 month, 6 months, 1 year', 'For each top pick: what past top picks (2012–2026) did over that period, applied to this stock’s price and swings. The middle figure is the typical outcome; the range held about half of past outcomes. Checked on years the fit had not seen: slightly optimistic, and the 1-year range is narrower than reality.'],
    ['6-month range', 'Price moved up and down by one standard deviation of its own swings over 6 months. Across 21,000 past cases about 70% of outcomes landed inside. It is a range, not a target.'],
    ['Grades A / B / C', 'How much evidence stands behind that KIND of reason. A: tested on this data. B: published research. C: weak, faded, or untested here; shown for reading only.'],
    ['Weak finances ⚑', 'In the weakest 20% of the list on profit for its size, cash from operations, profit backed by cash, debt, and how stable profits have been. In our tests these stocks were not worse on return but fell harder.'],
    ['Analysts’ target', 'The average 12-month price target of the analysts who cover the stock (from Nasdaq). Targets are optimistic on average, and no free source keeps their history, so their track record is not shown. Read them as opinion.'],
    ['SEC filing (8-K)', 'A US company must file an 8-K within days of a major event. Red items (bankruptcy, debt default, delisting notice, accounts that can no longer be relied on) hold new money back.'],
    ['Headline tone', 'A count of positive and negative words in headlines that name the company, −1 to +1. A pointer to what to read, not a forecast.'],
    ['1 year ($) vs 1 year (₹)', 'The dollar return, and the same return after the dollar’s move against the rupee. You earn the rupee figure.'],
    ['LRS and TCS', 'LRS lets you send up to $250,000 a year abroad. Tax is collected at source (20%) on investment remittances above ₹10 lakh a year; you claim it back when you file.'],
  ];
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950" aria-label="What these words mean">
      <details>
        <summary className="cursor-pointer text-lg font-semibold text-zinc-900 dark:text-zinc-50">What do these words mean? (in simple language)</summary>
        <dl className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map(([t, p]) => (
            <div key={t} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
              <dt className="font-semibold text-zinc-900 dark:text-zinc-50">{t}</dt>
              <dd className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{p}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

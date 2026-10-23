'use client';

/**
 * Global Markets — which countries' stock markets are strongest for an Indian
 * investor (measured in rupees), the leading companies inside them, how to
 * reach them from India, and what 21 years of history say about following such
 * a ranking. See BE/src/services/global for the method.
 */
import { useState } from 'react';
import { Badge, Card, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import type { GlobalEtfPremium, GlobalMarketRow, GlobalMarkets, GlobalStockRow, GlobalStrategy } from '../lib/types';
import { usePolling } from '../lib/usePolling';

const pc = (x: number | null | undefined, dp = 0): string => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(dp)}%`);
const pl = (x: number | null | undefined, dp = 0): string => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`);
const tone = (x: number | null | undefined): string =>
  x == null ? 'text-zinc-400' : x >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

function isReady(d: unknown): d is GlobalMarkets {
  return !!d && typeof d === 'object' && 'markets' in d;
}

export default function GlobalMarketsPage() {
  const poll = usePolling(() => api.globalMarkets(), 120_000);
  const [busy, setBusy] = useState(false);
  const d = poll.data;
  return (
    <div>
      <PageHeader
        title="Global Markets"
        subtitle="Which countries' stock markets are strongest for an Indian investor, measured in rupees. Past strength, not a forecast."
        action={
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.refreshGlobalMarkets();
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
      {poll.error && <p className="mb-4 text-sm text-rose-600">Could not load Global Markets: {poll.error}</p>}
      {!isReady(d) ? (
        <Card>
          <p className="text-sm text-zinc-500">
            {d && 'status' in d && d.status.lastError
              ? `The first read failed: ${d.status.lastError}`
              : 'Loading 20+ years of history for 25 markets, their currencies and about 130 companies. The first load takes a minute or two.'}
          </p>
        </Card>
      ) : (
        <View d={d} />
      )}
    </div>
  );
}

function View({ d }: { d: GlobalMarkets }) {
  const byCode = new Map(d.markets.map((m) => [m.code, m] as const));
  const strongest = d.strongest.map((c) => byCode.get(c)).filter((m): m is GlobalMarketRow => !!m);
  const st = (id: string) => d.backtest.strategies.find((s) => s.id === id);
  const india = st('india');
  const mix = st('in70us30');
  const top3 = st('top3');
  const ew = st('equalWeight');
  const indiaRow = byCode.get('IN');
  return (
    <div className="space-y-6">
      {/* The short answer */}
      <section className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-5 dark:border-sky-800 dark:bg-sky-950/30" aria-label="The short answer">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">The short answer · data to {d.asOf}</div>
        <ul className="mt-3 space-y-3 text-sm text-zinc-800 dark:text-zinc-100">
          <li>
            <b>Strongest markets right now, in rupees:</b> {strongest.map((m) => `${m.name} (${pc(m.inr?.ret12m)} in a year)`).join(', ')}.{' '}
            {indiaRow?.inr && <>India over the same year: {pc(indiaRow.inr.ret12m)}.</>}
          </li>
          {top3 && ew && (
            <li>
              <b>Should you just buy whichever markets are strongest?</b>{' '}
              {d.backtest.rankingWorked
                ? 'In our test since 2005, buying the top-ranked markets each month beat holding all of them equally in both halves of the period.'
                : `In our test since ${d.backtest.from.slice(0, 4)}, no. Buying the top 3 markets each month returned ${pl(top3.cagr, 1)} a year, against ${pl(ew.cagr, 1)} for simply holding all ${ew.label.match(/\d+/)?.[0] ?? ''} foreign markets equally, with a worse fall (${pl(top3.maxDD)} against ${pl(ew.maxDD)}). Chasing last year\u2019s winners has not paid for a rupee investor.`}
            </li>
          )}
          {india && mix && (
            <li>
              <b>What has helped: keeping part of your money abroad.</b> 70% India and 30% in the US S&amp;P 500 returned {pl(mix.cagr, 1)} a year since{' '}
              {d.backtest.from.slice(0, 4)}, against {pl(india.cagr, 1)} for India alone. Its worst fall was {pl(mix.maxDD)} against {pl(india.maxDD)}. It did worse than India in the
              first half ({pl(mix.halves[0], 1)} vs {pl(india.halves[0], 1)}) and better in the second ({pl(mix.halves[1], 1)} vs {pl(india.halves[1], 1)}). Diversifying buys a
              steadier ride, not guaranteed extra return.
            </li>
          )}
        </ul>
        <p className="mt-3 text-xs text-zinc-500">
          Past performance only. Index prices exclude dividends. For your own use; this is not advice from a SEBI-registered adviser.
        </p>
      </section>

      {/* Strongest markets */}
      <section aria-label="Strongest markets">
        <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">Strongest markets now, and their leading companies</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {strongest.map((m) => (
            <MarketCard key={m.code} m={m} leaders={d.leaders[m.code] ?? []} etfs={d.etfs} />
          ))}
        </div>
      </section>

      {/* ETF premiums */}
      <Card title="India-listed international ETFs: what you pay vs what they hold">
        <p className="mb-3 text-xs text-zinc-500">
          Indian funds have hit their overseas investment limits, so these ETFs cannot create new units and trade above the value of their holdings (the NAV). A premium of
          50% means paying ₹150 for ₹100 of foreign shares; if the premium disappears (SEBI restores a NAV-based price band from 1 April 2027), you lose that part even if the
          shares do not move. Price from NSE, NAV from AMFI.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3">ETF</th>
                <th className="py-2 pr-3 text-right">NSE price</th>
                <th className="py-2 pr-3 text-right">Value of holdings (NAV)</th>
                <th className="py-2 pr-3 text-right">You pay extra</th>
                <th className="py-2 pr-3">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {d.etfs.map((e) => (
                <tr key={e.symbol} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-3">
                    <span className="font-medium text-zinc-800 dark:text-zinc-100">{e.name}</span>
                    <span className="ml-1 font-mono text-xs text-zinc-400">{e.symbol}</span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {e.price == null ? '–' : `₹${e.price.toFixed(2)}`} <span className="text-xs text-zinc-400">{e.priceDate?.slice(5)}</span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {e.nav == null ? '–' : `₹${e.nav.toFixed(2)}`} <span className="text-xs text-zinc-400">{e.navDate?.slice(0, 6)}</span>
                  </td>
                  <td className={`py-2 pr-3 text-right font-semibold tabular-nums ${premiumTone(e.premium)}`}>{pc(e.premium, 1)}</td>
                  <td className="py-2 pr-3 text-xs">{premiumVerdict(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-4 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          {d.facts.map((f) => (
            <li key={f}>• {f}</li>
          ))}
        </ul>
      </Card>

      {/* Global leaders */}
      <Card title="The strongest of the world's biggest companies, in rupees">
        <p className="mb-3 text-xs text-zinc-500">
          Ranked together on the same momentum score, from a hand-picked list of each market&apos;s largest companies (today&apos;s giants, so yesterday&apos;s losers are missing).
          Only companies in an uptrend are shown. Strong stocks have tended to stay strong for a while, but single stocks are far riskier than a whole market.
        </p>
        <StockTable rows={d.globalLeaders} showCountry />
      </Card>

      {/* All markets */}
      <Card title="Every market, ranked">
        <p className="mb-3 text-xs text-zinc-500">
          All returns are in rupees: the market&apos;s own move plus what its currency did against the rupee. &quot;In local currency&quot; shows the market&apos;s own move. The
          score ranks risk-adjusted 6- and 12-month momentum, leaving out the last month. &quot;Moves with India&quot; is the correlation of monthly returns over 5 years: lower
          means it spreads your risk better.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3 text-right">1 month</th>
                <th className="py-2 pr-3 text-right">6 months</th>
                <th className="py-2 pr-3 text-right">1 year</th>
                <th className="py-2 pr-3 text-right">1 year, local currency</th>
                <th className="py-2 pr-3 text-right">3 yr / yr</th>
                <th className="py-2 pr-3 text-right">5 yr / yr</th>
                <th className="py-2 pr-3 text-right">Swings / yr</th>
                <th className="py-2 pr-3 text-right">Worst fall, 3 yr</th>
                <th className="py-2 pr-3">Trend</th>
                <th className="py-2 pr-3 text-right">Moves with India</th>
              </tr>
            </thead>
            <tbody>
              {d.markets.map((m) => (
                <tr key={m.code} className={`border-t border-zinc-100 dark:border-zinc-800 ${m.code === 'IN' ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}`}>
                  <td className="py-2 pr-2 tabular-nums text-zinc-400">{m.rank ?? '–'}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">{m.name}</div>
                    <div className="text-xs text-zinc-500">
                      {m.indexName} · {m.currency}
                    </div>
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${tone(m.inr?.ret1m)}`}>{pc(m.inr?.ret1m, 1)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${tone(m.inr?.ret6m)}`}>{pc(m.inr?.ret6m)}</td>
                  <td className={`py-2 pr-3 text-right font-semibold tabular-nums ${tone(m.inr?.ret12m)}`}>{pc(m.inr?.ret12m)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">{pc(m.local12m)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pc(m.inr?.cagr3y)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pc(m.inr?.cagr5y)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pl(m.inr?.vol1y)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pl(m.inr?.maxDD3y)}</td>
                  <td className="py-2 pr-3">{m.inr?.uptrend ? <Badge tone="green">up</Badge> : <Badge tone="red">down</Badge>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.corrWithIndia == null ? '–' : m.corrWithIndia.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Backtest */}
      <Card title={`Does following this pay? Monthly test, ${d.backtest.from} to ${d.backtest.to}, in rupees`}>
        <p className="mb-3 text-xs text-zinc-500">
          Each month the markets were ranked using only data up to that month, and the chosen ones were held for the next month, with 0.3% cost for every switch. The period
          is split at {d.backtest.split}: an idea has to work in both halves to count. Edge is the yearly return minus holding all foreign markets equally.
        </p>
        <Curves strategies={['india', 'in70us30', 'us', 'equalWeight', 'top3'].map(st).filter((s): s is GlobalStrategy => !!s)} />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3">Approach</th>
                <th className="py-2 pr-3 text-right">Return / yr</th>
                <th className="py-2 pr-3 text-right">Worst fall</th>
                <th className="py-2 pr-3 text-right">1st half</th>
                <th className="py-2 pr-3 text-right">2nd half</th>
                <th className="py-2 pr-3 text-right">Edge 1st / 2nd</th>
              </tr>
            </thead>
            <tbody>
              {d.backtest.strategies.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-3">{s.label}</td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums">{pl(s.cagr, 1)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pl(s.maxDD)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pl(s.halves[0], 1)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pl(s.halves[1], 1)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {s.id === 'equalWeight' ? '–' : (
                      <>
                        <span className={tone(s.edgeHalves[0])}>{s.edgeHalves[0] >= 0 ? '+' : ''}{s.edgeHalves[0].toFixed(1)}</span> /{' '}
                        <span className={tone(s.edgeHalves[1])}>{s.edgeHalves[1] >= 0 ? '+' : ''}{s.edgeHalves[1].toFixed(1)}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Glossary d={d} />

      <p className="text-xs text-zinc-500">
        Updated {dateTime(d.computedAt)} from Yahoo daily prices ({d.health.tickers} series{d.health.failed.length ? `, unavailable: ${d.health.failed.join(', ')}` : ''}).
        Thailand and Saudi Arabia are left out because Yahoo has no index history for them.
      </p>
    </div>
  );
}

function premiumTone(p: number | null): string {
  if (p == null) return 'text-zinc-400';
  if (p <= 0.03) return 'text-emerald-600 dark:text-emerald-400';
  if (p <= 0.1) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function premiumVerdict(e: GlobalEtfPremium): string {
  if (e.premium == null) return 'No price or NAV today.';
  if (e.premium <= 0.03) return 'Close to fair value.';
  if (e.premium <= 0.1) return 'Small premium: you overpay a little.';
  return `Overpriced: about ₹${Math.round(100 * (1 + e.premium))} for every ₹100 of holdings. Avoid buying at this premium.`;
}

function MarketCard({ m, leaders, etfs }: { m: GlobalMarketRow; leaders: GlobalStockRow[]; etfs: GlobalEtfPremium[] }) {
  const etfBy = new Map(etfs.map((e) => [e.symbol, e] as const));
  const star = leaders[0]?.inr?.ret12m != null ? [...leaders].sort((a, b) => (b.inr?.ret12m ?? -9) - (a.inr?.ret12m ?? -9))[0] : null;
  const concentrated =
    star?.inr?.ret12m != null && m.inr?.ret12m != null && star.inr.ret12m > 1 && star.inr.ret12m > 2.5 * Math.max(0.05, m.inr.ret12m);
  const fxEffect = m.inr?.ret12m != null && m.local12m != null ? (1 + m.inr.ret12m) / (1 + m.local12m) - 1 : null;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{m.code}</span>
          <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{m.name}</span>
          <span className="ml-2 text-xs text-zinc-500">#{m.rank} · {m.indexName}</span>
        </div>
        {m.inr?.uptrend && <Badge tone="green">uptrend</Badge>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Mini label="1 year" value={pc(m.inr?.ret12m)} cls={tone(m.inr?.ret12m)} />
        <Mini label="6 months" value={pc(m.inr?.ret6m)} cls={tone(m.inr?.ret6m)} />
        <Mini label="3 yr, per year" value={pc(m.inr?.cagr3y)} cls={tone(m.inr?.cagr3y)} />
      </div>
      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        In {m.currency} the market moved {pc(m.local12m)} in a year;{' '}
        {fxEffect == null ? '' : fxEffect >= 0 ? `the ${m.currency} also rose ${pc(fxEffect)} against the rupee` : `the ${m.currency} fell ${pc(-fxEffect).replace('+', '')} against the rupee`}
        , so a rupee investor got {pc(m.inr?.ret12m)}. Swings: {pl(m.inr?.vol1y)} a year · worst fall in 3 years {pl(m.inr?.maxDD3y)} · moves with India {m.corrWithIndia?.toFixed(2) ?? '–'}.
      </p>
      {concentrated && star && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Much of this rise comes from a few companies ({star.name} {pc(star.inr?.ret12m)} in a year). Buying the market is partly a bet on them.
        </p>
      )}
      {leaders.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Leading companies, ranked inside this market</div>
          <StockTable rows={leaders.slice(0, 3)} />
        </div>
      )}
      {m.access && (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
          <div className="font-semibold text-zinc-700 dark:text-zinc-200">How to invest from India</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">{m.access.summary}</p>
          {m.access.instruments.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {m.access.instruments.map((i) => (
                <li key={i.name} className="text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">{i.name}</span>
                  {i.symbol && <span className="ml-1 font-mono">({i.symbol})</span>} · {i.how === 'nse-etf' ? 'ETF on NSE, via your Zerodha account' : i.how === 'india-fof' ? 'Indian mutual fund (fund of funds)' : 'direct, via LRS'}
                  {i.how === 'nse-etf' && i.symbol && etfBy.get(i.symbol)?.premium != null && (
                    <span className={`font-semibold ${premiumTone(etfBy.get(i.symbol)!.premium)}`}> · premium {pc(etfBy.get(i.symbol)!.premium, 0)}</span>
                  )}
                  {i.note && <span className="text-amber-700 dark:text-amber-400"> · {i.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-900">
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function StockTable({ rows, showCountry = false }: { rows: GlobalStockRow[]; showCountry?: boolean }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">No company in an uptrend from this list today.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="py-1.5 pr-3">Company</th>
            {showCountry && <th className="py-1.5 pr-3">Market</th>}
            <th className="py-1.5 pr-3 text-right">1 year</th>
            <th className="py-1.5 pr-3 text-right">6 months</th>
            <th className="py-1.5 pr-3 text-right">Swings / yr</th>
            <th className="py-1.5 pr-3">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-1.5 pr-3">
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.name}</span>
                <span className="ml-1 font-mono text-xs text-zinc-400">{r.ticker}</span>
              </td>
              {showCountry && <td className="py-1.5 pr-3 text-zinc-500">{r.countryName}</td>}
              <td className={`py-1.5 pr-3 text-right font-semibold tabular-nums ${tone(r.inr?.ret12m)}`}>{pc(r.inr?.ret12m)}</td>
              <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(r.inr?.ret6m)}`}>{pc(r.inr?.ret6m)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{pl(r.inr?.vol1y)}</td>
              <td className="py-1.5 pr-3">{r.inr?.uptrend ? <Badge tone="green">up</Badge> : <Badge tone="red">down</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CURVE_COLORS: Record<string, string> = {
  india: '#d97706',
  in70us30: '#2a78d6',
  us: '#1baf7a',
  equalWeight: '#71717a',
  top3: '#e34948',
};

/** Growth of ₹1 for a few approaches, on a log scale so early and late years read fairly. */
function Curves({ strategies }: { strategies: GlobalStrategy[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!strategies.length) return null;
  const W = 900;
  const H = 260;
  const L = 44;
  const R = 12;
  const T = 12;
  const B = 28;
  const n = Math.max(...strategies.map((s) => s.curve.length));
  const all = strategies.flatMap((s) => s.curve.map((p) => p.value));
  const lo = Math.log(Math.min(...all));
  const hi = Math.log(Math.max(...all));
  const x = (k: number) => L + ((W - L - R) * k) / Math.max(1, n - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (Math.log(v) - lo) / Math.max(1e-9, hi - lo));
  const ticks = [1, 2, 4, 8, 16].filter((v) => Math.log(v) >= lo - 0.01 && Math.log(v) <= hi + 0.01);
  const months = strategies[0].curve.map((p) => p.month);
  const years = months.map((m, k) => ({ m, k })).filter((o, k) => k === 0 || o.m.slice(0, 4) !== months[k - 1].slice(0, 4)).filter((o) => Number(o.m.slice(0, 4)) % 4 === 0);
  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-zinc-600 dark:text-zinc-300">
        {strategies.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: CURVE_COLORS[s.id] ?? '#888' }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Growth of one rupee for each approach"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-zinc-200 dark:stroke-zinc-800" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-zinc-500 text-[11px]">
              ₹{v}
            </text>
          </g>
        ))}
        {years.map((o) => (
          <text key={o.m} x={x(o.k)} y={H - 8} textAnchor="middle" className="fill-zinc-500 text-[11px]">
            {o.m.slice(0, 4)}
          </text>
        ))}
        {strategies.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke={CURVE_COLORS[s.id] ?? '#888'}
            strokeWidth={s.id === 'in70us30' || s.id === 'india' ? 2.25 : 1.5}
            points={s.curve.map((p, k) => `${x(k).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
          />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-zinc-400" strokeDasharray="3 3" />}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute right-2 top-8 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white shadow dark:bg-zinc-100 dark:text-zinc-900">
          <div className="font-semibold">{months[hover]}</div>
          {strategies.map((s) => (
            <div key={s.id}>
              {s.label.split(',')[0]}: ₹{s.curve[hover]?.value.toFixed(2) ?? '–'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Glossary({ d }: { d: GlobalMarkets }) {
  const top = d.markets.find((m) => m.code === d.strongest[0]);
  const items: { term: string; plain: string; example: string }[] = [
    {
      term: 'Return in rupees',
      plain: 'What you actually earn as an Indian investor: the foreign market\'s own move, plus or minus what its currency did against the rupee.',
      example: top?.inr && top.local12m != null ? `${top.name}: ${pc(top.local12m)} in ${top.currency}, ${pc(top.inr.ret12m)} in rupees over the last year.` : 'Shown for each market above.',
    },
    {
      term: 'Momentum score',
      plain: 'How strong a market has been over the past 6 and 12 months, leaving out the last month and adjusting for how much it swings. Markets that were strong have often stayed strong for a while, but in our rupee test, picking the top few did not beat owning them all.',
      example: top ? `${top.name} ranks #${top.rank} today.` : '',
    },
    {
      term: 'Uptrend',
      plain: 'The price (in rupees) is above its average of the last 200 trading days, about ten months.',
      example: `${d.markets.filter((m) => m.inr?.uptrend).length} of ${d.markets.length} markets are in an uptrend today.`,
    },
    {
      term: 'Moves with India (correlation)',
      plain: 'From −1 to +1: how closely a market\'s monthly returns have followed India\'s over 5 years. Near 1 means it rises and falls with India; near 0 means it does its own thing, which is what spreads your risk.',
      example: (() => {
        const low = [...d.markets].filter((m) => m.corrWithIndia != null).sort((a, b) => a.corrWithIndia! - b.corrWithIndia!)[0];
        return low ? `Lowest today: ${low.name} at ${low.corrWithIndia!.toFixed(2)}.` : '';
      })(),
    },
    {
      term: 'Per year (CAGR)',
      plain: 'The steady yearly growth rate that would turn the starting value into the ending value.',
      example: '₹1 lakh at 12% a year for 5 years becomes about ₹1.76 lakh.',
    },
    {
      term: 'Worst fall',
      plain: 'The biggest drop from a high to a later low in the period. It tells you how painful holding it could have been.',
      example: 'A worst fall of −30% means ₹1 lakh would at some point have shown as ₹70,000.',
    },
    {
      term: 'Swings per year (volatility)',
      plain: 'How much prices typically move around in a year. Higher means a bumpier ride.',
      example: 'Around 15% is typical for a big, mature market; 30% or more is a wild ride.',
    },
    {
      term: 'ETF on NSE',
      plain: 'A fund that tracks a foreign index and trades on NSE like a share, so you can buy it with your Zerodha account in rupees, no foreign account needed.',
      example: 'Check its premium before buying: when Indian funds hit their overseas investment limits, some of these ETFs trade well above the value of what they hold.',
    },
    {
      term: 'LRS (Liberalised Remittance Scheme)',
      plain: 'The RBI rule that lets a resident Indian send up to $250,000 a year abroad, which is how you would buy foreign shares directly through an overseas broker or an app that partners with one.',
      example: 'Tax is collected at source (TCS) above the yearly threshold on such remittances; you can claim it back when you file your return.',
    },
  ];
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950" aria-label="What these words mean">
      <details open>
        <summary className="cursor-pointer text-lg font-semibold text-zinc-900 dark:text-zinc-50">What do these words mean? (in simple language)</summary>
        <dl className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((it) => (
            <div key={it.term} className="min-w-0 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
              <dt className="font-semibold text-zinc-900 dark:text-zinc-50">{it.term}</dt>
              <dd className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{it.plain}</dd>
              {it.example && (
                <dd className="mt-1 text-sm text-sky-700 dark:text-sky-300">
                  <span className="font-medium">Example: </span>
                  {it.example}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

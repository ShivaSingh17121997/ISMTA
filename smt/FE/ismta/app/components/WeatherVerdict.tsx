'use client';

/**
 * The top of the Market Weather page: one clear answer (invest / invest in
 * steps / hold new money), the stock-by-stock lists, and the plain-language
 * glossary. Written for someone who has never heard the terms — every term is
 * explained with today's real numbers as the example.
 *
 * There is deliberately no "sell" answer and no blanket "do not invest": both
 * lost money when tested (MARKET_WEATHER.md). The backend only returns HOLD
 * when the one sign that passed the test is on.
 */
import { useState } from 'react';
import type { MarketWeather, WeatherStockCall, WeatherVerdict } from '../lib/types';

const ACTION_STYLE: Record<WeatherVerdict['action'], { box: string; badge: string; icon: string; label: string }> = {
  invest: {
    box: 'border-emerald-400 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40',
    badge: 'bg-emerald-600 text-white',
    icon: '✅',
    label: 'Invest',
  },
  'invest-in-steps': {
    box: 'border-sky-400 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40',
    badge: 'bg-sky-600 text-white',
    icon: '📶',
    label: 'Invest in steps',
  },
  hold: {
    box: 'border-orange-400 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/40',
    badge: 'bg-orange-600 text-white',
    icon: '✋',
    label: 'Hold new money',
  },
};

const STEPS: { key: WeatherVerdict['action']; label: string; plain: string }[] = [
  { key: 'invest', label: 'Invest', plain: 'normal plan' },
  { key: 'invest-in-steps', label: 'Invest in steps', plain: 'split your money' },
  { key: 'hold', label: 'Hold new money', plain: 'keep shares, pause new buying' },
];

/** The turbulence and calm signs as chips, so the reason the step size changed is visible at a glance. */
export function NextMonthStrip({ d }: { d: MarketWeather }) {
  const rows = d.signals.filter((g) => g.kind !== 'warning' && g.grade !== 'C');
  if (!rows.length) return null;
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950" aria-label="Next month">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">The next month: how big the buying steps should be</h2>
        <span className="text-xs text-zinc-500">
          {d.verdict.steps === 'smaller' ? 'Smaller steps: rough weeks likely' : d.verdict.steps === 'front-loaded' ? 'Bigger first step: fear priced high' : 'Normal step size'}
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {rows.map((g) => (
          <li
            key={g.id}
            title={g.reason}
            className={`rounded-full border px-3 py-1 text-xs ${
              g.on
                ? g.kind === 'calm'
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'
            }`}
          >
            {g.on ? (g.kind === 'calm' ? '● ' : '▲ ') : '○ '}
            {g.label}
            {g.on == null ? ' (no data)' : g.on ? ' — on' : ' — off'}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function VerdictPanel({ v, asOf }: { v: WeatherVerdict; asOf: string }) {
  const st = ACTION_STYLE[v.action];
  return (
    <section className={`rounded-2xl border-2 p-5 sm:p-6 ${st.box}`} aria-label="What to do now">
      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">What to do now · market data to {asOf}</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-3xl">
          {st.icon}
        </span>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl dark:text-zinc-50">{v.title}</h2>
      </div>
      <p className="mt-2 text-base font-medium text-zinc-800 dark:text-zinc-100">{v.oneLine}</p>

      {/* The scale, so the reader sees where today sits among the three answers. */}
      <ol className="mt-4 grid grid-cols-3 gap-2 text-center text-xs" aria-label="The three possible answers">
        {STEPS.map((s) => {
          const on = s.key === v.action;
          return (
            <li
              key={s.key}
              aria-current={on ? 'true' : undefined}
              className={`rounded-lg border px-2 py-2 ${on ? `${ACTION_STYLE[s.key].badge} border-transparent font-semibold` : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'}`}
            >
              <div>{s.label}</div>
              <div className={on ? 'opacity-90' : 'opacity-70'}>{s.plain}</div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 rounded-xl bg-white/70 p-4 text-sm text-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">For example</div>
        {v.example}
      </div>

      <div className="mt-4">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Why</div>
        <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-200">
          {v.why.map((w) => (
            <li key={w} className="flex gap-2">
              <span aria-hidden className="text-zinc-400">
                •
              </span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        {v.never} This is a reading of past data, not a guarantee, and not advice from a registered adviser.
      </p>
    </section>
  );
}

function StockRow({ c, side }: { c: WeatherStockCall; side: 'careful' | 'resilient' }) {
  const [open, setOpen] = useState(false);
  const top = c.tags.filter((t) => (side === 'careful' ? t.points > 0 : t.points < 0));
  const other = c.tags.filter((t) => !top.includes(t));
  return (
    <li className="border-t border-zinc-100 py-2.5 first:border-t-0 dark:border-zinc-800">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">{c.symbol}</span>
          {c.held && <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">you own this</span>}
          <span className="block text-xs text-zinc-500">{c.sector}</span>
          <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-300">{shortReason(top[0]?.text ?? c.tags[0]?.text ?? '')}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-zinc-500">
          <span className="block tabular-nums text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {c.ifIndexMinus10Pct == null ? '–' : `${c.ifIndexMinus10Pct.toFixed(0)}%`}
          </span>
          if NIFTY −10%
          <span className="mt-0.5 block text-blue-600 dark:text-blue-400">{open ? 'Hide reasons' : 'Why?'}</span>
        </span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
          {[...top, ...other].map((t) => (
            <li key={t.text} className="flex gap-2">
              <span aria-hidden className={t.points > 0 ? 'text-rose-500' : 'text-emerald-500'}>
                {t.points > 0 ? '▲' : '▼'}
              </span>
              <span className="text-zinc-700 dark:text-zinc-300">
                {t.text} <span className="text-zinc-400">({t.points > 0 ? `+${t.points}` : t.points} risk)</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The first sentence of a tag, for the one-line summary under the stock name. */
function shortReason(t: string): string {
  const i = t.indexOf('. ');
  return i > 0 ? t.slice(0, i + 1) : t;
}

export function StockLists({ d }: { d: MarketWeather }) {
  const s = d.stocks;
  if (!s) return null;
  return (
    <section aria-label="Stock by stock">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Stock by stock, in today&apos;s conditions</h2>
        <span className="text-xs text-zinc-500">
          {s.scored} liquid NSE stocks plus your holdings
          {s.activeEvents.length ? ` · today's news types: ${s.activeEvents.map((e) => e.replace(/-/g, ' ')).join(', ')}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-rose-200 bg-white p-4 dark:border-rose-900/60 dark:bg-zinc-950">
          <h3 className="font-semibold text-rose-700 dark:text-rose-400">⚠️ Be careful with these now</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Wait before adding new money to these. They have tended to fall harder when the market falls, are in weak trends, or are hit by today&apos;s kind of news. If you
            already own one, this is not a reason to sell at a loss.
          </p>
          {s.careful.length ? (
            <ul className="mt-2">
              {s.careful.map((c) => (
                <StockRow key={c.symbol} c={c} side="careful" />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">No stock collects enough warning points today.</p>
          )}
        </div>
        <div className="rounded-xl border border-emerald-200 bg-white p-4 dark:border-emerald-900/60 dark:bg-zinc-950">
          <h3 className="font-semibold text-emerald-700 dark:text-emerald-400">🛡️ Have tended to hold up better</h3>
          <p className="mt-1 text-xs text-zinc-500">
            These have usually fallen less when the market fell, are in strong trends, or have benefited from today&apos;s kind of news. They can still fall, just usually
            less. They also tend to lag when the market bounces back.
          </p>
          {s.resilient.length ? (
            <ul className="mt-2">
              {s.resilient.map((c) => (
                <StockRow key={c.symbol} c={c} side="resilient" />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">No stock stands out as resilient today.</p>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Each stock gets points for things that have mattered in the past. It gains points if it falls harder than the market, is in a weak 12-month trend, is below its 200-day
        average, belongs to a sector that did badly in past falls, is usually hit by today&apos;s news, or is on NSE&apos;s surveillance list. Doing the opposite takes points away.
        Tap a stock to see its reasons. The lists show past behaviour; they do not predict any single stock.
      </p>
    </section>
  );
}

const fmt = (n: number, dp = 0) => n.toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: dp });

export function Glossary({ d }: { d: MarketWeather }) {
  const s = d.state;
  const high = s.close / (1 + s.fromAthPct / 100);
  const avg200 = s.vs200Pct == null ? null : s.close / (1 + s.vs200Pct / 100);
  const flow = d.escalation.flows[d.escalation.flows.length - 1];
  const steady = d.stocks?.resilient[0];
  const jumpy = d.stocks?.careful[0];
  const items: { term: string; plain: string; example: string }[] = [
    {
      term: 'Correction and bear market',
      plain: 'How far the market has fallen from its highest point. A fall of 10–20% is called a correction, more than 20% a bear market.',
      example: `NIFTY's high was about ${fmt(high)}. Today it is ${fmt(s.close)}, which is ${Math.abs(s.fromAthPct).toFixed(1)}% lower, so it is in a ${s.phase === 'bear' ? 'bear market' : s.phase === 'correction' ? 'correction' : s.phase}.`,
    },
    {
      term: '200-day average',
      plain: 'The average closing price of the last 200 trading days, about ten months. When the price is below it, the long-term trend is down.',
      example:
        avg200 == null
          ? 'Not available today.'
          : `NIFTY's 200-day average is about ${fmt(avg200)}. Today's ${fmt(s.close)} is ${Math.abs(s.vs200Pct!).toFixed(1)}% ${s.vs200Pct! < 0 ? 'below' : 'above'} it.`,
    },
    {
      term: '50-day below the 200-day ("death cross")',
      plain: 'The last ten weeks have been weaker than the last ten months. It is a sign of a downtrend, not a prediction.',
      example: s.deathCross ? 'This is the case today.' : 'This is not the case today.',
    },
    {
      term: 'Breadth',
      plain: 'Out of the 500 biggest NSE stocks, the share that are in their own uptrend (above their 200-day average). It shows whether the whole market is healthy or only a few big names are.',
      example: s.breadthPct == null ? 'Not available today.' : `Today ${Math.round(s.breadthPct)}% are. That is roughly ${Math.round(s.breadthPct / 10)} in every 10 stocks.`,
    },
    {
      term: 'Index near its high while most stocks are not',
      plain: 'The one warning sign that came before falls in both halves of 28 years of history. The index looks fine because a few heavyweights carry it, while most stocks have already started falling.',
      example: d.signals.find((x) => x.id === 'breadthDivergence')?.on ? 'It is ON today, so the answer above is Hold.' : 'It is off today.',
    },
    {
      term: 'India VIX (the fear gauge)',
      plain: 'How big a daily move traders expect over the next month. Under about 15 is calm; above 25 is fearful. A sudden 30% jump in a week means fear is rising fast.',
      example: s.indiaVix == null ? 'Not available today.' : `Today it is ${s.indiaVix.toFixed(1)}, which is ${s.indiaVix < 15 ? 'calm' : s.indiaVix < 25 ? 'somewhat nervous' : 'fearful'}.`,
    },
    {
      term: 'Brent crude',
      plain: 'The world price of a barrel of oil. India imports most of its oil, so a high price raises costs for fuel sellers, airlines and paint makers, and pushes up inflation.',
      example: s.brent == null ? 'Not available today.' : `Today it is $${s.brent.toFixed(0)}, and it has been above $90 for ${s.brentDaysAbove90} trading sessions.`,
    },
    {
      term: 'FII and DII',
      plain: 'FIIs are foreign investors. DIIs are Indian institutions such as mutual funds and insurers. "Net" means what they bought minus what they sold that day.',
      example: flow
        ? `On ${flow.date}, foreigners sold ₹${fmt(Math.abs(flow.fiiNet ?? 0))} crore more than they bought, and Indian institutions bought ₹${fmt(Math.abs(flow.diiNet ?? 0))} crore more than they sold.`
        : 'Not recorded yet.',
    },
    {
      term: 'PE and PB (valuation)',
      plain: 'PE is the price you pay for every ₹1 of a year\'s profit. PB is the price for every ₹1 of the company\'s net assets. Lower means cheaper. Cheapness has predicted good returns over 3–10 years, not next month.',
      example: d.valuation
        ? `NIFTY's PE is ${d.valuation.pe.toFixed(1)}: you pay ₹${d.valuation.pe.toFixed(0)} for every ₹1 of yearly profit. That is the cheapest since NSE changed how it counts profit in 2021.`
        : 'Not available today.',
    },
    {
      term: 'Down-day beta ("if NIFTY −10%")',
      plain: 'How much a stock has moved on the days NIFTY fell. 1.0 means it fell as much as the market, 1.5 means one and a half times as much, 0.5 means half.',
      example:
        steady && jumpy && steady.downBeta != null && jumpy.downBeta != null
          ? `If NIFTY falls 10%: ${jumpy.symbol} (beta ${jumpy.downBeta.toFixed(2)}) has typically fallen about ${Math.round(jumpy.downBeta * 10)}%, while ${steady.symbol} (beta ${steady.downBeta.toFixed(2)}) has fallen about ${Math.round(steady.downBeta * 10)}%.`
          : 'A stock with beta 1.3 has typically fallen about 13% when NIFTY fell 10%.',
    },
    {
      term: '12-month trend',
      plain: 'How much a stock rose or fell over the past year, leaving out the last month. Stocks that have been strong have tended to stay strong for a while, and weak ones to stay weak.',
      example: steady?.trend12m != null ? `${steady.symbol} is ${steady.trend12m >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(steady.trend12m * 100))}% on this measure.` : 'Shown per stock in the lists above.',
    },
    {
      term: 'Turbulence signs',
      plain: 'Signs that the next few weeks are likely to be bumpy (a 5%+ dip within a month), not that a big fall is coming. Examples: a bad month on Wall Street, fear jumping fast, NIFTY swinging much more than usual, or 1 in 10 stocks at a one-year low.',
      example: (() => {
        const on = d.signals.filter((g) => g.kind === 'turbulence' && g.on && g.grade !== 'C');
        return on.length ? `On today: ${on.map((g) => g.label.toLowerCase()).join('; ')}. So the steps are smaller.` : 'None is on today, so the step size is normal.';
      })(),
    },
    {
      term: 'Fear priced high (variance risk premium)',
      plain: 'India VIX is the size of swing traders are paying to protect against. When that is much bigger than the swings actually happening, fear is "expensive", and the months after have usually been good for buyers.',
      example: (() => {
        const g = d.signals.find((x) => x.id === 'vrpHigh');
        return g?.on ? 'It is on today, so the first buying step is bigger.' : 'It is off today.';
      })(),
    },
    {
      term: 'Advance–decline line',
      plain: 'A running count of how many stocks rose minus how many fell each day. If the index makes new highs while this line sinks, fewer and fewer stocks are carrying the rally.',
      example: d.signals.find((x) => x.id === 'adDivergence')?.on ? 'That divergence is on today.' : 'That divergence is off today (it can only fire near a high).',
    },
    {
      term: 'Dispersion ("stocks scattering")',
      plain: 'How far apart individual stocks returns are over a month. When some soar while others sink, the market is unsettled, and falls have followed more often.',
      example: d.signals.find((x) => x.id === 'dispersionHigh')?.on ? 'Stocks are scattering more than usual today.' : 'Stocks are moving fairly closely together today.',
    },
    {
      term: 'US yield curve',
      plain: 'The gap between the interest rate on 10-year and 3-month US government bonds. When short rates rise above long rates ("inverted") and then fall back, it has often come shortly before a US recession.',
      example: d.signals.find((x) => x.id === 'curveResteepen')?.on ? 'The curve has just turned normal after an inversion: a late-cycle warning.' : 'No re-steepening after an inversion today.',
    },
    {
      term: 'Since 2012 (the recent era)',
      plain: 'Before 2012 a 10% fall within 3 months followed about a third of all days; since 2012, about 1 in 11. The page shows both, because the calmer recent era is the fairer comparison for today.',
      example: `Full history ${Math.round((d.calibration.baseline.all.hitRate ?? 0) * 100)}%, since ${d.calibration.split.slice(0, 4)} ${Math.round((d.calibration.baseline.halves[1].hitRate ?? 0) * 100)}%.`,
    },
    {
      term: 'Investing in steps',
      plain: 'Splitting your money into parts and buying at different times or prices, instead of all at once. If prices fall further, your later parts buy cheaper; if they rise, you still have money working.',
      example: 'Investing ₹1,00,000 as four parts of ₹25,000 means a further 10% fall costs you much less than if you had put it all in on day one.',
    },
    {
      term: 'Hold new money',
      plain: 'Keep the shares you already own, but park fresh money (savings, or a liquid fund that earns about 6–7% a year) until the warning switches off.',
      example: 'Your SIP or new lump sum waits; nothing you own is sold.',
    },
    {
      term: 'Grade A / B / C and lift',
      plain: 'Each warning sign was tested on 1998–2011 and again on 2012–today. Lift 1.5× means 10% falls were 50% more likely than normal while the sign was on. A = more likely in both periods, many times. B = both periods, few times. C = failed one period, so ignore it.',
      example: `Normally a 10% fall followed within 3 months on ${Math.round((d.calibration.baseline.all.hitRate ?? 0) * 100)}% of days.`,
    },
    {
      term: 'Worst tenth of cases',
      plain: 'Line up all similar past situations from best to worst outcome and look at the bottom 10%. It shows how bad it got, not how bad it usually got.',
      example: d.analogs?.worstFurtherFallP10 != null ? `Here, the worst tenth saw a further fall of about ${Math.round(-d.analogs.worstFurtherFallP10 * 100)}%.` : 'Shown above when available.',
    },
    {
      term: 'NSE surveillance (ASM / GSM)',
      plain: 'Lists where the exchange puts stocks with unusual price jumps or weak finances, with extra trading restrictions. A stock on these lists is never shown as "holding up better".',
      example: 'ASM = Additional Surveillance Measure, GSM = Graded Surveillance Measure.',
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
              <dd className="mt-1 text-sm text-sky-700 dark:text-sky-300">
                <span className="font-medium">Today: </span>
                {it.example}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

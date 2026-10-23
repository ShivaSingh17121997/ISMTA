'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { DailyPnlCalendar } from '../components/DailyPnlCalendar';
import { LiveFeed } from '../components/LiveFeed';
import { PositionsTable } from '../components/PositionsTable';
import { StockModeTable } from '../components/StockModeTable';
import { TradesTable } from '../components/TradesTable';
import { Card, PageHeader } from '../components/ui';
import { FundsPanel } from '../components/FundsPanel';
import { SweepPanel } from '../components/SweepPanel';
import { AttentionStrip, type AttentionItem } from '../components/dashboard/AttentionStrip';
import { CapitalBar } from '../components/dashboard/CapitalBar';
import { BankedTile, EquityHero } from '../components/dashboard/EquityHero';
import { KpiRow, KpiTile } from '../components/dashboard/primitives';
import type { SparkPoint } from '../components/dashboard/Sparkline';
import { analyticsApi, api } from '../lib/api';
import { dayLabel, inr } from '../lib/format';
import { useNow } from '../lib/useNow';
import { usePolling } from '../lib/usePolling';
import { useSystem } from '../providers/SystemProvider';

/**
 * Dashboard.
 *
 * The hero (total equity, its change and curve) is the whole-account NAV
 * series, so all three share one basis. Every OTHER figure up top is a sum
 * over the same per-book accumulator reports the table below shows, so the
 * two can never disagree.
 * The strategy engine is a separate system with a separate store; its numbers
 * appear at the bottom under their own rule, never added to these.
 *
 * WHAT THE REDESIGN CHANGED, AND WHY
 *
 * The page used to open with four identically-sized stat cards — equity,
 * banked, unrealised, deployed — followed by a full-width funds panel and a
 * table. Three things were wrong with that, and each is now a structural fix
 * rather than a styling one:
 *
 *  1. NO HIERARCHY. Four equal cards make the reader decide what matters
 *     before they can read anything. There is now one hero (equity), one
 *     second-rank tile (banked profit, because that is the engine's actual
 *     promise), and everything else is deliberately smaller.
 *
 *  2. LEVELS WITHOUT TREND. Every number was a point in time. "₹2,10,000" is
 *     unreadable without knowing where it came from, so the hero now carries
 *     the equity curve and a signed change against the start of the window.
 *
 *  3. NO TRIAGE. A halt, a stalled feed, a breached loss limit and a lot 20%
 *     underwater were all discoverable — on two other pages. The attention
 *     strip answers "should I do something?" before the reader has to ask it,
 *     and is SILENT when the answer is no.
 *
 * Reading order is deliberate: what am I worth → does anything need me → where
 * is the money → the working table → history and activity → the other engine.
 */
export default function DashboardPage() {
  const acc = usePolling(() => api.accumulator(), 4000);
  const portfolio = usePolling(() => api.portfolio(), 10_000);
  const trades = usePolling(() => api.trades(), 10_000);
  const risk = usePolling(() => api.risk(), 15_000);
  // The NAV curve is the most expensive call on the page (it reconstructs a
  // daily series and reads a cached NIFTY). A minute is plenty: it changes
  // once a day plus a live final point.
  const nav = usePolling(() => analyticsApi.analyticsNav('1y'), 60_000);
  const { system } = useSystem();
  const now = useNow(10_000);

  const books = useMemo(() => acc.data?.books ?? [], [acc.data]);
  const sum = (f: (b: (typeof books)[number]) => number) => books.reduce((s, b) => s + f(b), 0);
  const equity = sum((b) => b.report.equity);
  const budget = sum((b) => b.book.budget);
  const unrealised = sum((b) => b.report.unrealisedPnl);
  const openLots = sum((b) => b.report.openLots);
  const deployed = sum((b) => b.report.deployed);
  const cash = sum((b) => b.report.cash);
  const unsettled = sum((b) => b.report.unsettledCash);

  const banked = sum((b) => b.report.bankedProfit);
  const closed = sum((b) => b.report.closedTrades);
  const allClosedLots = books.flatMap((b) => b.book.closedLots ?? []);

  // Win rate is a weighted question, not an average of averages: one book with
  // two closed lots must not count as much as one with two hundred.
  const winRatePct = closed > 0 ? (sum((b) => (b.report.winRatePct / 100) * b.report.closedTrades) / closed) * 100 : null;
  const winRateLabel = books.find((b) => b.report.closedTrades > 0)?.report.winRateLabel ?? null;

  // The worst open lot and the oldest, for the attention strip. Max/min over
  // books rather than a sum — "how bad is the worst thing I hold" has no
  // meaningful total.
  const worstLotPct = books.length ? Math.min(...books.map((b) => b.report.worstOpenLotPct)) : 0;
  const worstLotBook = books.find((b) => b.report.worstOpenLotPct === worstLotPct);
  // The engine reports this as a raw fraction of days (`oldest / 86_400_000`),
  // so it arrives as 7.081434606481482. Every display site rounds it — the
  // first cut of this page did not, and rendered the full float.
  const oldestLotDays = books.length
    ? Math.round(Math.max(...books.map((b) => b.report.oldestOpenLotDays)))
    : 0;
  // What the ladder is allowed to hold at once, across every book.
  const deployCeiling = sum((b) => b.report.deployCeiling);

  const loading = acc.loading && !acc.data;

  // ── the equity curve ──────────────────────────────────────────────────────
  // The NAV series is the honest source: it is flow-adjusted, so money added
  // to the account does not show up as a gain. Falls back to nothing rather
  // than to a fabricated two-point line.
  const points: SparkPoint[] = useMemo(() => {
    const raw = nav.data?.points ?? [];
    if (raw.length < 2) return [];
    // Cap the drawn series so a multi-year account does not render 700 points
    // into 600 pixels, where most of them land on the same column anyway.
    const MAX = 180;
    const step = Math.max(1, Math.ceil(raw.length / MAX));
    const sampled = raw.filter((_, i) => i % step === 0 || i === raw.length - 1);
    return sampled.map((p) => ({ label: dayLabel(p.day, true), value: p.equity }));
  }, [nav.data]);

  // ── the headline, on the same basis as the curve ──────────────────────────
  // The hero used to show the sum of the accumulator books and diff it against
  // the first point of the whole-account NAV series — two different bases, so
  // an account that was up 1.3% read as down 1.0% (the books exclude cash the
  // engine has no budget for). Number, change and curve now all come from the
  // NAV series. Its last point is the live one.
  //
  // The change is flow-adjusted: the rupee figure subtracts deposits and
  // withdrawals inside the window, and the percentage is the unit-price return,
  // so adding money never shows up as a gain.
  const headline = useMemo(() => {
    const raw = nav.data?.points ?? [];
    if (!raw.length) return null;
    const first = raw[0];
    const last = raw[raw.length - 1];
    const flows = raw.slice(1).reduce((s, p) => s + p.flow, 0);
    return {
      equity: last.equity,
      change: raw.length > 1 ? last.equity - first.equity - flows : null,
      changePct: raw.length > 1 && first.nav > 0 ? (last.nav / first.nav - 1) * 100 : null,
    };
  }, [nav.data]);
  // Books with money actually assigned — a book the allocator gave nothing to
  // is not a stock the capital is "allocated across".
  const fundedBooks = books.filter((b) => b.book.budget > 0).length;

  const periodLabel = useMemo(() => {
    const raw = nav.data?.points ?? [];
    if (raw.length < 2) return '';
    const days = nav.data?.stats.spanDays ?? raw.length;
    if (days <= 45) return `in ${days}d`;
    if (days <= 400) return `in ${Math.round(days / 30)}mo`;
    return `in ${(days / 365).toFixed(1)}y`;
  }, [nav.data]);

  // ── triage ────────────────────────────────────────────────────────────────
  const attention: AttentionItem[] = useMemo(() => {
    const items: AttentionItem[] = [];

    if (system?.halted) {
      items.push({
        level: 'critical',
        message:
          `Trading is halted — no new entries. ` +
          (system.halts?.length ? system.halts.map((h) => h.reason).join('; ') : 'Reason not recorded.'),
        href: '/system',
        hrefLabel: 'System',
      });
    }

    // A halt on one stock is as urgent as a system halt for that stock: it
    // stops its buys AND its sells until someone looks. The system flag above
    // only covers the whole-process halt.
    const haltedBooks = books.filter((b) => b.book.haltedReason);
    if (haltedBooks.length) {
      items.push({
        level: 'critical',
        message:
          `${haltedBooks.length} stock${haltedBooks.length === 1 ? ' is' : 's are'} halted (no buys or sells): ` +
          haltedBooks.map((b) => `${b.book.symbol} — ${b.book.haltedReason}`).join('; '),
        href: `/accumulator/${encodeURIComponent(haltedBooks[0].book.symbol)}`,
        hrefLabel: 'Open',
      });
    }

    for (const a of risk.data?.alerts ?? []) {
      items.push({
        level: a.level === 'critical' ? 'critical' : 'warning',
        message: a.message,
        href: '/risk',
        hrefLabel: 'Risk',
      });
    }

    // A feed that quietly stopped is the most dangerous failure on this page,
    // because every figure above keeps rendering the last good number as if it
    // were live. Only checked while the market is open — a stale feed at
    // midnight is correct behaviour, not a fault.
    const lastPass = system?.feed?.lastPassAt ?? null;
    if (system?.session.phase === 'open' && lastPass && now) {
      const ageSec = Math.round((now - lastPass) / 1000);
      if (ageSec > 180) {
        items.push({
          level: 'warning',
          message: `Price feed last updated ${ageSec}s ago — the figures above may be stale.`,
          href: '/system',
          hrefLabel: 'System',
        });
      }
    }

    const unpriced = system?.feed?.unpriced ?? [];
    if (unpriced.length) {
      items.push({
        level: 'warning',
        message: `No price for ${unpriced.slice(0, 4).join(', ')}${unpriced.length > 4 ? ` and ${unpriced.length - 4} more` : ''}.`,
        href: '/system',
        hrefLabel: 'System',
      });
    }

    // Not a sell signal — the accumulator never sells at a loss, so this is
    // purely "you should know this is here".
    if (worstLotBook && worstLotPct <= -15) {
      items.push({
        level: 'warning',
        message: `${worstLotBook.book.symbol} has a lot ${Math.abs(worstLotPct).toFixed(0)}% underwater. It will not be sold at a loss, but it is holding capital.`,
        href: `/accumulator/${worstLotBook.book.symbol}`,
        hrefLabel: 'Open book',
      });
    }

    if (oldestLotDays >= 90) {
      items.push({
        level: 'info',
        message: `Oldest open lot has been held ${oldestLotDays} days.`,
      });
    }

    return items;
  }, [system, risk.data, now, worstLotPct, worstLotBook, oldestLotDays, books]);

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader
        title="Dashboard"
        subtitle="Every stock the bot is watching, and what the capital is doing"
        action={
          nav.data?.meta ? (
            <span className="hidden text-xs text-zinc-400 sm:block" title={nav.data.meta.note}>
              {nav.data.meta.snapshots} daily snapshots
            </span>
          ) : undefined
        }
      />

      {/* Triage first: anything that needs a human outranks every number. */}
      <AttentionStrip items={attention} loading={loading} />

      {/* Hero row. The 2:1 split is the hierarchy made literal — equity is
          twice the width of anything else on the page. */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {/* Whole-account NAV once it has loaded. If the NAV call fails, the
              books' sum stands in — labelled as such, and with no change,
              since there is no series on that basis to diff against. */}
          <EquityHero
            equity={headline?.equity ?? equity}
            change={headline?.change ?? null}
            changePct={headline?.changePct ?? null}
            basis={
              headline
                ? 'Whole account — cash plus every holding, flow-adjusted'
                : 'Accumulator books only — account NAV unavailable'
            }
            points={headline ? points : []}
            periodLabel={periodLabel}
            loading={loading || (nav.loading && !nav.data)}
            budget={budget}
            bookCount={fundedBooks}
          />
        </div>
        <BankedTile
          banked={banked}
          closedTrades={closed}
          winRatePct={winRatePct}
          winRateLabel={winRateLabel}
          loading={loading}
        />
      </div>

      {/* Supporting metrics: one shared surface, divided — five facets of one
          position, not five separate decisions. */}
      <div className="mb-4">
        <KpiRow>
          <KpiTile
            label="Unrealised"
            value={openLots ? inr(unrealised, 0) : '—'}
            tone={openLots ? unrealised : undefined}
            sub={`${openLots} open lot${openLots === 1 ? '' : 's'}`}
            loading={loading}
          />
          <KpiTile
            label="Deployed"
            value={inr(deployed, 0)}
            sub={budget > 0 ? `${((deployed / budget) * 100).toFixed(0)}% of budget` : undefined}
            loading={loading}
          />
          <KpiTile
            label="Ready to buy"
            value={inr(cash, 0)}
            sub="settled cash waiting for dips"
            loading={loading}
          />
          <KpiTile
            label="Lots closed"
            value={String(closed)}
            sub={closed ? 'all above cost' : 'none yet'}
            loading={loading}
          />
          <KpiTile
            label="Oldest lot"
            value={oldestLotDays > 0 ? `${oldestLotDays}d` : '—'}
            sub={worstLotPct < 0 ? `worst ${worstLotPct.toFixed(0)}%` : 'nothing underwater'}
            loading={loading}
          />
        </KpiRow>
      </div>

      {/* Two different answers to "where is my money", deliberately side by
          side rather than merged. The bar is what the ENGINE has committed out
          of the budgets you gave it; the funds panel is what the BROKER
          actually holds. They are not the same number and should never be
          added — an account can hold cash the engine has no budget for. */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Engine capital"
          action={
            <Link
              href="/risk"
              className="rounded-md px-2 py-0.5 text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-zinc-300"
            >
              Risk limits
            </Link>
          }
        >
          <CapitalBar
            deployed={deployed}
            settled={cash}
            unsettled={unsettled}
            ceiling={deployCeiling}
            loading={loading}
          />
        </Card>
        <FundsPanel />
      </div>

      <div className="mb-4">
        <SweepPanel />
      </div>

      <div className="mb-4">
        <StockModeTable
          rows={books}
          profile={acc.data?.scalpProfile}
          swing={acc.data?.params}
          loading={acc.loading}
          onAction={acc.refresh}
          // Banked and unrealised already sit in the KPI row above.
          summary="modes"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DailyPnlCalendar lots={allClosedLots} title="Daily profit — all stocks" />
        </div>
        <Card title="Live activity">
          <LiveFeed />
        </Card>
      </div>

      {/* A drawn boundary, not an implied one. Two P&L systems on one screen
          that silently appear to add up is the worst outcome here. */}
      <SectionBreak />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Open positions">
          <PositionsTable positions={portfolio.data?.positions ?? []} />
        </Card>
        <Card title="Recent trades">
          <TradesTable trades={trades.data?.trades ?? []} limit={6} />
        </Card>
      </div>
    </div>
  );
}

function SectionBreak() {
  return (
    <div className="mb-3 mt-8 flex items-end justify-between gap-4 border-t border-zinc-200 pt-5 dark:border-zinc-800">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          Strategy engine
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Signal strategies — a separate system with its own store. These numbers are not part of
          the totals above.
        </p>
      </div>
      <Link
        href="/strategies"
        className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Manage
      </Link>
    </div>
  );
}

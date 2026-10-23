import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { seedDemoData } from './bootstrap/seed';
import { anyLiveBroker } from './brokers/registry';
import { connectMongo } from './store/db';
import { store } from './store/memoryStore';
import { brokerConnections } from './services/BrokerConnectionService';
import { kiteService } from './services/KiteService';
import { marketData } from './services/MarketDataService';
import { orderManager } from './services/OrderManager';
import { strategyEngine } from './services/StrategyEngine';
import { accumulatorEngine } from './services/AccumulatorEngine';
import { allocatorEngine } from './services/AllocatorEngine';
import { cashSweep } from './services/CashSweepService';
import { ensureInstruments } from './services/instruments';
import { yahooFeed } from './services/YahooFeed';
import { describe, isMarketOpen, istParts, isTradingDay } from './services/session';
import { wsManager } from './services/WebSocketManager';
import { checkStaticIp, tradingHalt } from './services/guards';
import { notifier } from './services/Notifier';
import { reconcileService } from './services/ReconcileService';
import { sweepStaleOrders } from './services/orderSweep';
import { marketEvents } from './services/marketEvents';
import { holidayCalendar } from './services/holidayCalendar';
import { snapshotService } from './services/SnapshotService';
import { triggerService } from './services/TriggerService';
import { marketWeather } from './services/MarketWeatherService';
import { globalMarkets } from './services/GlobalMarketsService';
import { foreignRecs } from './services/ForeignRecsService';
import { logger } from './utils/logger';
import { sealPlaintextTotp } from './services/totpSecrets';

/** Connect the .env Zerodha feed (DATA_SOURCE=zerodha); returns true if live data is flowing. */
async function startZerodhaFeed(): Promise<boolean> {
  marketData.setLiveMode(true);
  const ok = await kiteService.startFromEnv();
  if (ok) logger.info('Zerodha live market data enabled');
  return ok;
}

/**
 * Refuse to run a LIVE broker on the default JWT secret. The token signs every
 * order request; a guessable secret is someone else's trades. Paper mode gets
 * a loud warning instead, so development still works out of the box. (Per-user
 * live connections enforce the same rule when a user switches to live.)
 */
function enforceSecrets(): void {
  if (!config.jwt.secretIsDefault) return;
  if (config.env === 'production' || config.broker !== 'paper') {
    logger.error(
      'JWT_SECRET is not set. Refusing to start with a live broker or in production on the default secret. ' +
        'Add JWT_SECRET=<long random string> to BE/.env.',
    );
    process.exit(1);
  }
  logger.warn('JWT_SECRET not set — using the development default. Set it before exposing this beyond localhost.');
}

/**
 * Daily summary at 15:45 IST: the day's fills, P&L and any halts, to the alert
 * channel. Cheap insurance that the bot is still being watched.
 */
function startDailySummary(): NodeJS.Timeout {
  let sentFor = '';
  const timer = setInterval(() => {
    const now = Date.now();
    const { date, minutes } = istParts(now);
    if (!isTradingDay(now) || minutes < 15 * 60 + 45 || sentFor === date) return;
    sentFor = date;
    const lines: string[] = [`ISMTA ${date}`];
    for (const u of store.users.values()) {
      const pnl = store.getDailyPnl(u.id, now);
      const orders = store.ordersByUser(u.id).filter((o) => istParts(o.createdAt).date === date);
      const fills = orders.filter((o) => o.status === 'FILLED').length;
      const rejects = orders.length - fills;
      lines.push(`${u.name}: strategy P&L ₹${pnl.toFixed(0)}, ${fills} fills, ${rejects} rejected`);
    }
    if (tradingHalt.active) lines.push(`HALTED: ${tradingHalt.describe()}`);
    void notifier.send(lines.join('\n'));
  }, 60_000);
  timer.unref?.();
  return timer;
}

/** Feed watchdog: during the session, no tick for a while means the feed is dead. */
function startFeedWatchdog(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    if (!isMarketOpen(now) || !marketData.hasTicked()) {
      tradingHalt.clear('feed');
      return;
    }
    const tracked = marketData.symbols.filter((s) => marketData.getPrice(s) > 0);
    if (!tracked.length) return;
    const youngest = Math.min(...tracked.map((s) => marketData.quoteAge(s, now)));
    if (youngest > config.guards.maxQuoteAgeMs * 3) {
      tradingHalt.set('feed', `no tick on any symbol for ${Math.round(youngest / 1000)}s during the session`);
      void notifier.alert('critical', 'feed-dead', `Feed silent for ${Math.round(youngest / 1000)}s during the session — trading halted`);
    } else {
      tradingHalt.clear('feed');
    }
  }, 30_000);
  timer.unref?.();
  return timer;
}

async function main(): Promise<void> {
  enforceSecrets();

  // Persistence: connect to MongoDB and load existing data into the cache.
  // Non-fatal — the app still runs in-memory if MongoDB isn't available.
  await connectMongo();
  await store.hydrate();
  // Two-factor secrets written before they were encrypted: seal them now.
  for (const u of sealPlaintextTotp(store.users.values())) {
    store.users.set(u.id, u);
    logger.info(`TOTP secret sealed at rest for ${u.email}`);
  }
  // A manual trading halt left on before the last shutdown stays on.
  await tradingHalt.restore();
  // Users' own Zerodha sessions from earlier today (a session past 06:00 IST is marked expired).
  brokerConnections.start();

  const app = createApp();
  const server = http.createServer(app);
  wsManager.attach(server);

  await seedDemoData();
  store.audit({ kind: 'system', detail: `boot: broker=${config.broker} data=${config.dataSource} env=${config.env}` });

  // Pipe market ticks into the strategy engine + SL/TP monitor + standing triggers.
  marketData.on('tick', (tick) => {
    strategyEngine.onTick(tick.symbol, tick.ltp);
    void orderManager.onTick(tick.symbol, tick.ltp);
    void triggerService.onTick(tick.symbol, tick.ltp);
  });

  // Select the data source: real Zerodha feed or the simulator.
  if (config.dataSource === 'zerodha') {
    const ok = await startZerodhaFeed();
    if (!ok) {
      logger.warn('Falling back to SIMULATED market data');
      marketData.setLiveMode(false);
    }
  } else if (config.dataSource === 'yahoo') {
    // Real prices, polled. The simulator is off; the first pass is awaited so
    // the API never serves the seeded placeholders.
    marketData.setLiveMode(true);
    await yahooFeed.start();
  }
  marketData.start();
  // A connected paid-plan (Kite Connect) key streams live prices on top of Yahoo.
  brokerConnections.refreshFeed();

  // The broker's static-IP whitelist (mandatory since 1 Apr 2026). Fails
  // closed for a live broker: a wrong IP halts orders before the broker
  // rejects them one by one.
  const ip = await checkStaticIp();
  if (anyLiveBroker()) {
    logger.info(`Static IP check: ${ip.ok ? 'ok' : 'MISMATCH'} (public ${ip.ip ?? 'unknown'}, whitelisted ${ip.expected || 'not configured'})`);
    if (!config.guards.staticIp) {
      logger.warn('BROKER_STATIC_IP not set — the broker will reject orders from an unregistered IP (SEBI rule, live since 1 Apr 2026)');
    }
  }
  const ipTimer = setInterval(() => void checkStaticIp(), 10 * 60_000);
  ipTimer.unref?.();

  // Do the risk limits fit the account?
  //
  // `RISK_MAX_POSITION_VALUE` and `RISK_DAILY_LOSS_LIMIT` now DERIVE from
  // `RISK_CAPITAL` when they are not set, so the common case is consistent by
  // construction. This catches the other one: limits set explicitly, in rupees,
  // and left behind when the account changed.
  //
  // Exceeding capital is not automatically wrong — MIS gives intraday leverage,
  // so five positions worth more than the account can be perfectly fundable.
  // What makes it worth saying out loud here is that the ACCUMULATOR trades CNC
  // against the same account with no leverage at all, and the two engines draw
  // on one balance. So this warns; it does not refuse.
  {
    const { capital, maxPositions, maxPositionValue, dailyLossLimit } = config.risk;
    const notional = maxPositions * maxPositionValue;
    const share = capital > 0 ? notional / capital : Infinity;
    logger.info(
      `Risk limits: ₹${Math.round(maxPositionValue).toLocaleString('en-IN')}/position × ` +
        `${maxPositions} = ₹${Math.round(notional).toLocaleString('en-IN')} ` +
        `(${(share * 100).toFixed(0)}% of ₹${capital.toLocaleString('en-IN')} capital), ` +
        `daily loss limit ₹${Math.round(dailyLossLimit).toLocaleString('en-IN')} ` +
        `(${((dailyLossLimit / (capital || 1)) * 100).toFixed(2)}%)`,
    );
    if (share > 1) {
      logger.warn(
        `Strategy position limits allow ₹${Math.round(notional).toLocaleString('en-IN')} of ` +
          `notional against ₹${capital.toLocaleString('en-IN')} of capital ` +
          `(${(share * 100).toFixed(0)}%). That relies on intraday leverage, and the ` +
          `accumulator trades the same account in CNC with none. Lower ` +
          `RISK_MAX_POSITION_VALUE or RISK_MAX_POSITIONS if that is not deliberate.`,
      );
    }
    if (dailyLossLimit > capital * 0.05) {
      logger.warn(
        `RISK_DAILY_LOSS_LIMIT is ₹${Math.round(dailyLossLimit).toLocaleString('en-IN')} — ` +
          `${((dailyLossLimit / (capital || 1)) * 100).toFixed(1)}% of capital in one day.`,
      );
    }
  }

  // NSE listed-company master, then the no-loss scheduler over every enabled
  // book. The master is best-effort: NSE unreachable keeps the cached list.
  await ensureInstruments();
  // NSE's published holiday list, merged over the built-in one (and refreshed daily).
  await holidayCalendar.refresh();
  holidayCalendar.start();
  // NSE surveillance lists and results calendars, for the engine's entry blocks.
  marketEvents.start();
  // Orders an earlier run left PENDING: closed if paper, checked against the
  // broker if live, and reported when they cannot be confirmed. Before the
  // engine starts, so it never trades beside an order it does not know about.
  await sweepStaleOrders().catch((e) => logger.error(`order sweep: ${e instanceof Error ? e.message : e}`));
  // Then every filled engine order must be on its book. One that is not means
  // the last run stopped between a fill and its save; that book is halted
  // before the engine could buy the same rung, or sell the same lot, again.
  const unbooked = accumulatorEngine.haltUnbookedFills();
  logger.info(`Fill audit: ${unbooked.length ? `${unbooked.length} unbooked fill(s) — see halts` : 'every engine fill is booked'}`);
  accumulatorEngine.start();
  // Sizes each book from the paper capital; runs daily after the close.
  allocatorEngine.start();
  // Parks the books' spare cash in a liquid ETF; off until a user switches it on.
  cashSweep.start();
  // Broker holdings vs books, on a timer (whenever any account is live).
  reconcileService.start();
  // Daily equity rows for the NAV curve.
  snapshotService.start();
  // Standing GTT / OCO / trailing triggers.
  triggerService.start();
  // Market Weather: read-only market-risk read and alerts (first build after a short delay).
  marketWeather.start();
  // Global Markets: country ranking in rupees and India-listed ETF premiums (read-only).
  globalMarkets.start();
  // Foreign stocks: US-listed recommendations for LRS investing (read-only).
  foreignRecs.start();

  // Run strategy cycles on a fixed cadence. One cycle = one bar. On the Yahoo
  // feed that is one minute — the smallest bar the source actually has.
  const cycleTimer = setInterval(
    () => void strategyEngine.runCycle().catch((e) => logger.error(`runCycle: ${e?.message ?? e}`)),
    config.strategyBarMs,
  );

  // Session watchdog. Flattens MIS positions on OUR terms before the broker
  // does it on its own at 15:25 for ₹50+GST and a price we don't choose — and
  // before the closing auction freezes market orders on F&O scrips. Runs on its
  // own timer so it survives a stalled strategy cycle.
  const sessionTimer = setInterval(
    () =>
      void orderManager
        .enforceSessionFlatten()
        .catch((e) => logger.error(`session flatten: ${e?.message ?? e}`)),
    30_000,
  );
  const summaryTimer = startDailySummary();
  const feedTimer = startFeedWatchdog();

  if (config.session.enabled) {
    logger.info(
      `NSE session enforced — entries ${config.session.entryOpensAt}–${config.session.entryClosesAt}, ` +
        `flatten ${config.session.flattenAt}, broker square-off ${config.session.squareOffAt} (${describe(Date.now())})`,
    );
  } else {
    logger.warn('SESSION_ENABLED=false — trading hours, holidays and the MIS square-off are IGNORED');
  }

  // The trailing engine's stop-fill model assumes a resting stop filled at its
  // level. With a live broker that placed no such order, that assumption is a
  // lie — so we fall back to the observed price and say so out loud.
  if (config.broker !== 'paper' && !config.ntb.useExchangeStop) {
    logger.warn(
      'LIVE broker without USE_EXCHANGE_STOP: no resting stop order is placed, so stop exits ' +
        'fill at the next observed price, not at the stop level. NSE gaps every morning — ' +
        'expect realised losses worse than STOP_LOSS_PCT.',
    );
  }

  logger.info(
    notifier.configured
      ? 'Telegram alerts enabled'
      : 'Telegram alerts not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID) — alerts are logged only',
  );

  server.listen(config.port, config.host, () => {
    logger.info(
      `API on http://localhost:${config.port} (data=${config.dataSource}, broker=${config.broker}, bar=${config.strategyBarMs / 1000}s)`,
    );
    logger.info(`WebSocket on ws://localhost:${config.port}/ws?token=<jwt>`);
    logger.info(`Zerodha redirect URL for developers.kite.trade: ${brokerConnections.redirectUrl()}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down…');
    clearInterval(cycleTimer);
    clearInterval(sessionTimer);
    clearInterval(summaryTimer);
    clearInterval(feedTimer);
    clearInterval(ipTimer);
    accumulatorEngine.stop();
    allocatorEngine.stop();
    cashSweep.stop();
    reconcileService.stop();
    snapshotService.stop();
    triggerService.stop();
    marketWeather.stop();
    globalMarkets.stop();
    foreignRecs.stop();
    brokerConnections.stop();
    kiteService.stop();
    yahooFeed.stop();
    marketData.stop();
    store.audit({ kind: 'system', detail: 'shutdown' });
    // Let every queued write reach the database before the process dies.
    const done = store.flush().catch(() => undefined);
    const deadline = new Promise<void>((r) => setTimeout(r, 4_000));
    void Promise.race([done, deadline]).then(() => server.close(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A stray rejected promise is logged and alerted, and the process carries on:
  // every engine loop already catches its own errors, so one that escapes is a
  // bug to fix, not a reason to stop managing exits.
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logger.error(`Unhandled rejection: ${msg}`);
    void notifier.alert('critical', 'process:unhandledRejection', `Unhandled rejection: ${msg.split('\n')[0]}`, 10 * 60_000);
  });
  // An uncaught exception leaves state unknown. Save what is queued, say so,
  // and exit non-zero so the supervisor (npm run start:supervised) restarts a
  // clean process; the boot fill audit then checks nothing was lost.
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
    void notifier.alert('critical', 'process:uncaughtException', `Crashed: ${err.message}. Restarting.`, 0);
    const done = store.flush().catch(() => undefined);
    const deadline = new Promise<void>((r) => setTimeout(r, 3_000));
    void Promise.race([done, deadline]).then(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});

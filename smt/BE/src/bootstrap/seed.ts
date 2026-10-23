import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { store } from '../store/memoryStore';
import { StrategyConfig, User } from '../types';
import { strategyEngine } from '../services/StrategyEngine';
import { logger } from '../utils/logger';

/**
 * Seeds a demo trader and a few example strategies. Credentials:
 * demo@trader.in / demo123
 *
 * THE STRATEGIES ARE SEEDED OFF, and that is deliberate.
 *
 * They used to be created `enabled: true` with `direction: 'both'`, so a fresh
 * install began placing orders — including intraday SHORTS — within a minute of
 * first boot, on symbols nobody had chosen. On the demo account that meant open
 * short positions in RELIANCE and TCS, while accumulator books existed for the
 * same two names. Nothing separated the two engines except the allocator's
 * trend filter declining to anchor in a downtrend, and the allocator can enable
 * a book on its own.
 *
 * An install that starts trading by itself is wrong however good the strategy
 * is, and it is much worse when it happens to be short something the other
 * engine is accumulating. The `orderGate` now refuses strategy entries on a
 * symbol an accumulator book owns, but a gate is the second line — not
 * starting is the first.
 *
 * The accumulator is unaffected: it is not seeded at all. Its books are created
 * when you switch a stock on, and they keep running exactly as before.
 *
 * These stay as ready-made examples. Switch one on from /strategies when you
 * want it.
 */
export async function seedDemoData(): Promise<void> {
  if (store.findUserByEmail('demo@trader.in')) return;

  const user: User = {
    id: uuid(),
    email: 'demo@trader.in',
    name: 'Demo Trader',
    passwordHash: await bcrypt.hash('demo123', 10),
    role: 'admin',
    createdAt: Date.now(),
  };
  store.users.set(user.id, user);

  const strategies: StrategyConfig[] = [
    {
      id: uuid(),
      userId: user.id,
      name: 'NIFTY MA Crossover',
      type: 'MA_CROSSOVER',
      symbols: ['RELIANCE', 'TCS'],
      params: { fast: 9, slow: 21, stopLossPct: 1.5, takeProfitPct: 3 },
      quantity: 10,
      exitMode: 'static',
      direction: 'both',
      enabled: false,
      createdAt: Date.now(),
    },
    {
      id: uuid(),
      userId: user.id,
      name: 'Bank Momentum',
      type: 'MOMENTUM',
      symbols: ['HDFCBANK', 'ICICIBANK'],
      params: { rocPeriod: 10, rocThreshold: 2, stopLossPct: 1.5, takeProfitPct: 4 },
      quantity: 15,
      exitMode: 'static',
      direction: 'both',
      enabled: false,
      createdAt: Date.now(),
    },
    {
      // NTB port. Uses the trailing exit engine + risk-coupled sizing, so
      // `quantity` here is only a fallback for the static path.
      id: uuid(),
      userId: user.id,
      name: 'NTB Breakout (trailing)',
      type: 'NTB_BREAKOUT',
      symbols: ['INFY', 'SBIN'],
      params: {},
      quantity: 10,
      exitMode: 'trailing',
      direction: 'both',
      enabled: false,
      createdAt: Date.now(),
    },
  ];
  for (const s of strategies) {
    store.strategies.set(s.id, s);
    s.symbols.forEach((sym) => strategyEngine.ensureSymbol(sym));
  }

  logger.info(
    `Seeded demo user (demo@trader.in / demo123) + ${strategies.length} strategies, ` +
      `ALL DISABLED — switch one on from /strategies. Nothing trades until you do.`,
  );
}

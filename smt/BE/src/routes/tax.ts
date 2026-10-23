/**
 * Capital-gains report for the accumulator's delivery trades.
 *
 *   GET /api/tax?venue=live|paper
 *
 * Built by `services/tax/ledger.ts` from every buy and sell, FIFO per symbol,
 * which is how the tax law counts them, not how the bot's lots do. Paper
 * trades are not taxable; the paper view exists so the numbers can be checked
 * before real money is involved, and says so.
 */
import { Router } from 'express';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { marketData } from '../services/MarketDataService';
import {
  financialYear,
  harvestCandidates,
  matchFifo,
  summarise,
  transactionsFromBooks,
} from '../services/tax/ledger';
import { store } from '../store/memoryStore';

const router = Router();
router.use(authenticate);

router.get('/', (req: AuthedRequest, res) => {
  const venue = req.query.venue === 'live' ? 'live' : 'paper';
  const now = Date.now();
  // Every book, filtered lot by lot: a book that went live keeps its paper history.
  const books = store.accumulatorBooksByUser(req.userId!);

  const { buys, sells } = transactionsFromBooks(books, venue);
  const { matches, holdings, unmatched } = matchFifo(buys, sells);
  const enginePnlByFy: Record<string, number> = {};
  for (const s of sells) enginePnlByFy[financialYear(s.at)] = (enginePnlByFy[financialYear(s.at)] ?? 0) + s.enginePnl;
  const years = summarise(matches, enginePnlByFy);
  const currentFy = financialYear(now);
  const thisYear = years.find((y) => y.fy === currentFy);

  const prices: Record<string, number> = {};
  const instruments: Record<string, 'EQUITY' | 'ETF'> = {};
  for (const b of books) {
    const sym = b.symbol.toUpperCase();
    prices[sym] = marketData.getPrice(sym) || b.lastPrice || b.previousClose || 0;
    instruments[sym] = b.instrument;
  }

  // The liquid-ETF sweep is a debt fund: gains are taxed at the slab rate.
  const sweep = store.cashSweeps.get(req.userId!);
  const sweepByFy: Record<string, number> = {};
  if (sweep) {
    for (const r of sweep.realised) {
      if ((r.venue ?? 'paper') !== venue) continue;
      sweepByFy[financialYear(r.at)] = (sweepByFy[financialYear(r.at)] ?? 0) + r.gain;
    }
  }

  res.json({
    venue,
    taxable: venue === 'live',
    currentFy,
    years,
    matches,
    holdings: holdings.map((h) => ({ ...h, price: prices[h.symbol] ?? 0 })),
    unmatched,
    harvest: harvestCandidates(holdings, prices, instruments, thisYear, now),
    sweepSlabIncomeByFy: sweepByFy,
    notes: [
      'Sales are matched first-in-first-out per stock, as the tax law requires. The bot sells its newest, cheapest rung first, so a trade it books as a profit can be a loss for tax, and the reverse.',
      'Short-term (held 12 months or less): 20%. Long-term: 12.5% on gains above ₹1,25,000 a year, an exemption shared with all your other equity sales. 4% cess included; surcharge ignored.',
      'STT is not deductible and is excluded from cost; other charges are deductible and included.',
      'The liquid-ETF sweep is a debt fund: its gains are taxed at your slab rate and are shown separately.',
      'Intraday (MIS) trades are speculative business income and are not in this report.',
      'This is an estimate to plan with, not a filing. Check it against your broker\'s tax P&L.',
    ],
  });
});

export default router;

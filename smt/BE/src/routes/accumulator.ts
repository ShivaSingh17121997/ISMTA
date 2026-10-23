import { Router } from 'express';
import { brokerFor, venueOf } from '../brokers/registry';
import { cashSweep } from '../services/CashSweepService';
import { brokerConnections } from '../services/BrokerConnectionService';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { broker } from '../brokers';
import {
  accumulatorEngine,
  createBook,
  reportFor,
  validateBook,
} from '../services/AccumulatorEngine';
import { allocatorEngine, ManualBudgetError } from '../services/AllocatorEngine';
import { minManualCash, rungsForBudget } from '../services/allocator/allocate';
import {
  forceSellEstimate,
  lotBreakeven,
  lotTarget,
  lotTrailStop,
  nextTrancheSize,
  paramsFor,
} from '../services/accumulator/engine';
import { DEFAULT_SCALP_PROFILE, describeProfile } from '../services/accumulator/scalp';
import {
  applyCorporateAction,
  describeAction,
  type CorporateAction,
} from '../services/accumulator/corporateActions';
import { getInstrument } from '../services/instruments';
import { fetchYahooLtp } from '../services/yahooLtp';
import { marketData } from '../services/MarketDataService';
import { DEFAULT_ACCUMULATOR_PARAMS } from '../services/accumulator/types';
import { store } from '../store/memoryStore';
import { bookForView, liveCutoff, venueViewFor } from '../services/venueView';

const router = Router();
router.use(authenticate);

/** Mark price for a book: the broker's LTP, falling back to the last close seen. */
function markFor(symbol: string, fallback = 0): number {
  const ltp = broker.getLtp(symbol);
  return ltp > 0 ? ltp : fallback;
}

/** Like markFor, but will go to Yahoo for a symbol nothing has priced yet. */
async function markOrFetch(symbol: string, fallback = 0): Promise<number> {
  const have = markFor(symbol, 0);
  if (have > 0 && !marketData.isExternal(symbol)) return have;
  const ltp = await fetchYahooLtp(symbol);
  if (ltp !== null) marketData.ingestExternal(symbol, ltp);
  return markFor(symbol, fallback);
}

const withName = (b: { symbol: string }) => ({
  ...b,
  name: getInstrument(b.symbol)?.name ?? b.symbol,
});

/** Every accumulator book the user owns, with the honest report attached. */
router.get('/', (req: AuthedRequest, res) => {
  // Trading live, sold paper lots stay out of every report (services/venueView).
  const view = venueViewFor(req.userId!);
  const books = store.accumulatorBooksByUser(req.userId!).map((stored) => {
    const b = bookForView(stored, view);
    const mark = markFor(b.symbol, b.lastPrice ?? b.previousClose ?? 0);
    // Per-book params, so a scalping book shows its own 1.5% targets rather
    // than the 4% swing default.
    const p = paramsFor(b, DEFAULT_ACCUMULATOR_PARAMS);
    const lots = b.openLots.map((lot) => ({
      ...lot,
      breakeven: lotBreakeven(b, lot, p),
      target: lotTarget(b, lot, p),
      // An armed lot no longer rests at its target — it exits on a retracement
      // from its high. Showing only the target would name a price it will not
      // sell at.
      trailStop: lot.armed ? lotTrailStop(b, lot, p) : undefined,
    }));
    return { book: withName(b), mark, report: reportFor(b, mark), lots };
  });
  res.json({
    books,
    params: DEFAULT_ACCUMULATOR_PARAMS,
    scalpProfile: DEFAULT_SCALP_PROFILE,
    events: accumulatorEngine.recentEvents(50).filter((e) => e.at >= (liveCutoff(view) ?? 0)),
  });
});

/**
 * Open a book. Refuses rather than warns when the economics do not work —
 * a tranche the DP charge eats, or a target that cannot clear the round trip.
 */
router.post('/', async (req: AuthedRequest, res) => {
  const { symbol, instrument, budget, enabled } = req.body ?? {};
  if (typeof symbol !== 'string' || !symbol.trim()) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  if (instrument !== 'ETF' && instrument !== 'EQUITY') {
    return res.status(400).json({ error: "instrument must be 'ETF' or 'EQUITY'" });
  }
  if (typeof budget !== 'number' || !(budget > 0)) {
    return res.status(400).json({ error: 'budget must be a positive number' });
  }
  const sym = symbol.trim().toUpperCase();
  // Checked on the normalised symbol: 'syrma' must find SYRMA, or the new
  // book would be saved under the same key and wipe its lots and history.
  if (store.accumulatorBook(req.userId!, sym)) {
    return res.status(409).json({ error: `A book for ${sym} already exists` });
  }
  const listed = getInstrument(sym);
  if (store.instruments.size > 0 && !listed) {
    return res.status(422).json({ errors: [`${sym} is not in the NSE listed-company master`] });
  }
  if (listed && listed.series !== 'EQ' && listed.series !== 'BE') {
    return res.status(422).json({
      errors: [`${sym} is series ${listed.series}; only EQ/BE series trade as normal delivery`],
    });
  }
  // The instrument type drives the STT schedule (0.001% sell-only for an ETF
  // against 0.1% both legs for a stock), and through it every breakeven. A
  // stock filed as an ETF has every sell floor ~0.2% too low. The master
  // knows: ETF rows come from NSE's ETF list. Rows cached before that list
  // was loaded carry no kind, so the name is still the fallback.
  if (listed) {
    const isEtf = listed.kind
      ? listed.kind === 'ETF'
      : /\bETF\b|BEES|\bNIFTY\b.*\bFUND\b/i.test(listed.name) || /BEES$|ETF$/i.test(sym);
    if (instrument === 'ETF' && !isEtf) {
      return res.status(422).json({ errors: [`${sym} (${listed.name}) is a stock, not an ETF — its STT is 0.1% on both legs`] });
    }
    if (instrument === 'EQUITY' && isEtf) {
      return res.status(422).json({ errors: [`${sym} (${listed.name}) is an ETF — open it as one so the STT schedule is right`] });
    }
  }

  const input = {
    userId: req.userId!,
    symbol: sym,
    instrument,
    budget,
    enabled: typeof enabled === 'boolean' ? enabled : true,
  };
  const mark = await markOrFetch(sym);
  // Validate at the rung count the book will actually run, which is what the
  // allocator gives a budget this size. The global default (12) would demand
  // ₹2.26 lakh before a book could even be opened.
  const tranches = rungsForBudget(budget);
  const errors = validateBook(input, { ...DEFAULT_ACCUMULATOR_PARAMS, tranches }, mark);
  if (errors.length) return res.status(422).json({ errors });

  // Seed the start-gate history from real bars before the book goes live, so
  // its first "45-day high" is a 45-day high. Saves the book either way.
  const book = await accumulatorEngine.seedDayHighs({ ...createBook(input), tranches });
  res.status(201).json({ book: withName(book), mark, report: reportFor(book, mark) });
});

/**
 * Before going live: close every PAPER lot and unwind the paper cash-sweep
 * units, on paper only — no order reaches any broker. Refused while trading
 * is live, so it can never touch real positions. Body: { confirm: true }.
 */
router.post('/clear-paper', async (req: AuthedRequest, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Send { confirm: true } to clear paper lots.' });
  if (venueOf(brokerFor(req.userId!)) !== 'paper') {
    return res.status(409).json({ error: 'Trading is live. Paper lots can only be cleared while on paper.' });
  }
  try {
    const books = await accumulatorEngine.clearPaperLots(req.userId!);
    const sweep = await cashSweep.clearPaper(req.userId!);
    // Re-plan at once: the last plan still counted the cleared lots as
    // committed, and its notes would say "1 open lot kept" until tomorrow.
    const replanned = await allocatorEngine
      .runFor(req.userId!, 'paper lots cleared')
      .then(() => true)
      .catch(() => false);
    store.audit({
      userId: req.userId!, kind: 'engine',
      detail: `cleared paper lots before going live: ${books.map((b) => `${b.symbol} ×${b.lots}`).join(', ') || 'none'}` +
        (sweep ? `; sweep ${sweep.units} unit(s)` : ''),
    });
    res.json({ books, sweep, replanned, blockers: brokerConnections.liveBlockers(req.userId!) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Capital allocator — the bot's view of which books deserve the paper capital
 * and how much. Registered BEFORE `/:symbol` so "allocator" is never read as
 * a ticker.
 */
router.get('/allocator', (req: AuthedRequest, res) => {
  res.json({
    run: allocatorEngine.lastRun(req.userId!) ?? null,
    params: allocatorEngine.params(),
    schedule: allocatorEngine.due(req.userId!),
    events: allocatorEngine.recentEvents(req.userId!, 20),
    // Amounts the user fixed by hand, read from the books so an amount saved
    // before the re-run finished still shows in its field.
    manualBudgets: Object.fromEntries(
      store
        .accumulatorBooksByUser(req.userId!)
        .filter((b) => b.manualBudget !== undefined)
        .map((b) => [b.symbol, b.manualBudget]),
    ),
    manualTranches: Object.fromEntries(
      store
        .accumulatorBooksByUser(req.userId!)
        .filter((b) => b.manualBudget !== undefined && b.manualTranches !== undefined)
        .map((b) => [b.symbol, b.manualTranches]),
    ),
    minManualCash: minManualCash(allocatorEngine.params()),
    // Per stock: the smallest new money worth a rung at its price (allocator/rungFloor).
    minManualCashBy: Object.fromEntries(
      store.accumulatorBooksByUser(req.userId!).map((b) => {
        const f = allocatorEngine.rungFloorFor(b);
        return [b.symbol, { newCash: f.newCash, why: f.why }];
      }),
    ),
    note:
      'Strength ranks what has been rising; it is not a forecast. Open lots are never moved — ' +
      'only settled, uncommitted cash is re-assigned, and the ladder still decides the day a rupee is spent.',
  });
});

/** Re-score and re-allocate now. Refuses to overlap a pass already running. */
router.post('/allocator/run', async (req: AuthedRequest, res) => {
  try {
    const run = await allocatorEngine.runFor(req.userId!, 'manual');
    res.json({ run, events: allocatorEngine.recentEvents(req.userId!, 20) });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Fix this stock's budget by hand, or hand it back to the allocator.
 * Body: { amount: number } in rupees (total: lots + T+1 + new cash), or
 * { amount: null } for automatic. 422 when the amount cannot be honoured.
 */
router.post('/:symbol/budget', async (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const raw = req.body?.amount;
  if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    return res.status(400).json({ error: 'amount must be a number of rupees, or null for automatic' });
  }
  const rungs = req.body?.rungs ?? null;
  if (rungs !== null && (typeof rungs !== 'number' || !Number.isInteger(rungs))) {
    return res.status(400).json({ error: 'rungs must be a whole number, or null for automatic' });
  }
  if (!store.accumulatorBook(req.userId!, sym)) return res.status(404).json({ error: 'No such accumulator book' });
  try {
    const out = await allocatorEngine.setManualBudget(req.userId!, sym, raw, rungs);
    res.json({ book: withName(out.book), run: out.run, pending: out.pending, plan: out.plan });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(e instanceof ManualBudgetError ? 422 : 500).json({ error: msg });
  }
});

/**
 * Preview an amount and rung count without saving: rupees per rung, rungs
 * bought and still to buy, the most rungs the amount allows, and any error.
 *   GET /:symbol/budget/preview?amount=60000&rungs=3   (omit rungs = automatic)
 */
router.get('/:symbol/budget/preview', async (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const amount = Number(req.query.amount);
  const rungs = req.query.rungs === undefined || req.query.rungs === '' ? null : Number(req.query.rungs);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be ₹0 or more' });
  if (rungs !== null && !Number.isFinite(rungs)) return res.status(400).json({ error: 'rungs must be a number' });
  if (!store.accumulatorBook(req.userId!, sym)) return res.status(404).json({ error: 'No such accumulator book' });
  res.json(await allocatorEngine.previewBudget(req.userId!, sym, Math.floor(amount), rungs));
});

/** One book, with every lot's live breakeven and resting target. */
router.get('/:symbol', (req: AuthedRequest, res) => {
  const stored = store.accumulatorBook(req.userId!, req.params.symbol.toUpperCase());
  if (!stored) return res.status(404).json({ error: 'No such accumulator book' });
  const view = venueViewFor(req.userId!);
  const book = bookForView(stored, view);
  const since = liveCutoff(view) ?? 0;

  const mark = markFor(book.symbol, book.lastPrice ?? book.previousClose ?? 0);
  const p = paramsFor(book, DEFAULT_ACCUMULATOR_PARAMS);
  const lots = book.openLots.map((lot) => ({
    ...lot,
    breakeven: lotBreakeven(book, lot, p),
    target: lotTarget(book, lot, p),
    trailStop: lot.armed ? lotTrailStop(book, lot, p) : undefined,
    marketValue: lot.quantity * mark,
    unrealised: lot.quantity * mark - lot.quoteSpent,
  }));

  res.json({
    book: withName(book),
    mark,
    lots,
    report: reportFor(book, mark),
    params: p,
    /**
     * What the NEXT ladder rung would spend, in rupees.
     *
     * Served rather than recomputed on the client because the formula is not
     * "budget ÷ rungs": it is what the ladder has left divided by the rungs it
     * has left, where "left" nets off lots already SOLD from this epoch. A
     * second implementation in the UI would drift the first time the allocator
     * changed a budget mid-ladder, and the screen would quietly promise a
     * tranche size the engine would not buy.
     *
     * It is an estimate for display: the settled-cash check, the deployment
     * ceiling and whole-share rounding all still apply at buy time.
     */
    nextTranche: nextTrancheSize(book, p),
    events: accumulatorEngine.recentEvents(200).filter((e) => e.symbol === book.symbol && e.at >= since),
  });
});

/**
 * What the Sell button would do, per lot, at the current price: net proceeds
 * after every sell-side charge (the flat DP charge included) and the result
 * against the lot's full cost. Places nothing. `blocker` says why a sale
 * cannot go out right now (market closed, halted, wrong venue…), or is null.
 */
router.get('/:symbol/force-sell/preview', async (req: AuthedRequest, res) => {
  const book = store.accumulatorBook(req.userId!, req.params.symbol.toUpperCase());
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });
  const mark = await markOrFetch(book.symbol, book.lastPrice ?? book.previousClose ?? 0);
  const p = paramsFor(book, DEFAULT_ACCUMULATOR_PARAMS);
  const lots = book.openLots.map((lot) => {
    const est = forceSellEstimate(book, lot, mark);
    return {
      id: lot.id,
      epoch: lot.epoch,
      level: lot.level,
      quantity: lot.quantity,
      fillPrice: lot.fillPrice,
      quoteSpent: lot.quoteSpent,
      openedAt: lot.openedAt,
      breakeven: lotBreakeven(book, lot, p),
      estProceeds: est.proceeds,
      estPnl: est.pnl,
    };
  });
  res.json({
    symbol: book.symbol,
    mark,
    lots,
    blocker: accumulatorEngine.forceSellBlocker(book),
    killSwitchEngaged: book.killSwitchEngaged,
    venue: book.venue ?? 'paper',
  });
});

/**
 * The Sell button: sell the chosen lots NOW, at market, even below cost. The
 * only way a lot can close at a loss, and only a person can call it.
 * Body: { confirm: true, lotIds: string[], stopBuying?: boolean (default true) }.
 */
router.post('/:symbol/force-sell', async (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const { confirm, lotIds, stopBuying } = req.body ?? {};
  if (confirm !== true) return res.status(400).json({ error: 'Send { confirm: true } to sell at market.' });
  if (!Array.isArray(lotIds) || lotIds.length === 0 || !lotIds.every((x) => typeof x === 'string')) {
    return res.status(400).json({ error: 'lotIds must be a non-empty list of lot ids.' });
  }
  if (stopBuying !== undefined && typeof stopBuying !== 'boolean') {
    return res.status(400).json({ error: 'stopBuying must be true or false.' });
  }
  if (!store.accumulatorBook(req.userId!, sym)) return res.status(404).json({ error: 'No such accumulator book' });

  const result = await accumulatorEngine.forceSell(req.userId!, sym, lotIds, { stopBuying: stopBuying !== false });
  store.audit({
    userId: req.userId!, kind: 'engine', symbol: sym,
    detail: result.refused
      ? `force sell refused: ${result.refused}`
      : `force sell: ${result.sold.length} sold, ${result.failed.length} not sold` +
        (result.sold.length ? ` (P&L ₹${result.sold.reduce((s, l) => s + l.pnl, 0).toFixed(2)})` : ''),
  });
  if (result.refused) return res.status(409).json({ error: result.refused, ...result });
  res.json(result);
});

/**
 * Kill switch. Halts NEW RISK only — entries and ladder buys. It cannot block
 * an exit: that is enforced inside the engine, not here, so no API shape can
 * ever be made to hold a profitable sale back.
 */
router.post('/:symbol/kill-switch', (req: AuthedRequest, res) => {
  const { engaged } = req.body ?? {};
  if (typeof engaged !== 'boolean') {
    return res.status(400).json({ error: 'Body must be {"engaged": true|false}' });
  }
  const book = accumulatorEngine.setKillSwitch(req.userId!, req.params.symbol.toUpperCase(), engaged);
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });
  res.json({
    killSwitchEngaged: book.killSwitchEngaged,
    note: 'Halts new entries and ladder buys only. Exits are never blocked.',
  });
});

/**
 * No-loss mode on/off. Mirrors POST /strategies/:id/toggle. Off stops the
 * scheduler touching the book; every lot stays exactly where it is.
 */
router.post('/:symbol/toggle', (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const current = store.accumulatorBook(req.userId!, sym);
  if (!current) return res.status(404).json({ error: 'No such accumulator book' });
  const book = accumulatorEngine.setEnabled(req.userId!, sym, !current.enabled);
  res.json({ book: withName(book!), enabled: book!.enabled });
});

/**
 * Scalping mode on/off. A PROFILE on the same engine, not a second engine:
 * tighter targets and a faster entry cadence, with the no-loss floor untouched.
 * Nested inside no-loss mode — the flag saves either way, but only bites while
 * no-loss mode is on.
 *
 * 422 when the target cannot clear 1.5x the round-trip cost at this book's
 * tranche size. That refusal is the point: on a small tranche the flat DP
 * charge turns a 1.5% "profit" into a payment to the exchange.
 */
router.post('/:symbol/scalp', async (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const current = store.accumulatorBook(req.userId!, sym);
  if (!current) return res.status(404).json({ error: 'No such accumulator book' });

  const { enabled } = req.body ?? {};
  const on = typeof enabled === 'boolean' ? enabled : !current.scalp;

  const mark = await markOrFetch(sym, current.lastPrice ?? current.previousClose ?? 0);
  const { book, errors } = accumulatorEngine.setScalp(req.userId!, sym, on, mark);
  if (errors.length) return res.status(422).json({ errors });
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });

  res.json({
    book: withName(book),
    scalp: book.scalp === true,
    profile: book.scalp ? 'scalp' : 'swing',
    profileNote: describeProfile(book.scalp === true),
    note:
      'Scalping changes the profit target and the entry cadence. It does not change the floor: ' +
      'a lot is still never sold below its fee-inclusive cost, so a scalp that goes wrong ' +
      'becomes a held lot, not a loss.',
  });
});

/**
 * Regime autopilot on/off.
 *
 * On, the bot reads the trend from daily closes and owns the scalp flag:
 * sideways switches to scalp, a confirmed trend switches to swing. Turning it
 * on runs a pass immediately, so the response already carries the profile the
 * trend calls for.
 *
 * While it is on the scalp switch belongs to the bot. One controller per knob.
 */
router.post('/:symbol/autopilot', async (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const current = store.accumulatorBook(req.userId!, sym);
  if (!current) return res.status(404).json({ error: 'No such accumulator book' });

  const { enabled } = req.body ?? {};
  const on = typeof enabled === 'boolean' ? enabled : !current.autoProfile;
  const book = await accumulatorEngine.setAutoProfile(req.userId!, sym, on);
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });

  res.json({
    book: withName(book),
    autoProfile: book.autoProfile === true,
    regime: book.regime ?? null,
    regimeNote: book.regimeNote ?? null,
    profile: book.scalp ? 'scalp' : 'swing',
    note:
      'Sideways markets switch to scalp, confirmed trends to swing. A downtrend also uses swing: ' +
      "scalp's shallower gate and shorter brake would ladder into weakness faster, and no-loss " +
      'means those lots cannot be cut. Neither profile can sell below fee-inclusive cost.',
  });
});

/**
 * Apply a corporate action by hand.
 *
 * The engine reads splits and dividends from Yahoo automatically, and Yahoo
 * encodes an Indian bonus issue as a split, so most actions need nothing. This
 * is for the ones it misses, and for resolving a book the automatic path
 * halted.
 *
 * Body: `{ type, exDate, ratio?: {from,to}, dividendPerShare? }`.
 */
router.post('/:symbol/corporate-action', (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const book = store.accumulatorBook(req.userId!, sym);
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });

  const { type, exDate, ratio, dividendPerShare } = req.body ?? {};
  if (type !== 'SPLIT' && type !== 'BONUS' && type !== 'DIVIDEND') {
    return res.status(400).json({ error: "type must be 'SPLIT', 'BONUS' or 'DIVIDEND'" });
  }
  const at = typeof exDate === 'number' ? exDate : Date.parse(String(exDate));
  if (!Number.isFinite(at)) {
    return res.status(400).json({ error: 'exDate must be an epoch in ms or an ISO date' });
  }

  const action: CorporateAction = {
    type,
    exDate: at,
    source: 'manual',
    ...(ratio ? { ratio } : {}),
    ...(typeof dividendPerShare === 'number' ? { dividendPerShare } : {}),
  };

  try {
    const before = book.openLots.reduce((s, l) => s + l.quantity, 0);
    // A manual action clears any halt the automatic path raised for it: the
    // point of doing it by hand is to resolve exactly that.
    const next = applyCorporateAction({ ...book, haltedReason: undefined }, action);
    store.saveAccumulatorBook({ ...next, updatedAt: Date.now() });
    res.json({
      book: withName(next),
      applied: describeAction(action),
      sharesBefore: before,
      sharesAfter: next.openLots.reduce((s, l) => s + l.quantity, 0),
      note:
        'Quantity scaled and per-share prices scaled the other way. No money moved, so every ' +
        "lot's cost basis and breakeven are unchanged. Closed lots were not rewritten.",
    });
  } catch (e) {
    res.status(422).json({ errors: [e instanceof Error ? e.message : String(e)] });
  }
});

/**
 * Release a halt.
 *
 * A halt means the engine could not apply an adjustment exactly and stopped
 * rather than trade on a cost basis it did not trust. Releasing it asserts that
 * the book is now correct — so it says plainly what it is asserting.
 */
router.post('/:symbol/release-halt', (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const book = store.accumulatorBook(req.userId!, sym);
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });
  if (!book.haltedReason) return res.json({ halted: false, note: 'This book was not halted.' });

  const was = book.haltedReason;
  store.saveAccumulatorBook({ ...book, haltedReason: undefined, updatedAt: Date.now() });
  res.json({
    halted: false,
    released: was,
    note:
      'Released. This asserts the cost basis on every open lot is now correct. If the ' +
      'adjustment was never applied, the engine will trade against a wrong basis and, because ' +
      'it cannot sell below cost, a mis-stated lot is locked up rather than closed.',
  });
});

/**
 * Remove a book. Refused while it holds open lots: those are positions (paper
 * today, real shares live), and deleting the book would orphan them with no
 * path to sell. Close them first — at a profit, by construction.
 */
router.delete('/:symbol', (req: AuthedRequest, res) => {
  const sym = req.params.symbol.toUpperCase();
  const book = store.accumulatorBook(req.userId!, sym);
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });
  if (book.openLots.length > 0) {
    return res.status(409).json({
      error: `${sym} holds ${book.openLots.length} open lot(s); a book with positions cannot be removed`,
    });
  }
  store.accumulatorBooks.delete(store.accumulatorKey(req.userId!, sym));
  res.json({ removed: sym });
});

/** Advance one book against the current LTP. */
router.post('/:symbol/step', async (req: AuthedRequest, res) => {
  const book = store.accumulatorBook(req.userId!, req.params.symbol.toUpperCase());
  if (!book) return res.status(404).json({ error: 'No such accumulator book' });

  const mark = await markOrFetch(book.symbol, book.lastPrice ?? book.previousClose ?? 0);
  if (!(mark > 0)) return res.status(503).json({ error: 'No price available for this symbol yet' });

  const next = await accumulatorEngine.step(book, mark);
  res.json({
    book: next,
    mark,
    report: reportFor(next, mark),
    events: accumulatorEngine.recentEvents(20).filter((e) => e.symbol === next.symbol),
  });
});

export default router;

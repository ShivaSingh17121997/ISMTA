/**
 * Accumulator ("no-loss") engine tests.
 *
 * The headline assertion is the invariant: no closed lot ever books a loss,
 * across randomised price paths with adverse fills. Everything else exists to
 * stop that guarantee being true only by accident.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { charges, dpChargeInclGst, roundTripCostPct } from '../services/costs';
import { istParts, nextTradingDayStart } from '../services/session';
import {
  BreakevenViolationError,
  applyBuyFill,
  decide,
  deployedCapital,
  equity,
  lotBreakeven,
  lotTarget,
  nextTrancheSize,
  openEpoch,
  paramsFor,
  recordDayHigh,
  releaseSettled,
  sellLot,
  syncLadder,
  totalCash,
  unsettledCash,
} from '../services/accumulator/engine';
import {
  dailyVolPct,
  dpImpactPct,
  ladderLevels,
  netBreakeven,
  netProceeds,
  nextLevelToBuy,
  sellTarget,
  sharesFor,
  startGatePasses,
  trancheSize,
  volStepPct,
} from '../services/accumulator/math';
import {
  DEFAULT_ACCUMULATOR_PARAMS,
  type AccumulatorBook,
  type AccumulatorParams,
} from '../services/accumulator/types';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

const P: AccumulatorParams = DEFAULT_ACCUMULATOR_PARAMS;
const BUDGET = 300_000;
const T0 = Date.parse('2026-01-05T04:00:00Z'); // Monday 09:30 IST
const DAY = 24 * 3_600_000;

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b1',
    userId: 'u1',
    symbol: 'NIFTYBEES',
    instrument: 'ETF',
    budget: BUDGET,
    cash: BUDGET,
    unsettled: [],
    openLots: [],
    closedLots: [],
    epochs: [],
    lotSeq: 0,
    dayHighs: {},
    orderedDays: [],
    enabled: true,
    killSwitchEngaged: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** Seed a rolling high so the start gate has something to measure against. */
function withHigh(b: AccumulatorBook, high: number, at = T0 - DAY): AccumulatorBook {
  return recordDayHigh(b, high, at);
}

// ─── cost model: the delivery extension ───────────────────────────────────
test('CNC equity pays STT on BOTH legs; intraday pays sell-side only', () => {
  const cncBuy = charges('BUY', 300, 100, { product: 'CNC', instrument: 'EQUITY' });
  const misBuy = charges('BUY', 300, 100);
  assert.ok(cncBuy.stt > 0, 'delivery equity buy must pay STT');
  assert.equal(misBuy.stt, 0, 'intraday buy must not');
});

test('an ETF pays STT on the sell leg only, ~100x lighter than delivery equity', () => {
  const etf = charges('SELL', 300, 100, { product: 'CNC', instrument: 'ETF' });
  const eq = charges('SELL', 300, 100, { product: 'CNC', instrument: 'EQUITY' });
  assert.equal(charges('BUY', 300, 100, { product: 'CNC', instrument: 'ETF' }).stt, 0);
  assert.ok(eq.stt / etf.stt > 50, `expected a large STT gap, got ${eq.stt}/${etf.stt}`);
});

test('the DP charge applies to CNC sells only, and carries GST', () => {
  assert.equal(charges('BUY', 300, 100, { product: 'CNC', instrument: 'ETF' }).dpCharge, 0);
  assert.equal(charges('SELL', 300, 100).dpCharge, 0, 'intraday has no demat debit');
  assert.ok(charges('SELL', 300, 100, { product: 'CNC', instrument: 'ETF' }).dpCharge > 0);
  assert.ok(Math.abs(dpChargeInclGst() - 13.5 * 1.18) < 1e-9);
});

test('the DP charge is larger than a 1% target on a small lot', () => {
  assert.ok(dpImpactPct(1_000) > 1, 'flat fee must dominate a Rs 1,000 lot');
  assert.ok(dpImpactPct(20_000) < 0.1, 'and be negligible on a Rs 20,000 one');
});

test('existing intraday callers are unchanged by the delivery extension', () => {
  const before = charges('SELL', 2950, 10);
  assert.equal(before.dpCharge, 0);
  assert.ok(before.total > 0);
  assert.ok(roundTripCostPct(2950, 10) > 0);
});

// ─── breakeven ────────────────────────────────────────────────────────────
test('at the net breakeven price, proceeds exactly cover cost basis', () => {
  for (const [spent, qty] of [[21300, 76], [5000, 18], [100000, 357], [1000, 4]]) {
    const be = netBreakeven(spent, qty, { instrument: 'ETF' });
    const got = netProceeds(qty, be, { instrument: 'ETF' });
    assert.ok(Math.abs(got - spent) < 1e-6, `spent ${spent}: proceeds ${got}`);
  }
});

test('a percentage-only breakeven that drops the flat DP charge books a real loss', () => {
  const qty = 4;
  const spent = 1_000;
  // The mistake: model cost as a pure PERCENTAGE, so the flat rupee DP charge
  // falls out of the numerator entirely.
  const leg = charges('SELL', spent / qty, qty, { product: 'CNC', instrument: 'ETF' });
  const proportionalOnly = leg.total - dpChargeInclGst();
  const feeRate = proportionalOnly / spent;
  const naive = spent / (qty * (1 - feeRate));

  const shortfall = spent - netProceeds(qty, naive, { instrument: 'ETF' });
  assert.ok(shortfall > 0, 'the naive floor must lose money');
  // The loss is the omitted flat charge, near enough.
  assert.ok(Math.abs(shortfall - dpChargeInclGst()) < 0.5, `shortfall ${shortfall}`);
  assert.ok((shortfall / spent) * 100 > 1.5, 'over 1.5% on a Rs 1,000 lot');

  // The correct floor clears cost exactly.
  const correct = netBreakeven(spent, qty, { instrument: 'ETF' });
  assert.ok(correct > naive);
  assert.ok(Math.abs(netProceeds(qty, correct, { instrument: 'ETF' }) - spent) < 1e-6);
});

test('the slippage buffer puts the floor strictly above exact breakeven', () => {
  const exact = netBreakeven(21_300, 76, { instrument: 'ETF' }, 0);
  const buffered = netBreakeven(21_300, 76, { instrument: 'ETF' }, 0.05);
  assert.ok(buffered > exact);
  assert.ok(netProceeds(76, buffered, { instrument: 'ETF' }) > 21_300);
});

// ─── ladder geometry ──────────────────────────────────────────────────────
test('ladder rungs compound and cover roughly -80% at the defaults', () => {
  const levels = ladderLevels(282, P.tranches, P.stepPct, P.stepGrowth);
  assert.equal(levels.length, 12);
  assert.ok(Math.abs(levels[1] - 282 * 0.94) < 1e-6, 'rung 1 sits 6% below the anchor');
  const coverage = (1 - levels[levels.length - 1] / 282) * 100;
  assert.ok(coverage > 75 && coverage < 85, `coverage ${coverage.toFixed(1)}%`);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] < levels[i - 1]);
});

test('the start gate refuses to anchor near the rolling high', () => {
  assert.equal(startGatePasses(297, 300, 6), false);
  assert.equal(startGatePasses(282, 300, 6), true);
});

test('a gap-down books the shallowest unfilled rung, not the deepest', () => {
  const epoch = {
    index: 0, anchorPrice: 100, openedAt: T0,
    levels: [100, 94, 87.5, 80], filledLevels: [0], status: 'OPEN' as const,
  };
  assert.equal(nextLevelToBuy(epoch, 79), 1, 'crashing past rung 3 still fills rung 1');
  assert.equal(nextLevelToBuy(epoch, 95), null);
});

test('sell targets round UP to the tick and never sit below breakeven', () => {
  const be = 283.111;
  assert.ok(sellTarget(be, 4) >= be * 1.04);
  assert.ok(sellTarget(be, 0) >= be);
  assert.ok(sellTarget(be, -100) >= be, 'a negative target cannot undercut the floor');
});

test('whole shares only, remainder carried as cash', () => {
  assert.equal(sharesFor(21_250, 280), 75);
  assert.equal(sharesFor(100, 280), 0);
});

// ─── the state machine ────────────────────────────────────────────────────
test('no epoch is anchored while price sits near the high', () => {
  const d = decide(withHigh(book(), 300), 297, T0, P);
  assert.equal(d.every((x) => x.action === 'HOLD'), true);
  assert.match(d[0].reason, /Start gate/);
});

test('an epoch anchors once the discount is reached, and builds a ladder', () => {
  const d = decide(withHigh(book(), 300), 282, T0, P);
  assert.equal(d[0].action, 'BUY');
  assert.equal(d[0].level, 0);
  const after = applyBuyFill(withHigh(book(), 300), {
    epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0,
  }, P);
  assert.equal(after.openLots.length, 1);
  assert.equal(openEpoch(after)!.levels.length, 12);
  assert.ok(after.cash < BUDGET);
});

test('the reserve is never deployed', () => {
  let b = withHigh(book(), 300);
  let price = 282;
  let at = T0;
  for (let i = 0; i < 30; i++) {
    const d = decide(b, price, at, P);
    const buy = d.find((x) => x.action === 'BUY');
    if (buy) {
      b = applyBuyFill(b, {
        epoch: buy.epoch!, level: buy.level!, fillPrice: buy.limitPrice!, quantity: buy.quantity!, at,
      }, P);
    }
    price *= 0.94;
    at += DAY;
    b = recordDayHigh(b, price, at);
  }
  const deployable = BUDGET * (1 - P.reservePct / 100);
  assert.ok(deployedCapital(b) <= deployable, `deployed ${deployedCapital(b)} > ${deployable}`);
  assert.ok(b.openLots.length > 3, 'the ladder must actually have filled');
});

test('the crash-cascade brake spaces ladder buys', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const soon = decide(b, 282 * 0.94, T0 + 60_000, P);
  assert.equal(soon.some((x) => x.action === 'BUY'), false);
  assert.match(soon.find((x) => x.action === 'HOLD')!.reason, /brake/);
});

// ─── ladder resize and rung sizing ────────────────────────────────────────
/** One lot anchored at 282 on a `rungs`-rung ladder, then the book moved to `tranches`. */
function anchored(rungs: number, tranches: number, budget = BUDGET): AccumulatorBook {
  let b = withHigh(book({ budget, cash: budget, tranches: rungs }), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  return { ...b, tranches };
}

/** Buy rung `k` of the open ladder at its own price. */
function fillRung(b: AccumulatorBook, k: number, at: number): AccumulatorBook {
  const price = openEpoch(b)!.levels[k];
  const buy = decide(b, price, at, P).find((x) => x.action === 'BUY');
  assert.ok(buy, `rung ${k} should buy`);
  return applyBuyFill(b, { epoch: 0, level: k, fillPrice: price, quantity: buy!.quantity!, at }, P);
}

test('a ladder built on 3 rungs grows a 4th when the book moves to 4, existing rungs untouched', () => {
  const b = anchored(3, 4);
  const before = openEpoch(b)!.levels;
  assert.equal(before.length, 3);
  const after = openEpoch(syncLadder(b, P))!.levels;
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(0, 3), before);
  const expected = ladderLevels(282, 4, P.stepPct, P.stepGrowth)[3];
  assert.ok(Math.abs(after[3] - expected) < 1e-6, `rung 3 ${after[3]} vs ${expected}`);
});

test('the grown rung keeps the ladder\'s own gaps, not the profile in force now', () => {
  const after = openEpoch(syncLadder({ ...anchored(3, 4), scalp: true }, P))!.levels;
  const expected = ladderLevels(282, 4, P.stepPct, P.stepGrowth)[3];
  assert.ok(Math.abs(after[3] - expected) < 1e-6, `scalp's 2% gaps leaked in: ${after[3]} vs ${expected}`);
});

test('shrinking a ladder drops unfilled rungs only, never one that holds a lot', () => {
  const b = fillRung(anchored(4, 4), 1, T0 + 2 * DAY);
  assert.equal(openEpoch(syncLadder({ ...b, tranches: 3 }, P))!.levels.length, 3);
  assert.equal(openEpoch(syncLadder({ ...b, tranches: 1 }, P))!.levels.length, 2, 'rung 1 holds a lot');
});

test('syncLadder returns the same book when the rung count already matches', () => {
  const b = anchored(4, 4);
  assert.equal(syncLadder(b, P), b);
});

test('a full 3-rung ladder buys the 4th rung once the book moves to 4, and the fill stores it', () => {
  let b = anchored(3, 3);
  b = fillRung(b, 1, T0 + 2 * DAY);
  b = fillRung(b, 2, T0 + 4 * DAY);
  const at = T0 + 6 * DAY;
  const rung3 = ladderLevels(282, 4, P.stepPct, P.stepGrowth)[3];
  assert.equal(decide(b, rung3, at, P).some((x) => x.action === 'BUY'), false, 'nothing left on 3 rungs');
  b = { ...b, tranches: 4 };
  assert.equal(decide(b, rung3, at, P).some((x) => x.action === 'BUY'), false,
    'same budget: only the reserve is left, so a 4th rung has no money');
  // The allocator adds rungs when it adds money.
  b = { ...b, budget: b.budget + 100_000, cash: b.cash + 100_000 };
  const buy = decide(b, rung3, at, P).find((x) => x.action === 'BUY');
  assert.equal(buy?.level, 3);
  b = applyBuyFill(b, { epoch: 0, level: 3, fillPrice: rung3, quantity: buy!.quantity!, at }, P);
  assert.equal(openEpoch(b)!.levels.length, 4);
});

test('with a steady budget every rung gets the same rupees, give or take one share', () => {
  const next = nextTrancheSize(anchored(12, 12), P);
  assert.ok(Math.abs(next - trancheSize(BUDGET, P)) < 282, `rung 1 ₹${next} vs ₹${trancheSize(BUDGET, P)}`);
});

test('a budget raised mid-ladder is spread over the rungs still to come (the SYRMA case)', () => {
  const small = anchored(3, 3, 57_000);
  const spent = small.openLots[0].quoteSpent;
  // The allocator hands the book ₹80,000 of fresh cash and moves it to 4 rungs.
  const b = syncLadder({ ...small, tranches: 4, budget: spent + 80_000, cash: 80_000 }, P);
  const expected = ((spent + 80_000) * (1 - P.reservePct / 100) - spent) / 3;
  const next = nextTrancheSize(b, P);
  assert.ok(Math.abs(next - expected) < 1e-6, `₹${next} vs ₹${expected}`);
  assert.ok(next > spent, 'later rungs catch up to the budget instead of staying at the old size');
  assert.ok(3 * next <= b.cash, 'the remaining rungs fit in the cash the book holds');
});

test('a sold rung still counts as spent, so taking profit does not inflate deeper rungs', () => {
  const b = fillRung(anchored(12, 12), 1, T0 + 2 * DAY);
  const before = nextTrancheSize(b, P);
  const lot0 = b.openLots.find((l) => l.level === 0)!;
  const sold = sellLot(b, lot0.id, lotTarget(b, lot0, P), T0 + 3 * DAY, T0 + 4 * DAY, P);
  assert.ok(openEpoch(sold), 'rung 1 keeps the ladder open');
  assert.ok(Math.abs(nextTrancheSize(sold, P) - before) < 1e-9);
});

// ─── THE INVARIANT ────────────────────────────────────────────────────────
test('selling below net breakeven throws and leaves the lot open', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const lot = b.openLots[0];
  const floor = lotBreakeven(b, lot, P);

  assert.throws(
    () => sellLot(b, lot.id, floor * 0.999, T0 + DAY, T0 + 2 * DAY, P),
    BreakevenViolationError,
  );
  assert.equal(b.openLots.length, 1, 'a refused sell changes nothing');
  assert.equal(b.closedLots.length, 0);
});

test('no closed lot ever books a loss, across 80 randomised paths', () => {
  let closed = 0;
  let refused = 0;

  for (let seed = 1; seed <= 80; seed++) {
    let rng = seed * 2654435761;
    const rand = (): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };

    let b = withHigh(book(), 320);
    let price = 300;
    let at = T0;

    for (let i = 0; i < 400; i++) {
      const shock = rand() < 0.02 ? -(4 + rand() * 10) : (rand() - 0.5) * 3;
      price = Math.max(1, price * (1 + shock / 100));
      at += DAY;
      b = recordDayHigh(b, price, at);

      for (const d of decide(b, price, at, P)) {
        if (d.action === 'BUY') {
          // Adverse buy slippage: we pay up to 0.3% more than we asked.
          b = applyBuyFill(b, {
            epoch: d.epoch!, level: d.level!,
            fillPrice: d.limitPrice! * (1 + rand() * 0.003),
            quantity: d.quantity!, at,
          }, P);
        } else if (d.action === 'SELL') {
          // Slippage in BOTH directions, so some fills land under the floor.
          const fill = d.limitPrice! * (1 + (rand() - 0.5) * 0.08);
          try {
            b = sellLot(b, d.lotId!, fill, at, at + DAY, P);
          } catch (e) {
            assert.ok(e instanceof BreakevenViolationError, `unexpected: ${e}`);
            refused++;
            assert.ok(b.openLots.some((l) => l.id === d.lotId), 'refused lot must stay open');
          }
        }
      }
    }

    for (const lot of b.closedLots) {
      assert.ok(lot.pnl >= 0, `seed ${seed}: lot ${lot.id} booked ${lot.pnl}`);
      assert.ok(lot.proceeds >= lot.quoteSpent);
      assert.ok(lot.sellPrice >= lot.netBreakeven - 1e-6);
    }
    assert.ok(b.cash >= -1e-6, `seed ${seed}: negative cash`);
    closed += b.closedLots.length;
  }

  assert.ok(closed > 50, `only ${closed} lots closed — the assertions would be vacuous`);
  assert.ok(refused > 0, 'the refusal path was never exercised');
});

// ─── Phase 4: re-armed rungs ─────────────────────────────────────────────
const REARM: AccumulatorParams = { ...P, rearmSoldRungs: true };

test('with re-arm, a sold deeper rung can buy again; the anchor rung never re-arms', () => {
  let b = fillRung(anchored(4, 4), 1, T0 + 2 * DAY);
  const lot1 = b.openLots.find((l) => l.level === 1)!;
  b = sellLot(b, lot1.id, lotTarget(b, lot1, REARM), T0 + 3 * DAY, T0 + 4 * DAY, REARM);
  assert.deepEqual(openEpoch(b)!.filledLevels, [0], 'rung 1 is free again');
  // Settle the proceeds, then a second dip to rung 1 buys it again.
  b = releaseSettled(b, T0 + 5 * DAY);
  const price = openEpoch(b)!.levels[1];
  const buy = decide(b, price, T0 + 6 * DAY, REARM).find((d) => d.action === 'BUY');
  assert.ok(buy, 'the re-armed rung buys on the next dip');
  assert.equal(buy!.level, 1);
});

test('without re-arm, a sold rung stays filled until the ladder closes', () => {
  const OFF: AccumulatorParams = { ...P, rearmSoldRungs: false };
  let b = fillRung(anchored(4, 4), 1, T0 + 2 * DAY);
  const lot1 = b.openLots.find((l) => l.level === 1)!;
  b = sellLot(b, lot1.id, lotTarget(b, lot1, OFF), T0 + 3 * DAY, T0 + 4 * DAY, OFF);
  assert.deepEqual([...openEpoch(b)!.filledLevels].sort(), [0, 1]);
});

test('with re-arm, a re-armed rung is sized from what is still open, so its money comes back', () => {
  let b = fillRung(anchored(4, 4), 1, T0 + 2 * DAY);
  const before = nextTrancheSize(b, REARM);
  const lot1 = b.openLots.find((l) => l.level === 1)!;
  b = sellLot(b, lot1.id, lotTarget(b, lot1, REARM), T0 + 3 * DAY, T0 + 4 * DAY, REARM);
  // 3 unfilled rungs share the pool minus the anchor lot: rung 1's money is back.
  const after = nextTrancheSize(b, REARM);
  assert.ok(Math.abs(after - before) / before < 0.02, `before ${before}, after ${after}`);
});

test('with re-arm, no closed lot books a loss and no rung is held twice, across 60 random paths', () => {
  let closed = 0;
  let rebought = 0;
  for (let seed = 1; seed <= 60; seed++) {
    let rng = seed * 2246822519;
    const rand = (): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    let b = withHigh(book({ tranches: 4 }), 320);
    let price = 300;
    let at = T0;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      price = Math.max(1, price * (1 + (rand() < 0.03 ? -(3 + rand() * 8) : (rand() - 0.5) * 3) / 100));
      at += DAY;
      b = releaseSettled(recordDayHigh(b, price, at), at);
      for (const d of decide(b, price, at, REARM)) {
        if (d.action === 'BUY') {
          const key = `${d.epoch}:${d.level}`;
          if (seen.has(key)) rebought++;
          seen.add(key);
          b = applyBuyFill(b, { epoch: d.epoch!, level: d.level!, fillPrice: d.limitPrice!, quantity: d.quantity!, at }, REARM);
        } else if (d.action === 'SELL') {
          b = sellLot(b, d.lotId!, d.limitPrice!, at, at + DAY, REARM);
        }
      }
      const e = openEpoch(b);
      if (e) {
        const openLevels = b.openLots.filter((l) => l.epoch === e.index).map((l) => l.level).sort();
        assert.deepEqual([...e.filledLevels].sort(), openLevels, `seed ${seed}: filled rungs and open lots disagree`);
      }
    }
    for (const lot of b.closedLots) assert.ok(lot.pnl >= 0, `seed ${seed}: ${lot.id} booked ${lot.pnl}`);
    assert.ok(b.cash >= -1e-6, `seed ${seed}: negative cash`);
    closed += b.closedLots.length;
  }
  assert.ok(closed > 50, `only ${closed} closed`);
  assert.ok(rebought > 0, 'no rung was ever bought twice — re-arm never exercised');
});

// ─── Phase 4: volatility-spaced rungs ────────────────────────────────────
test('daily volatility is the standard deviation of daily log returns', () => {
  const flat = Array.from({ length: 61 }, (_, i) => 100 * 1.01 ** i);
  assert.ok(dailyVolPct(flat)! < 1e-9, 'a constant return has no volatility');
  const zigzag = Array.from({ length: 61 }, (_, i) => (i % 2 ? 102 : 100));
  const v = dailyVolPct(zigzag)!;
  assert.ok(v > 1.9 && v < 2.1, `zigzag ±2% → ~2%, got ${v}`);
  assert.equal(dailyVolPct([100, 101, 102]), undefined, 'too few returns');
});

test('the volatility gap is k × daily vol × √20, clamped', () => {
  const cfg = { k: 1, minPct: 3, maxPct: 15 };
  assert.ok(Math.abs(volStepPct(1.5, cfg) - 1.5 * Math.sqrt(20)) < 1e-9);
  assert.equal(volStepPct(0.2, cfg), 3);
  assert.equal(volStepPct(10, cfg), 15);
});

test('a calm stock gets a tighter new ladder than a volatile one; scalp keeps its own gap', () => {
  const V: AccumulatorParams = { ...P, volStep: { enabled: true, k: 1, minPct: 3, maxPct: 15 } };
  const calm = anchoredWith(V, 1.0);
  const wild = anchoredWith(V, 2.5);
  const gap = (b: AccumulatorBook) => 1 - openEpoch(b)!.levels[1] / openEpoch(b)!.levels[0];
  assert.ok(Math.abs(gap(calm) - 0.0447) < 0.001, `calm gap ${gap(calm)}`);
  assert.ok(Math.abs(gap(wild) - 0.1118) < 0.001, `wild gap ${gap(wild)}`);
  assert.equal(paramsFor(book({ volPct: 2.5, scalp: true }), V).stepPct, paramsFor(book({ scalp: true }), P).stepPct);
  assert.equal(paramsFor(book({ volPct: 2.5 }), P).stepPct, P.stepPct, 'off by default');
});

test('an open ladder keeps its gaps when the volatility reading changes', () => {
  const V: AccumulatorParams = { ...P, volStep: { enabled: true, k: 1, minPct: 3, maxPct: 15 } };
  const b = anchoredWith(V, 1.0);
  const levels = openEpoch(b)!.levels;
  const later = syncLadder({ ...b, volPct: 3, tranches: (b.tranches ?? 3) + 1 }, V);
  assert.deepEqual(openEpoch(later)!.levels.slice(0, levels.length), levels);
});

function anchoredWith(params: AccumulatorParams, volPct: number): AccumulatorBook {
  let b = withHigh(book({ tranches: 3, volPct }), 300);
  const d = decide(b, 282, T0, params);
  return applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, params);
}

// ─── kill switch, T+1, reporting ──────────────────────────────────────────
test('the kill switch blocks a ladder buy but never an exit', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const halted = { ...b, killSwitchEngaged: true };

  const atRung = decide(halted, openEpoch(halted)!.levels[1], T0 + 2 * DAY, P);
  assert.equal(atRung.some((x) => x.action === 'BUY'), false);
  assert.match(atRung.find((x) => x.action === 'HOLD')!.reason, /Kill switch/);

  const target = lotTarget(halted, halted.openLots[0], P);
  const atTarget = decide(halted, target + 1, T0 + 2 * DAY, P);
  assert.equal(atTarget.some((x) => x.action === 'SELL'), true, 'exits must survive the kill switch');
});

test('sale proceeds are unsettled until T+1 and cannot fund a buy', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const lot = b.openLots[0];
  const target = lotTarget(b, lot, P);
  const settlesAt = nextTradingDayStart(T0 + 10 * DAY);

  b = sellLot(b, lot.id, target, T0 + 10 * DAY, settlesAt, P);
  assert.equal(b.unsettled.length, 1);
  assert.ok(unsettledCash(b) > 0);
  assert.ok(totalCash(b) > BUDGET, 'the money is ours');
  assert.ok(b.cash < BUDGET, 'but it is not spendable yet');

  assert.equal(releaseSettled(b, settlesAt - 1).cash, b.cash);
  const settled = releaseSettled(b, settlesAt);
  assert.equal(settled.unsettled.length, 0);
  assert.ok(settled.cash > BUDGET);
});

test('T+1 across a Friday lands on Monday, not Saturday', () => {
  const friday = Date.parse('2026-01-02T06:00:00Z');
  assert.equal(istParts(friday).date, '2026-01-02');
  assert.equal(istParts(nextTradingDayStart(friday)).date, '2026-01-05');
});

test('equity counts unsettled cash, so a sale is not mistaken for a loss', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const before = equity(b, 282);
  const target = lotTarget(b, b.openLots[0], P);
  b = sellLot(b, b.openLots[0].id, target, T0 + DAY, T0 + 3 * DAY, P);
  assert.ok(equity(b, 282) > before, 'a profitable sale must raise equity immediately');
});

test('an epoch closes when its last lot exits, and the gate must pass again', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  const target = lotTarget(b, b.openLots[0], P);
  b = sellLot(b, b.openLots[0].id, target, T0 + DAY, T0 + 3 * DAY, P);

  assert.equal(b.epochs[0].status, 'CLOSED');
  assert.equal(openEpoch(b), undefined);
  const near = decide(b, 299, T0 + 5 * DAY, P);
  assert.match(near.find((x) => x.action === 'HOLD')!.reason, /Start gate/);
});

test('a buy fill naming the wrong epoch is refused', () => {
  let b = withHigh(book(), 300);
  const d = decide(b, 282, T0, P);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 282, quantity: d[0].quantity!, at: T0 }, P);
  assert.throws(
    () => applyBuyFill(b, { epoch: 99, level: 1, fillPrice: 265, quantity: 10, at: T0 + DAY }, P),
    /does not belong to/,
  );
});

test('tranche sizing respects the reserve', () => {
  assert.ok(Math.abs(trancheSize(300_000, P) - (300_000 * 0.85) / 12) < 1e-9);
});

if (failures.length) {
  console.error(`✗ accumulator: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ accumulator: ${passed} passed`);

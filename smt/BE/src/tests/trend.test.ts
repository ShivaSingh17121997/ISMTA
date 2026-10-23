/**
 * Regime autopilot tests.
 *
 * The autopilot owns a switch that changes the targets on open lots, so the
 * properties that matter are the ones that stop it thrashing: a neutral band
 * so EMAs brushing past each other do not read as a trend, confirmation so a
 * one-day wobble changes nothing, and a rate limit so an oscillating regime
 * cannot drag the profile with it.
 *
 * It cannot affect the no-loss guarantee — both profiles sell only above
 * fee-inclusive cost — so these tests are about stability, not safety.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_TREND_OPTIONS as T,
  autoProfileDecision,
  classifyRegime,
  profileForRegime,
} from '../services/accumulator/trend';
import type { AccumulatorBook } from '../services/accumulator/types';

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

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-08T10:00:00Z');

/** `n` closes drifting at `drift` per bar, with an optional oscillation. */
function series(n: number, drift: number, wobble = 0, start = 100): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + drift;
    out.push(p * (1 + Math.sin(i / 3) * wobble));
  }
  return out;
}

type BookBits = Pick<AccumulatorBook, 'scalp' | 'autoProfile' | 'profileSwitchedAt'>;
const bits = (over: Partial<BookBits> = {}): BookBits => ({ autoProfile: true, ...over });

// ─── classification ───────────────────────────────────────────────────────
test('a sustained rise is classified up and confirmed', () => {
  const r = classifyRegime(series(200, 0.004));
  assert.equal(r.regime, 'up');
  assert.equal(r.confirmed, true);
  assert.ok(r.spreadPct > T.bandPct, `spread ${r.spreadPct} should clear the band`);
});

test('a sustained fall is classified down', () => {
  const r = classifyRegime(series(200, -0.004));
  assert.equal(r.regime, 'down');
  assert.ok(r.spreadPct < -T.bandPct);
});

test('a flat market is sideways, not a coin flip between up and down', () => {
  const r = classifyRegime(series(200, 0));
  assert.equal(r.regime, 'sideways');
  assert.ok(Math.abs(r.spreadPct) <= T.bandPct);
});

test('the neutral band absorbs a drift too small to be a trend', () => {
  // Drifts upward, but not enough to separate the EMAs past the band.
  const r = classifyRegime(series(200, 0.0002));
  assert.equal(r.regime, 'sideways', `spread was ${r.spreadPct}`);
});

test('too little history reports no regime rather than guessing', () => {
  const r = classifyRegime(series(20, 0.01));
  assert.equal(r.regime, null);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /insufficient history/);
});

test('a one-bar spike does not confirm a new regime', () => {
  const closes = series(200, 0);
  closes[closes.length - 1] *= 1.35; // one violent day
  const r = classifyRegime(closes);
  assert.equal(r.confirmed, false, 'a single bar must not confirm');
  assert.equal(r.regime, null);
  assert.match(r.reason, /unconfirmed/);
});

test('the regime is only confirmed once the read agrees with itself', () => {
  const r = classifyRegime(series(200, 0.004));
  assert.equal(r.confirmed, true);
  assert.match(r.reason, new RegExp(`held ${T.confirmBars} bars`));
});

// ─── the mapping the user asked for ───────────────────────────────────────
test('sideways calls for scalp; a rising trend calls for swing', () => {
  assert.equal(profileForRegime('sideways'), 'scalp');
  assert.equal(profileForRegime('up'), 'swing');
});

test('a downtrend calls for swing, never scalp', () => {
  // Scalp's 2% gate and 2h brake would ladder into a falling market far
  // faster, and no-loss means those lots cannot be cut.
  assert.equal(profileForRegime('down'), 'swing');
});

// ─── the autopilot decision ───────────────────────────────────────────────
test('autopilot off changes nothing, whatever the regime', () => {
  const d = autoProfileDecision(bits({ autoProfile: false }), classifyRegime(series(200, 0)), NOW);
  assert.equal(d.scalp, null);
  assert.match(d.reason, /autopilot off/);
});

test('a sideways read switches a swing book to scalp', () => {
  const d = autoProfileDecision(bits({ scalp: false }), classifyRegime(series(200, 0)), NOW);
  assert.equal(d.scalp, true);
  assert.match(d.reason, /switching to scalp/);
});

test('an uptrend switches a scalping book back to swing', () => {
  const d = autoProfileDecision(bits({ scalp: true }), classifyRegime(series(200, 0.004)), NOW);
  assert.equal(d.scalp, false);
  assert.match(d.reason, /switching to swing/);
});

test('a book already on the right profile is left alone', () => {
  const d = autoProfileDecision(bits({ scalp: true }), classifyRegime(series(200, 0)), NOW);
  assert.equal(d.scalp, null);
  assert.match(d.reason, /already there/);
});

test('an unconfirmed read never moves the profile', () => {
  const closes = series(200, 0);
  closes[closes.length - 1] *= 1.35;
  const d = autoProfileDecision(bits({ scalp: false }), classifyRegime(closes), NOW);
  assert.equal(d.scalp, null);
  assert.match(d.reason, /holding the current profile/);
});

test('a flip inside the rate limit is refused with the wait time', () => {
  const d = autoProfileDecision(
    bits({ scalp: false, profileSwitchedAt: NOW - 2 * HOUR }),
    classifyRegime(series(200, 0)),
    NOW,
  );
  assert.equal(d.scalp, null);
  assert.match(d.reason, /waiting \d+h more/);
});

test('a flip is allowed once the rate limit has expired', () => {
  const d = autoProfileDecision(
    bits({ scalp: false, profileSwitchedAt: NOW - 25 * HOUR }),
    classifyRegime(series(200, 0)),
    NOW,
  );
  assert.equal(d.scalp, true);
});

test('an oscillating regime cannot flip the profile more than once a day', () => {
  // Alternate the market between flat and rising every step and count flips.
  let book: BookBits = bits({ scalp: false, profileSwitchedAt: undefined });
  let flips = 0;
  let now = NOW;
  for (let i = 0; i < 40; i++) {
    const read = classifyRegime(series(200, i % 2 === 0 ? 0 : 0.004));
    const d = autoProfileDecision(book, read, now, T);
    if (d.scalp !== null) {
      flips++;
      book = { ...book, scalp: d.scalp, profileSwitchedAt: now };
    }
    now += 6 * HOUR; // check every six hours over ten days
  }
  assert.ok(flips <= 11, `expected at most one flip a day over ten days, saw ${flips}`);
});

if (failures.length) {
  console.error(`✗ trend: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ trend: ${passed} passed`);

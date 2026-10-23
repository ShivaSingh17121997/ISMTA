/**
 * The plain-language read of the market. Pure.
 *
 * THE LEVEL DESCRIBES CONDITIONS, NOT A FORECAST. "Stormy" means the market is
 * in a correction or a validated warning sign is on. It does not mean a fall is
 * coming, and the text never says one is: no dates, no targets, no "will fall".
 * That is enforced by `BANNED` and a test over every string this file can
 * produce, because the measured failure mode of this feature (MARKET_WEATHER.md)
 * is sliding back into confident timing claims that history does not support.
 *
 * GUIDANCE follows the evidence, which is often the opposite of instinct:
 *   - in a correction, forward returns from similar states were ABOVE average,
 *     so the advice is staged buying with cash kept ready — never "sell";
 *   - a grade-A/B warning near highs is the one case where slowing new buying
 *     was supported in both halves of history;
 *   - the no-loss floor is never overridden; nothing here sells a lot.
 */
import type { Calibration, RuleId } from './calibrate';
import type { Analogs, SignalRead } from './odds';
import type { MarketState, SignalId } from './regime';

export type Level = 'calm' | 'unsettled' | 'stormy' | 'severe';

export const LEVEL_LABEL: Record<Level, string> = {
  calm: 'Calm',
  unsettled: 'Unsettled',
  stormy: 'Stormy',
  severe: 'Severe',
};

/** Phrases this feature must never produce. */
export const BANNED: RegExp[] = [
  /\bwill (fall|crash|drop|decline|collapse|rise|rally|recover)\b/i,
  /\bis (due|coming|imminent)\b/i,
  /\bcrash (on|by|in|within)\b/i,
  /\bin \d+ (trading )?(days|weeks|months)\b/i,
  /\b(by|before|on) \d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /\b(target|go to|head(ing)? to) \d/i,
  /\bguarantee/i,
  /\bsell (everything|all|now)\b/i,
  /\bdo not buy\b/i,
];

export function violations(text: string): string[] {
  return BANNED.filter((r) => r.test(text)).map((r) => r.source);
}

export interface Summary {
  level: Level;
  headline: string;
  /** Why the level is what it is. */
  drivers: string[];
  /** What history says about states like this one. */
  odds: string[];
  /** What the evidence supports doing. */
  guidance: string[];
  note: string;
}

const PHASE_TEXT: Record<MarketState['phase'], string> = {
  'at-highs': 'near its high',
  pullback: 'in a pullback',
  correction: 'in a correction',
  bear: 'in a bear market',
};

const p0 = (x: number | null | undefined): string => (x == null ? '–' : `${Math.round(x * 100)}%`);
const signed = (x: number | null | undefined): string => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`);

export interface SectorLeaders {
  /** Beat the index in at least 70% of past falls, on average. */
  heldUp: string[];
  /** Beat the index in at least 60% of the 6-month rebounds, by 5pp or more on average. */
  ledRebound: string[];
}

/** Read the leaders from calibration, so a re-run changes the advice with the data. */
export function sectorLeaders(cal: Calibration): SectorLeaders {
  const s = cal.sectors ?? [];
  const share = (x: { beat: number; n: number }): number => (x.n ? x.beat / x.n : 0);
  const heldUp = s
    .filter((x) => x.inFall.n >= 5 && share(x.inFall) >= 0.7 && (x.inFall.meanPp ?? 0) > 0)
    .sort((a, b) => share(b.inFall) - share(a.inFall))
    .map((x) => x.sector);
  const ledRebound = s
    .filter((x) => x.rebound.n >= 5 && share(x.rebound) >= 0.6 && (x.rebound.meanPp ?? 0) >= 5)
    .sort((a, b) => (b.rebound.meanPp ?? 0) - (a.rebound.meanPp ?? 0))
    .map((x) => x.sector);
  return { heldUp, ledRebound };
}

/** The sign each exposure rule acts on. */
const RULE_SIGNAL: Partial<Record<RuleId, SignalId>> = {
  breadthHalf: 'breadthDivergence',
  spxHalf: 'spxBelow200',
  trend200Half: 'below200',
  trend200Out: 'below200',
};

/**
 * Signs whose exposure rule beat the same-exposure mix in BOTH halves of
 * history. Only these may ever carry "slow new buying" advice; every other sign
 * is information. Read from the calibration so a re-run can add or remove one.
 */
export function supportedSignals(cal: Calibration): SignalId[] {
  const out = new Set<SignalId>();
  for (const r of cal.rules) {
    const sig = RULE_SIGNAL[r.id];
    if (sig && r.halves[0].edgePp > 0 && r.halves[1].edgePp > 0) out.add(sig);
  }
  return [...out];
}

/** Graded warning signs that are on (turbulence and calm signs are counted separately). */
const warningsOn = (signals: SignalRead[]): SignalRead[] =>
  signals.filter((s) => s.on === true && s.grade !== 'C' && s.direction === 'higher' && (s.kind ?? 'warning') === 'warning');
/** Graded turbulence signs that are on: rough weeks ahead, not a crash call. */
export const turbulenceOn = (signals: SignalRead[]): SignalRead[] => signals.filter((s) => s.on === true && s.grade !== 'C' && s.kind === 'turbulence');
/** Graded calm signs that are on: past returns from here were above normal. */
export const calmOn = (signals: SignalRead[]): SignalRead[] => signals.filter((s) => s.on === true && s.grade !== 'C' && s.kind === 'calm');

export function levelOf(state: MarketState, signals: SignalRead[]): Level {
  const strongOn = warningsOn(signals).length > 0;
  if (state.phase === 'bear' || (state.indiaVix != null && state.indiaVix > 30)) return 'severe';
  if (state.phase === 'correction' || strongOn) return 'stormy';
  if (state.phase === 'pullback' || state.active.includes('below200') || state.brentDaysAbove90 >= 20 || turbulenceOn(signals).length) return 'unsettled';
  return 'calm';
}

export function summarize(
  state: MarketState,
  signals: SignalRead[],
  analogs: Analogs | null,
  indexLabel: string,
  supported: SignalId[] = [],
  leaders: SectorLeaders = { heldUp: [], ledRebound: [] },
  levelAtHighs?: Calibration['levelAtHighs'],
): Summary {
  const level = levelOf(state, signals);
  const drivers: string[] = [];
  drivers.push(`${indexLabel} is ${Math.abs(state.fromAthPct).toFixed(1)}% below its high (${PHASE_TEXT[state.phase]}).`);
  if (state.vs200Pct != null) {
    drivers.push(
      state.vs200Pct < 0
        ? `It is ${Math.abs(state.vs200Pct).toFixed(1)}% below its 200-day average${state.deathCross ? ', and the 50-day is below the 200-day' : ''}.`
        : `It is ${state.vs200Pct.toFixed(1)}% above its 200-day average.`,
    );
  }
  if (state.breadthPct != null) drivers.push(`${Math.round(state.breadthPct)}% of NIFTY 500 stocks are above their own 200-day average.`);
  if (state.brentDaysAbove90 >= 5 && state.brent != null) {
    drivers.push(`Brent is $${state.brent.toFixed(0)}, above $90 for ${state.brentDaysAbove90} sessions.`);
  }
  if (state.indiaVix != null) drivers.push(`India VIX is ${state.indiaVix.toFixed(1)}.`);
  for (const s of warningsOn(signals)) drivers.push(`Warning sign on (grade ${s.grade}): ${s.label.toLowerCase()}.`);
  for (const s of turbulenceOn(signals)) drivers.push(`Turbulence sign on (grade ${s.grade}): ${s.label.toLowerCase()}. Expect rougher weeks.`);
  for (const s of calmOn(signals)) drivers.push(`Calm sign on (grade ${s.grade}): ${s.label.toLowerCase()}.`);

  const odds: string[] = [];
  if (analogs && analogs.episodes.length) {
    const y = analogs.forward.find((f) => f.horizonDays === 252);
    odds.push(
      `Similar past states: ${analogs.spec.describe.charAt(0).toLowerCase()}${analogs.spec.describe.slice(1)} — ${analogs.episodes.length} separate episodes since ${analogs.episodes[0].slice(0, 4)}.`,
    );
    if (analogs.furtherFallOdds != null) {
      odds.push(
        `Another 10%+ fall within 3 months followed ${p0(analogs.furtherFallOdds)} of those days (all days: ${p0(analogs.baselineFallOdds)}).`,
      );
      if (analogs.baselineFallOddsRecent != null) {
        odds.push(
          `Since ${analogs.recentFrom.slice(0, 4)} the market has been calmer: a 10%+ fall within 3 months followed ${p0(analogs.baselineFallOddsRecent)} of all days` +
            (analogs.recentMatchDays >= 60 ? `, and ${p0(analogs.furtherFallOddsRecent)} of days like today.` : '.'),
        );
      }
    }
    if (y && y.median != null && analogs.completeEpisodes >= 3) {
      odds.push(
        `Twelve months later the index was higher ${p0(y.shareHigher)} of the time, median ${signed(y.median)} (all days: ${signed(analogs.baselineForward[2].median)}), across ${analogs.completeEpisodes} episodes with a full year since.`,
      );
    }
    if (analogs.worstFurtherFallP10 != null && analogs.worstFurtherFallP10 < -0.1) {
      odds.push(`In the worst tenth of cases the index first fell another ${p0(-analogs.worstFurtherFallP10)}.`);
    }
  } else {
    odds.push('No close match in past history, so no odds are shown for this state.');
  }
  // Near a high, say plainly how often this level has been right before.
  const here = levelAtHighs?.[level];
  const calmAt = levelAtHighs?.calm;
  if (state.phase === 'at-highs' && here?.hitRate != null && level !== 'calm') {
    odds.push(
      `Near past highs, days that read "${LEVEL_LABEL[level].toLowerCase()}" were followed by a 10%+ fall within 3 months ${p0(here.hitRate)} of the time` +
        (calmAt?.hitRate != null ? ` (days that read calm: ${p0(calmAt.hitRate)}).` : '.') +
        ' Most such readings were not followed by a fall.',
    );
  }

  const guidance: string[] = [];
  const strongOn = warningsOn(signals);
  const y = analogs?.forward.find((f) => f.horizonDays === 252);
  const base12 = analogs?.baselineForward[2]?.median;
  if (state.phase === 'correction' || state.phase === 'bear') {
    if (y?.median != null && base12 != null && y.median > base12) {
      guidance.push('Past returns from states like this were above average. History favours buying in steps here, not stopping.');
    } else {
      guidance.push('Buy in steps rather than all at once; the path from here has been rough in the past.');
    }
    guidance.push('Keep cash ready for lower rungs instead of spending it on the first dip.');
  }
  const actionable = signals.filter((s) => s.on === true && supported.includes(s.id));
  for (const s of actionable) {
    guidance.push(
      `"${s.label}" is the kind of sign where slowing new buying and keeping cash ready beat simply holding less, in both halves of history. Selling existing lots was not tested as better.`,
    );
  }
  if (turbulenceOn(signals).length) guidance.push('Rough weeks are more likely than usual. Use smaller buying steps, spaced further apart, rather than skipping them.');
  if (calmOn(signals).length) guidance.push('Fear is priced high. In the past, the 3 months after this beat the normal return in both halves of history, so buying in steps can go faster.');
  if (!guidance.length) guidance.push('No action is supported by the evidence. Carry on with the normal plan.');
  if (leaders.heldUp.length || leaders.ledRebound.length) {
    const parts: string[] = [];
    if (leaders.heldUp.length) parts.push(`Held up best in past falls: ${leaders.heldUp.slice(0, 4).join(', ')}.`);
    if (leaders.ledRebound.length) parts.push(`Led the 6 months after past bottoms: ${leaders.ledRebound.slice(0, 4).join(', ')}.`);
    guidance.push(parts.join(' '));
  }

  const headline = `${LEVEL_LABEL[level]}: ${indexLabel} ${PHASE_TEXT[state.phase]}${state.active.includes('below200') ? ', in a downtrend' : ''}${
    state.brentDaysAbove90 >= 20 ? ', oil above $90' : ''
  }${strongOn.length ? `, ${strongOn.length} warning sign${strongOn.length > 1 ? 's' : ''} on` : ''}`;

  return {
    level,
    headline,
    drivers,
    odds,
    guidance,
    note: 'The level describes conditions today. It is not a forecast, and no date or price target is ever given.',
  };
}

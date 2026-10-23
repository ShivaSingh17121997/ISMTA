/**
 * Cleaning for Yahoo daily bars, shared by the live engine and the backtest.
 *
 * Yahoo's NSE history has bad prints: NIFTYBEES and BANKBEES trade at a tenth
 * of their price on 19-20 Dec 2019. Live, a bad HIGH inflates a book's 45-day
 * high and freezes its start gate; a bad close skews the trend read and the
 * allocator's strength score. So every daily series is cleaned before use.
 */
import { istParts } from './session';
import type { Candle } from '../types';

/**
 * Drop bad prints: a short run of bars that jumps by more than `jump` (×) from
 * the last good close and comes back within `revert` of it inside `maxRun`
 * bars. Yahoo has these (NIFTYBEES and BANKBEES trade at a tenth of their price
 * on 19–20 Dec 2019), and a ladder reads them as a real crash it can buy and
 * sell for a tenfold "profit". A real move does not snap back like that; one
 * that does not revert is kept. Pure.
 */
export function dropBadPrints(
  bars: Candle[],
  opts: { jump?: number; revert?: number; maxRun?: number } = {},
): { bars: Candle[]; dropped: string[] } {
  const jump = Math.log(opts.jump ?? 1.6);
  const revert = Math.log(1 + (opts.revert ?? 0.2));
  const maxRun = opts.maxRun ?? 5;
  const out: Candle[] = [];
  const dropped: string[] = [];
  let i = 0;
  while (i < bars.length) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(Math.log(bars[i].close / prev.close)) > jump) {
      let back = -1;
      for (let k = i + 1; k < Math.min(bars.length, i + 1 + maxRun); k++) {
        if (Math.abs(Math.log(bars[k].close / prev.close)) < revert) {
          back = k;
          break;
        }
      }
      if (back > 0) {
        for (let k = i; k < back; k++) dropped.push(istParts(bars[k].timestamp).date);
        i = back;
        continue;
      }
    }
    out.push(bars[i]);
    i++;
  }
  return { bars: out, dropped };
}

/**
 * Bad prints out, then a spiked high clamped to the bar's open/close: one more
 * than `maxJump` above the previous close AND more than `spike` above both the
 * open and the close. The first test alone is not enough: F&O stocks have no
 * fixed circuit band, so a real +30% day happens, and its high sits near the
 * close. A print error stands alone above the bar. Pure.
 */
export function cleanDailyBars(bars: Candle[], maxJump = 0.25, spike = 0.1): Candle[] {
  const { bars: kept } = dropBadPrints(bars);
  return kept.map((c, i) => {
    const prev = kept[i - 1]?.close;
    const body = Math.max(c.open, c.close);
    if (prev && c.high > prev * (1 + maxJump) && c.high > body * (1 + spike)) return { ...c, high: body };
    return c;
  });
}

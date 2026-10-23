'use client';

import { useTheme } from '../providers/ThemeProvider';

/**
 * Chart colours, one selected set per theme.
 *
 * Extracted from `NavChart` so a page that wants a colour does not have to
 * import Recharts to get one — the dashboard draws its own SVG and would
 * otherwise pull the whole charting library into its bundle for a palette.
 * `NavChart` re-exports these, so every existing import still resolves.
 *
 * Dark mode is SELECTED, not an automatic flip of the light values: each set
 * was validated against its own surface (#ffffff and #09090b, the card
 * backgrounds the marks actually sit on) for lightness band, chroma floor,
 * colour-vision separation between adjacent slots, and contrast.
 *
 * The categorical slots are a FIXED ORDER, never cycled. `cat1/cat2/cat3` are
 * the first three; a fourth series is not a generated hue, it folds into
 * "Other" or becomes small multiples.
 */

export interface ChartPalette {
  /** Slot 1 — also the account's NAV line. */
  nav: string;
  /** Slot 2 — also the NIFTY benchmark line. */
  nifty: string;
  grid: string;
  axis: string;
  muted: string;
  surface: string;
  ink: string;
  /** Status. Reserved: never reused as a series colour. */
  bad: string;
  good: string;
  /** Categorical slots, fixed order. cat1/cat2 alias nav/nifty by design. */
  cat1: string;
  cat2: string;
  cat3: string;
}

const PALETTES: Record<'light' | 'dark', ChartPalette> = {
  light: {
    nav: '#2a78d6',
    nifty: '#eb6834',
    grid: '#e4e4e7',
    axis: '#d4d4d8',
    muted: '#71717a',
    surface: '#ffffff',
    ink: '#18181b',
    bad: '#d03b3b',
    good: '#0ca30c',
    cat1: '#2a78d6',
    cat2: '#eb6834',
    // Violet was chosen over teal and gray: gray failed the chroma floor
    // (reads as "no data"), and violet gave the widest worst-case separation
    // under simulated protanopia — ΔE 24.7 against the pair beside it.
    cat3: '#8b5cf6',
  },
  dark: {
    nav: '#3987e5',
    nifty: '#d95926',
    grid: '#27272a',
    axis: '#3f3f46',
    muted: '#898781',
    surface: '#09090b',
    ink: '#fafafa',
    bad: '#e66767',
    good: '#0ca30c',
    cat1: '#3987e5',
    cat2: '#d95926',
    // Same hue as light: it passed the dark surface checks on its own, so
    // there was no reason to step it. A lighter violet (#a78bfa) failed the
    // lightness band here.
    cat3: '#8b5cf6',
  },
};

/** The chart colours for the theme in force. Safe to call during render. */
export function useChartPalette(): ChartPalette {
  const { resolved } = useTheme();
  return PALETTES[resolved];
}

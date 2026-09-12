/**
 * The match clock as the chrome shows it, and the number formatting every
 * readout shares.
 *
 * THE CEILING IS THE SPEC. Section 12: the clock reads `01:00` for the whole
 * first second and `00:00` only at exactly zero. The match stores exact
 * seconds (that reading is PF-7's), so the display owns one rounding and it
 * is the ceiling: any remainder, however small, is a second the player still
 * has. Exactly zero, and only exactly zero, is time up. A negative remainder
 * cannot arrive from the match, but the guard is written as `!(remaining >
 * 0)` rather than `remaining === 0` so that the whole non-positive half
 * reads 00:00 instead of propagating a minus sign into the minutes.
 *
 * LOCALE, EXPLICITLY. QUALITY-BAR section 11: `Intl` with no locale argument
 * reads the host default locale, which has no relationship to the document's
 * `lang` attribute, so the list is always explicit and resolved as
 * `[...(navigator.languages ?? []), 'en-US']`, the documented fallback last.
 * Grouping is off: several locales group with U+202F rather than a plain
 * space, and an MM:SS pair has no digits that could ever need a separator.
 */

const FALLBACK_LOCALE = 'en-US';

/** The host languages, or none where no host names any. */
export function hostLocales(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  return [...(navigator.languages ?? [])];
}

interface Formatters {
  readonly locales: string;
  readonly number: Intl.NumberFormat;
  readonly twoDigits: Intl.NumberFormat;
}

let cached: Formatters | undefined;

/**
 * The chrome does sync once per frame, so formatter construction belongs on a
 * locale edge rather than a readout edge. The cache key is the complete,
 * ordered locale list, including the explicit fallback; changing
 * `navigator.languages` therefore builds fresh formatters on the next read.
 */
function formatters(locales: readonly string[]): Formatters {
  const resolved = [...locales, FALLBACK_LOCALE];
  const key = JSON.stringify(resolved);
  if (cached?.locales === key) {
    return cached;
  }
  cached = {
    locales: key,
    number: new Intl.NumberFormat(resolved, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      useGrouping: false,
    }),
    twoDigits: new Intl.NumberFormat(resolved, {
      minimumIntegerDigits: 2,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      useGrouping: false,
    }),
  };
  return cached;
}

/** The displayed second count: the ceiling, and 00:00 only at exactly zero. */
export function ceilingSeconds(remaining: number): number {
  if (!(remaining > 0)) {
    return 0;
  }
  return Math.ceil(remaining);
}

/** The clock face: exact seconds remaining in, MM:SS ceiling-rounded out. */
export function formatClock(remaining: number, locales?: readonly string[]): string {
  const seconds = ceilingSeconds(remaining);
  const minutes = Math.floor(seconds / 60);
  const within = seconds % 60;
  const digits = formatters(locales ?? hostLocales()).twoDigits;
  return `${digits.format(minutes)}:${digits.format(within)}`;
}

/** A plain count in the host locale: scores and the ladder rung. */
export function formatNumber(value: number, locales?: readonly string[]): string {
  return formatters(locales ?? hostLocales()).number.format(value);
}

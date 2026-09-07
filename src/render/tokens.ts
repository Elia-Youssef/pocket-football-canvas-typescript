/**
 * The renderer's half of the token layer, item E1.
 *
 * WHY THERE ARE TWO FORMS OF THE SAME THING. A Canvas 2D context takes a colour
 * string and a number. It cannot take a `var()`, and reading a custom property
 * back out of the document per draw call would put a layout read in the hot
 * path. So the play surface gets the same values as plain data, and the two
 * forms are held together by a test rather than by anybody remembering.
 *
 * THIS FILE READS NOTHING. It does not parse the stylesheet, and the stylesheet
 * does not read it: a shared source that one of them derives from would make
 * the other's copy unfalsifiable, and the point of the arrangement is that a
 * third document, tests/reference/design-contract.json, can disagree with either.
 * It also asks the platform nothing. Whether motion is reduced is a policy
 * decision read once, outside this layer, and passed in.
 *
 * Sources, neither of which is here: the numeric scales are QUALITY-BAR section
 * 15, the palette is SPEC section 18.
 */

/**
 * The two brightness variants of the pitch. SPEC section 18: the dark theme is
 * a floodlit night pitch and the light theme is daylight, and the difference is
 * a brightness variant rather than a second palette. The luminance ORDER of
 * everything on the pitch is the same in both, which is what the section's
 * contrast guarantees are built on.
 */
export type Brightness = 'floodlit' | 'daylight';

/** The chrome's two themes, which the variants above are tied to. */
export type Theme = 'dark' | 'light';

/** SPEC section 18's tie between the two, in one place. */
export const BRIGHTNESS_BY_THEME = {
  dark: 'floodlit',
  light: 'daylight',
} as const satisfies Record<Theme, Brightness>;

/**
 * Every colour the play surface draws with.
 *
 * `line` is the boundary token: SPEC section 18 gives every meaningful object
 * on the pitch a light outline at 3:1 against what is behind it, and the fill
 * inside that outline carries identity rather than contrast. `teamPlayer` and
 * `teamOpponent` are those fills, separated in relative luminance rather than
 * in hue, because hue is what protanopia and deuteranopia collapse.
 *
 * `accent` is the aim arrow's strong end, which the same section ramps to from
 * `line` at the weak end. It is the chrome accent read through the theme rather
 * than a colour of its own.
 */
export interface PitchPalette {
  readonly stripeA: string;
  readonly stripeB: string;
  readonly line: string;
  readonly rail: string;
  readonly teamPlayer: string;
  readonly teamOpponent: string;
  readonly glyphOnPlayer: string;
  readonly glyphOnOpponent: string;
  readonly ballBody: string;
  readonly ballPanel: string;
  readonly accent: string;
}

export const PLAY_SURFACE = {
  floodlit: {
    stripeA: '#2A7336',
    stripeB: '#2F7D3C',
    line: '#F2F7F3',
    rail: '#C8CFCB',
    teamPlayer: '#5590CE',
    teamOpponent: '#6E1712',
    glyphOnPlayer: '#0A1A2B',
    glyphOnOpponent: '#F2F7F3',
    ballBody: '#FAFAF8',
    ballPanel: '#1A1A1A',
    accent: '#F5C542',
  },
  daylight: {
    stripeA: '#359045',
    stripeB: '#3C9A4D',
    line: '#F2F7F3',
    rail: '#DDE3DF',
    teamPlayer: '#5590CE',
    teamOpponent: '#6E1712',
    glyphOnPlayer: '#0A1A2B',
    glyphOnOpponent: '#F2F7F3',
    ballBody: '#FAFAF8',
    ballPanel: '#1A1A1A',
    accent: '#7A5A06',
  },
} as const satisfies Record<Brightness, PitchPalette>;

/** The palette in force for a theme, which is the only way to pick one. */
export function pitchFor(theme: Theme): PitchPalette {
  return PLAY_SURFACE[BRIGHTNESS_BY_THEME[theme]];
}

/**
 * The numeric scales, in the units the renderer works in: logical pixels for
 * anything spatial, milliseconds for anything timed. Unitless, because a
 * canvas coordinate has no unit and a string would have to be parsed back.
 *
 * There is deliberately no type scale here. QUALITY-BAR section 15 gives the
 * play surface no text scale of its own: anything a player needs in order to
 * decide is real DOM text, and only a glyph whose presentation is essential to
 * the depiction may live on the canvas at all.
 */
export const SPACE = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
} as const;

export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 14,
  pill: 999,
} as const;

export const BORDER = {
  hair: 1,
  thin: 2,
  thick: 3,
} as const;

export const DURATION = {
  0: 0,
  1: 80,
  2: 140,
  3: 220,
  4: 320,
} as const;

export const EASING = {
  out: 'cubic-bezier(0.2, 0, 0, 1)',
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/** The five steps, so a caller cannot name a duration that does not exist. */
export type DurationStep = keyof typeof DURATION;

/**
 * A duration in milliseconds, resolved against the reduced-motion setting.
 *
 * QUALITY-BAR section 4: reduced motion removes animation entirely, and the
 * sequence of states and the outcome must not change. Returning zero is what
 * removes the animation while leaving whatever is sequenced after it to run in
 * the same order, which is why nothing here skips a step or takes a branch.
 *
 * The flag is a parameter and not a media query read: this layer states the
 * value, and the composition root decides the policy.
 */
export function duration(step: DurationStep, reducedMotion: boolean): number {
  return reducedMotion ? DURATION[0] : DURATION[step];
}

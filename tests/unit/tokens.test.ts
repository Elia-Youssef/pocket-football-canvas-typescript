import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BORDER,
  BRIGHTNESS_BY_THEME,
  DURATION,
  EASING,
  PLAY_SURFACE,
  RADIUS,
  SPACE,
  duration,
  pitchFor,
  playSurfaceFor,
} from '../../src/render/tokens';
import type { Brightness, DurationStep, Theme } from '../../src/render/tokens';

/**
 * Item E1: every colour, spacing, radius, type and motion value comes from a
 * token on the QUALITY-BAR section 15 scales, and no literal value appears in
 * component code.
 *
 * THREE SOURCES, ONE OF WHICH IS NOT SHIPPED.
 *
 *   src/ui/tokens.css              what the chrome reads
 *   src/render/tokens.ts           the same values as data, because a canvas
 *                                  context takes a colour string and not a var()
 *   tests/reference/design-contract.json
 *                                  a hand copy of QUALITY-BAR section 15 and
 *                                  SPEC section 18, which this file reads
 *
 * The two shipped forms are checked against the contract and against each
 * other. Nothing here checks the contract against the two outside documents,
 * because they are outside this repository; that copy is a reviewer's job and
 * the contract file says so in its own first paragraph.
 *
 * EVERY QUOTED RATIO IS RE-DERIVED, from the hexes alone, with the relative
 * luminance arithmetic written out below rather than borrowed from anything
 * that also produced the numbers. A palette whose measurements are asserted by
 * quoting them is a palette nobody measured.
 *
 * The sweep at the end covers every file under src/ that later parts have not
 * been written yet, which is why it was installed at this part rather than at
 * the part that first draws something.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const SOURCE_ROOT = path.join(PROJECT_ROOT, 'src');
const STYLESHEET = path.join(PROJECT_ROOT, 'src', 'ui', 'tokens.css');
const CONTRACT = path.join(PROJECT_ROOT, 'tests', 'reference', 'design-contract.json');
const ENTRY = path.join(PROJECT_ROOT, 'src', 'main.ts');

/** Relative, POSIX, so a path reads the same in a message on either platform. */
const TOKEN_LAYER = ['src/ui/tokens.css', 'src/render/tokens.ts'];

const stylesheetText = readFileSync(STYLESHEET, 'utf8');
const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Record<string, Table[]>;

// ---------------------------------------------------------------------------
// Relative luminance and contrast, WCAG 2.x, written out on purpose.
// ---------------------------------------------------------------------------

function channel(byte: number): number {
  const value = byte / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (match === null) {
    throw new Error(`not a six-digit hex colour: ${JSON.stringify(hex)}`);
  }
  const digits = match[1] ?? '';
  const byte = (at: number): number => Number.parseInt(digits.slice(at, at + 2), 16);
  return 0.2126 * channel(byte(0)) + 0.7152 * channel(byte(2)) + 0.0722 * channel(byte(4));
}

function contrast(one: string, other: string): number {
  const a = luminance(one);
  const b = luminance(other);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Two decimal places, which is the precision both documents quote. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// The contract's tables, read by section and column name.
// ---------------------------------------------------------------------------

interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function tablesUnder(heading: string): Table[] {
  const found = contract[heading];
  if (found === undefined) {
    throw new Error(`the contract has no section headed ${JSON.stringify(heading)}`);
  }
  return found;
}

function tableUnder(heading: string): Table {
  const found = tablesUnder(heading);
  const first = found[0];
  if (first === undefined) {
    throw new Error(`the contract section ${JSON.stringify(heading)} carries no table`);
  }
  return first;
}

function field(table: Table, row: readonly string[], header: string): string {
  const at = table.headers.indexOf(header);
  if (at === -1) {
    throw new Error(
      `no column headed ${JSON.stringify(header)}, the columns are ${table.headers.join(', ')}`,
    );
  }
  return row[at] ?? '';
}

const SCALES = tableUnder('1. Numeric scales');
const CHROME = tableUnder('2. Chrome palette');
const SURFACE = tableUnder('3. Play surface palette');
const ARROW_ACCENT = tableUnder('4. The eleventh colour the play surface uses');
const PAIRS = tableUnder('5. Measured pairs');
const IDENTITY = tableUnder('6. Identity separation, in relative luminance');
const RETRACTED = tableUnder('7. The retracted claim');
const SCOPED = tableUnder('8. Cells the threshold does not govern');
const FORCED_ONLY = tableUnder('10. Cells stated for the high-contrast variant alone');
/** SPEC section 18's own luminance column for the eleven high-contrast values. */
const FORCED_LUMINANCE = tablesUnder('10. Cells stated for the high-contrast variant alone')[1] ?? {
  headers: [],
  rows: [],
};

/** A play-surface token's value per variant, including the arrow's accent. */
const SURFACE_BY_VARIANT: Record<Brightness, Map<string, string>> = {
  floodlit: new Map(),
  daylight: new Map(),
  highcontrast: new Map(),
};
for (const table of [SURFACE, ARROW_ACCENT]) {
  for (const row of table.rows) {
    SURFACE_BY_VARIANT.floodlit.set(field(table, row, 'Token'), field(table, row, 'Floodlit'));
    SURFACE_BY_VARIANT.daylight.set(field(table, row, 'Token'), field(table, row, 'Daylight'));
    SURFACE_BY_VARIANT.highcontrast.set(
      field(table, row, 'Token'),
      field(table, row, 'High-contrast'),
    );
  }
}

const CHROME_BY_THEME: Record<Theme, Map<string, string>> = {
  dark: new Map(),
  light: new Map(),
};
for (const row of CHROME.rows) {
  CHROME_BY_THEME.dark.set(field(CHROME, row, 'Token'), field(CHROME, row, 'Dark'));
  CHROME_BY_THEME.light.set(field(CHROME, row, 'Token'), field(CHROME, row, 'Light'));
}

/**
 * The theme a brightness variant belongs to, stated here independently so that
 * the renderer's own statement of the same tie is something this file checks
 * rather than something it inherits.
 *
 * THE THIRD VARIANT BELONGS TO NEITHER THEME, which is the whole of SPEC section
 * 18's high-contrast subsection: it is selected by `forced-colors: active` and by
 * nothing else, and it replaces both brightness variants whichever theme is in
 * force. The map is therefore partial on purpose, and `resolve` below reaches the
 * chrome palette only for the two variants a theme can name.
 */
const THEME_BY_VARIANT: Partial<Record<Brightness, Theme>> = {
  floodlit: 'dark',
  daylight: 'light',
};
const VARIANTS: readonly Brightness[] = ['floodlit', 'daylight', 'highcontrast'];

/** A token's hex in one variant: play surface by variant, chrome by theme. */
function resolve(token: string, variant: Brightness): string {
  const surface = SURFACE_BY_VARIANT[variant].get(token);
  if (surface !== undefined) {
    return surface;
  }
  const theme = THEME_BY_VARIANT[variant];
  const chrome = theme === undefined ? undefined : CHROME_BY_THEME[theme].get(token);
  if (chrome !== undefined) {
    return chrome;
  }
  throw new Error(`the contract states no ${variant} value for ${token}`);
}

/**
 * A ground the page cannot predict, written as its own six-digit hex.
 *
 * SPEC section 18 measures the rail against a black and a white SYSTEM ground,
 * because beyond the wall band the canvas is transparent and meets the chrome's
 * ground, which under `forced-colors: active` is whatever the platform supplies.
 * It is not a token and there is nothing to look up, so a hex in a background
 * column answers for itself and everything else still has to be a token name.
 */
function ground(token: string, variant: Brightness): string {
  return /^#[0-9A-F]{6}$/.test(token) ? token : resolve(token, variant);
}

/** A variant named in a contract cell, checked rather than cast. */
function variantOf(text: string): Brightness {
  const value = text.toLowerCase().replace('-', '');
  if (value !== 'floodlit' && value !== 'daylight' && value !== 'highcontrast') {
    throw new Error(`not a brightness variant: ${JSON.stringify(text)}`);
  }
  return value;
}

/** The column a variant's number is quoted in. */
function columnFor(variant: Brightness): string {
  if (variant === 'floodlit') {
    return 'Floodlit';
  }
  return variant === 'daylight' ? 'Daylight' : 'High-contrast';
}

/** One cell of the measured-pairs table, named the way section 8 names it. */
function cellKey(pair: string, variant: Brightness): string {
  return `${pair}  ${variant}`;
}

/**
 * Tokens that hold a different colour in at least one variant, read off the
 * contract. `--team-opponent` joined them with the high-contrast set: it is one
 * colour in the two brightness variants and darker in the third, so a rule that
 * asked only whether floodlit and daylight differ would file it as fixed and
 * then have nothing to say about the variant that moves it.
 */
const VARYING = SURFACE.rows
  .filter(
    (row) =>
      new Set(VARIANTS.map((variant) => field(SURFACE, row, columnFor(variant)))).size > 1,
  )
  .map((row) => field(SURFACE, row, 'Token'));
const FIXED = SURFACE.rows
  .map((row) => field(SURFACE, row, 'Token'))
  .filter((token) => !VARYING.includes(token));

// ---------------------------------------------------------------------------
// The stylesheet, parsed. Blocks by brace matching rather than by regular
// expression, so that the set of blocks is knowable and can be pinned.
// ---------------------------------------------------------------------------

/**
 * Comments replaced by spaces, string contents left alone.
 *
 * Strings are copied through whole rather than skipped, for two reasons: a
 * comment opener inside a string must not start a comment, and a literal hidden
 * inside a string is exactly what the sweep at the end of this file is for.
 * Prose may quote a value; a string is code.
 */
function stripComments(text: string, lineComments: boolean): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const here = text[at] ?? '';
    const next = text[at + 1] ?? '';
    if (here === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(at, stop).replace(/[^\n]/g, ' ');
      at = stop;
      continue;
    }
    if (lineComments && here === '/' && next === '/') {
      const end = text.indexOf('\n', at);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - at);
      at = stop;
      continue;
    }
    if (here === '"' || here === "'" || here === '`') {
      let end = at + 1;
      while (end < text.length) {
        const character = text[end] ?? '';
        if (character === '\\') {
          end += 2;
          continue;
        }
        end += 1;
        if (character === here) {
          break;
        }
      }
      out += text.slice(at, end);
      at = end;
      continue;
    }
    out += here;
    at += 1;
  }
  return out;
}

interface Block {
  readonly media: string | null;
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
  readonly names: readonly string[];
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const here = text[at];
    if (here === '{') {
      depth += 1;
    } else if (here === '}') {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }
  throw new Error('the stylesheet has an unclosed block');
}

function declarationsIn(body: string): { map: Map<string, string>; names: string[] } {
  const map = new Map<string, string>();
  const names: string[] = [];
  for (const part of body.split(';')) {
    const text = part.trim();
    if (text === '') {
      continue;
    }
    const colon = text.indexOf(':');
    if (colon === -1) {
      throw new Error(`not a declaration: ${JSON.stringify(text)}`);
    }
    const name = text.slice(0, colon).trim();
    names.push(name);
    map.set(name, text.slice(colon + 1).trim());
  }
  return { map, names };
}

function blocksIn(source: string, media: string | null, into: Block[]): void {
  let at = 0;
  for (;;) {
    const open = source.indexOf('{', at);
    if (open === -1) {
      return;
    }
    const prelude = source.slice(at, open).trim();
    const close = matchingBrace(source, open);
    const body = source.slice(open + 1, close);
    if (prelude.startsWith('@media')) {
      blocksIn(body, prelude.replace(/^@media\s*/, '').trim(), into);
    } else {
      const parsed = declarationsIn(body);
      into.push({ media, selector: prelude, declarations: parsed.map, names: parsed.names });
    }
    at = close + 1;
  }
}

const BLOCKS: Block[] = [];
blocksIn(stripComments(stylesheetText, false), null, BLOCKS);

function block(media: string | null, selector: string): Block {
  const found = BLOCKS.find((entry) => entry.media === media && entry.selector === selector);
  if (found === undefined) {
    throw new Error(
      `the stylesheet has no ${media === null ? 'top-level' : media} block for ${selector}`,
    );
  }
  return found;
}

const BASE = block(null, ':root');
const DARK_BY_PREFERENCE = block('(prefers-color-scheme: dark)', ":root:not([data-theme='light'])");
const DARK_BY_SETTING = block(null, ":root[data-theme='dark']");
const LIGHT_BY_SETTING = block(null, ":root[data-theme='light']");
const REDUCED_MOTION = block('(prefers-reduced-motion: reduce)', ':root');
const FORCED_COLORS = block(
  '(forced-colors: active)',
  ":root:not([data-theme='light']), :root[data-theme='light']",
);

/**
 * The system colours the chrome adopts under `forced-colors: active`, and the
 * chrome token each of them answers for.
 *
 * WHY A KEYWORD AND NOT A HEX. The platform supplies the value and the page
 * cannot predict it, which is the whole of QUALITY-BAR section 5's rule: under
 * the query the chrome adopts the SYSTEM palette rather than one of its own. The
 * four names below are the CSS system colours for exactly the four roles the
 * chrome palette states, so the substitution is one for one and the chrome keeps
 * meaning what it meant.
 */
const SYSTEM_COLOURS: ReadonlyArray<readonly [string, string]> = [
  ['--pf-ground', 'Canvas'],
  ['--pf-text', 'CanvasText'],
  ['--pf-text-muted', 'GrayText'],
  ['--pf-accent', 'Highlight'],
];

function declared(from: Block, token: string): string {
  const value = from.declarations.get(token);
  if (value === undefined) {
    throw new Error(`${from.selector} declares no ${token}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The renderer record, mapped to token names.
// ---------------------------------------------------------------------------

const RENDERER_COLOURS: Record<Brightness, ReadonlyArray<readonly [string, string]>> = {
  floodlit: [
    ['--pitch-stripe-a', PLAY_SURFACE.floodlit.stripeA],
    ['--pitch-stripe-b', PLAY_SURFACE.floodlit.stripeB],
    ['--pf-line', PLAY_SURFACE.floodlit.line],
    ['--pf-rail', PLAY_SURFACE.floodlit.rail],
    ['--team-player', PLAY_SURFACE.floodlit.teamPlayer],
    ['--team-opponent', PLAY_SURFACE.floodlit.teamOpponent],
    ['--glyph-on-player', PLAY_SURFACE.floodlit.glyphOnPlayer],
    ['--glyph-on-opponent', PLAY_SURFACE.floodlit.glyphOnOpponent],
    ['--ball-body', PLAY_SURFACE.floodlit.ballBody],
    ['--ball-panel', PLAY_SURFACE.floodlit.ballPanel],
    ['--pf-accent', PLAY_SURFACE.floodlit.accent],
  ],
  daylight: [
    ['--pitch-stripe-a', PLAY_SURFACE.daylight.stripeA],
    ['--pitch-stripe-b', PLAY_SURFACE.daylight.stripeB],
    ['--pf-line', PLAY_SURFACE.daylight.line],
    ['--pf-rail', PLAY_SURFACE.daylight.rail],
    ['--team-player', PLAY_SURFACE.daylight.teamPlayer],
    ['--team-opponent', PLAY_SURFACE.daylight.teamOpponent],
    ['--glyph-on-player', PLAY_SURFACE.daylight.glyphOnPlayer],
    ['--glyph-on-opponent', PLAY_SURFACE.daylight.glyphOnOpponent],
    ['--ball-body', PLAY_SURFACE.daylight.ballBody],
    ['--ball-panel', PLAY_SURFACE.daylight.ballPanel],
    ['--pf-accent', PLAY_SURFACE.daylight.accent],
  ],
  highcontrast: [
    ['--pitch-stripe-a', PLAY_SURFACE.highcontrast.stripeA],
    ['--pitch-stripe-b', PLAY_SURFACE.highcontrast.stripeB],
    ['--pf-line', PLAY_SURFACE.highcontrast.line],
    ['--pf-rail', PLAY_SURFACE.highcontrast.rail],
    ['--team-player', PLAY_SURFACE.highcontrast.teamPlayer],
    ['--team-opponent', PLAY_SURFACE.highcontrast.teamOpponent],
    ['--glyph-on-player', PLAY_SURFACE.highcontrast.glyphOnPlayer],
    ['--glyph-on-opponent', PLAY_SURFACE.highcontrast.glyphOnOpponent],
    ['--ball-body', PLAY_SURFACE.highcontrast.ballBody],
    ['--ball-panel', PLAY_SURFACE.highcontrast.ballPanel],
    ['--pf-accent', PLAY_SURFACE.highcontrast.accent],
  ],
};

const RENDERER_NUMBERS: ReadonlyArray<readonly [string, number]> = [
  ['--space-1', SPACE[1]],
  ['--space-2', SPACE[2]],
  ['--space-3', SPACE[3]],
  ['--space-4', SPACE[4]],
  ['--space-5', SPACE[5]],
  ['--space-6', SPACE[6]],
  ['--space-7', SPACE[7]],
  ['--space-8', SPACE[8]],
  ['--radius-sm', RADIUS.sm],
  ['--radius-md', RADIUS.md],
  ['--radius-lg', RADIUS.lg],
  ['--radius-pill', RADIUS.pill],
  ['--border-hair', BORDER.hair],
  ['--border-thin', BORDER.thin],
  ['--border-thick', BORDER.thick],
  ['--dur-0', DURATION[0]],
  ['--dur-1', DURATION[1]],
  ['--dur-2', DURATION[2]],
  ['--dur-3', DURATION[3]],
  ['--dur-4', DURATION[4]],
];

const RENDERER_STRINGS: ReadonlyArray<readonly [string, string]> = [
  ['--ease-out', EASING.out],
  ['--ease-in-out', EASING.inOut],
];

const STEPS: readonly DurationStep[] = [0, 1, 2, 3, 4];

// ---------------------------------------------------------------------------
// The literal sweep. Machinery here, assertions in the describe block below.
// ---------------------------------------------------------------------------

const SWEPT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css',
]);

/**
 * Colour literals, in any language. The functional forms beyond the four the
 * criterion names are here because a colour written as oklch() is no less a
 * literal than the same colour written as a hex.
 *
 * Case-insensitive, because a CSS function name is: RGB() and rgb() are the
 * same function to a browser and would not be to a case-sensitive scan. The
 * bare color() form is matched separately so that a preceding identifier
 * character or hyphen rules it out, which is what keeps getColor() and a
 * property name ending in -color from reading as a colour literal.
 */
const COLOUR_LITERAL =
  /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(|(?<![\w-])color\s*\(/gi;

/**
 * Every unit a design value can be written in: the lengths, the angles, the
 * two times, the percentage and the flex fraction. In a stylesheet they are
 * matched anywhere; in TypeScript they are matched inside string literals
 * only, which is where a dimension can appear as a value: the chrome is DOM,
 * so from the chrome part onward a style property is set from a string, and
 * '12px' there is exactly the literal this item forbids.
 *
 * WHY THE WHOLE LIST. This matcher knew `px`, `rem`, `em`, `ms` and `s` and
 * nothing else, so a size or a threshold written in `vw`, `vh`, `%` or `ch`
 * reached the tree unremarked, and the shipped chrome stylesheet already
 * carried four viewport units the sweep could not see. A missing unit is not a
 * weaker rule, it is no rule for the value written in it.
 *
 * WHAT IS DELIBERATELY OUT. The resolution units (`dpi`, `dpcm`, `dppx`, `x`)
 * and the frequency units (`Hz`, `kHz`) express no design value on any
 * QUALITY-BAR section 15 scale, and `x` in particular would fire on ordinary
 * text. They are stated here as an absence with its reason rather than left to
 * be discovered as a gap.
 *
 * A bare number in TypeScript is not this matcher's business: 12 may be a
 * radius that belongs in a token, or an entity count, or a loop bound, and no
 * matcher over units tells them apart. THAT RESIDUE IS NARROWED, NOT LEFT: the
 * bare-numeric sweep at the end of this file asks a smaller question over the
 * eight modules that draw - does this number EQUAL one of the sixteen values on
 * the four scales - and names every occurrence that does with its reason. What
 * E1's Inspection still owns is every module outside `src/render/`, a design
 * value that happens to equal no token, and the judgement of whether a new
 * exemption there is honest.
 *
 * A bare 0 needs no unit and no token, so it is not matched.
 */
const DIMENSION_UNITS: readonly string[] = [
  // Absolute lengths.
  'px', 'cm', 'mm', 'q', 'in', 'pt', 'pc',
  // Font-relative lengths, and their root-relative forms.
  'em', 'rem', 'ex', 'rex', 'ch', 'rch', 'ic', 'ric', 'cap', 'rcap', 'lh', 'rlh',
  // Viewport-relative lengths: the classic pair, the two axis-relative names,
  // and the small, large and dynamic viewport families.
  'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax',
  'svw', 'svh', 'svi', 'svb', 'svmin', 'svmax',
  'lvw', 'lvh', 'lvi', 'lvb', 'lvmin', 'lvmax',
  'dvw', 'dvh', 'dvi', 'dvb', 'dvmin', 'dvmax',
  // Container-relative lengths.
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
  // Angles, times, and the two unitless-looking values that are still values.
  'deg', 'grad', 'rad', 'turn', 's', 'ms', 'fr', '%',
];

/**
 * The units longest first, because a regular expression alternation takes the
 * first branch that matches: with `s` ahead of `svh`, `100svh` would be read
 * as the number 100 followed by nothing at all.
 *
 * A LEADING MINUS IS PART OF THE LITERAL. `margin-top: -12px` and
 * `translateX(-50%)` are values on QUALITY-BAR section 15's scales like any
 * other, and a matcher whose lookbehind refused a minus saw neither: it was
 * there to keep the `1` of `--space-1` out, and it took every negative offset
 * with it. The lookbehind still refuses a minus that FOLLOWS an identifier
 * character or another minus, which is what a custom property name is, so
 * `var(--space-1)` stays out and `-12px` comes in.
 */
const DIMENSION_LITERAL = new RegExp(
  String.raw`(?<![\w#-])-?\d*\.?\d+(?:` +
    [...DIMENSION_UNITS].sort((one, other) => other.length - one.length).join('|') +
    String.raw`)(?![\w-])`,
  'gi',
);

/**
 * A `url(...)` with nothing left inside it.
 *
 * A LOCATION IS NOT A VALUE. `url(https://x.example/12px.png)` names a file
 * whose name happens to contain a length, and reporting it would be reporting
 * the file name; nothing inside those parentheses resolves through a token
 * because nothing inside them is a measurement. The one shape this cannot
 * follow is a closing parenthesis inside a quoted location, which is stated
 * here rather than left to be found: such a URL would end the elision early
 * and the tail would be scanned, which is the safe direction.
 */
function withoutUrls(text: string): string {
  return text.replace(/url\([^)]*\)/gi, 'url()');
}

/**
 * The occurrences E1 exempts, each named with the reason it is not a design
 * value, and each consumed exactly once by the sweep below.
 *
 * A VIEWPORT UNIT IS NOT A VALUE ON A SCALE. QUALITY-BAR section 15 states a
 * spacing, radius, type and motion scale and no viewport scale, because there
 * is nothing to state: `100vh` is "the viewport", not a size somebody chose,
 * and tokenising it would put a name in front of a word the stylesheet already
 * has. The same is true of the one percentage: it says a card fills the box its
 * parent gives it, which is a relationship and not a measurement.
 *
 * The count is part of the entry, so a fifth `100dvh` appended tomorrow is an
 * offence rather than something that hides behind these four; and every entry
 * is asserted to have been used, so an exemption that outlives its occurrence
 * reddens rather than sitting here forever.
 */
interface Exemption {
  readonly file: string;
  readonly literal: string;
  readonly count: number;
  readonly why: string;
}

const DIMENSION_EXEMPT: readonly Exemption[] = [
  {
    file: 'src/ui/components/chrome.css',
    literal: '100vh',
    count: 2,
    why: 'the app column and the stage each take a whole viewport; no scale states one',
  },
  {
    file: 'src/ui/components/chrome.css',
    literal: '100dvh',
    count: 2,
    why: 'the dynamic-viewport spelling of the same two rules, declared after each as the pair',
  },
  {
    file: 'src/ui/components/chrome.css',
    literal: '100%',
    count: 1,
    why: 'a panel card fills the box its parent gives it, which is a relationship not a size',
  },
  {
    file: 'src/ui/components/chrome.css',
    literal: '1px',
    count: 2,
    why: 'a visually hidden box keeps one pixel so the platform still lays it out; not a design size',
  },
  {
    file: 'src/ui/components/chrome.css',
    literal: '50%',
    count: 1,
    why: 'the clip that hides it takes half of nothing from every side, which is a shape not a size',
  },
];

/**
 * Colour keywords, the obvious way round a hex ban. Matched in value position
 * only, so a selector or a class name spelling one is left alone. Best effort
 * and stated as such: the list is the common ones rather than all of them.
 */
const NAMED_COLOURS = new Set([
  'aqua', 'azure', 'beige', 'black', 'blue', 'brown', 'coral', 'crimson', 'cyan',
  'fuchsia', 'gold', 'gray', 'green', 'grey', 'indigo', 'ivory', 'khaki',
  'lavender', 'lime', 'magenta', 'maroon', 'navy', 'olive', 'orange', 'orchid',
  'pink', 'plum', 'purple', 'red', 'salmon', 'silver', 'snow', 'tan', 'teal',
  'turquoise', 'violet', 'wheat', 'white', 'yellow',
]);

function colourLiterals(text: string, css: boolean): string[] {
  const source = stripComments(text, !css);
  const found = [...source.matchAll(COLOUR_LITERAL)].map((match) => match[0]);
  if (!css) {
    return found;
  }
  for (const declaration of source.matchAll(/:([^;{}]*)[;}]/g)) {
    for (const word of (declaration[1] ?? '').matchAll(/[A-Za-z-]+/g)) {
      const keyword = word[0].toLowerCase();
      if (NAMED_COLOURS.has(keyword)) {
        found.push(keyword);
      }
    }
  }
  return found;
}

function dimensionsIn(text: string): string[] {
  return [...withoutUrls(text).matchAll(DIMENSION_LITERAL)].map((match) => match[0]);
}

function dimensionLiterals(text: string): string[] {
  return dimensionsIn(stripComments(text, false));
}

/**
 * The contents of every string literal, comments removed first. A literal
 * hidden in a string is code, and a template literal that interpolates a
 * number carries no literal at all: `${width}px` has no digit before the unit.
 */
function stringLiterals(text: string): string[] {
  const source = stripComments(text, true);
  const found: string[] = [];
  let at = 0;
  while (at < source.length) {
    const here = source[at] ?? '';
    if (here === '"' || here === "'" || here === '`') {
      let end = at + 1;
      while (end < source.length) {
        const character = source[end] ?? '';
        if (character === '\\') {
          end += 2;
          continue;
        }
        if (character === here) {
          break;
        }
        end += 1;
      }
      found.push(source.slice(at + 1, end));
      at = end + 1;
      continue;
    }
    at += 1;
  }
  return found;
}

/** Every dimension literal a file is answerable for, by language. */
function dimensionsFor(text: string, css: boolean): string[] {
  return css ? dimensionLiterals(text) : stringLiterals(text).flatMap(dimensionsIn);
}

interface Walk {
  readonly visited: string[];
  readonly scanned: string[];
}

/** Every file under src/, and the subset the sweep is entitled to complain about. */
function walkSource(): Walk {
  const visited: string[] = [];
  const scanned: string[] = [];
  const stack = [SOURCE_ROOT];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(PROJECT_ROOT, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      visited.push(relative);
      if (!SWEPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (TOKEN_LAYER.includes(relative)) {
        continue;
      }
      scanned.push(relative);
    }
  }
  return { visited: visited.sort(), scanned: scanned.sort() };
}

// ---------------------------------------------------------------------------

describe('PF-1 design tokens', () => {
  describe('the contract this file reads', () => {
    it('parses every table it depends on, at the size it depends on', () => {
      // A parser that has quietly stopped finding rows reports an agreement it
      // never checked, and every check below would pass over an empty loop.
      expect(SCALES.rows).toHaveLength(38);
      expect(CHROME.rows).toHaveLength(4);
      expect(SURFACE.rows).toHaveLength(10);
      expect(ARROW_ACCENT.rows).toHaveLength(1);
      // SPEC section 18's high-contrast subsection arrives as a COLUMN on the
      // three palette tables rather than as a second fixture, because it states
      // a third value for the same ten tokens and the same eleventh colour. A
      // column that had quietly stopped being read would leave every
      // high-contrast assertion below comparing an empty string with itself.
      for (const table of [SURFACE, ARROW_ACCENT]) {
        expect(table.headers).toContain('High-contrast');
      }
      expect(PAIRS.headers).toContain('High-contrast');
      expect(PAIRS.headers).toContain('High-contrast target');
      expect(IDENTITY.headers).toContain('High-contrast relative luminance');
      // Fourteen rows, which is what SPEC section 18's measured table states
      // once its two rail-FILL rows are gone: the section retired them with
      // the correction that gave the rail a boundary, and a fill row carrying
      // a threshold of 3 here would be a guarantee the source no longer makes.
      expect(PAIRS.rows).toHaveLength(14);
      expect(IDENTITY.rows).toHaveLength(2);
      expect(RETRACTED.rows).toHaveLength(2);
      // Section 8 lists every cell whose threshold the source scopes to a named
      // carrier. It listed two until the rail's guarantee moved to the boundary,
      // then one; SPEC section 18's high-contrast subsection adds three of its
      // own, two carried by an outline and one refused outright, and the section
      // says of the last that the refusal is arithmetic rather than taste.
      expect(SCOPED.rows).toHaveLength(4);
      // Section 10 holds the cells SPEC section 18 states for the high-contrast
      // variant ALONE: the arrow against the second mown stripe, and the rail
      // where the canvas ends and a system ground the page cannot predict
      // begins. They are here rather than in section 5 because a system ground
      // is not a token, and a background column that could hold either would
      // stop the lookup above being a lookup.
      expect(FORCED_ONLY.rows).toHaveLength(6);
      // Section 1 carries a second table, the prose derivations. Reading it by
      // accident would compare the wrong column.
      expect(tablesUnder('1. Numeric scales')).toHaveLength(2);
    });

    it('separates the four varying colours from the six fixed ones', () => {
      // `--team-opponent` is here because the high-contrast variant darkens it;
      // it is one colour in both brightness variants, which is why a rule that
      // compared only those two filed it as fixed.
      expect(VARYING).toEqual([
        '--pitch-stripe-a',
        '--pitch-stripe-b',
        '--pf-rail',
        '--team-opponent',
      ]);
      expect(FIXED).toHaveLength(6);
      expect(VARIANTS).toEqual(['floodlit', 'daylight', 'highcontrast']);
    });
  });

  describe('the stylesheet mechanism, pinned so the parser cannot be blinded', () => {
    it('is exactly six blocks, with forced colours written last', () => {
      // THE ORDER IS PART OF THE LIST. The forced-colors block selects at the
      // same specificity as the two theme blocks, so the only thing deciding it
      // against them is that it comes after them; a reorder that moved it above
      // either one would leave the query inert on the machines that match that
      // theme, and every assertion below it would still pass.
      expect(
        BLOCKS.map((entry) => `${entry.media ?? 'top level'}  ${entry.selector}`),
      ).toEqual([
        'top level  :root',
        "(prefers-color-scheme: dark)  :root:not([data-theme='light'])",
        "top level  :root[data-theme='dark']",
        "top level  :root[data-theme='light']",
        '(prefers-reduced-motion: reduce)  :root',
        "(forced-colors: active)  :root:not([data-theme='light']), :root[data-theme='light']",
      ]);
    });

    it('answers forced colours at the specificity of the blocks it has to beat', () => {
      // A plain `:root` here is (0, 1, 0) against the dark-preference block's
      // (0, 2, 0), so on a machine with no stored theme the query would lose and
      // the chrome would keep the floodlit palette with every test green. The
      // selector therefore names both theme cases explicitly, which is the same
      // specificity as each, and the file order decides it.
      expect(FORCED_COLORS.selector).toContain(":root:not([data-theme='light'])");
      expect(FORCED_COLORS.selector).toContain(":root[data-theme='light']");
      expect(FORCED_COLORS.selector).not.toBe(':root');
      const source = stripComments(stylesheetText, false);
      expect(source.indexOf('@media (forced-colors: active)')).toBeGreaterThan(
        source.indexOf(":root[data-theme='light']"),
      );
      expect(source.indexOf('@media (forced-colors: active)')).toBeGreaterThan(
        source.indexOf('@media (prefers-color-scheme: dark)'),
      );
    });

    it('quotes the theme attribute the one way this file reads it', () => {
      // The parser matches the selector as text. A refactor to double quotes
      // changes nothing a browser does and blinds every check below it, so the
      // spelling is asserted rather than assumed.
      expect(stylesheetText).toContain("[data-theme='light']");
      expect(stylesheetText).toContain("[data-theme='dark']");
      expect(stylesheetText).not.toContain('data-theme="');
    });

    it('declares every token once per block', () => {
      for (const entry of BLOCKS) {
        expect(new Set(entry.names).size, entry.selector).toBe(entry.names.length);
      }
    });

    it('writes every colour as a six-digit uppercase hex', () => {
      for (const match of stripComments(stylesheetText, false).matchAll(/#[0-9A-Za-z]+/g)) {
        expect(match[0], match[0]).toMatch(/^#[0-9A-F]{6}$/);
      }
    });
  });

  describe('the numeric scales, against QUALITY-BAR section 15', () => {
    it('declares every scale token with the contract value', () => {
      for (const row of SCALES.rows) {
        const token = field(SCALES, row, 'Token');
        expect(declared(BASE, token), token).toBe(field(SCALES, row, 'Value'));
      }
    });

    it('declares nothing the contract does not know about', () => {
      const expected = new Set<string>();
      for (const row of SCALES.rows) {
        expected.add(field(SCALES, row, 'Token'));
      }
      for (const row of CHROME.rows) {
        const token = field(CHROME, row, 'Token');
        expected.add(token);
        expected.add(`${token}-dark`);
        expected.add(`${token}-light`);
      }
      for (const token of VARYING) {
        expected.add(token);
        for (const variant of VARIANTS) {
          expected.add(`${token}-${variant}`);
        }
      }
      for (const token of FIXED) {
        expected.add(token);
      }
      expect([...BASE.declarations.keys()].sort()).toEqual([...expected].sort());
    });

    it('carries the same scales in the renderer record, unitless', () => {
      const value = (token: string): string => {
        const row = SCALES.rows.find((entry) => field(SCALES, entry, 'Token') === token);
        if (row === undefined) {
          throw new Error(`the contract states no ${token}`);
        }
        return field(SCALES, row, 'Value');
      };
      for (const [token, number] of RENDERER_NUMBERS) {
        expect(Number(value(token).replace(/(?:px|ms)$/, '')), token).toBe(number);
      }
      for (const [token, text] of RENDERER_STRINGS) {
        expect(value(token), token).toBe(text);
      }
    });

    it('carries no scale value the contract has not seen', () => {
      expect(Object.keys(SPACE)).toHaveLength(8);
      expect(Object.keys(RADIUS)).toHaveLength(4);
      expect(Object.keys(BORDER)).toHaveLength(3);
      expect(Object.keys(DURATION)).toHaveLength(5);
      expect(Object.keys(EASING)).toHaveLength(2);
      expect(RENDERER_NUMBERS).toHaveLength(20);
      expect(RENDERER_STRINGS).toHaveLength(2);
    });

    it('holds the touch minimum and its clearance, section 3 and section 15', () => {
      expect(declared(BASE, '--target-min')).toBe('44px');
      // Aliased rather than restated: section 15 says the clearance IS --space-2.
      expect(declared(BASE, '--target-clearance')).toBe('var(--space-2)');
      expect(declared(BASE, '--space-2')).toBe('8px');
    });
  });

  describe('the palette, against SPEC section 18', () => {
    it('declares both chrome themes exactly as the spec measured them', () => {
      for (const row of CHROME.rows) {
        const token = field(CHROME, row, 'Token');
        expect(declared(BASE, `${token}-dark`), token).toBe(field(CHROME, row, 'Dark'));
        expect(declared(BASE, `${token}-light`), token).toBe(field(CHROME, row, 'Light'));
      }
    });

    it('declares the play surface exactly as the spec measured it', () => {
      for (const token of VARYING) {
        for (const variant of VARIANTS) {
          expect(declared(BASE, `${token}-${variant}`), `${token} ${variant}`).toBe(
            resolve(token, variant),
          );
        }
      }
      for (const token of FIXED) {
        expect(declared(BASE, token), token).toBe(resolve(token, 'floodlit'));
        for (const variant of VARIANTS) {
          expect(resolve(token, variant), `${token} ${variant}`).toBe(
            resolve(token, 'floodlit'),
          );
        }
      }
    });

    it('carries the same play surface in the renderer record', () => {
      for (const variant of VARIANTS) {
        for (const [token, value] of RENDERER_COLOURS[variant]) {
          expect(value, `${variant} ${token}`).toBe(resolve(token, variant));
        }
        expect(RENDERER_COLOURS[variant]).toHaveLength(SURFACE.rows.length + 1);
        expect(Object.keys(PLAY_SURFACE[variant])).toHaveLength(SURFACE.rows.length + 1);
      }
    });

    it('ties the arrow accent on the pitch to the chrome accent of that theme', () => {
      // The eleventh colour is a cross-reference, not a decision: if it ever
      // stops being the chrome accent it has become a colour somebody chose.
      let tied = 0;
      for (const variant of VARIANTS) {
        const theme = THEME_BY_VARIANT[variant];
        if (theme === undefined) {
          continue;
        }
        expect(resolve('--pf-accent', variant), variant).toBe(
          CHROME_BY_THEME[theme].get('--pf-accent'),
        );
        expect(pitchFor(theme).accent, theme).toBe(resolve('--pf-accent', variant));
        tied += 1;
      }
      expect(tied).toBe(2);
      expect(BRIGHTNESS_BY_THEME).toEqual({ dark: 'floodlit', light: 'daylight' });
    });

    it('states the eleventh colour outright in the variant no theme can reach', () => {
      // THE ONE EXCEPTION TO THE TIE ABOVE, and SPEC section 18 says why: under
      // `forced-colors: active` the chrome accent is a system colour the page
      // cannot predict, so an arrow strong end read through the theme would be
      // read through a value nobody here knows. The section states the hex, and
      // it is the one the floodlit pitch had already measured.
      expect(resolve('--pf-accent', 'highcontrast')).toBe('#F5C542');
      expect(resolve('--pf-accent', 'highcontrast')).toBe(resolve('--pf-accent', 'floodlit'));
      expect(THEME_BY_VARIANT['highcontrast']).toBeUndefined();
      expect(Object.values(BRIGHTNESS_BY_THEME)).not.toContain('highcontrast');
      // And the renderer hands it out for either theme under the query, which is
      // the "one set replacing both brightness variants" the section states.
      for (const theme of ['dark', 'light'] as const) {
        expect(playSurfaceFor(theme, true), theme).toBe(PLAY_SURFACE.highcontrast);
        expect(playSurfaceFor(theme, true).accent, theme).toBe('#F5C542');
        expect(playSurfaceFor(theme, true)).not.toBe(playSurfaceFor(theme, false));
        expect(playSurfaceFor(theme, false), theme).toBe(pitchFor(theme));
      }
    });

    it('overrides the chrome with system colours under forced colours, and nothing else', () => {
      // QUALITY-BAR section 5: the chrome adopts the SYSTEM palette. Every
      // chrome rule resolves its colour through one of these four names, so the
      // four are the whole of the chrome half; each is asserted to be a system
      // keyword and NOT the theme's hex, which is the difference a vacuous block
      // of aliases pointing back at the theme would not have.
      for (const [token, keyword] of SYSTEM_COLOURS) {
        expect(declared(FORCED_COLORS, token), token).toBe(keyword);
        expect(declared(FORCED_COLORS, token), token).not.toMatch(/^#|^var\(/);
        expect(declared(BASE, token), token).toMatch(/^var\(/);
      }
      // The play-surface half: the four that move take their high-contrast
      // value, and the six that do not are absent here exactly as they are
      // absent from the theme blocks.
      for (const token of VARYING) {
        expect(declared(FORCED_COLORS, token), token).toBe(`var(${token}-highcontrast)`);
      }
      for (const token of FIXED) {
        expect(FORCED_COLORS.declarations.has(token), token).toBe(false);
      }
      // No token is declared here that a theme block does not also decide, so
      // the query flips a set rather than reaching past one.
      expect([...FORCED_COLORS.declarations.keys()].sort()).toEqual(
        [...DARK_BY_SETTING.declarations.keys()].sort(),
      );
    });

    it('keeps two tokens at the same colour as two declarations', () => {
      // Section 18 states both independently. An alias would turn two decisions
      // that agree today into one decision used twice.
      expect(declared(BASE, '--glyph-on-opponent')).toBe(declared(BASE, '--pf-line'));
      expect(declared(BASE, '--glyph-on-opponent')).toMatch(/^#/);
      expect(declared(BASE, '--pf-line')).toMatch(/^#/);
    });

    it('flips the whole set together, or not at all', () => {
      const aliases = [...BASE.declarations.keys()].filter((token) =>
        (BASE.declarations.get(token) ?? '').startsWith('var(--'),
      );
      const themed = aliases.filter(
        (token) => token !== '--target-clearance' && token !== '--focus-ring-color',
      );
      for (const entry of [DARK_BY_PREFERENCE, DARK_BY_SETTING, LIGHT_BY_SETTING]) {
        expect([...entry.declarations.keys()].sort(), entry.selector).toEqual([...themed].sort());
      }
      // The two dark blocks say the same thing, and the light one is the base.
      expect([...DARK_BY_SETTING.declarations]).toEqual([...DARK_BY_PREFERENCE.declarations]);
      for (const [token, value] of LIGHT_BY_SETTING.declarations) {
        expect(BASE.declarations.get(token), token).toBe(value);
      }
      expect(themed).toHaveLength(4 + VARYING.length);
    });
  });

  describe('every quoted ratio re-derives from the hexes alone', () => {
    it('re-derives all six chrome ratios, in both themes', () => {
      let checked = 0;
      for (const row of CHROME.rows) {
        const token = field(CHROME, row, 'Token');
        for (const [theme, colour, ratio] of [
          ['dark', 'Dark', 'Ratio on dark ground'],
          ['light', 'Light', 'Ratio on light ground'],
        ] as const) {
          const quoted = field(CHROME, row, ratio);
          if (quoted === '-') {
            // The ground has no ratio against itself, and the spec writes a
            // dash rather than a 1.
            expect(token).toBe('--pf-ground');
            continue;
          }
          const ground = CHROME_BY_THEME[theme].get('--pf-ground') ?? '';
          expect(round2(contrast(field(CHROME, row, colour), ground)), `${token} ${theme}`).toBe(
            Number(quoted),
          );
          // Every one of them is a text or a boundary colour, so 3:1 is the
          // floor even before section 4's 4.5:1 for body text.
          expect(contrast(field(CHROME, row, colour), ground), `${token} ${theme}`)
            .toBeGreaterThanOrEqual(3);
          checked += 1;
        }
      }
      expect(checked).toBe(6);
    });

    it('pins the threshold each row is measured against', () => {
      // The Needs column is data, and a threshold lowered to suit a colour is
      // as quiet a change as a colour moved to suit a threshold. Two rows clear
      // theirs by 0.09, so the distribution is pinned rather than the ceiling.
      const spread = (table: Table, header: string): [string, number][] => {
        const counts = new Map<string, number>();
        for (const row of table.rows) {
          const value = field(table, row, header);
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts].sort();
      };
      expect(spread(PAIRS, 'Needs')).toEqual([
        ['3', 12],
        ['4.5', 2],
      ]);
      // SPEC section 18's high-contrast subsection states a second floor above
      // the first: the MINIMUM is the Needs column unchanged, and the TARGET is
      // 4.5:1 for every graphical pair and 7:1 for the two glyph pairs. Both
      // distributions are pinned, because a target quietly relaxed to the
      // minimum would make every "met" below true by construction.
      expect(spread(PAIRS, 'High-contrast target')).toEqual([
        ['4.5', 12],
        ['7', 2],
      ]);
      // Section 8's bound is whichever of the two the scoped cell falls under,
      // so the column is no longer one number and is pinned as a distribution.
      // A bound written as something neither the row's minimum nor its target
      // is a bound nobody stated.
      expect(spread(SCOPED, 'Stays below')).toEqual([
        ['3', 1],
        ['4.5', 2],
        ['7', 1],
      ]);
      for (const row of SCOPED.rows) {
        const pair = field(SCOPED, row, 'Pair');
        const bound = field(SCOPED, row, 'Stays below');
        const stated = PAIRS.rows.find((entry) => field(PAIRS, entry, 'Pair') === pair);
        if (stated === undefined) {
          throw new Error(`section 8 scopes a pair section 5 does not measure: ${pair}`);
        }
        expect(
          [field(PAIRS, stated, 'Needs'), field(PAIRS, stated, 'High-contrast target')],
          pair,
        ).toContain(bound);
      }
    });

    it('re-derives every measured pair the spec quotes, in all three variants', () => {
      // WHICH FLOOR A SCOPED CELL IS SCOPED FROM, read off its own bound rather
      // than assumed. The daylight arrow is below the MINIMUM its row states and
      // its outline carries the guarantee instead; the three high-contrast cells
      // clear their minimum and fall short of the TARGET alone. Collapsing the
      // two would stop the minimum being checked on three cells that meet it.
      const scoped = new Map<string, string>();
      for (const row of SCOPED.rows) {
        scoped.set(
          cellKey(field(SCOPED, row, 'Pair'), variantOf(field(SCOPED, row, 'Variant'))),
          field(SCOPED, row, 'Stays below'),
        );
      }
      let checked = 0;
      let minimumScoped = 0;
      let targeted = 0;
      let targetScoped = 0;
      for (const row of PAIRS.rows) {
        const pair = field(PAIRS, row, 'Pair');
        const foreground = field(PAIRS, row, 'Foreground');
        const background = field(PAIRS, row, 'Background');
        const needs = field(PAIRS, row, 'Needs');
        const target = field(PAIRS, row, 'High-contrast target');
        for (const variant of VARIANTS) {
          const quoted = field(PAIRS, row, columnFor(variant));
          const key = cellKey(pair, variant);
          const bound = scoped.get(key);
          const derived = contrast(resolve(foreground, variant), resolve(background, variant));
          // Every cell re-derives from the hexes, the quiet ones included.
          expect(round2(derived), key).toBe(Number(quoted));
          if (bound === needs) {
            // Scoped from the minimum: the section 8 tests assert the quiet cell
            // stays quiet and its named carrier clears.
            minimumScoped += 1;
            continue;
          }
          expect(derived, `${key}, needs ${needs}`).toBeGreaterThanOrEqual(Number(needs));
          checked += 1;
          if (variant !== 'highcontrast') {
            continue;
          }
          if (bound === target) {
            // Scoped from the target alone, which is the only floor the
            // high-contrast subsection adds. The minimum above still applied.
            targetScoped += 1;
            continue;
          }
          // The second floor, and the reason the variant exists at all: the
          // high-contrast set is not merely legal, it is aimed at 4.5 and 7.
          expect(derived, `${key}, target ${target}`).toBeGreaterThanOrEqual(Number(target));
          targeted += 1;
        }
      }
      // Fourteen rows, three variants, less the one cell scoped from its floor.
      expect(checked).toBe(14 * 3 - 1);
      expect(minimumScoped).toBe(1);
      expect(targetScoped).toBe(3);
      expect(targeted).toBe(14 - 3);
      expect(scoped.size).toBe(4);
    });

    it('re-derives every relative luminance SPEC section 18 states for the variant', () => {
      // NINE OF THE ELEVEN WERE PINNED BY NOTHING. The contract carried the
      // hexes, the ratios, the floors and the targets, and not the luminance
      // column the section states beside them; only two survived, rounded to
      // two decimals, through the identity table. A stated number nothing
      // re-derives is a number that can be wrong in an approved document.
      expect(FORCED_LUMINANCE.headers).toEqual([
        'Token',
        'High-contrast',
        'Relative luminance',
        'From',
      ]);
      expect(FORCED_LUMINANCE.rows).toHaveLength(11);
      for (const row of FORCED_LUMINANCE.rows) {
        const token = field(FORCED_LUMINANCE, row, 'Token');
        const hex = field(FORCED_LUMINANCE, row, 'High-contrast');
        // The value is the one the renderer draws with, not a third copy.
        const name = token.replace(' on the pitch', '');
        expect(SURFACE_BY_VARIANT.highcontrast.get(name), token).toBe(hex);
        // And the luminance is re-derived from that hex to three decimals,
        // which is the precision the section states them at.
        const stated = Number(field(FORCED_LUMINANCE, row, 'Relative luminance'));
        expect(Math.round(luminance(hex) * 1000) / 1000, `${token} ${hex}`).toBe(stated);
      }
    });

    it('holds the cells the high-contrast variant alone is measured for', () => {
      // SPEC section 18 states four cells that only exist under the query, and
      // two readings that carry its one refusal: the arrow against the second
      // mown stripe, the rail fill where the canvas ends and a system ground
      // begins, and the boundary token's own reading on that ground, which is
      // what makes "the boundary cannot carry this edge" a measurement rather
      // than a sentence.
      let derivedCells = 0;
      let carried = 0;
      for (const row of FORCED_ONLY.rows) {
        const pair = field(FORCED_ONLY, row, 'Pair');
        const foreground = field(FORCED_ONLY, row, 'Foreground');
        const background = field(FORCED_ONLY, row, 'Ground');
        const derived = contrast(
          ground(foreground, 'highcontrast'),
          ground(background, 'highcontrast'),
        );
        expect(round2(derived), pair).toBe(Number(field(FORCED_ONLY, row, 'Ratio')));
        derivedCells += 1;
        const minimum = field(FORCED_ONLY, row, 'Minimum');
        const target = field(FORCED_ONLY, row, 'Target');
        if (minimum === '-') {
          // Ungoverned, and the row says who carries the edge instead. The
          // carrier is the darkened rail fill, and it is asserted here rather
          // than taken from the prose.
          expect(field(FORCED_ONLY, row, 'Target met'), pair).toContain('rail fill');
          expect(target, pair).toBe('-');
          carried += 1;
          continue;
        }
        if (minimum === 'outline carries 3:1') {
          // The arrow's own guarantee is its `--pf-line` outline, exactly as the
          // two brightness variants have it; the fill is measured beside it.
          expect(
            contrast(resolve('--pf-line', 'highcontrast'), ground(background, 'highcontrast')),
            pair,
          ).toBeGreaterThanOrEqual(3);
        } else {
          expect(derived, `${pair}, minimum ${minimum}`).toBeGreaterThanOrEqual(
            Number(minimum),
          );
        }
        const met = field(FORCED_ONLY, row, 'Target met');
        if (met === 'yes') {
          expect(derived, `${pair}, target ${target}`).toBeGreaterThanOrEqual(Number(target));
        } else {
          expect(derived, `${pair}, target ${target}`).toBeLessThan(Number(target));
          expect(met.length, pair).toBeGreaterThan('yes'.length);
        }
      }
      expect(derivedCells).toBe(6);
      expect(carried).toBe(2);
      // The refused edge and its carrier, side by side: the boundary token reads
      // 1.08 on a white system ground and cannot carry it, and the darkened rail
      // fill reads 3.12 there and does.
      const rail = resolve('--pf-rail', 'highcontrast');
      const line = resolve('--pf-line', 'highcontrast');
      expect(round2(contrast(line, '#FFFFFF'))).toBe(1.08);
      expect(round2(contrast(rail, '#FFFFFF'))).toBe(3.12);
      expect(contrast(rail, '#FFFFFF')).toBeGreaterThanOrEqual(3);
      expect(contrast(rail, '#000000')).toBeGreaterThanOrEqual(3);
    });

    it('holds the rail boundary against both mown stripes, in both variants', () => {
      // SPEC section 18's rail row states the boundary against BOTH stripes,
      // floodlit first: 5.38 / 4.70 and 3.71 / 3.27. It used to quote the
      // stripe A pair of the rail FILL alone, which is how the daylight stripe
      // B cell sat at 2.72 unstated until the 2026-09-08 audit measured it;
      // the guarantee now belongs to the three-design-unit `--pf-line`
      // boundary the wall pass draws, and these are its four cells.
      const rows = PAIRS.rows.filter((entry) =>
        field(PAIRS, entry, 'Pair').startsWith('Rail boundary on stripe'),
      );
      expect(rows.map((entry) => field(PAIRS, entry, 'Pair'))).toEqual([
        'Rail boundary on stripe A',
        'Rail boundary on stripe B',
      ]);
      /** Re-derived to the quoted cell, and clearing the threshold beside it. */
      const holds = (quoted: string, derived: number, needs: number): boolean =>
        round2(derived) === Number(quoted) && derived >= needs;
      let checked = 0;
      for (const row of rows) {
        expect(field(PAIRS, row, 'Foreground'), field(PAIRS, row, 'Pair')).toBe('--pf-line');
        for (const variant of VARIANTS) {
          const derived = contrast(
            resolve(field(PAIRS, row, 'Foreground'), variant),
            resolve(field(PAIRS, row, 'Background'), variant),
          );
          expect(
            holds(
              field(PAIRS, row, columnFor(variant)),
              derived,
              Number(field(PAIRS, row, 'Needs')),
            ),
            `${field(PAIRS, row, 'Pair')}, ${variant}`,
          ).toBe(true);
          checked += 1;
        }
      }
      expect(checked).toBe(6);
      // THE SIX CELLS AS LITERALS, in the order the section quotes them, so a
      // fixture edited to agree with a moved hex fails here as well as there.
      expect(
        round2(contrast(resolve('--pf-line', 'floodlit'), resolve('--pitch-stripe-a', 'floodlit'))),
      ).toBe(5.38);
      expect(
        round2(contrast(resolve('--pf-line', 'floodlit'), resolve('--pitch-stripe-b', 'floodlit'))),
      ).toBe(4.7);
      expect(
        round2(contrast(resolve('--pf-line', 'daylight'), resolve('--pitch-stripe-a', 'daylight'))),
      ).toBe(3.71);
      expect(
        round2(contrast(resolve('--pf-line', 'daylight'), resolve('--pitch-stripe-b', 'daylight'))),
      ).toBe(3.27);
      expect(
        round2(
          contrast(
            resolve('--pf-line', 'highcontrast'),
            resolve('--pitch-stripe-a', 'highcontrast'),
          ),
        ),
      ).toBe(8.34);
      expect(
        round2(
          contrast(
            resolve('--pf-line', 'highcontrast'),
            resolve('--pitch-stripe-b', 'highcontrast'),
          ),
        ),
      ).toBe(7.15);
      // THE CONTROLS, one per way the check can be wrong. A cell that does not
      // re-derive is refused; and so is one that re-derives and does not clear,
      // which the daylight rail FILL on stripe B still is. The fill's own
      // reading is not quoted here, because SPEC section 18 no longer states
      // one and a literal would red on a recolour the section now permits: what
      // is asserted is that the fill re-derives to whatever it re-derives to
      // and is refused all the same. The 2026-09-08 audit read it at 2.72
      // against the 3 the table asks for, which is why the row above is the
      // boundary's rather than the fill's.
      expect(holds('3.71', 3.81, 3)).toBe(false);
      const fillOnStripeB = contrast(
        resolve('--pf-rail', 'daylight'),
        resolve('--pitch-stripe-b', 'daylight'),
      );
      expect(holds(String(round2(fillOnStripeB)), fillOnStripeB, 3)).toBe(false);
    });

    it('holds the corrected arrow cells: the fills re-derive and the outline carries the guarantee', () => {
      const row = SCOPED.rows.find(
        (entry) => field(SCOPED, entry, 'Pair') === 'Aim arrow strong end on pitch',
      );
      if (row === undefined) {
        throw new Error('the contract scopes no arrow cell');
      }
      expect(variantOf(field(SCOPED, row, 'Variant'))).toBe('daylight');
      // The strong end's daylight fill is the accent in force for the light
      // theme, on the pitch. Derived, quoted in section 5, pinned here, and
      // deliberately quiet: the guarantee moved to the outline, so a fill
      // nudged until it clears 3 reads as the retired both-ends claim coming
      // quietly back.
      const strong = contrast(
        resolve('--pf-accent', 'daylight'),
        resolve('--pitch-stripe-a', 'daylight'),
      );
      expect(round2(strong)).toBe(Number(field(SCOPED, row, 'Measured')));
      expect(strong).toBeLessThan(Number(field(SCOPED, row, 'Stays below')));
      // The weak end fills its cell the ordinary way and clears, and the
      // floodlit strong end still clears on its own, as section 5 quotes.
      expect(
        round2(contrast(resolve('--pf-line', 'daylight'), resolve('--pitch-stripe-a', 'daylight'))),
      ).toBe(3.71);
      expect(
        round2(
          contrast(resolve('--pf-accent', 'floodlit'), resolve('--pitch-stripe-a', 'floodlit')),
        ),
      ).toBe(3.59);
      // The carrier the source names: the arrow's own `--pf-line` outline,
      // clearing against both stripes in both variants, which is the same
      // boundary rule every other object on the pitch already follows.
      for (const variant of VARIANTS) {
        expect(
          contrast(resolve('--pf-line', variant), resolve('--pitch-stripe-a', variant)),
          `outline on stripe A, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(resolve('--pf-line', variant), resolve('--pitch-stripe-b', variant)),
          `outline on stripe B, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // Exactly these cells are scoped, and a fifth cannot arrive unannounced.
      // The rail's cell left this table with the boundary correction, which gave
      // that row a carrier that clears on both stripes in every variant; the
      // three that arrived with the high-contrast set fall short of its TARGET
      // and of nothing else, which is why each of them names a carrier or, in
      // the one case the section refuses outright, says so.
      expect(
        SCOPED.rows
          .map((entry) =>
            cellKey(field(SCOPED, entry, 'Pair'), variantOf(field(SCOPED, entry, 'Variant'))),
          )
          .sort(),
      ).toEqual([
        'Aim arrow strong end on pitch  daylight',
        'Ball on player fill  highcontrast',
        'Entity ring on player fill  highcontrast',
        'Glyph on player  highcontrast',
      ]);
    });

    it('carries the high-contrast target misses to the carrier each one names', () => {
      // SPEC section 18: "The three target misses are arithmetic, not taste."
      // The ring and the ball on the player fill are carried by their outlines
      // against the pitch, the scoping the arrow cells already use; the dark
      // glyph is refused, because a 7:1 glyph needs the player fill at 0.3684
      // relative luminance or above while the ring's 3:1 minimum caps that fill
      // at 0.2729, which is an empty window and not a preference.
      const onPitch = contrast(
        resolve('--pf-line', 'highcontrast'),
        resolve('--pitch-stripe-a', 'highcontrast'),
      );
      expect(round2(onPitch)).toBe(8.34);
      for (const pair of ['Entity ring on player fill', 'Ball on player fill']) {
        const row = SCOPED.rows.find(
          (entry) =>
            field(SCOPED, entry, 'Pair') === pair &&
            field(SCOPED, entry, 'Variant') === 'High-contrast',
        );
        if (row === undefined) {
          throw new Error(`the contract scopes no high-contrast cell for ${pair}`);
        }
        expect(field(SCOPED, row, 'Carried by'), pair).toContain('8.34');
        expect(onPitch, pair).toBeGreaterThanOrEqual(4.5);
      }
      // The refusal, re-derived rather than quoted: the window the two floors
      // leave for the player fill is empty, to four decimal places.
      const fill = luminance(resolve('--team-player', 'highcontrast'));
      const glyph = luminance(resolve('--glyph-on-player', 'highcontrast'));
      const line = luminance(resolve('--pf-line', 'highcontrast'));
      // A 7:1 dark glyph on the fill needs the fill at least this bright.
      const floorForGlyph = 7 * (glyph + 0.05) - 0.05;
      // The ring's own 3:1 against the fill caps the fill at this.
      const ceilingForRing = (line + 0.05) / 3 - 0.05;
      expect(Number(floorForGlyph.toFixed(4))).toBe(0.3684);
      expect(Number(ceilingForRing.toFixed(4))).toBe(0.2729);
      expect(floorForGlyph).toBeGreaterThan(ceilingForRing);
      expect(fill).toBeLessThanOrEqual(ceilingForRing);
      expect(round2(contrast(resolve('--glyph-on-player', 'highcontrast'),
        resolve('--team-player', 'highcontrast')))).toBe(5.24);
    });

    it('re-derives both identity luminances to two decimal places', () => {
      for (const row of IDENTITY.rows) {
        const token = field(IDENTITY, row, 'Token');
        expect(round2(luminance(resolve(token, 'floodlit'))), token).toBe(
          Number(field(IDENTITY, row, 'Relative luminance')),
        );
        expect(round2(luminance(resolve(token, 'highcontrast'))), token).toBe(
          Number(field(IDENTITY, row, 'High-contrast relative luminance')),
        );
      }
      // The gap is what identity rests on, and it survives every dichromacy. The
      // high-contrast set WIDENS it rather than merely keeping it: SPEC section
      // 18 records 0.26 against 0.04 becoming 0.26 against 0.01, and the fills
      // against each other rising from 3.49 to 4.97.
      for (const variant of VARIANTS) {
        const player = luminance(resolve('--team-player', variant));
        const opponent = luminance(resolve('--team-opponent', variant));
        expect(player, variant).toBeGreaterThan(opponent);
      }
      const brightened =
        luminance(resolve('--team-player', 'highcontrast')) -
        luminance(resolve('--team-opponent', 'highcontrast'));
      const before =
        luminance(resolve('--team-player', 'floodlit')) -
        luminance(resolve('--team-opponent', 'floodlit'));
      expect(brightened).toBeGreaterThan(before);
      expect(
        round2(
          contrast(
            resolve('--team-player', 'highcontrast'),
            resolve('--team-opponent', 'highcontrast'),
          ),
        ),
      ).toBe(4.97);
      expect(
        round2(
          contrast(resolve('--team-player', 'floodlit'), resolve('--team-opponent', 'floodlit')),
        ),
      ).toBe(3.49);
    });
  });

  describe('the retracted claim stays retracted', () => {
    it('measures both fills below 3:1 on the pitch, as the spec records', () => {
      for (const row of RETRACTED.rows) {
        const derived = contrast(
          resolve(field(RETRACTED, row, 'Foreground'), 'floodlit'),
          resolve(field(RETRACTED, row, 'Background'), 'floodlit'),
        );
        const label = field(RETRACTED, row, 'Pair');
        expect(round2(derived), label).toBe(Number(field(RETRACTED, row, 'Measured')));
        expect(derived, label).toBeLessThan(Number(field(RETRACTED, row, 'Stays below')));
      }
    });

    it('carries the two guarantees that replaced it', () => {
      // The outline clears 3:1 against the pitch, and the two fills clear 3:1
      // against each other. Both are in the measured pairs above; asserted
      // again here by name so that removing either row is not silent.
      for (const variant of VARIANTS) {
        expect(
          contrast(resolve('--pf-line', variant), resolve('--pitch-stripe-a', variant)),
          `outline on pitch, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(resolve('--pf-line', variant), resolve('--pitch-stripe-b', variant)),
          `outline on the other stripe, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(resolve('--team-player', variant), resolve('--team-opponent', variant)),
          `fill against fill, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe('the three variants', () => {
    it('redefines the pitch per theme, and only where the spec says it changes', () => {
      // THE THREE MOWN-AND-RAIL TOKENS ARE THE BRIGHTNESS PAIR. Daylight is the
      // brighter of the two, which is what makes it a brightness variant rather
      // than a second palette. `--team-opponent` is not one of them: it is the
      // same colour in both themes and darkens only under the query, so the two
      // rules are stated apart rather than run together.
      const themed = VARYING.filter(
        (token) => resolve(token, 'floodlit') !== resolve(token, 'daylight'),
      );
      expect(themed).toEqual(['--pitch-stripe-a', '--pitch-stripe-b', '--pf-rail']);
      for (const token of themed) {
        expect(
          luminance(resolve(token, 'daylight')),
          token,
        ).toBeGreaterThan(luminance(resolve(token, 'floodlit')));
      }
      expect(resolve('--team-opponent', 'floodlit')).toBe(resolve('--team-opponent', 'daylight'));
      // Every varying token is aliased per block all the same, so a theme change
      // flips the whole set or none of it.
      for (const token of VARYING) {
        expect(DARK_BY_SETTING.declarations.get(token), token).toBe(`var(${token}-floodlit)`);
        expect(LIGHT_BY_SETTING.declarations.get(token), token).toBe(`var(${token}-daylight)`);
        expect(FORCED_COLORS.declarations.get(token), token).toBe(
          `var(${token}-highcontrast)`,
        );
      }
      for (const token of FIXED) {
        expect(DARK_BY_SETTING.declarations.has(token), token).toBe(false);
        expect(LIGHT_BY_SETTING.declarations.has(token), token).toBe(false);
        expect(FORCED_COLORS.declarations.has(token), token).toBe(false);
      }
    });

    it('darkens the high-contrast pitch rather than recolouring it', () => {
      // SPEC section 18: every moved value is the floodlit value with its three
      // channels scaled by one factor and rounded half up, which is what makes
      // it "a darkening of the pitch the two themes share, not a second
      // palette". Re-derived here from the floodlit hexes and the four factors
      // the section states, so a hand-picked colour that happened to look right
      // could not pass.
      const scaled = (hex: string, factor: number): string => {
        const digits = hex.slice(1);
        const byte = (at: number): number => Number.parseInt(digits.slice(at, at + 2), 16);
        const part = (at: number): string =>
          Math.floor(byte(at) * factor + 0.5)
            .toString(16)
            .toUpperCase()
            .padStart(2, '0');
        return `#${part(0)}${part(2)}${part(4)}`;
      };
      const factors: ReadonlyArray<readonly [string, number]> = [
        ['--pitch-stripe-a', 0.72],
        ['--pitch-stripe-b', 0.75],
        ['--pf-rail', 0.71],
        ['--team-opponent', 0.55],
      ];
      for (const [token, factor] of factors) {
        expect(scaled(resolve(token, 'floodlit'), factor), token).toBe(
          resolve(token, 'highcontrast'),
        );
        expect(
          luminance(resolve(token, 'highcontrast')),
          token,
        ).toBeLessThan(luminance(resolve(token, 'floodlit')));
      }
      expect(factors.map(([token]) => token)).toEqual([...VARYING]);
      // The control: a factor that is not the one the section states does not
      // reproduce the hex, so the check above is a derivation and not a copy.
      expect(scaled(resolve('--pitch-stripe-a', 'floodlit'), 0.73)).not.toBe(
        resolve('--pitch-stripe-a', 'highcontrast'),
      );
    });

    it('keeps the luminance order of the play surface identical in all three', () => {
      // SPEC section 18 rests every contrast guarantee on this. If the order
      // moved, a pair that clears its threshold in one variant could fail in
      // another with nothing else changing, and the high-contrast subsection
      // says so in as many words: the order is identical, so every guarantee
      // built on it carries.
      const order = (variant: Brightness): string[] =>
        [...VARYING, ...FIXED]
          .map((token) => ({ token, value: luminance(resolve(token, variant)) }))
          .sort((one, other) => one.value - other.value)
          .map((entry) => entry.token);
      expect(order('daylight')).toEqual(order('floodlit'));
      expect(order('highcontrast')).toEqual(order('floodlit'));
      expect(order('floodlit')).toHaveLength(10);
    });
  });

  describe('reduced motion', () => {
    it('resolves every duration to --dur-0, and does it by redefining tokens', () => {
      expect([...REDUCED_MOTION.declarations]).toEqual([
        ['--dur-1', 'var(--dur-0)'],
        ['--dur-2', 'var(--dur-0)'],
        ['--dur-3', 'var(--dur-0)'],
        ['--dur-4', 'var(--dur-0)'],
      ]);
      // A blanket animation or transition cancel also stops transitionend and
      // animationend arriving, so anything sequenced on them stops arriving and
      // the ORDER of states changes. Section 4 forbids exactly that.
      const source = stripComments(stylesheetText, false);
      const at = source.indexOf('@media (prefers-reduced-motion: reduce)');
      expect(at).toBeGreaterThan(-1);
      const body = source.slice(at);
      expect(body).not.toMatch(/\banimation\b/);
      expect(body).not.toMatch(/\btransition\b/);
      expect(body).not.toContain('!important');
    });

    it('resolves the renderer duration to zero, for every step', () => {
      for (const step of STEPS) {
        expect(duration(step, true), `step ${String(step)}`).toBe(0);
        expect(duration(step, false), `step ${String(step)}`).toBe(DURATION[step]);
      }
      expect(STEPS).toHaveLength(Object.keys(DURATION).length);
      // Reduced motion removes the animation and leaves the sequence alone, so
      // the zero is a duration and never a skipped step.
      expect(duration(4, true)).toBe(duration(0, false));
    });
  });

  describe('the composition root reads the query the third variant answers', () => {
    it('asks the platform for forced colours, once, beside the theme', () => {
      // SPEC section 18's wiring, read as source because the composition root is
      // what does it and no unit test can mount one. Nothing under `render/` may
      // ask the platform anything, so the read is here, and the stylesheet
      // answers the same query for the chrome: one palette rather than two.
      const entry = readFileSync(ENTRY, 'utf8');
      expect(entry).toContain("const FORCED_COLORS_QUERY = '(forced-colors: active)';");
      expect(entry).toContain('forcedColorsQuery ??= window.matchMedia(FORCED_COLORS_QUERY);');
      // AND HANDS IT TO THE RESOLVER, which is the half a query read and thrown
      // away would leave out: the frame draws with whatever this returns.
      expect(entry).toContain(
        'const palette = playSurfaceFor(themeInForce(), forcedColorsInForce());',
      );
      // The list is built once and asked every frame, the same way the theme and
      // the motion policy are: a MediaQueryList is live, so a preference turned
      // on mid-session moves the pitch on the next frame.
      expect(entry).toContain('let forcedColorsQuery: MediaQueryList | null = null;');
      // And the theme-only resolver is NOT what the frame calls, because it
      // cannot see the query at all.
      expect(entry).not.toContain('pitchFor(themeInForce())');
    });
  });

  describe('the token layer is imported once, at the composition root', () => {
    it('imports the stylesheet from main.ts', () => {
      expect(readFileSync(ENTRY, 'utf8')).toContain("import './ui/tokens.css';");
    });

    it('is imported from nowhere else under src/', () => {
      const importers = walkSource()
        .scanned.filter((relative) => relative !== 'src/main.ts')
        .filter((relative) =>
          /\bimport\s+['"][^'"]+\.css['"]/.test(
            readFileSync(path.join(PROJECT_ROOT, relative), 'utf8'),
          ),
        );
      expect(importers).toEqual([]);
    });
  });

  describe('no literal value in component code', () => {
    it('finds no colour literal under src/ outside the token layer', () => {
      const walk = walkSource();
      const offences: string[] = [];
      // The exemptions, as an allowance spent one occurrence at a time: an
      // extra `100dvh` is an offence rather than a fifth free one, and an
      // entry nothing spends is reported below.
      const allowance = new Map<string, number>();
      for (const entry of DIMENSION_EXEMPT) {
        allowance.set(`${entry.file}: ${entry.literal}`, entry.count);
      }
      for (const relative of walk.scanned) {
        const text = readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
        const css = relative.endsWith('.css');
        for (const hit of colourLiterals(text, css)) {
          offences.push(`${relative}: ${hit}`);
        }
        for (const hit of dimensionsFor(text, css)) {
          const key = `${relative}: ${hit}`;
          const left = allowance.get(key) ?? 0;
          if (left > 0) {
            allowance.set(key, left - 1);
            continue;
          }
          offences.push(key);
        }
      }
      expect(offences).toEqual([]);
      // Every exemption was spent, so a carve-out cannot outlive the line it
      // was written for.
      expect([...allowance].filter(([, left]) => left > 0)).toEqual([]);
      // A sweep over nothing passes. This is the part of it that cannot.
      expect(walk.scanned.length).toBeGreaterThan(0);
    });

    it('names every exempt occurrence, with its reason and its count', () => {
      // The list is the carve-out, so it is pinned by value and by length: a
      // sixth entry is a review, not an edit, and every entry says why the
      // occurrence is not a design value.
      expect(
        DIMENSION_EXEMPT.map((entry) => `${entry.file} ${entry.literal} x${String(entry.count)}`),
      ).toEqual([
        'src/ui/components/chrome.css 100vh x2',
        'src/ui/components/chrome.css 100dvh x2',
        'src/ui/components/chrome.css 100% x1',
        'src/ui/components/chrome.css 1px x2',
        'src/ui/components/chrome.css 50% x1',
      ]);
      expect(DIMENSION_EXEMPT).toHaveLength(5);
      for (const entry of DIMENSION_EXEMPT) {
        expect(entry.why.length, entry.literal).toBeGreaterThan(20);
      }
      // Eight occurrences in one file, and the file is a real one the sweep
      // reaches rather than a name nothing walks to.
      expect(DIMENSION_EXEMPT.reduce((total, entry) => total + entry.count, 0)).toBe(8);
      expect(walkSource().scanned).toContain('src/ui/components/chrome.css');
    });

    it('matches every unit a design value can be written in', () => {
      // THE LIST IS THE GATE, so it is pinned as a value the way the swept
      // extensions are, and every member is proven to fire in both languages.
      // A unit missing from here is not a weaker rule: it is no rule at all
      // for anything written in it, which is how four viewport units came to
      // be shipped in the chrome stylesheet unremarked.
      expect([...DIMENSION_UNITS].sort()).toEqual([
        '%', 'cap', 'ch', 'cm', 'cqb', 'cqh', 'cqi', 'cqmax', 'cqmin', 'cqw',
        'deg', 'dvb', 'dvh', 'dvi', 'dvmax', 'dvmin', 'dvw', 'em', 'ex', 'fr',
        'grad', 'ic', 'in', 'lh', 'lvb', 'lvh', 'lvi', 'lvmax', 'lvmin', 'lvw',
        'mm', 'ms', 'pc', 'pt', 'px', 'q', 'rad', 'rcap', 'rch', 'rem', 'rex',
        'ric', 'rlh', 's', 'svb', 'svh', 'svi', 'svmax', 'svmin', 'svw', 'turn',
        'vb', 'vh', 'vi', 'vmax', 'vmin', 'vw',
      ]);
      expect(DIMENSION_UNITS).toHaveLength(57);
      expect(new Set(DIMENSION_UNITS).size).toBe(DIMENSION_UNITS.length);
      // One positive control per unit, in both languages, and each one is
      // matched WHOLE: a `100svh` read as a `100s` would leave the alternation
      // ordered wrongly and every longer unit half seen.
      for (const unit of DIMENSION_UNITS) {
        const value = `12${unit}`;
        expect(dimensionsFor(`.a { width: ${value}; }`, true), unit).toEqual([value]);
        expect(dimensionsFor(`const width = '${value}';`, false), unit).toEqual([value]);
      }
      // And the negative controls that keep the wider matcher from firing on
      // ordinary text: a bare number, an identifier that ends in a unit name,
      // a token name whose tail is a digit, and a resolution unit, which is
      // out of the list by the decision stated at its head.
      expect(dimensionsFor('.a { flex: 12; }', true)).toEqual([]);
      expect(dimensionsFor('.a { width: var(--space-1); }', true)).toEqual([]);
      expect(dimensionsFor("const name = 'grid12ch';", false)).toEqual([]);
      expect(dimensionsFor('.a { background-image: image-set(a 2x); }', true)).toEqual([]);
    });

    it('reads a negative offset as the literal it is, and a location as neither', () => {
      // A MINUS IS PART OF THE NUMBER. Both shapes below survived the sweep,
      // and both are values on a QUALITY-BAR section 15 scale: a negative
      // margin is a spacing step and a negative translate is a proportion.
      expect(dimensionsFor('.a { margin-top: -12px; }', true)).toEqual(['-12px']);
      expect(dimensionsFor('.a { transform: translateX(-50%); }', true)).toEqual(['-50%']);
      expect(dimensionsFor("const shift = 'translateY(-1.5rem)';", false)).toEqual(['-1.5rem']);
      // AND THE NEGATIVE CONTROL THE MINUS MUST NOT COST: a custom property
      // name ends in a digit after a minus and is not a literal at all.
      expect(dimensionsFor('.a { width: var(--space-1); }', true)).toEqual([]);
      expect(dimensionsFor('.a { --space-1: 4px; }', true)).toEqual(['4px']);
      // A LOCATION IS NOT A VALUE. What is inside `url(...)` is a file name,
      // and a file name that carries a length is still a file name.
      expect(dimensionsFor('.a { background: url(https://x.example/12px.png); }', true)).toEqual(
        [],
      );
      expect(
        dimensionsFor('.a { background: url("https://x.example/12px.png"); }', true),
      ).toEqual([]);
      expect(dimensionsFor("const style = 'url(a/12px.png)';", false)).toEqual([]);
      // And the positive control beside it, so the elision did not simply stop
      // the sweep: the same declaration with a real value after the location.
      expect(dimensionsFor('.a { background: url(a/12px.png) 4px 8px; }', true)).toEqual([
        '4px',
        '8px',
      ]);
      // A FLEX FRACTION STAYS MATCHED, inside `repeat()` like anywhere else: it
      // is a design value on the E1 rule, not a location and not a count.
      expect(dimensionsFor('.a { grid-template-columns: repeat(2, 1fr); }', true)).toEqual([
        '1fr',
      ]);
    });

    it('sweeps every extension a module or a stylesheet can arrive in', () => {
      // A missing extension is not a weaker rule, it is no rule: the file is
      // never read at all. The stylesheet extension is the one with nothing
      // else anchoring it, because the only CSS under src/ today is the token
      // file the sweep is supposed to skip, and every chrome stylesheet from
      // the chrome part onward lands beside it.
      expect([...SWEPT_EXTENSIONS].sort()).toEqual([
        '.cjs', '.css', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx',
      ]);
    });

    it('reaches into subdirectories and excludes exactly the token layer', () => {
      const walk = walkSource();
      for (const relative of TOKEN_LAYER) {
        expect(walk.visited, relative).toContain(relative);
        expect(walk.scanned, relative).not.toContain(relative);
      }
      expect(walk.scanned).toContain('src/main.ts');
      expect(walk.visited.length).toBeGreaterThan(walk.scanned.length);
    });

    it('would see a literal if there were one, in either language', () => {
      // The positive control. Without it, a matcher that has stopped matching
      // reports a clean tree forever, which is the same output as a clean tree.
      const controls: ReadonlyArray<readonly [string, boolean, number, number]> = [
        ["const fill = '#FF0000';", false, 1, 0],
        ['const fill = `rgba(0, 0, 0, 0.5)`;', false, 1, 0],
        // A percentage inside a colour function is both: the colour matcher
        // reports the function and the dimension matcher reports the 70%,
        // which is what a matcher covering every unit is supposed to do.
        ['const fill = "oklch(70% 0.1 200)";', false, 1, 1],
        // A CSS function name is case-insensitive and the bare color() form is
        // a colour like any other. Both were live escapes.
        ['const fill = "RGB(255, 0, 0)";', false, 1, 0],
        ['const fill = "color(display-p3 1 0 0)";', false, 1, 0],
        // And the guard that keeps the bare form from eating ordinary code.
        ['const fill = getColor(1);', false, 0, 0],
        ['/* #FF0000 and rgba(1, 2, 3, 1) */ const count = 1;', false, 0, 0],
        ['// #FF0000\nconst count = 1;', false, 0, 0],
        // A dimension in a string is a style value, which is a literal. A bare
        // number is not, and an interpolated one carries no digit at all.
        ["const width = '12px';", false, 0, 1],
        ['const step = "220ms";', false, 0, 1],
        ['const width = `${size}px`;', false, 0, 0],
        ['const gap = 12;', false, 0, 0],
        ['// 12px\nconst gap = 0;', false, 0, 0],
        ['.a { color: #FFF; }', true, 1, 0],
        ['.a { color: red; }', true, 1, 0],
        ['.a { color: RGB(255, 0, 0); }', true, 1, 0],
        ['.a { padding: 4px 0.5rem; }', true, 0, 2],
        ['.a { padding: 0; }', true, 0, 0],
        ['/* 4px */ .a { padding: var(--space-1); }', true, 0, 0],
        [".a { content: '12px'; }", true, 0, 1],
        ['.a { transition: opacity 140ms; }', true, 0, 1],
        ['.a { transition: opacity var(--dur-2); }', true, 0, 0],
      ];
      expect(controls).toHaveLength(22);
      for (const [text, css, colours, dimensions] of controls) {
        expect(colourLiterals(text, css), `colours in ${text}`).toHaveLength(colours);
        expect(dimensionsFor(text, css), `dimensions in ${text}`).toHaveLength(dimensions);
      }
      // And on the real files, which is the strongest form of the control: the
      // token layer is where the literals live, so the matchers must find them.
      expect(colourLiterals(stylesheetText, true).length).toBeGreaterThan(20);
      expect(dimensionsFor(stylesheetText, true).length).toBeGreaterThan(20);
      expect(
        colourLiterals(readFileSync(path.join(PROJECT_ROOT, TOKEN_LAYER[1] ?? ''), 'utf8'), false)
          .length,
      ).toBeGreaterThan(20);
    });
  });
});

// ---------------------------------------------------------------------------
// The bare-numeric sweep over the drawing modules, item E1's stated residue.
// ---------------------------------------------------------------------------

const RENDER_ROOT = path.join(SOURCE_ROOT, 'render');

/**
 * Every value on the four numeric scales, as numbers, taken from the renderer
 * record rather than written out: the record is checked against the design
 * contract above, so this set is the contract's set by construction.
 *
 * ZERO AND ONE ARE OUT, WITH THEIR REASON. `--border-hair` is 1 and `--dur-0`
 * is 0, and those two are also the identity values of arithmetic: an origin, a
 * first index, a full alpha, a unit step. A sweep that read every one of them
 * as a token reference would report the whole tree and be turned off within a
 * day. What that leaves unswept is a hairline weight written as `1`, and the
 * `lineWidth` rule below is what covers it: a stroke weight is the one place a
 * bare 1 is a token value rather than an identity.
 */
const TOKEN_VALUES: ReadonlySet<number> = new Set(
  [
    ...Object.values(SPACE),
    ...Object.values(RADIUS),
    ...Object.values(BORDER),
    ...Object.values(DURATION),
  ].filter((value) => value !== 0 && value !== 1),
);

/**
 * A token reference by index is a token reference. `SPACE[8]` and `DURATION[2]`
 * name a step on a scale exactly as `RADIUS.sm` names one by key, and so does
 * `duration(2, reducedMotion)`, whose first argument is typed as the step. The
 * digit inside them is a NAME, so it is removed before the sweep reads numbers.
 */
const TOKEN_SUBSCRIPT = /\b(?:SPACE|DURATION)\s*\[\s*\d+\s*\]/g;
const TOKEN_STEP_CALL = /\bduration\s*\(\s*\d+\s*,/g;

/**
 * A numeric literal, refusing a digit that is part of an identifier or of a
 * property name: the `2` of `vec2`, and the `0` of `point.x0`, are not numbers.
 */
const BARE_NUMBER = /(?<![A-Za-z0-9_$.])\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?/gi;

/** A stroke weight written as a number, which is a `--border-*` step inlined. */
const LINE_WIDTH_LITERAL = /\blineWidth\s*=\s*-?\d[\d_]*(?:\.\d+)?/g;

/**
 * String contents blanked, comments already gone. A number inside a string is
 * a dimension or a colour and is the other sweep's business; here it would
 * report the `2` of `'pf-2'` as a border weight.
 */
function withoutStrings(text: string): string {
  const source = stripComments(text, true);
  let out = '';
  let at = 0;
  while (at < source.length) {
    const here = source[at] ?? '';
    if (here !== '"' && here !== "'" && here !== '`') {
      out += here;
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < source.length) {
      const character = source[end] ?? '';
      if (character === '\\') {
        end += 2;
        continue;
      }
      if (character === here) {
        break;
      }
      end += 1;
    }
    out += here + source.slice(at + 1, end).replace(/[^\n]/g, ' ') + here;
    at = end + 1;
  }
  return out;
}

/** The code of a module with strings, comments and token references removed. */
function scannableCode(text: string): string {
  return withoutStrings(text)
    .replace(TOKEN_SUBSCRIPT, (match) => ' '.repeat(match.length))
    .replace(TOKEN_STEP_CALL, (match) => ' '.repeat(match.length));
}

/** Every literal in a module whose value is a value on a token scale. */
function tokenNumbersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of scannableCode(text).matchAll(BARE_NUMBER)) {
    if (TOKEN_VALUES.has(Number(match[0].replace(/_/g, '')))) {
      found.push(match[0]);
    }
  }
  return found;
}

/** Every stroke weight in a module written as a number instead of a token. */
function lineWidthNumbersIn(text: string): string[] {
  return [...scannableCode(text).matchAll(LINE_WIDTH_LITERAL)].map((match) => match[0]);
}

/** The modules the bare-numeric sweep reads: everything that draws but the record. */
function drawingModules(): string[] {
  return readdirSync(RENDER_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `src/render/${entry.name}`)
    .filter((relative) => !TOKEN_LAYER.includes(relative))
    .sort();
}

/**
 * The occurrences the bare-numeric sweep exempts, each named with the reason it
 * is not a token reference, and each consumed exactly once.
 *
 * THREE REASONS AND NO OTHERS. A GEOMETRY constant is a proportion of a shape
 * this file draws, most often a halving; TRIGONOMETRY is a fraction of a turn;
 * an INDEX or a COUNT is a position in a list or a number of things. None of
 * them is a length, a radius, a weight or a duration, which are the four scales
 * QUALITY-BAR section 15 states and the only four this sweep is about.
 *
 * The count is part of the entry, so a second `64` appended to `effects.ts`
 * tomorrow is an offence rather than something that hides behind this one, and
 * every entry is asserted to have been used, so an exemption that outlives its
 * occurrence reddens rather than sitting here forever.
 */
const NUMERIC_EXEMPT: readonly Exemption[] = [
  {
    file: 'src/render/arrow.ts',
    literal: '2',
    count: 3,
    why: 'geometry: the head clamped to half the shaft, and the two hex digits of one channel, twice',
  },
  {
    file: 'src/render/arrow.ts',
    literal: '3',
    count: 1,
    why: 'index: the third channel offset in #RRGGBB, which is a string position',
  },
  {
    file: 'src/render/arrow.ts',
    literal: '16',
    count: 2,
    why: 'count: base sixteen, once to parse a channel and once to print one',
  },
  {
    file: 'src/render/effects.ts',
    literal: '2',
    count: 10,
    why: 'geometry: seven halvings of a span or a frame, the two slow pulse steps, the two-sample trail floor and the trail width as a diameter',
  },
  {
    file: 'src/render/effects.ts',
    literal: '3',
    count: 1,
    why: 'count: SC 2.3.1 admits three flashes per region per second',
  },
  {
    file: 'src/render/effects.ts',
    literal: '4',
    count: 1,
    why: 'count: the rate limiter grid is four rows deep',
  },
  {
    file: 'src/render/effects.ts',
    literal: '8',
    count: 1,
    why: 'count: the rate limiter grid is eight columns across',
  },
  {
    file: 'src/render/effects.ts',
    literal: '12',
    count: 1,
    why: 'count: a goal burst is twelve particles',
  },
  {
    file: 'src/render/effects.ts',
    literal: '64',
    count: 1,
    why: 'count: the event log keeps sixty-four records, so a long match cannot grow',
  },
  {
    file: 'src/render/entities.ts',
    literal: '2',
    count: 3,
    why: 'trigonometry: the turn in TAU, and the quarter turn the star starts at, twice',
  },
  {
    file: 'src/render/guide.ts',
    literal: '2',
    count: 1,
    why: 'geometry: a polyline needs two points before it is a line',
  },
  {
    file: 'src/render/pitch.ts',
    literal: '2',
    count: 5,
    why: 'geometry: stripe parity, the two vignette radii, the band across both walls, and the half of the boundary weight a centred stroke covers',
  },
  {
    file: 'src/render/surface.ts',
    literal: '2',
    count: 2,
    why: 'geometry: centring a point in a viewport is halving it, once per axis',
  },
];

describe('PF-1 the bare numerics the dimension sweep cannot see', () => {
  /**
   * ITEM E1's OWN STATED RESIDUE, closed for the drawing modules.
   *
   * The sweep above matches colours and dimensions: a colour anywhere, and a
   * number with a CSS unit welded to it inside a string. Neither can see a
   * renderer literal, because a canvas context takes numbers - `lineWidth = 3`
   * and `arc(x, y, 24, 0, TAU)` carry no unit and no hash - so `BORDER.thick`
   * replaced by its own 3, or `SPACE[5]` by its own 24, drew exactly the same
   * pixels and passed every gate in the project. That residue was handed to
   * E1's Inspection, on the reasoning that 12 may be a radius or a count and no
   * regular expression tells them apart.
   *
   * WHAT CLOSES IT IS NOT A CLEVERER MATCHER, IT IS A NARROWER QUESTION. The
   * sweep does not ask whether a number is a design value; it asks whether a
   * number EQUALS one of the sixteen values on the four scales, in the eight
   * modules that draw. That is a small set of candidates, and every one of them
   * in the tree today is named above with the reason it is a count, an index or
   * a proportion. E1's Inspection no longer has to read the render layer for
   * inlined spacing, radius, weight or duration values; what it still owns is
   * every module OUTSIDE `src/render/`, any design value that happens not to
   * equal a token, and the judgement of whether a new exemption is honest.
   */
  it('finds no token value written as a number in a module that draws', () => {
    const modules = drawingModules();
    const offences: string[] = [];
    const allowance = new Map<string, number>();
    for (const entry of NUMERIC_EXEMPT) {
      allowance.set(`${entry.file}: ${entry.literal}`, entry.count);
    }
    for (const relative of modules) {
      const text = readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
      for (const hit of tokenNumbersIn(text)) {
        const key = `${relative}: ${hit}`;
        const left = allowance.get(key) ?? 0;
        if (left > 0) {
          allowance.set(key, left - 1);
          continue;
        }
        offences.push(key);
      }
      for (const hit of lineWidthNumbersIn(text)) {
        offences.push(`${relative}: ${hit}`);
      }
    }
    expect(offences).toEqual([]);
    // Every exemption was spent, so a carve-out cannot outlive the line it was
    // written for, and a sweep over nothing cannot pass.
    expect([...allowance].filter(([, left]) => left > 0)).toEqual([]);
    expect(modules.length).toBeGreaterThan(0);
  });

  it('reads every module that draws, and exactly the token record is skipped', () => {
    // A file the walk never opens is a file the sweep never reads, so the list
    // is reconciled against the directory in both directions.
    expect(drawingModules()).toEqual([
      'src/render/arrow.ts',
      'src/render/capture.ts',
      'src/render/effects.ts',
      'src/render/entities.ts',
      'src/render/guide.ts',
      'src/render/input.ts',
      'src/render/pitch.ts',
      'src/render/surface.ts',
    ]);
    expect(drawingModules()).not.toContain('src/render/tokens.ts');
    expect(TOKEN_LAYER).toContain('src/render/tokens.ts');
    // The record itself is where these values live, so the matcher must find a
    // great many of them there: the strongest form of the control.
    expect(
      tokenNumbersIn(readFileSync(path.join(PROJECT_ROOT, 'src/render/tokens.ts'), 'utf8'))
        .length,
    ).toBeGreaterThan(10);
  });

  it('sweeps the sixteen values the four scales carry, and no others', () => {
    // THE SET IS THE GATE, so it is pinned as a value. It is derived from the
    // renderer record, which the assertions above hold to the design contract,
    // so a scale value that changed would change this list and be reviewed.
    expect([...TOKEN_VALUES].sort((one, other) => one - other)).toEqual([
      2, 3, 4, 8, 12, 14, 16, 24, 32, 48, 64, 80, 140, 220, 320, 999,
    ]);
    expect(TOKEN_VALUES.size).toBe(16);
    // And the two the set deliberately does not carry, with their reason at the
    // constant: the hairline weight and the zero duration are the identities of
    // arithmetic, and the `lineWidth` rule covers the half that matters.
    expect(TOKEN_VALUES.has(0)).toBe(false);
    expect(TOKEN_VALUES.has(1)).toBe(false);
    expect(BORDER.hair).toBe(1);
    expect(DURATION[0]).toBe(0);
  });

  it('would see a token reference replaced by its own number, one shape at a time', () => {
    // ONE POSITIVE CONTROL PER SHAPE THE SWEEP MUST CATCH, which is one per
    // scale plus the hairline the identities cost it. Without these, a matcher
    // that had stopped matching reports a clean tree forever.
    const controls: ReadonlyArray<readonly [string, string, number, number]> = [
      ['a border weight', 'context.lineWidth = 3;', 1, 1],
      // The hairline is the one the value set cannot see, so the weight rule
      // is the whole of its coverage; a negative one is caught twice, because
      // the minus is not part of the number the value set is asked about.
      ['a hairline weight', 'context.lineWidth = 1;', 0, 1],
      ['a spacing step', 'const HEAD_LENGTH = 24;', 1, 0],
      ['a radius step', 'context.arc(x, y, 14, 0, TAU);', 1, 0],
      ['a pill radius', 'const round = 999;', 1, 0],
      ['a duration step', 'const period = 140;', 1, 0],
      ['a negative weight', 'context.lineWidth = -3;', 1, 1],
    ];
    for (const [name, source, numbers, widths] of controls) {
      expect(tokenNumbersIn(source), name).toHaveLength(numbers);
      expect(lineWidthNumbersIn(source), name).toHaveLength(widths);
    }
    // AND THE NEGATIVE CONTROLS, each one a shape the sweep must NOT report: a
    // token reference by key or by index, a step named to `duration`, a number
    // that is on no scale, a digit inside an identifier or a property, a number
    // inside a string, and a number inside a comment.
    for (const [name, source] of [
      ['a key reference', 'context.lineWidth = BORDER.thick;'],
      ['an index reference', 'const HEAD_LENGTH = SPACE[5];'],
      ['a duration index', 'const step = DURATION[2];'],
      ['a duration step call', 'const period = duration(2, reducedMotion);'],
      ['a value on no scale', 'const BURST_SLOWEST_RATIO = 0.5;'],
      ['a digit in an identifier', "import { set } from './vec2';"],
      ['a digit in a property', 'const value = point.x2;'],
      ['a number in a string', "root.dataset['pf'] = 'panel-3';"],
      ['a number in a comment', '// the head is 24 units long\nconst a = 0;'],
      ['a number in a block comment', '/* 24 */ const a = 0;'],
    ] as const) {
      expect(tokenNumbersIn(source), name).toEqual([]);
      expect(lineWidthNumbersIn(source), name).toEqual([]);
    }
    // A COMPUTED WEIGHT IS NOT A LITERAL WEIGHT, which is the one shape the two
    // rules answer differently: the stroke rule sees no number assigned, while
    // the value set still reports the doubling inside the expression - and that
    // doubling is exempted by name above, as the trail's own diameter.
    const computed = 'context.lineWidth = from.radius * 2 * left;';
    expect(lineWidthNumbersIn(computed)).toEqual([]);
    expect(tokenNumbersIn(computed)).toEqual(['2']);
  });

  it('names every exempt occurrence, with its reason and its count', () => {
    // The list is the carve-out, so it is pinned by value and by length: a
    // fourteenth entry is a review, not an edit, and every entry says why the
    // occurrence is a count, an index or a proportion rather than a token.
    expect(
      NUMERIC_EXEMPT.map((entry) => `${entry.file} ${entry.literal} x${String(entry.count)}`),
    ).toEqual([
      'src/render/arrow.ts 2 x3',
      'src/render/arrow.ts 3 x1',
      'src/render/arrow.ts 16 x2',
      'src/render/effects.ts 2 x10',
      'src/render/effects.ts 3 x1',
      'src/render/effects.ts 4 x1',
      'src/render/effects.ts 8 x1',
      'src/render/effects.ts 12 x1',
      'src/render/effects.ts 64 x1',
      'src/render/entities.ts 2 x3',
      'src/render/guide.ts 2 x1',
      'src/render/pitch.ts 2 x5',
      'src/render/surface.ts 2 x2',
    ]);
    expect(NUMERIC_EXEMPT).toHaveLength(13);
    expect(NUMERIC_EXEMPT.reduce((total, entry) => total + entry.count, 0)).toBe(32);
    for (const entry of NUMERIC_EXEMPT) {
      expect(entry.why.length, `${entry.file} ${entry.literal}`).toBeGreaterThan(20);
      // Each reason names its class, so "why" is an answer rather than a label.
      expect(entry.why, `${entry.file} ${entry.literal}`).toMatch(
        /^(?:geometry|trigonometry|index|count): /,
      );
      // And every file named is one the sweep actually reads.
      expect(drawingModules(), entry.file).toContain(entry.file);
    }
  });
});

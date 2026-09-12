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

/** A play-surface token's value per variant, including the arrow's accent. */
const SURFACE_BY_VARIANT: Record<Brightness, Map<string, string>> = {
  floodlit: new Map(),
  daylight: new Map(),
};
for (const table of [SURFACE, ARROW_ACCENT]) {
  for (const row of table.rows) {
    SURFACE_BY_VARIANT.floodlit.set(field(table, row, 'Token'), field(table, row, 'Floodlit'));
    SURFACE_BY_VARIANT.daylight.set(field(table, row, 'Token'), field(table, row, 'Daylight'));
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
 */
const THEME_BY_VARIANT = { floodlit: 'dark', daylight: 'light' } as const;
const VARIANTS: readonly Brightness[] = ['floodlit', 'daylight'];

/** A token's hex in one variant: play surface by variant, chrome by theme. */
function resolve(token: string, variant: Brightness): string {
  const surface = SURFACE_BY_VARIANT[variant].get(token);
  if (surface !== undefined) {
    return surface;
  }
  const chrome = CHROME_BY_THEME[THEME_BY_VARIANT[variant]].get(token);
  if (chrome !== undefined) {
    return chrome;
  }
  throw new Error(`the contract states no ${variant} value for ${token}`);
}

/** A variant named in a contract cell, checked rather than cast. */
function variantOf(text: string): Brightness {
  const value = text.toLowerCase();
  if (value !== 'floodlit' && value !== 'daylight') {
    throw new Error(`not a brightness variant: ${JSON.stringify(text)}`);
  }
  return value;
}

/** The column a variant's number is quoted in. */
function columnFor(variant: Brightness): string {
  return variant === 'floodlit' ? 'Floodlit' : 'Daylight';
}

/** One cell of the measured-pairs table, named the way section 8 names it. */
function cellKey(pair: string, variant: Brightness): string {
  return `${pair}  ${variant}`;
}

/** Tokens that hold a different colour in each variant, read off the contract. */
const VARYING = SURFACE.rows
  .filter((row) => field(SURFACE, row, 'Floodlit') !== field(SURFACE, row, 'Daylight'))
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
 * A bare number in TypeScript is still nobody's business but the reviewer's: 12
 * may be a radius that belongs in a token, or an entity count, or a loop bound,
 * and no scan tells them apart. That residue is what makes E1 an Inspection
 * item, and the checklist hands it over rather than pretending a regular
 * expression closed it.
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
      expect(SCALES.rows).toHaveLength(37);
      expect(CHROME.rows).toHaveLength(4);
      expect(SURFACE.rows).toHaveLength(10);
      expect(ARROW_ACCENT.rows).toHaveLength(1);
      expect(PAIRS.rows).toHaveLength(14);
      expect(IDENTITY.rows).toHaveLength(2);
      expect(RETRACTED.rows).toHaveLength(2);
      // Section 8 lists the two cells whose threshold the source scopes to a
      // named carrier, corrected 2026-08-29 from the two disclosures this
      // file recorded at PF-1.
      expect(SCOPED.rows).toHaveLength(2);
      // Section 1 carries a second table, the prose derivations. Reading it by
      // accident would compare the wrong column.
      expect(tablesUnder('1. Numeric scales')).toHaveLength(2);
    });

    it('separates the three brightness variants from the seven fixed colours', () => {
      expect(VARYING).toEqual(['--pitch-stripe-a', '--pitch-stripe-b', '--pf-rail']);
      expect(FIXED).toHaveLength(7);
    });
  });

  describe('the stylesheet mechanism, pinned so the parser cannot be blinded', () => {
    it('is exactly five blocks: a base, a preference, two settings and reduced motion', () => {
      expect(
        BLOCKS.map((entry) => `${entry.media ?? 'top level'}  ${entry.selector}`),
      ).toEqual([
        'top level  :root',
        "(prefers-color-scheme: dark)  :root:not([data-theme='light'])",
        "top level  :root[data-theme='dark']",
        "top level  :root[data-theme='light']",
        '(prefers-reduced-motion: reduce)  :root',
      ]);
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
        expected.add(`${token}-floodlit`);
        expected.add(`${token}-daylight`);
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
        expect(declared(BASE, `${token}-floodlit`), token).toBe(resolve(token, 'floodlit'));
        expect(declared(BASE, `${token}-daylight`), token).toBe(resolve(token, 'daylight'));
      }
      for (const token of FIXED) {
        expect(declared(BASE, token), token).toBe(resolve(token, 'floodlit'));
        expect(resolve(token, 'daylight'), token).toBe(resolve(token, 'floodlit'));
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
      for (const variant of VARIANTS) {
        const theme = THEME_BY_VARIANT[variant];
        expect(resolve('--pf-accent', variant), variant).toBe(
          CHROME_BY_THEME[theme].get('--pf-accent'),
        );
        expect(pitchFor(theme).accent, theme).toBe(resolve('--pf-accent', variant));
      }
      expect(BRIGHTNESS_BY_THEME).toEqual({ dark: 'floodlit', light: 'daylight' });
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
      const counts = new Map<string, number>();
      for (const row of PAIRS.rows) {
        const needs = field(PAIRS, row, 'Needs');
        counts.set(needs, (counts.get(needs) ?? 0) + 1);
      }
      expect([...counts].sort()).toEqual([
        ['3', 12],
        ['4.5', 2],
      ]);
      for (const row of SCOPED.rows) {
        expect(field(SCOPED, row, 'Stays below'), field(SCOPED, row, 'Pair')).toBe('3');
      }
    });

    it('re-derives every measured pair the spec quotes, in both variants', () => {
      const scoped = new Set(
        SCOPED.rows.map((row) =>
          cellKey(field(SCOPED, row, 'Pair'), variantOf(field(SCOPED, row, 'Variant'))),
        ),
      );
      let checked = 0;
      let quiet = 0;
      for (const row of PAIRS.rows) {
        const pair = field(PAIRS, row, 'Pair');
        const foreground = field(PAIRS, row, 'Foreground');
        const background = field(PAIRS, row, 'Background');
        const needs = Number(field(PAIRS, row, 'Needs'));
        for (const variant of VARIANTS) {
          const quoted = field(PAIRS, row, columnFor(variant));
          const key = cellKey(pair, variant);
          const derived = contrast(resolve(foreground, variant), resolve(background, variant));
          // Every cell re-derives from the hexes, the two quiet ones included.
          expect(round2(derived), key).toBe(Number(quoted));
          if (scoped.has(key)) {
            // The threshold is scoped to another carrier; the section 8 tests
            // assert the quiet cell stays quiet and the carrier clears.
            quiet += 1;
            continue;
          }
          expect(derived, `${key}, needs ${String(needs)}`).toBeGreaterThanOrEqual(needs);
          checked += 1;
        }
      }
      // Fourteen rows, two variants, and the two cells section 8 scopes away.
      expect(checked).toBe(14 * 2 - 2);
      expect(quiet).toBe(2);
      expect(scoped.size).toBe(2);
    });

    it('holds the corrected rail cell: re-derives, stays quiet, and the pitch row carries it', () => {
      const row = SCOPED.rows.find((entry) => field(SCOPED, entry, 'Pair') === 'Rail on ground');
      if (row === undefined) {
        throw new Error('the contract scopes no rail cell');
      }
      expect(variantOf(field(SCOPED, row, 'Variant'))).toBe('daylight');
      const source = PAIRS.rows.find((entry) => field(PAIRS, entry, 'Pair') === 'Rail on ground');
      if (source === undefined) {
        throw new Error('the measured pairs carry no rail row');
      }
      const derived = contrast(resolve('--pf-rail', 'daylight'), resolve('--pf-ground', 'daylight'));
      // Derived, quoted in section 5, and pinned here, so a hex nudged back
      // toward the retired 8.59 quote fails in three places at once.
      expect(round2(derived)).toBe(Number(field(SCOPED, row, 'Measured')));
      expect(field(PAIRS, source, columnFor('daylight'))).toBe(field(SCOPED, row, 'Measured'));
      // Deliberately quiet: the source scopes the 3:1 to the floodlit variant,
      // so the cell is asserted BELOW the ceiling, and a rail recoloured until
      // it clears fails as loudly as one that stopped clearing floodlit. The
      // recolour is also what would invert the cross-variant luminance order.
      expect(derived).toBeLessThan(Number(field(SCOPED, row, 'Stays below')));
      // The carrier the source names: rail on pitch, both variants, and the
      // floodlit half of the same row still re-derives and clears on its own.
      for (const variant of VARIANTS) {
        expect(
          contrast(resolve('--pf-rail', variant), resolve('--pitch-stripe-a', variant)),
          `rail on pitch, ${variant}`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(
        round2(contrast(resolve('--pf-rail', 'floodlit'), resolve('--pf-ground', 'floodlit'))),
      ).toBe(11.82);
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
      // Exactly two cells are scoped, and these are they: a third quiet cell
      // cannot arrive unannounced.
      expect(
        SCOPED.rows
          .map((entry) =>
            cellKey(field(SCOPED, entry, 'Pair'), variantOf(field(SCOPED, entry, 'Variant'))),
          )
          .sort(),
      ).toEqual(['Aim arrow strong end on pitch  daylight', 'Rail on ground  daylight']);
    });

    it('re-derives both identity luminances to two decimal places', () => {
      for (const row of IDENTITY.rows) {
        const token = field(IDENTITY, row, 'Token');
        expect(round2(luminance(resolve(token, 'floodlit'))), token).toBe(
          Number(field(IDENTITY, row, 'Relative luminance')),
        );
      }
      // The gap is what identity rests on, and it survives every dichromacy.
      const player = luminance(resolve('--team-player', 'floodlit'));
      const opponent = luminance(resolve('--team-opponent', 'floodlit'));
      expect(player).toBeGreaterThan(opponent);
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

  describe('the two brightness variants', () => {
    it('redefines the pitch per theme, and only where the spec says it changes', () => {
      for (const token of VARYING) {
        expect(resolve(token, 'floodlit'), token).not.toBe(resolve(token, 'daylight'));
        // Daylight is the brighter of the two, which is what makes it a
        // brightness variant rather than a second palette.
        expect(
          luminance(resolve(token, 'daylight')),
          token,
        ).toBeGreaterThan(luminance(resolve(token, 'floodlit')));
        expect(DARK_BY_SETTING.declarations.get(token), token).toBe(`var(${token}-floodlit)`);
        expect(LIGHT_BY_SETTING.declarations.get(token), token).toBe(`var(${token}-daylight)`);
      }
      for (const token of FIXED) {
        expect(DARK_BY_SETTING.declarations.has(token), token).toBe(false);
        expect(LIGHT_BY_SETTING.declarations.has(token), token).toBe(false);
      }
    });

    it('keeps the luminance order of the play surface identical in both', () => {
      // SPEC section 18 rests every contrast guarantee on this. If the order
      // moved, a pair that clears its threshold in one variant could fail in
      // the other with nothing else changing.
      const order = (variant: Brightness): string[] =>
        [...VARYING, ...FIXED]
          .map((token) => ({ token, value: luminance(resolve(token, variant)) }))
          .sort((one, other) => one.value - other.value)
          .map((entry) => entry.token);
      expect(order('daylight')).toEqual(order('floodlit'));
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
      ]);
      expect(DIMENSION_EXEMPT).toHaveLength(3);
      for (const entry of DIMENSION_EXEMPT) {
        expect(entry.why.length, entry.literal).toBeGreaterThan(20);
      }
      // Five occurrences in one file, and the file is a real one the sweep
      // reaches rather than a name nothing walks to.
      expect(DIMENSION_EXEMPT.reduce((total, entry) => total + entry.count, 0)).toBe(5);
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

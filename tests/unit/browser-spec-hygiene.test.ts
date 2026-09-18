import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { overlaps } from '../browser/support/viewports';
import { PLAY_SURFACE } from '../../src/render/tokens';

/**
 * The browser suite's shared harness, held to being shared, and its page clock,
 * held to being stopped.
 *
 * WHY THESE ARE UNIT TESTS OVER SOURCE. Both properties fail as a green suite.
 * A browser spec that retypes a value the shared module already exports passes
 * every run: the copies agree today and nothing compares them, so the suite is
 * green right up to the moment one of them moves. Eight of the twenty-five
 * specs had done it, five of them with a SPEC section 18 fill, and the cost is
 * stated rather than aesthetic: a palette change would update
 * `src/render/tokens.ts`, the design contract and the shared module and leave
 * five specs scanning the pitch for a colour the game no longer draws, all of
 * them still green because the pixels they wanted are simply never found and
 * the assertions they feed are about where a body is, not about whether it was
 * seen. And a spec that installs the page clock without stopping it passes
 * every run on a quiet machine and fails under load, which is the worst shape a
 * defect can have: three failures are on record, one in CI.
 *
 * IT IS WRITTEN IN THE STYLE OF `tests/unit/browser-gate.test.ts` and carries
 * the same warning: it reads the spec files as text, so it cannot tell a real
 * declaration from something that happens to look like one, and a legitimate
 * refactor that renames an export will fail it. That is the price of grading a
 * property whose failure mode is a green suite, and the failure is loud and one
 * line to fix rather than silent.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const BROWSER_ROOT = path.join(PROJECT_ROOT, 'tests', 'browser');
const SUPPORT = path.join(BROWSER_ROOT, 'support', 'game.ts');
const VIEWPORTS_SUPPORT = path.join(BROWSER_ROOT, 'support', 'viewports.ts');

const supportText = readFileSync(SUPPORT, 'utf8');
const viewportsText = readFileSync(VIEWPORTS_SUPPORT, 'utf8');

/**
 * BOTH support modules, because there are two of them since PF-15.
 *
 * `support/game.ts` is the match harness and `support/viewports.ts` is item
 * F1's overlap sweep, extracted so that item G6 could run the same sweep at 200
 * percent text rather than writing a second one. A spec that redeclared a name
 * either of them exports shadows the shared thing under the shared name, which
 * is the defect this file was written about.
 */
const SHARED_TEXTS: readonly string[] = [supportText, viewportsText];

/** Comments away first: a name discussed in prose is not a name declared. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The same, with every offset preserved, for the scans that report a LINE: a
 * comment becomes spaces of its own length rather than one space, so an index
 * into the mask is an index into the source. Every spec header in this suite
 * discusses the calls these scans look for, so a scan of the raw text reports
 * the prose that explains the rule as a breach of it.
 */
function maskComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/** A top-level declaration in the shared module, which is what it offers. */
const EXPORTED =
  /^export (?:async function|function|const|interface|type|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Every name a spec BINDS, at any depth and in every binding form.
 *
 * DEPTH IS THE WHOLE POINT. A matcher anchored to the start of a line saw only
 * top-level declarations, and in a Playwright spec almost nothing is at the top
 * level: a `const SETTLE` inside a `test.describe` callback shadows the shared
 * import for every test in the file, and that is precisely the copy that costs
 * most. `let`, `var`, `export const` and a destructuring `const { SETTLE }` were
 * invisible for the same reason, which is why the binding keyword is matched
 * wherever it appears rather than only where a file happens to start a line.
 *
 * THE RULE FOR A GENUINELY LOCAL NAME. A binding is an offence when its NAME is
 * one the shared module exports, and never otherwise: a `const board` inside a
 * single test body is nobody's business, at any depth. There is no exemption
 * for depth, because a local `const SETTLE` is not a private convenience, it is
 * the shared budget under the shared name meaning something else.
 */
const BOUND = new RegExp(
  String.raw`(?:^|[^\w$.])(?:export\s+)?(?:async\s+)?` +
    String.raw`(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)`,
  'g',
);

/**
 * A destructuring binding, one level deep, which is as far as text can follow
 * it: `const { SETTLE } = ...` and `const { timeout: SETTLE } = ...` both bind
 * the name on the right of the colon.
 */
const DESTRUCTURED = /(?:^|[^\w$.])(?:const|let|var)\s*(\{[^{}]*\}|\[[^[\]]*\])\s*=/g;

function namesIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Every name bound anywhere in a spec, comments removed first. */
function boundNames(text: string): string[] {
  const source = withoutComments(text);
  const names = namesIn(source, BOUND);
  for (const match of source.matchAll(DESTRUCTURED)) {
    const inner = (match[1] ?? '').slice(1, -1);
    for (const part of inner.split(',')) {
      const renamed = part.includes(':') ? part.slice(part.lastIndexOf(':') + 1) : part;
      const bound = (renamed.split('=')[0] ?? '').trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(bound)) {
        names.push(bound);
      }
    }
  }
  return names;
}

function specFiles(): string[] {
  return readdirSync(BROWSER_ROOT)
    .filter((entry) => entry.endsWith('.spec.ts'))
    .sort();
}

function specText(name: string): string {
  return readFileSync(path.join(BROWSER_ROOT, name), 'utf8');
}

/** A `[0x55, 0x90, 0xce]` fill in the support module, as three numbers. */
function fillIn(name: string): number[] {
  const found = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(supportText);
  if (found === null) {
    throw new Error(`the shared harness exports no ${name}`);
  }
  return (found[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => Number(part));
}

/** A six-digit hex as its three bytes, which is how a canvas reads it back. */
function bytesOf(hex: string): number[] {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (match === null) {
    throw new Error(`not a six-digit hex colour: ${JSON.stringify(hex)}`);
  }
  const digits = match[1] ?? '';
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16));
}

/* ---------------------------------------------------------------------------
 * The page clock.
 * ------------------------------------------------------------------------- */

/** Where a test, a hook or a helper body begins, in source order. */
const BLOCK_START = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|test|it|describe)\b/gm;

/** The call that installs the page clock, and the call that stops it. */
const INSTALL = /page\.clock\.install\s*\(/g;
const STOP = 'pauseClock(';

/**
 * The marker an install line carries where the clock must KEEP RUNNING: a test
 * that waits on a page timer rather than on the simulation. It names the timer,
 * so the exception is reviewable rather than a way out of the rule.
 */
const REAL_TIME = /\/\/ real time: \S/;

/** The line an offset sits on, which is where an exception has to be declared. */
function lineAt(text: string, at: number): string {
  const from = text.lastIndexOf('\n', at) + 1;
  const to = text.indexOf('\n', at);
  return text.slice(from, to === -1 ? text.length : to);
}

/** From an offset to the end of the test, hook or helper body it sits in. */
function bodyFrom(text: string, at: number): string {
  for (const start of text.matchAll(BLOCK_START)) {
    const index = start.index ?? 0;
    if (index > at) {
      return text.slice(at, index);
    }
  }
  return text.slice(at);
}

/** What one spec does with the page clock: every install, and its verdict. */
interface ClockSite {
  readonly line: string;
  readonly stopped: boolean;
  readonly marked: boolean;
}

function clockSites(text: string): ClockSite[] {
  // The SITES and the STOPS are read off the mask, so neither a header that
  // explains the rule nor a comment that names the helper can answer for code
  // that does; the LINE is read off the source, because the one exception the
  // rule admits is declared in a comment on the install line itself.
  const masked = maskComments(text);
  const sites: ClockSite[] = [];
  for (const match of masked.matchAll(INSTALL)) {
    const at = match.index ?? 0;
    const line = lineAt(text, at);
    sites.push({
      line: line.trim(),
      stopped: bodyFrom(masked, at).includes(STOP),
      marked: REAL_TIME.test(line),
    });
  }
  return sites;
}

describe('the browser suite shares one harness', () => {
  it('lets no spec redeclare a name either shared module exports', () => {
    const exported = new Set(SHARED_TEXTS.flatMap((text) => namesIn(text, EXPORTED)));
    const offences: string[] = [];
    for (const name of specFiles()) {
      for (const bound of boundNames(specText(name))) {
        if (exported.has(bound)) {
          offences.push(`${name}: ${bound}`);
        }
      }
    }
    expect(offences).toEqual([]);
    // A scan over nothing passes, and so does a scan whose export list has
    // quietly emptied, and so does one whose binding matcher has stopped
    // finding bindings. All three halves are pinned: the module really does
    // export the harness, there really are specs to read, and the matcher
    // really does find what a spec binds.
    expect(exported.size).toBeGreaterThan(20);
    expect([...exported]).toContain('PLAYER_FILL');
    expect([...exported]).toContain('LOGICAL_WIDTH');
    expect([...exported]).toContain('centres');
    // And the second module really is in the set, so extending the scan was a
    // change to what it reads rather than to what it says it reads.
    for (const name of ['VIEWPORTS', 'controlBoxes', 'overlaps', 'DOUBLED_ROOT_FONT_SIZE']) {
      expect([...exported], name).toContain(name);
    }
    expect(specFiles().length).toBeGreaterThan(20);
    const seen = specFiles().flatMap((name) => boundNames(specText(name)));
    expect(seen.length).toBeGreaterThan(50);
  });

  it('sees a shadow at any depth and in every binding form', () => {
    // THE POSITIVE CONTROLS, one per shape a copy can arrive in. Four of the
    // five below survived the matcher this test used to carry, and the last of
    // them - a `const` inside the file's own describe callback - is the one
    // that shadows the shared import for every test in the file.
    const exported = new Set(SHARED_TEXTS.flatMap((text) => namesIn(text, EXPORTED)));
    const fires: readonly string[] = [
      'const SETTLE = { timeout: 120_000 };',
      'let SETTLE = { timeout: 120_000 };',
      'var SETTLE = { timeout: 120_000 };',
      'export const SETTLE = { timeout: 120_000 };',
      'const { SETTLE } = budgets;',
      'const { budget: SETTLE } = budgets;',
      "test.describe('a file', () => {\n  const SETTLE = { timeout: 1 };\n});",
      "test('one case', async () => {\n    const PLAYER_FILL = [1, 2, 3];\n  });",
      'async function nextFrames(page: Page): Promise<void> {',
      'function centres(page: Page): Promise<Centres> {',
      'interface Centres {',
    ];
    for (const text of fires) {
      const shadows = boundNames(text).filter((name) => exported.has(name));
      expect(shadows, text).not.toEqual([]);
    }
    // AND THE RULE FOR A GENUINELY LOCAL NAME, with its own controls: a binding
    // whose name is not one the shared module exports is nobody's business at
    // any depth, and neither is a name that merely begins with one, nor a
    // mention of an exported name in prose.
    const quiet: readonly string[] = [
      "test('one case', async () => {\n    const board = await scores(page);\n  });",
      'const SETTLE_STEP = 100;',
      'const at = (page: Page) => page;',
      '// The SETTLE budget is a starvation budget.\nconst budget = 1;',
      '/* const SETTLE = { timeout: 1 }; */\nconst budget = 1;',
      'for (const [mode, arm] of pairs) {',
    ];
    for (const text of quiet) {
      const shadows = boundNames(text).filter((name) => exported.has(name));
      expect(shadows, text).toEqual([]);
    }
  });

  it('ties the harness fills to the palette the renderer draws with', () => {
    // SPEC section 18 owns these three colours and `src/render/tokens.ts` is
    // the renderer's record of them; the browser suite reads them back off the
    // canvas as bytes. Nothing tied the two together, so a palette change
    // would have left the specs hunting for a colour the game had stopped
    // drawing. The three are fixed across both brightness variants, which is
    // itself part of the tie: a fill that started varying by variant would
    // make one of the two comparisons below fail.
    for (const variant of ['floodlit', 'daylight'] as const) {
      const palette = PLAY_SURFACE[variant];
      expect(fillIn('PLAYER_FILL'), variant).toEqual(bytesOf(palette.teamPlayer));
      expect(fillIn('OPPONENT_FILL'), variant).toEqual(bytesOf(palette.teamOpponent));
      expect(fillIn('BALL_FILL'), variant).toEqual(bytesOf(palette.ballBody));
    }
    // And the parse really parsed: three bytes each, and the literals are the
    // ones SPEC section 18 states, so neither side of the comparison above is
    // an empty list agreeing with an empty list.
    expect(fillIn('PLAYER_FILL')).toEqual([0x55, 0x90, 0xce]);
    expect(fillIn('OPPONENT_FILL')).toEqual([0x6e, 0x17, 0x12]);
    expect(fillIn('BALL_FILL')).toEqual([0xfa, 0xfa, 0xf8]);
    expect(bytesOf('#5590CE')).toEqual([0x55, 0x90, 0xce]);
  });

  it('excludes from item G10 s sweep only the two values the chrome really shares', () => {
    // WHAT THE SWEEP ASKS is whether any chrome rule resolves a colour the
    // CANVAS alone supplies, so it can only ask it about values the chrome does
    // not legitimately carry. Two are shared and the list names them: SPEC
    // section 18 draws the aim arrow's ramp from the chrome's accent, so
    // `--pf-accent-dark` and `--pf-accent-light` appear on both sides of the
    // boundary. Every value excluded beyond those two is a value a chrome rule
    // could hard-code with the sweep still green, which is why the list is held
    // here rather than in the spec: the spec's own assertions about it run in a
    // browser and a lengthened list reads as a shorter sweep, never as a
    // failure.
    const forced = specText('forced-colors.spec.ts');
    const declared = /const SHARED_WITH_THE_CHROME: readonly string\[\] = \[([^\]]*)\];/.exec(
      withoutComments(forced),
    );
    expect(declared, 'the sweep declares its exclusion list').not.toBeNull();
    const excluded = (declared?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((part) => part !== '');
    expect(excluded).toEqual(['#F5C542', '#7A5A06']);
    // AND THE REASON IS TRUE OF BOTH, read off the chrome's own declarations
    // rather than taken from the list's comment. The stylesheet declares the
    // play surface as well, so the comparison is against the FOUR chrome
    // families the sweep reads and their per-theme ends, and never against the
    // whole file, where every pitch value appears by definition.
    const chrome = readFileSync(path.join(PROJECT_ROOT, 'src', 'ui', 'tokens.css'), 'utf8');
    const CHROME_VALUE = /--pf-(?:ground|text|text-muted|accent)(?:-dark|-light)?:\s*(#[0-9A-Fa-f]{6});/g;
    const chromeValues = new Set(
      [...chrome.matchAll(CHROME_VALUE)].map((found) => (found[1] ?? '').toUpperCase()),
    );
    for (const hex of excluded) {
      expect(chromeValues, `${hex} is a chrome value too`).toContain(hex);
    }
    // AND FALSE OF THE REST, which is what makes the pair a pair and not a
    // habit: the play surface's other values are declared nowhere in the chrome
    // palette, so excluding one would hide exactly the defect the sweep exists
    // to find.
    const surface = new Set(
      Object.values(PLAY_SURFACE).flatMap((variant) =>
        Object.values(variant).map((hex) => hex.toUpperCase()),
      ),
    );
    for (const hex of surface) {
      if (excluded.includes(hex)) {
        continue;
      }
      expect(chromeValues, `${hex} is the canvas's alone`).not.toContain(hex);
    }
    // Neither scan is vacuous: the set walked is the renderer's own and carries
    // `--pf-line`, the chrome set carries more than the shared pair, and the
    // chrome's near-identical text value is a different colour from that line.
    expect(surface.size).toBeGreaterThan(12);
    expect(surface.has('#F2F7F3')).toBe(true);
    expect(chromeValues.size).toBeGreaterThan(excluded.length);
    expect(chrome).toContain('--pf-text-dark: #EAF2EC;');
  });
});

describe('the shared sweep states the size item G6 measures at', () => {
  it('pins two hundred percent as a doubling of a stated default', () => {
    // QUALITY-BAR section 4 asks that chrome text resize to 200 PERCENT, and a
    // size written as "32px" alone is a number nobody can check. Both halves are
    // pinned by literal here rather than in the spec that uses them: a constant
    // compared against itself passes for whatever it becomes, and the browser
    // suite is where it would pass quietly.
    expect(viewportsText).toContain('export const DEFAULT_ROOT_FONT_SIZE = 16;');
    expect(viewportsText).toContain("export const DOUBLED_ROOT_FONT_SIZE = '32px';");
    const doubled = /export const DOUBLED_ROOT_FONT_SIZE = '(\d+)px';/.exec(viewportsText);
    const base = /export const DEFAULT_ROOT_FONT_SIZE = (\d+);/.exec(viewportsText);
    expect(doubled, 'the doubled size is stated as a px string').not.toBeNull();
    expect(base, 'the default size is stated as a number').not.toBeNull();
    expect(Number(doubled?.[1])).toBe(Number(base?.[1]) * 2);
    // 16 is the size every desktop engine ships at, so the pair states a
    // doubling of the size a player who changed nothing actually has.
    expect(Number(base?.[1])).toBe(16);
    expect(Number(doubled?.[1])).toBe(32);
  });

  it('calls two boxes overlapping when they share area, and not when they touch', () => {
    // DRIVEN RATHER THAN READ, because this one can be: the sweep's own
    // predicate decides what items F1 and G6 mean by "never covers one with
    // another", and a predicate loosened to a slack nothing can reach would
    // pass every viewport at every text size.
    const box = (x: number, y: number, width = 40, height = 20): Parameters<typeof overlaps>[0] => ({
      label: `${String(x)},${String(y)}`,
      x,
      y,
      width,
      height,
    });
    expect(overlaps(box(0, 0), box(20, 10))).toBe(true);
    expect(overlaps(box(0, 0), box(0, 0))).toBe(true);
    // A SHARED EDGE IS NOT AN OVERLAP, which is the whole of the half-pixel
    // slack: two controls side by side in a flex row meet exactly.
    expect(overlaps(box(0, 0), box(40, 0))).toBe(false);
    expect(overlaps(box(0, 0), box(0, 20))).toBe(false);
    // And the slack is half a pixel rather than something a layout could hide
    // inside: a whole pixel of shared area is still an overlap.
    expect(overlaps(box(0, 0), box(38.9, 0))).toBe(true);
    expect(overlaps(box(0, 0), box(39.6, 0))).toBe(false);
    // Symmetric, because the sweep compares each pair once and in one order.
    expect(overlaps(box(20, 10), box(0, 0))).toBe(true);
    expect(overlaps(box(40, 0), box(0, 0))).toBe(false);
  });

  it('raises a font size rather than scaling a picture of the chrome', () => {
    // A CSS transform would keep every line break where it was and pass a
    // clipping test that means nothing, which is why the criterion says text.
    expect(viewportsText).toContain("style.setProperty('font-size', value)");
    // COMMENTS AWAY FIRST, because the module's own header explains why neither
    // of these is used and prose that discusses a rule is not a breach of it.
    const code = withoutComments(viewportsText);
    expect(code).not.toContain('transform');
    expect(code).not.toContain('zoom');
    // The controls, on text that DOES carry each of them, so a check that
    // had stopped looking is caught here rather than in six months.
    expect('element.style.transform = scale(2)').toContain('transform');
    expect('document.body.style.zoom = 2').toContain('zoom');
  });

  it('holds the four breakpoint viewports item F1 swept, unchanged', () => {
    // The sweep moved out of `breakpoints.spec.ts` at PF-15 so item G6 could
    // reuse it. The four viewports are what F1 closed on, so they are pinned
    // here: an extraction that quietly changed one of them would have changed
    // what F1 grades as well as what G6 does.
    expect(viewportsText).toContain("{ name: 'wide', width: 1280, height: 900 }");
    expect(viewportsText).toContain("{ name: 'medium', width: 900, height: 700 }");
    expect(viewportsText).toContain("{ name: 'compact', width: 700, height: 420 }");
    expect(viewportsText).toContain("{ name: 'portrait', width: 420, height: 800 }");
    // And both specs consume it rather than one of them keeping a copy.
    for (const spec of ['breakpoints.spec.ts', 'text-scale.spec.ts']) {
      expect(specText(spec), spec).toContain("from './support/viewports'");
    }
    expect(specText('breakpoints.spec.ts')).not.toContain('const VIEWPORTS');
  });
});

describe('the browser suite stops the page clock it installs', () => {
  it('leaves no driven spec racing the clock it installed', () => {
    // AN INSTALLED CLOCK IS NOT A STOPPED ONE. It keeps advancing with real
    // time and keeps firing frames (measured at the PF-14 close: 1.5 s of real
    // waiting advanced it 1.5 s and fired 94 frames on Chromium and 50 on
    // WebKit), so a test that believes it is driving the match frame by frame
    // is sharing the drive with the machine, and every premise of the form
    // "nothing ran between these two readings" is unenforced. That is the
    // reduced-motion flake CI recorded, and the FULL TIME that arrived while a
    // max-drag test waited for the handover.
    const offences: string[] = [];
    let installs = 0;
    let marked = 0;
    const carriers: string[] = [];
    for (const name of specFiles()) {
      const sites = clockSites(specText(name));
      if (sites.length > 0) {
        carriers.push(name);
      }
      for (const site of sites) {
        installs += 1;
        if (site.marked) {
          marked += 1;
          continue;
        }
        if (!site.stopped) {
          offences.push(`${name}: ${site.line}`);
        }
      }
    }
    expect(offences).toEqual([]);
    // THE COUNTS ARE THE OTHER HALF OF THE GATE. A scan that had stopped
    // finding install sites would report a clean suite forever, which is the
    // same output as a clean suite; and an exception that stopped being an
    // exception would sit here unread. Both are pinned by literal.
    // Thirty-two since PF-15's fix round, in three new files: item G1 drives a
    // match to full time so its scan has a game-over screen to look at and two
    // ladder rungs so it has the other two arrangements of that overlay (two
    // installs in the one test, because taking the next rung starts a new
    // match), item G9 does the same for the one overlay that opens without an
    // invoking control, and item G4's armour plays two whole matches to read
    // the announcements back.
    expect(installs).toBe(32);
    expect(marked).toBe(0);
    expect(carriers).toHaveLength(19);
    expect(carriers).toContain('max-drag.spec.ts');
    expect(carriers).toContain('reduced-motion.spec.ts');
  });

  it('fires on an install that is never stopped, and on nothing else', () => {
    // THE THREE SHAPES, each as its own control. A pure reading of source text,
    // so the shapes can be written out rather than arranged in a browser.
    const stopped = [
      "  test('a case', async ({ page }) => {",
      '    await page.clock.install({ time: 0 });',
      '    await startMatch(page);',
      '    await pauseClock(page);',
      '  });',
    ].join('\n');
    expect(clockSites(stopped)).toEqual([
      { line: 'await page.clock.install({ time: 0 });', stopped: true, marked: false },
    ]);

    const racing = [
      "  test('a case', async ({ page }) => {",
      '    await page.clock.install({ time: 0 });',
      '    await startMatch(page);',
      '    await advance(page, 4);',
      '  });',
    ].join('\n');
    expect(clockSites(racing)).toEqual([
      { line: 'await page.clock.install({ time: 0 });', stopped: false, marked: false },
    ]);

    const excepted = [
      "  test('a case', async ({ page }) => {",
      '    await page.clock.install({ time: 0 }); // real time: the announce throttle',
      '    await startMatch(page);',
      '  });',
    ].join('\n');
    expect(clockSites(excepted)).toEqual([
      {
        line: 'await page.clock.install({ time: 0 }); // real time: the announce throttle',
        stopped: false,
        marked: true,
      },
    ]);

    // AND A STOP IN ANOTHER TEST IS NOT A STOP IN THIS ONE, which is the shape
    // a whole-file search would miss: the body ends where the next test begins.
    const elsewhere = [
      "  test('the racing one', async ({ page }) => {",
      '    await page.clock.install({ time: 0 });',
      '    await startMatch(page);',
      '  });',
      '',
      "  test('the careful one', async ({ page }) => {",
      '    await pauseClock(page);',
      '  });',
    ].join('\n');
    expect(clockSites(elsewhere).map((site) => site.stopped)).toEqual([false]);

    // The bare negative: a file that installs nothing has nothing to answer.
    expect(clockSites("test('a case', async () => { await startMatch(page); });")).toEqual([]);
  });
});

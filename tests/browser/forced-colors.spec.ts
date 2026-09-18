import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, LOGICAL_HEIGHT, LOGICAL_WIDTH, SETTLE, startMatch } from './support/game';
import { PLAY_SURFACE } from '../../src/render/tokens';

/**
 * Item G10, method T, evidence `playwright/forced-colors`:
 *
 *   "Under forced-colors active the chrome adopts the system palette, no chrome
 *    element depends on a colour the canvas supplies, and the play surface
 *    switches to its high-contrast token set through the media query."
 *
 * THREE CLAUSES AND THREE HALVES OF THE PAGE, so the file is in three parts:
 * what the DOM does, what the DOM does NOT do, and what the canvas does.
 *
 * ON ALL THREE ENGINES, and the reason is measured rather than assumed:
 * `page.emulateMedia({ forcedColors: 'active' })` takes effect on chromium,
 * firefox and webkit alike, verified on 2026-09-15 and asserted again below as
 * the first thing every test does. The chromium-only habit elsewhere in this
 * suite is for emulation nobody has checked; this one is checked.
 *
 * THE VALUES ARE SPEC SECTION 18'S AND THEY ARE LITERALS HERE. `tests/unit/
 * tokens.test.ts` holds the renderer record and the stylesheet against the
 * design contract and re-derives every ratio, so a palette that moved reddens
 * there first and loudly; what these literals do is say which pixels this spec
 * expects to see, the way `rail-boundary.spec.ts` already does.
 */

/** SPEC section 18's two team fills, and what the third variant does to them. */
const PLAYER_FRAME = [0x55, 0x90, 0xce];
const OPPONENT_FRAME = { normal: [0x6e, 0x17, 0x12], forced: [0x3d, 0x0d, 0x0a] };

/** The two goal frames, which SPEC section 3 puts just outside the field edge. */
const FRAME_SAMPLE = { player: { x: 58, y: 360 }, opponent: { x: 1222, y: 360 } };

/** A patch of mown stripe clear of the centre circle, the midline and both circles. */
const STRIPE_SAMPLE = { x: 760, y: 150 };

/**
 * A patch of the rail, the band SPEC section 3 puts outside the field edge.
 *
 * SPEC section 3 puts the wall band immediately outside the field edge and
 * `WALL_THICKNESS` is twelve design units, so the middle of the band above the
 * field is `FIELD_TOP` plus six, 641. It is read there, away from both goal
 * mouths, so the sample is the rail's own fill rather than the three-unit
 * boundary stroke `rail-boundary.spec.ts` measures or a goal frame.
 */
const RAIL_SAMPLE = { x: 760, y: 641 };

/** The four names every chrome rule resolves its colour through. */
const CHROME_TOKENS: readonly string[] = [
  '--pf-ground',
  '--pf-text',
  '--pf-text-muted',
  '--pf-accent',
];

/**
 * The two play-surface values the chrome legitimately shares, and nothing else.
 *
 * MEASURED AGAINST THE CHROME PALETTE, one value at a time, because the first
 * form of this list excluded six on a reason true of only two. `#F5C542` and
 * `#7A5A06` are `--pf-accent-dark` and `--pf-accent-light`: the pitch READS the
 * chrome's accent for the aim arrow's strong end, so finding one of them on a
 * chrome element proves nothing. The other four that were excluded are not
 * chrome values at all: `--pf-line` `#F2F7F3` is not `--pf-text-dark`
 * `#EAF2EC`, `--glyph-on-player` `#0A1A2B` is not `--pf-ground-dark`
 * `#0A1410`, and neither ball value appears in the chrome palette anywhere. A
 * chrome rule hard-coding one of those four is exactly what this sweep exists
 * to catch, so they are swept.
 */
const SHARED_WITH_THE_CHROME: readonly string[] = ['#F5C542', '#7A5A06'];

/**
 * Every play-surface colour that is the CANVAS'S ALONE, derived from the
 * renderer's own record rather than written out again.
 *
 * A LIST WRITTEN BY HAND IS A LIST THAT DRIFTS: SPEC section 18's three
 * variants carry eighteen distinct values between them, and the previous form
 * of this constant carried twelve of them with a prose count of seventeen. This
 * takes the record the canvas actually draws from, drops the two the chrome
 * shares, and compares what is left.
 */
const PLAY_SURFACE_COLOURS: readonly string[] = [
  ...new Set(
    Object.values(PLAY_SURFACE).flatMap((variant) =>
      Object.values(variant).map((hex) => hex.toUpperCase()),
    ),
  ),
].filter((hex) => !SHARED_WITH_THE_CHROME.includes(hex));

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** What the media feature answers inside the page, which is the premise. */
async function forcedColours(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(forced-colors: active)').matches);
}

/** The computed value of each chrome token, as the cascade resolves it. */
async function tokenValues(page: Page, names: readonly string[]): Promise<string[]> {
  return page.evaluate((tokens) => {
    const style = window.getComputedStyle(document.documentElement);
    return tokens.map((token) => style.getPropertyValue(token).trim());
  }, names);
}

/** The resolved background and text colours of the page itself. */
async function pageColours(page: Page): Promise<{ background: string; text: string }> {
  return page.evaluate(() => {
    const style = window.getComputedStyle(document.body);
    return { background: style.backgroundColor, text: style.color };
  });
}

/** One canvas pixel, read in the design space SPEC section 3 states. */
async function pixelAt(page: Page, point: { x: number; y: number }): Promise<number[]> {
  return page.evaluate(
    (input) => {
      const canvas = document.querySelector('[data-pf="play-surface"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('the play surface is not in the document');
      }
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new Error('the play surface has no 2d context');
      }
      const column = Math.floor((input.point.x * canvas.width) / input.width);
      const row = Math.floor(((input.height - input.point.y) * canvas.height) / input.height);
      const data = context.getImageData(column, row, 1, 1).data;
      return [Number(data[0]), Number(data[1]), Number(data[2])];
    },
    { point, width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
  );
}

/** The three bytes of a six-digit hex, which is how a canvas reads it back. */
function bytesOf(hex: string): number[] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

/** Relative luminance, WCAG 2.x, written out rather than borrowed. */
function luminance(rgb: readonly number[]): number {
  const channel = (byte: number): number => {
    const value = Number(byte) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(Number(rgb[0])) +
    0.7152 * channel(Number(rgb[1])) +
    0.0722 * channel(Number(rgb[2]))
  );
}

test.describe('PF-15 forced colours, item G10', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('is a media feature this engine actually answers, which is the premise', async ({
    page,
  }) => {
    // Every assertion in this file rests on the emulation reaching the page. An
    // engine that ignored the option would leave all of them measuring the
    // ordinary palette twice and reporting agreement.
    await startMatch(page, { mode: 'first-to', target: 3 });
    expect(await forcedColours(page)).toBe(false);
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await forcedColours(page)).toBe(true);
    await page.emulateMedia({ forcedColors: 'none' });
    expect(await forcedColours(page)).toBe(false);
  });

  test('gives the chrome the system palette, and takes the theme out of it', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3 });
    const before = await tokenValues(page, CHROME_TOKENS);
    const groundBefore = await pageColours(page);
    // The theme's own hexes, which is what the four names resolve to normally.
    for (const value of before) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }

    await page.emulateMedia({ forcedColors: 'active' });
    const after = await tokenValues(page, CHROME_TOKENS);
    expect(after).toEqual(['Canvas', 'CanvasText', 'GrayText', 'Highlight']);
    // THE DIFFERENCE IS THE ASSERTION. A block of aliases pointing back at the
    // theme would satisfy "there is a forced-colors block" and change nothing.
    for (let token = 0; token < CHROME_TOKENS.length; token += 1) {
      expect(after[token], CHROME_TOKENS[token]).not.toBe(before[token]);
    }
    // And it reaches the pixels, not only the custom properties: the page's own
    // resolved background and text colours move with them.
    const groundAfter = await pageColours(page);
    expect(groundAfter.background).not.toBe(groundBefore.background);
    expect(groundAfter.text).not.toBe(groundBefore.text);

    await page.emulateMedia({ forcedColors: 'none' });
    expect(await tokenValues(page, CHROME_TOKENS)).toEqual(before);
  });

  test('keeps the theme override working underneath the query', async ({ page }) => {
    // SPEC section 17's stored theme writes `data-theme` on the root, and the
    // forced-colors block has to beat BOTH theme cases: a plain `:root` selector
    // loses to the dark-preference block on any machine with no stored theme,
    // which is the default setup and the one a test is least likely to be in.
    await startMatch(page, { mode: 'first-to', target: 3 });
    await page.emulateMedia({ forcedColors: 'active' });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset['theme'] = value;
      }, theme);
      expect(await tokenValues(page, CHROME_TOKENS), theme).toEqual([
        'Canvas',
        'CanvasText',
        'GrayText',
        'Highlight',
      ]);
    }
    await page.evaluate(() => {
      delete document.documentElement.dataset['theme'];
    });
    expect(await tokenValues(page, CHROME_TOKENS)).toEqual([
      'Canvas',
      'CanvasText',
      'GrayText',
      'Highlight',
    ]);

    // AND THE STATE THE STYLESHEET CALLS ITS DEFAULT: no attribute at all, with
    // the platform preferring dark. That is the one case where the forced block
    // wins on SPECIFICITY rather than on source order, because
    // `:root:not([data-theme='light'])` matches there too and matches at the
    // same (0,2,0) weight. Until this round it was exercised in no page.
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme, forcedColors: 'active' });
      expect(await tokenValues(page, CHROME_TOKENS), colorScheme).toEqual([
        'Canvas',
        'CanvasText',
        'GrayText',
        'Highlight',
      ]);
    }
    await page.emulateMedia({ colorScheme: null, forcedColors: 'none' });
  });

  test('leaves no chrome element depending on a colour the canvas supplies', async ({
    page,
  }) => {
    // The criterion's middle clause, read as a measurement over the real DOM:
    // every colour any chrome element resolves is compared against SPEC section
    // 18's whole play-surface palette, in all three variants, and none of them
    // may be one. Under the query and outside it, because a chrome that borrowed
    // a pitch colour would borrow it either way.
    await startMatch(page, { mode: 'first-to', target: 3 });
    for (const forced of [false, true]) {
      await page.emulateMedia({ forcedColors: forced ? 'active' : 'none' });
      const borrowed = await page.evaluate((palette) => {
        const wanted = palette.map((hex) => {
          const byte = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16);
          return `rgb(${String(byte(1))}, ${String(byte(3))}, ${String(byte(5))})`;
        });
        const found: string[] = [];
        let seen = 0;
        const column = document.querySelector('.pf-app');
        if (!(column instanceof HTMLElement)) {
          throw new Error('the app column is not in the document');
        }
        for (const element of [column, ...column.querySelectorAll('*')]) {
          if (!(element instanceof HTMLElement) || element.tagName === 'CANVAS') {
            continue;
          }
          seen += 1;
          const style = window.getComputedStyle(element);
          for (const property of [
            'color',
            'backgroundColor',
            'borderTopColor',
            'borderBottomColor',
            'outlineColor',
            'accentColor',
            'textDecorationColor',
          ] as const) {
            const value = style[property];
            if (wanted.includes(value)) {
              found.push(`${element.dataset['pf'] ?? element.className} ${property} ${value}`);
            }
          }
        }
        return { found, seen };
      }, PLAY_SURFACE_COLOURS);
      // The sweep is not vacuous: it reached the whole chrome, and the palette
      // it compared against is the one the canvas is drawing with right now.
      expect(borrowed.seen, String(forced)).toBeGreaterThan(40);
      expect(borrowed.found, String(forced)).toEqual([]);
      // AND IT IS THE WHOLE PALETTE MINUS THE TWO THE CHROME SHARES. Derived
      // from the renderer's own record, so a nineteenth value added to SPEC
      // section 18 is swept the day it lands.
      expect(PLAY_SURFACE_COLOURS).toHaveLength(16);
      for (const value of ['#F2F7F3', '#0A1A2B', '#FAFAF8', '#1A1A1A']) {
        expect(PLAY_SURFACE_COLOURS, `${value} is the canvas's alone`).toContain(value);
      }
      for (const value of SHARED_WITH_THE_CHROME) {
        expect(PLAY_SURFACE_COLOURS, `${value} is the chrome's own accent`).not.toContain(value);
      }
    }

    // THE PLANTED CONTROL, because every assertion above is that a list is
    // empty. A chrome rule carrying one of the swept values is exactly the
    // defect the sweep exists to find, and until this round four of those
    // values were excluded and would have passed it.
    //
    // OUTSIDE THE QUERY, because inside it the browser overrides author colours
    // with the system palette: a planted colour would be forced away before
    // anything could read it, which is a fact about forced colours rather than
    // about the sweep.
    await page.emulateMedia({ forcedColors: 'none' });
    const planted = await page.evaluate((hex) => {
      const line = document.querySelector('[data-pf="turn"]');
      if (!(line instanceof HTMLElement)) {
        throw new Error('the turn readout is not in the document');
      }
      line.style.setProperty('color', hex);
      const byte = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16);
      const wanted = `rgb(${String(byte(1))}, ${String(byte(3))}, ${String(byte(5))})`;
      const seen = window.getComputedStyle(line).color === wanted;
      line.style.removeProperty('color');
      return { seen, restored: window.getComputedStyle(line).color !== wanted };
    }, '#F2F7F3');
    expect(planted.seen, 'a chrome rule carrying --pf-line is visible to the sweep').toBe(true);
    expect(planted.restored, 'and the plant is taken back out').toBe(true);
  });

  test('switches the play surface to its high-contrast set through the query', async ({
    page,
  }) => {
    // THE CANVAS CANNOT ADOPT THE SYSTEM PALETTE, which is why SPEC section 18
    // gives it a third variant instead: forced colours do not reach canvas
    // pixels, so the pitch answers the query by raising its own contrast. The
    // two goal frames are flat fills drawn last, so they read back exactly.
    await startMatch(page, { mode: 'first-to', target: 3 });
    const opponentBefore = await pixelAt(page, FRAME_SAMPLE.opponent);
    const railBefore = await pixelAt(page, RAIL_SAMPLE);
    const playerBefore = await pixelAt(page, FRAME_SAMPLE.player);
    const stripeBefore = await pixelAt(page, STRIPE_SAMPLE);
    expect(opponentBefore).toEqual(OPPONENT_FRAME.normal);
    expect(playerBefore).toEqual(PLAYER_FRAME);

    await page.emulateMedia({ forcedColors: 'active' });
    // The pitch is re-rendered on the next frame, because the palette is read
    // per frame and the cached layer invalidates on palette identity.
    await expect
      .poll(async () => (await pixelAt(page, FRAME_SAMPLE.opponent)).join(','), SETTLE)
      .toBe(OPPONENT_FRAME.forced.join(','));

    // Four of the ten tokens move and six keep the shared value: the opponent
    // fill is one of the four and the player fill is one of the six, so the
    // pair together says a VARIANT changed rather than a colour.
    expect(await pixelAt(page, FRAME_SAMPLE.player)).toEqual(PLAYER_FRAME);
    // AGAINST THE RECORD THE CANVAS DRAWS FROM, not against a second literal in
    // this file: the line this replaces compared two file-local constants and
    // could not fail. `tokens.test.ts` holds that record against the design
    // contract and SPEC section 18, so this closes the chain from the document
    // to the pixel.
    expect(bytesOf(PLAY_SURFACE.highcontrast.teamOpponent)).toEqual(OPPONENT_FRAME.forced);
    expect(bytesOf(PLAY_SURFACE.floodlit.teamOpponent)).toEqual(OPPONENT_FRAME.normal);

    // And the mown stripe darkened, which is what the whole variant is: every
    // moved value is the floodlit value with its channels scaled down.
    const stripeAfter = await pixelAt(page, STRIPE_SAMPLE);
    expect(luminance(stripeAfter)).toBeLessThan(luminance(stripeBefore));

    // THE RAIL IS THE FOURTH MOVED TOKEN AND THE ONLY ONE THAT DIFFERS IN ALL
    // THREE VARIANTS, and until this round no rendered pixel sampled it. It is
    // read on the rail band outside the field edge, where SPEC section 3 puts
    // it, and it has to be the variant's own value rather than merely darker.
    const railAfter = await pixelAt(page, RAIL_SAMPLE);
    expect(railAfter).toEqual(bytesOf(PLAY_SURFACE.highcontrast.rail));
    // And it was the DAYLIGHT rail before, which is the variant a page with no
    // stored theme takes under the light colour scheme this suite runs in: the
    // opponent fill this test opened on is the same byte triple in both normal
    // variants, so the rail is also the one sample that says WHICH.
    expect(railBefore).toEqual(bytesOf(PLAY_SURFACE.daylight.rail));

    await page.emulateMedia({ forcedColors: 'none' });
    await expect
      .poll(async () => (await pixelAt(page, FRAME_SAMPLE.opponent)).join(','), SETTLE)
      .toBe(OPPONENT_FRAME.normal.join(','));
    // The rail comes back with it, so the reading above is the variant and not
    // a pixel this test left behind.
    expect(await pixelAt(page, RAIL_SAMPLE)).toEqual(railBefore);
  });

  test('keeps the canvas out of the chrome half, and the chrome out of the canvas', async ({
    page,
  }) => {
    // The two halves answer the SAME query and must not answer it for each
    // other. The canvas is `aria-hidden` and carries no colour of its own in
    // CSS, so the stylesheet's forced-colors block reaches the chrome alone;
    // the renderer's variant reaches the canvas alone.
    await startMatch(page, { mode: 'first-to', target: 3 });
    await page.emulateMedia({ forcedColors: 'active' });
    const canvas = await page.evaluate(() => {
      const element = document.querySelector('[data-pf="play-surface"]');
      if (!(element instanceof HTMLCanvasElement)) {
        throw new Error('the play surface is not in the document');
      }
      const style = window.getComputedStyle(element);
      const parts = (style.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      return {
        hidden: element.getAttribute('aria-hidden'),
        background: style.backgroundColor,
        // THE ALPHA AND NOT THE STRING. Under this query the browser forces the
        // colour component of every background it can, so a transparent canvas
        // reads back as a white one at zero alpha rather than as a black one;
        // what says nothing is painted is the alpha, in either case.
        alpha: parts.length < 4 ? 1 : Number(parts[3]),
        border: style.borderTopWidth,
      };
    });
    expect(canvas.hidden).toBe('true');
    // Nothing paints behind the scene: QUALITY-BAR section 7's no-box rule, and
    // the reason a forced-colors override of the chrome cannot change a pixel.
    expect(canvas.alpha, canvas.background).toBe(0);
    expect(canvas.border).toBe('0px');
    await expect(at(page, 'play-surface')).toBeVisible();
  });
});

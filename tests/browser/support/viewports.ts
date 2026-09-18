import type { Page } from '@playwright/test';

/**
 * The overlap sweep, shared.
 *
 * WHY IT MOVED HERE. It was written for item F1 at PF-14 and lived inside
 * `breakpoints.spec.ts`; item G6 asks the same question of the same four
 * viewports with the root font size doubled, and the two answers have to be
 * produced by ONE sweep or the pair proves nothing. A spec cannot import
 * another spec - doing so re-registers that file's tests - so the sweep is a
 * support module, which is also what lets `tests/unit/browser-spec-hygiene.
 * test.ts` hold every spec against it.
 *
 * INVARIANTS RATHER THAN PIXELS, which is F1's own rule and G6 inherits it:
 * nothing here says where a control is, only that none is off the screen
 * sideways and that no two of them cover each other. Those outlive a layout
 * change, and a pixel assertion at four viewports times two text sizes would
 * not survive the next part that adds a control.
 */

/** Every viewport that resolves to each name, with a height that keeps the bars stuck. */
export const VIEWPORTS = [
  { name: 'wide', width: 1280, height: 900 },
  { name: 'medium', width: 900, height: 700 },
  { name: 'compact', width: 700, height: 420 },
  { name: 'portrait', width: 420, height: 800 },
] as const;

/**
 * A viewport to lay the page out at: the size, and the breakpoint name the page
 * is required to resolve for it.
 *
 * STRUCTURAL RATHER THAN THE TABLE'S OWN ROW TYPE, because the tight list below
 * is a second set of sizes that resolve to names the table already carries, and
 * a type keyed to the table's literal widths could not describe them.
 */
export interface ViewportSize {
  readonly name: string;
  /** What a failure message calls it, where the name alone would not say. */
  readonly label?: string;
  readonly width: number;
  readonly height: number;
}

/** One row of the table above. */
export type Viewport = (typeof VIEWPORTS)[number];

/** What a failure message calls a viewport: its label where it has one. */
export function viewportLabel(viewport: ViewportSize): string {
  return viewport.label ?? viewport.name;
}

/**
 * The two viewports where the chrome has least room of all, which the four
 * above do not reach.
 *
 * WHY THEY ARE A LIST AND NOT A PARAGRAPH. QUALITY-BAR section 5's floor is 320
 * by 256 CSS pixels, and the four breakpoints above are sampled at comfortable
 * heights; the arrangement that broke at 200 percent text was a SHORT viewport,
 * where the two bars stop fitting. Both sweeps that run at the doubled size
 * take this list as well, so the case is measured by the same assertions rather
 * than by a second set that could drift from them.
 *
 * 360 by 500 is the narrow, short screen `focus-obscured.spec.ts` already
 * measured the two bars at; 320 by 400 is section 5's own floor width at the
 * height its sticky rule turns on.
 */
export const TIGHT_VIEWPORTS: readonly ViewportSize[] = [
  { name: 'portrait', label: 'narrow and short, 360 by 500', width: 360, height: 500 },
  { name: 'portrait', label: 'the supported floor width, 320 by 400', width: 320, height: 400 },
];

/**
 * Resize, and wait until the page has answered for the new size.
 *
 * MEASURED, AND IT CHANGED AN ANSWER. `src/main.ts` resolves QUALITY-BAR
 * section 5's breakpoint from the window inside the play surface's resize
 * observer, so the `data-pf-breakpoint` attribute `chrome.css` selects on is
 * written a callback AFTER the viewport changes rather than with it. A reading
 * taken in between is a reading of the previous arrangement: in a loaded
 * three-engine run the compact score readout was read at `--type-lg` (23.04 px)
 * before the resize had landed and at `--type-base` (32 px at the doubled root)
 * after it, so a doubling arrived as 1.39 times. Alone, the callback was always
 * in before the first `evaluate` and the same test passed.
 *
 * WAITING ON THE ATTRIBUTE RATHER THAN ON TIME. A timeout would be a guess at
 * how loaded the machine is; the attribute is the page saying it has resolved
 * this viewport, and the name it must carry is the one the table above declares,
 * so the wait also asserts `breakpointFor` agrees with the row.
 */
export async function useViewport(page: Page, viewport: ViewportSize): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForFunction(
    (name) => document.documentElement.dataset['pfBreakpoint'] === name,
    viewport.name,
  );
}

/**
 * QUALITY-BAR section 4's text scaling clause, as the size a browser is given.
 *
 * TWO HUNDRED PERCENT OF SIXTEEN, and both numbers are here rather than one: a
 * doubling stated as "32px" alone is a number nobody can check, and the default
 * is what makes it a doubling. `tests/unit/browser-spec-hygiene.test.ts` pins
 * the pair by literal, because a constant that drove its own assertion would
 * pass for whatever it became.
 *
 * IT IS A FONT SIZE AND NEVER A TRANSFORM. Section 4 asks that chrome TEXT
 * resize; a CSS transform scales a picture of the chrome, keeps every line break
 * where it was and would pass a clipping test that means nothing. Every size in
 * the chrome is stated in rem (QUALITY-BAR section 15), so raising the root size
 * is what a browser's own text-size setting does.
 */
export const DEFAULT_ROOT_FONT_SIZE = 16;
export const DOUBLED_ROOT_FONT_SIZE = '32px';

/**
 * A control's box, named for what it is rather than `Box`.
 *
 * Seven specs in this suite already declare a `Box` of their own for a reading
 * off the canvas, and those are a different thing entirely; a shared export
 * under that name would shadow every one of them.
 */
export interface ControlBox {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Every visible control a player can actually reach, with the box the platform
 * gives it.
 *
 * INERT IS THE FILTER, AND IT IS NOT A CONVENIENCE. An open overlay is fixed
 * over the whole viewport and item G9's trap makes everything under it `inert`,
 * so the chrome beneath really is covered and covering it is the POINT. A sweep
 * that asked whether any two visible boxes overlap would therefore report the
 * pause control under the pause panel as a defect: measured on all three
 * engines, the aim row's Aim right sat over the menu's Goal target radio at the
 * first-launch overlay. What "no control covers another" has to mean is that no
 * control a player can use is covered, and `inert` is exactly the platform's
 * word for the ones they cannot. At every breakpoint with no overlay open,
 * which is where item F1's sweep runs, nothing is inert and this changes
 * nothing.
 */
export async function controlBoxes(page: Page): Promise<ControlBox[]> {
  const found: ControlBox[] = [];
  for (const locator of await page.locator('button:visible, input:visible').all()) {
    const box = await locator.boundingBox();
    if (box === null) {
      continue;
    }
    const reachable = await locator.evaluate(
      (element) => element.closest('[inert]') === null && !element.hasAttribute('inert'),
    );
    if (!reachable) {
      continue;
    }
    const marker = (await locator.getAttribute('data-pf')) ?? '';
    const label = (await locator.getAttribute('aria-label')) ?? (await locator.innerText());
    found.push({
      label: `${marker}|${label}`,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  return found;
}

/** True where two boxes share area. A shared edge is not an overlap. */
export function overlaps(one: ControlBox, other: ControlBox): boolean {
  const slack = 0.5;
  return (
    one.x + one.width - slack > other.x &&
    other.x + other.width - slack > one.x &&
    one.y + one.height - slack > other.y &&
    other.y + other.height - slack > one.y
  );
}

/** Whether the PAGE can be scrolled sideways, which item F2 forbids outright. */
export async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

/**
 * Set the root font size, or put it back where the stylesheet left it.
 *
 * The root element's inline style is what a browser's own text-size setting
 * moves, and it is the one place a size set here cannot be confused with a
 * stylesheet rule the game ships.
 */
export async function setRootFontSize(page: Page, size: string | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) {
      document.documentElement.style.removeProperty('font-size');
      return;
    }
    document.documentElement.style.setProperty('font-size', value);
  }, size);
}

/**
 * Set the root font size and wait for the page to have re-laid itself out.
 *
 * THE SAME RACE THE VIEWPORT HAS, and for the same reason: the two bars grow
 * with the text, the stage shrinks, and `main.ts` re-resolves QUALITY-BAR
 * section 5's sticky rule inside the play surface's resize observer, so the
 * `data-pf-bars` attribute lands a callback after the style does. A reading
 * taken in between is a reading of the previous arrangement, and at 200 percent
 * text on a short viewport the two arrangements are the whole question.
 *
 * The expected value is the CALLER'S, computed from the rule's own constants in
 * the spec, so this waits for the page to agree with the document rather than
 * for the page to agree with itself.
 */
export async function useRootFontSize(
  page: Page,
  size: string | null,
  expectBars: 'sticky' | 'static',
): Promise<void> {
  await setRootFontSize(page, size);
  await page.waitForFunction(
    (want) => document.documentElement.dataset['pfBars'] === want,
    expectBars,
  );
}

/** The root font size the page is actually laid out at, in CSS pixels. */
export async function rootFontSize(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize),
  );
}

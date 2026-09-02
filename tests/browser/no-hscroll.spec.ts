import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, nextFrames, startMatch } from './support/game';

/**
 * Item F2, method T, evidence `playwright/no-hscroll`:
 *
 *   "No horizontal page scroll occurs at any viewport width from 320 pixels
 *    upward."
 *
 * THE INVARIANT, NOT A LAYOUT. What is asserted at every width is that the
 * document is no wider than the box it is shown in, and that the page cannot
 * be scrolled sideways even when something tries. Both halves are here because
 * they fail differently: a document that overflows by a pixel reports a wider
 * scroll width, and a document that overflows into a container with its own
 * scrollbar reports the same width and scrolls anyway.
 *
 * THE WIDTHS ARE THE BOUNDARIES AND THE ONES BETWEEN THEM. Every breakpoint
 * edge is here with its neighbour, because a layout is likeliest to overflow
 * exactly where its arrangement changes, and 320 is here because that is where
 * SC 1.4.10 puts the floor.
 *
 * AND AT THE LARGEST SIZE SETTING, because QUALITY-BAR section 4's
 * magnification is the one thing in this game that deliberately makes the
 * surface wider than its box. The excess belongs to the play frame, which
 * scrolls, and never to the document, which does not.
 */

/** SC 1.4.10's floor, every breakpoint edge and its neighbour, and beyond. */
const WIDTHS = [320, 360, 375, 414, 480, 600, 767, 768, 900, 1023, 1024, 1280, 1920];

/** The one key SPEC section 16 gives the game, as the storage module names it. */
const SAVE_KEY = 'pocket-football:save';

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

interface Sideways {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrolled: number;
}

/** Whether the page is wider than its box, and whether it will move if pushed. */
async function sideways(page: Page): Promise<Sideways> {
  return page.evaluate(() => {
    window.scrollTo(4000, 0);
    const moved = window.scrollX;
    window.scrollTo(0, 0);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrolled: moved,
    };
  });
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  // Polled, because a viewport change is answered on the next frame: the
  // resize observer refits the surface after the layout it was given. What is
  // asserted is the settled answer, and a real overflow never settles.
  await expect
    .poll(async () => {
      const measured = await sideways(page);
      return measured.scrollWidth - measured.clientWidth;
    }, SETTLE)
    .toBeLessThanOrEqual(0);
  const measured = await sideways(page);
  expect(measured.scrolled, `${where} scrolled to`).toBe(0);
}

test.describe('PF-14 no horizontal page scroll, item F2', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('never scrolls sideways at any width from 320 upward, in a match', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await nextFrames(page, 2);
      await expect(at(page, 'hud')).toBeVisible();
      await expectNoSidewaysScroll(page, `${String(width)} wide, tall`);
      // And again at a height that unsticks the bars, because that is a
      // different arrangement of the same chrome.
      await page.setViewportSize({ width, height: 300 });
      await nextFrames(page, 2);
      await expectNoSidewaysScroll(page, `${String(width)} wide, short`);
    }
  });

  test('never scrolls sideways with the ladder readout in the HUD', async ({ page }) => {
    // The widest thing the HUD ever carries is SPEC section 10's rung line,
    // and it is on screen in exactly one mode. Without this the sweep above
    // never sees the readout that would overflow first.
    await startMatch(page, { mode: 'ladder', firstEver: true });
    await expect(at(page, 'ladder')).not.toHaveText('');
    for (const width of [320, 360, 480, 767]) {
      await page.setViewportSize({ width, height: 800 });
      await nextFrames(page, 2);
      await expect(at(page, 'ladder')).toBeVisible();
      await expectNoSidewaysScroll(page, `${String(width)} with the ladder readout`);
    }
  });

  test('never scrolls sideways at the menu or behind an open overlay', async ({ page }) => {
    // The overlays are the widest thing in the chrome and the mode menu is the
    // one with the most controls in it, so the narrowest viewport with a panel
    // open is where a layout overflows if it is going to.
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 640 });
      await page.goto('/');
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      const howTo = at(page, 'panel-how-to-play');
      if (await howTo.isVisible()) {
        await expectNoSidewaysScroll(page, `${String(width)} with how to play open`);
        await page
          .locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' })
          .click();
      }
      await expect(howTo).toBeHidden(SETTLE);
      await expectNoSidewaysScroll(page, `${String(width)} at the menu`);
    }
  });

  test('never scrolls sideways with the play surface at 200 percent', async ({ page }) => {
    // The setting is seeded rather than clicked, because what this test is
    // about is the LAYOUT at 200 percent and not the control that gets there;
    // the control is item F6's, next door.
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(seed.key, seed.text);
      },
      {
        key: SAVE_KEY,
        text: JSON.stringify({ version: 2, settings: { surfaceScale: 200 } }),
      },
    );
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await nextFrames(page, 2);
      await expect(at(page, 'hud')).toBeVisible();
      // The surface really is larger than the box it is in, so this is not a
      // 100 percent measurement wearing a different name. Polled for the same
      // reason the scroll check is: the refit lands on the next frame.
      const magnified = async (): Promise<boolean> =>
        page.evaluate(() => {
          const canvas = document.querySelector('[data-pf="play-surface"]');
          const stage = document.querySelector('[data-pf="stage"]');
          if (!(canvas instanceof HTMLCanvasElement) || !(stage instanceof HTMLElement)) {
            throw new Error('the play surface is not mounted inside a stage');
          }
          const surface = canvas.getBoundingClientRect();
          const box = stage.getBoundingClientRect();
          return surface.width > box.width + 1 || surface.height > box.height + 1;
        });
      await expect.poll(magnified, SETTLE).toBe(true);
      await expectNoSidewaysScroll(page, `${String(width)} at 200 percent`);
    }
  });
});

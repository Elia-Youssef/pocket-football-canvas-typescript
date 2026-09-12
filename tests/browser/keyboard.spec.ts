import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, nextFrames, startMatch } from './support/game';

/**
 * Item C12, method T, evidence `playwright/keyboard`:
 *
 *   "Tab order is logical, Enter and Space activate, the focus indicator
 *    measures at least 3:1 and is never removed, and no state change leaves
 *    focus on the document body."
 *
 * A REAL TAB WALK, NEVER element.focus(). The walk below starts on the
 * document and presses Tab, recording what the platform actually focused at
 * each stop. It matters because a tabindex construction passed 1,096 tests in
 * an earlier build against the weaker form: `element.focus()` succeeds on
 * anything, including an element the platform would never have reached, so a
 * suite built on it proves the test can focus a control and says nothing about
 * whether a player can.
 *
 * PRESENCE BEFORE REACHABILITY, and per phase. Every phase asserts the whole
 * inventory is in the document before anything is asserted about reaching it,
 * because a control that vanished and a control that is merely refused look
 * identical to a test that only looks one up. That is also the failure mode
 * the last clause names: a control removed on a state change drops focus onto
 * the body and a screen reader loses its place.
 *
 * THE RING IS MEASURED, not asserted to exist. The computed outline is read
 * back from the focused element and its contrast against the ground it is
 * drawn on is derived in the page with the WCAG arithmetic written out, in
 * both themes, and compared against the literal 3. The shipped stylesheet is
 * then swept for the one declaration that would remove it.
 */

/**
 * THE BUDGETS, THE DESIGN SPACE AND THE FILLS COME FROM `support/game.ts`.
 * They were retyped in eight of these specs, SPEC section 18's fills among
 * them, so a palette change would have left five of them scanning for a colour
 * the game no longer draws. `SETTLE` and `A_WHOLE_TEST` there are starvation
 * budgets rather than correctness ones: a test here reads the canvas back and
 * drives real shots to rest, and the mutation harness runs this suite with a
 * build going beside it.
 */

/** QUALITY-BAR section 3's floor for a focus indicator, as a literal. */
const FOCUS_CONTRAST = 3;
/** QUALITY-BAR section 15's focus ring: 2 px solid, 2 px offset. */
const FOCUS_WIDTH = 2;

/**
 * The tab order the chrome and the play surface make together: the pause
 * control leads the document, the play surface follows it, and the no-drag
 * controls follow the surface in the order a turn uses them. The four panels
 * are closed and a closed panel is `hidden`, which is what keeps it out of
 * the order without removing it from the document.
 */
const TAB_ORDER = [
  'pause',
  'play-frame',
  'aim-left',
  'aim-angle',
  'aim-right',
  'power-down',
  'power',
  'power-up',
  'aim-launch',
  'aim-cancel',
] as const;

interface Ring {
  readonly marker: string;
  readonly style: string;
  readonly width: number;
  readonly ink: string;
  readonly ground: string;
  readonly ratio: number;
}

async function activeMarker(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return 'body';
    }
    return active.getAttribute('data-pf') ?? active.tagName.toLowerCase();
  });
}

/** The focused control's own text, for the panel buttons, which carry no marker. */
async function activeLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return '';
    }
    if (active instanceof HTMLInputElement) {
      return (active.labels?.[0]?.textContent ?? '').trim();
    }
    return (active.textContent ?? '').trim() || (active.getAttribute('aria-label') ?? '');
  });
}

/**
 * Tab until the focused control carries this name. Bounded, and it reports
 * where it ended up: a radio group is ONE stop however many radios it holds,
 * so counting presses is a guess about the platform and this is not.
 */
async function tabToLabel(page: Page, label: string, limit = 8): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if ((await activeLabel(page)) === label) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${label}, it stopped on ${await activeLabel(page)}`);
}

async function walk(page: Page, stops: number): Promise<string[]> {
  const seen: string[] = [];
  for (let step = 0; step < stops; step += 1) {
    await page.keyboard.press('Tab');
    seen.push(await activeMarker(page));
  }
  return seen;
}

async function tabTo(page: Page, marker: string): Promise<void> {
  for (let step = 0; step < TAB_ORDER.length + 2; step += 1) {
    if ((await activeMarker(page)) === marker) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${marker}`);
}

/**
 * The focused element's ring, and its contrast against the ground it is drawn
 * on. The relative luminance arithmetic is written out here rather than
 * borrowed, so the number this file reports is one it derived.
 */
async function ringOf(page: Page): Promise<Ring> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      throw new Error('nothing is focused');
    }
    const style = getComputedStyle(active);
    const bytesOf = (colour: string): number[] => {
      const found = colour.match(/[\d.]+/g) ?? [];
      return found.slice(0, 3).map((part) => Number(part));
    };
    const channel = (byte: number): number => {
      const value = byte / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (colour: string): number => {
      const [red = 0, green = 0, blue = 0] = bytesOf(colour);
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const ground = getComputedStyle(document.body).backgroundColor;
    const ink = style.outlineColor;
    const one = luminance(ink);
    const other = luminance(ground);
    return {
      marker: active.getAttribute('data-pf') ?? active.tagName.toLowerCase(),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      ink,
      ground,
      ratio: (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05),
    };
  });
}

test.describe('PF-6 keyboard operation, item C12', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('holds the whole inventory in every phase before any of it is reached', async ({
    page,
  }) => {
    // Presence, in the player's turn.
    for (const marker of TAB_ORDER) {
      await expect(page.locator(`[data-pf="${marker}"]`), marker).toHaveCount(1);
    }

    // Presence again while the world is moving, which is a phase that refuses
    // every one of them. Driven by a real drag, because a launch is the only
    // way into it.
    const box = await page.locator('[data-pf="play-surface"]').boundingBox();
    if (box === null) {
      throw new Error('the play surface has no box');
    }
    const from = { x: box.x + (300 * box.width) / 1280, y: box.y + (360 * box.height) / 720 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 100, from.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
    for (const marker of TAB_ORDER) {
      await expect(page.locator(`[data-pf="${marker}"]`), marker).toHaveCount(1);
      await expect(page.locator(`[data-pf="${marker}"]`), marker).toBeVisible();
    }

    // And while the match is paused, where an overlay covers the pitch.
    await page.locator('[data-pf="pause"]').click();
    await expect(page.locator('[data-pf="turn"]')).toHaveText('PAUSED', SETTLE);
    for (const marker of TAB_ORDER) {
      await expect(page.locator(`[data-pf="${marker}"]`), marker).toHaveCount(1);
    }
  });

  test('walks the tab order the document actually offers', async ({ page }) => {
    const stops = await walk(page, TAB_ORDER.length);
    expect(stops).toEqual([...TAB_ORDER]);

    // The four panels are built once and closed, and a closed one is the
    // `hidden` attribute rather than a removed subtree, so its buttons are in
    // the document and must stay out of the order. What the platform does at
    // the end of the page differs by engine - one leaves for the browser's own
    // chrome, another wraps back to the first control - so the assertion is
    // the property rather than either behaviour: four more presses, and not
    // one of them lands inside an overlay nobody opened.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement
          ? active.closest('.pf-panel[hidden]') !== null
          : false;
      });
      expect(inside, `stop ${String(step)} past the end`).toBe(false);
    }
  });

  test('activates a control with Enter and with Space', async ({ page }) => {
    // Enter on the Launch button takes the shot. Tabbing past the play
    // surface has already entered aim mode, so there is an aim to launch,
    // which is SPEC section 5.1's own reading of focusing the surface.
    await tabTo(page, 'aim-launch');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
    // The state changed under the focused control and the control kept it.
    expect(await activeMarker(page)).toBe('aim-launch');
  });

  test('activates the same control with Space', async ({ page }) => {
    await tabTo(page, 'aim-launch');
    await page.keyboard.press('Space');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
    expect(await activeMarker(page)).toBe('aim-launch');
  });

  test('activates the chrome controls with Enter and with Space too', async ({ page }) => {
    // "Enter and Space activate" is a claim about the controls, not about one
    // of them. The pause control answers Space, and the buttons inside the
    // overlay it opens answer both keys; between them and the Launch tests
    // above, every kind of control this document offers has been activated by
    // each key at least once.
    await tabTo(page, 'pause');
    await page.keyboard.press('Space');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('PAUSED', SETTLE);

    // Focus is on Resume inside the panel; Space opens Settings from the
    // second button and Enter closes it again from the Close button.
    await page.keyboard.press('Tab');
    expect(await activeLabel(page)).toBe('Settings');
    await page.keyboard.press('Space');
    await expect(page.locator('[data-pf="panel-settings"]')).toBeVisible();
    // The overlay took focus, on its first control.
    expect(await activeLabel(page)).toBe('System');
    await tabToLabel(page, 'Close');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="panel-settings"]')).toBeHidden();

    // And Enter on Resume takes the match back, so both keys reached a panel
    // button and both reached a control outside the panels.
    expect(await activeLabel(page)).toBe('Settings');
    await page.keyboard.press('Shift+Tab');
    expect(await activeLabel(page)).toBe('Resume');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
  });

  test('opens and closes the pause overlay from the keyboard alone', async ({ page }) => {
    await tabTo(page, 'pause');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('PAUSED', SETTLE);
    // The overlay took focus rather than leaving it behind a covered pitch.
    const inPanel = await page.evaluate(() => {
      const panel = document.querySelector('[data-pf="panel-pause"]');
      const active = document.activeElement;
      return {
        contained: panel instanceof HTMLElement && active instanceof HTMLElement
          ? panel.contains(active)
          : false,
        label: active?.textContent ?? '',
        onBody: active === document.body,
      };
    });
    expect(inPanel.onBody).toBe(false);
    expect(inPanel.contained).toBe(true);
    expect(inPanel.label).toBe('Resume');

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    // And it handed focus back to the control that opened it.
    expect(await activeMarker(page)).toBe('pause');
  });

  test('leaves focus off the document body through every state change', async ({ page }) => {
    const changes: string[] = [];
    await tabTo(page, 'pause');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('PAUSED', SETTLE);
    changes.push(await activeMarker(page));
    const opened = await activeLabel(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    changes.push(await activeMarker(page));
    await tabTo(page, 'aim-launch');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
    changes.push(await activeMarker(page));
    // The turn passing out of play, whichever state it has reached by the time
    // this reads: from PF-9 the opponent answers its own turn and hands the
    // match back by itself, so naming one of the states it passes through
    // would be racing the game rather than sampling it. What this test is
    // about is where focus is after a state change, and any of them is one.
    await expect(page.locator('[data-pf="turn"]')).not.toHaveText('IN PLAY', SETTLE);
    changes.push(await activeMarker(page));
    // Both sinks, not just one: an element removed under a focused control
    // drops focus on the body in most engines and on the root element in
    // some, and either is the screen reader losing its place.
    for (const sink of ['body', 'html']) {
      expect(changes, `focus sank to ${sink}`).not.toContain(sink);
    }
    expect(changes).toHaveLength(4);
    // The overlay took focus off the pause control and onto its own first
    // button, which carries no marker of its own.
    expect(changes[0]).not.toBe('pause');
    expect(opened).toBe('Resume');
    // Closing it handed focus back to the control that opened it, and the two
    // state changes after that left focus exactly where the player put it.
    expect(changes[1]).toBe('pause');
    expect(changes[2]).toBe('aim-launch');
    expect(changes[3]).toBe('aim-launch');
  });

  test('measures the focus ring at every stop, in both themes', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await startMatch(page);
      await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
      const rings: Ring[] = [];
      for (const marker of TAB_ORDER) {
        await page.keyboard.press('Tab');
        expect(await activeMarker(page), `${theme} ${marker}`).toBe(marker);
        rings.push(await ringOf(page));
      }
      expect(new Set(rings.map((ring) => ring.marker)).size, theme).toBe(
        TAB_ORDER.length,
      );
      for (const ring of rings) {
        // Never removed, at the width the scale states, and clearing the
        // floor QUALITY-BAR section 3 puts on it.
        expect(ring.style, `${theme} ${ring.marker} style`).not.toBe('none');
        expect(ring.width, `${theme} ${ring.marker} width`).toBeGreaterThanOrEqual(
          FOCUS_WIDTH,
        );
        expect(ring.ratio, `${theme} ${ring.marker} ratio`).toBeGreaterThanOrEqual(
          FOCUS_CONTRAST,
        );
      }
      // The ring is the accent, so the number it measures is one of the two
      // SPEC section 18 quotes for the accent on its own ground. Pinned as a
      // literal, so a ring recoloured to something that merely passes 3:1
      // reddens this rather than sliding through.
      const measured = Math.round((rings[0]?.ratio ?? 0) * 100) / 100;
      expect(measured, theme).toBe(theme === 'dark' ? 11.56 : 5.63);
    }
  });

  test('ships no rule that removes an outline, and one that draws it', async ({ page }) => {
    const rules = await page.evaluate(() =>
      [...document.styleSheets].flatMap((sheet) =>
        [...sheet.cssRules].map((rule) => rule.cssText),
      ),
    );
    expect(rules.length).toBeGreaterThan(10);
    const removals = rules.filter((text) =>
      /outline(?:-width|-style)?\s*:\s*(?:none|0(?:px)?)\b/i.test(text),
    );
    expect(removals).toEqual([]);
    // And the ring itself is in there, so the sweep above ran over a
    // stylesheet that has an outline in it to find.
    const ring = rules.filter(
      (text) => text.includes(':focus-visible') && /outline\s*:/.test(text),
    );
    expect(ring).toHaveLength(1);
  });
});

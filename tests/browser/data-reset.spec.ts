import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, playUntil, turnText } from './support/game';

/**
 * Item I4, method T, evidence `playwright/data-reset`:
 *
 *   "Reset all data is reachable from settings, requires confirmation, and
 *    clears every persisted value including ladder progress."
 *
 * THE SESSION STARTS WITH SOMETHING TO CLEAR. A reset over a new player's
 * empty document clears nothing observable, so these tests seed a saved
 * document before the page loads and then prove the game READ it: the ladder
 * stands on rung four by name, the theme is the stored one, and the menu opens
 * on the stored mode. Only then is the reset worth measuring, and the seed is
 * validated by the game's own readouts rather than trusted.
 *
 * THE SEEDED DOCUMENT IS WRITTEN AS LITERALS, exactly as SPEC section 10's six
 * names and SPEC section 9's numbers are elsewhere in this suite. Its shape is
 * pinned over the real module in tests/unit/storage-migration.test.ts; here it
 * is a fixture, and a shape that stopped matching would fail loudly at the
 * first readout rather than quietly seeding nothing. That the game WRITES this
 * shape is item I5's, next door.
 *
 * "REQUIRES CONFIRMATION" IS GRADED IN BOTH DIRECTIONS. The confirmation is
 * refused before it is armed, cancelling leaves everything where it was, and
 * only the armed confirm clears. A two-step that cleared on the first press
 * would pass a test that only ever pressed twice.
 *
 * "EVERY PERSISTED VALUE" IS MEASURED AFTER A RELOAD as well as in place,
 * because the seen flag for SPEC section 19's overlay and the stored settings
 * are only observable on the next load. The overlay coming back is the proof
 * that the flag went with the rest.
 */

/** The one key SPEC section 16 gives the game, as the storage module names it. */
const SAVE_KEY = 'pocket-football:save';

/** A saved document from a player several matches in, at the current version. */
const SEEDED = {
  version: 2,
  progress: { ladderRung: 4, howToDismissed: true, playedBefore: true },
  settings: {
    mode: 'first-to',
    duration: 120,
    target: 7,
    difficulty: 'ace',
    guide: true,
    theme: 'dark',
    muted: false,
    volume: 1,
    motion: 'system',
    surfaceScale: 100,
  },
  records: {
    quick: { goalsFor: 5, goalsAgainst: 1 },
    'first-to': null,
    ladder: { goalsFor: 3, goalsAgainst: 0 },
    hotseat: null,
  },
  counters: { matchesPlayed: 7, goalsFor: 18, goalsAgainst: 9 },
};

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function saved(page: Page, key: string): Promise<string | null> {
  return page.evaluate((name) => window.localStorage.getItem(name), key);
}

/** Seed the document, load the game and open Settings from the pause overlay. */
async function openSettings(page: Page): Promise<void> {
  await at(page, 'mode-start').click();
  await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
  await at(page, 'pause').click();
  await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
  await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
}

test.describe('PF-10 reset all data, item I4', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(seed.key, seed.text);
      },
      { key: SAVE_KEY, text: JSON.stringify(SEEDED) },
    );
  });

  test('opens the stored session, so a reset has something to clear', async ({ page }) => {
    await page.goto('/');
    // SPEC section 19: the overlay is not shown again once it was dismissed,
    // and the stored flag says it was.
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await expect(at(page, 'panel-how-to-play')).toBeHidden();
    // SPEC section 17's stored theme, applied by the chrome at mount.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // SPEC section 16's stored settings, as the menu opens on them.
    await expect(at(page, 'mode-first-to')).toBeChecked();
    await expect(at(page, 'target-7')).toBeChecked();
    await expect(at(page, 'difficulty-ace')).toBeChecked();
    await expect(at(page, 'mode-guide')).toBeChecked();
    // SPEC section 10's fourth rung, by name.
    await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 4 of 6, Vector');
  });

  test('states plainly that progress is stored in this browser only', async ({ page }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await openSettings(page);
    const notice = at(page, 'storage-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('stored in this browser only');
    await expect(notice).toContainText('Clearing this browser can clear it too');
    await expect(at(page, 'reset-data')).toBeVisible();
  });

  test('refuses the confirmation until the reset is armed', async ({ page }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await openSettings(page);

    // Unarmed: both halves of the confirmation refused in place, and the
    // prompt empty. QUALITY-BAR section 3 keeps them in the document.
    await expect(at(page, 'reset-confirm')).toHaveAttribute('aria-disabled', 'true');
    await expect(at(page, 'reset-cancel')).toHaveAttribute('aria-disabled', 'true');
    await expect(at(page, 'reset-prompt')).toHaveText('');

    // The refusal is real and not merely announced. The click is DISPATCHED
    // rather than performed, exactly as the refused pause control and the
    // refused aim steppers are driven elsewhere in this suite: an automated
    // press will not touch an `aria-disabled` control at all, and what has to
    // be proven here is that the handler behind it refuses the event a
    // platform would still deliver.
    await at(page, 'reset-confirm').dispatchEvent('click');
    expect(await saved(page, SAVE_KEY)).not.toBeNull();
    await expect(at(page, 'reset-prompt')).toHaveText('');

    await at(page, 'reset-data').click();
    await expect(at(page, 'reset-confirm')).toHaveAttribute('aria-disabled', 'false');
    await expect(at(page, 'reset-cancel')).toHaveAttribute('aria-disabled', 'false');
    await expect(at(page, 'reset-data')).toHaveAttribute('aria-disabled', 'true');
    await expect(at(page, 'reset-prompt')).toContainText('cannot be undone');
    // The safe half takes focus, so the destructive one is never under the
    // next activation.
    await expect(at(page, 'reset-cancel')).toBeFocused();
  });

  test('cancelling leaves every stored value exactly where it was', async ({ page }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await openSettings(page);
    // Read after the start, because a start is itself a write: the comparison
    // is against the document as it stands when the reset is offered.
    const before = await saved(page, SAVE_KEY);

    await at(page, 'reset-data').click();
    await at(page, 'reset-cancel').click();

    await expect(at(page, 'reset-confirm')).toHaveAttribute('aria-disabled', 'true');
    await expect(at(page, 'reset-prompt')).toHaveText('');
    await expect(at(page, 'reset-data')).toBeFocused();
    expect(await saved(page, SAVE_KEY)).toBe(before);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('clears every persisted value once confirmed, ladder progress included', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await openSettings(page);

    await at(page, 'reset-data').click();
    await at(page, 'reset-confirm').click();

    // The document is gone rather than replaced by a default one.
    expect(await saved(page, SAVE_KEY)).toBeNull();
    await expect(at(page, 'reset-prompt')).toContainText('cleared');
    await expect(at(page, 'reset-confirm')).toHaveAttribute('aria-disabled', 'true');
    // SPEC section 17's theme is back to System, which is the absence of an
    // override, and the chrome shows the same thing.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel('System')).toBeChecked();

    // The live session follows: the ladder is back on rung one the moment the
    // menu reads it, without a reload.
    await page.locator('[data-pf="panel-settings"] button', { hasText: 'Close' }).click();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Quit' }).click();
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 1 of 6, Sparks');
  });

  test('leaves a new player behind after the reload, seen flag included', async ({ page }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await openSettings(page);
    await at(page, 'reset-data').click();
    await at(page, 'reset-confirm').click();
    expect(await saved(page, SAVE_KEY)).toBeNull();

    // The seed is re-applied on every load by the init script, so it is
    // removed before the reload: what comes back has to be the cleared state
    // and not the fixture again.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, SAVE_KEY);
    await page.reload();

    // SPEC section 19: How to Play is shown on first launch, and the cleared
    // flag makes this launch a first one again.
    await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
    // Nothing has been written yet, because nothing has been started.
    expect(await saved(page, SAVE_KEY)).toBeNull();
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();

    // SPEC section 9's own defaults, and no theme override.
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await expect(at(page, 'mode-quick')).toBeChecked();
    await expect(at(page, 'duration-60')).toBeChecked();
    await expect(at(page, 'target-3')).toBeChecked();
    await expect(at(page, 'difficulty-casual')).toBeChecked();
    await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 1 of 6, Sparks');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test(
    'lets the match it was taken during write nothing at its whistle',
    { tag: '@drive' },
    async ({ page }) => {
      // THE ONLY ROUTE TO THIS CONTROL RUNS THROUGH A LIVE MATCH. Settings is
      // opened from the pause overlay, so every reset is taken with a match in
      // progress and with the composition root still holding that match's
      // mode. The whistle is where the ladder rung, the mode's best result and
      // the lifetime counters are written, and writing them after a reset
      // would put back, from the match's own memory, the progress the player
      // had just erased. So the reset has to end that match's claim on the
      // document as well as clearing it.
      await page.clock.install({ time: 0 });
      await page.goto('/');
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      await at(page, 'mode-ladder').check();
      await at(page, 'mode-guide').uncheck();
      await at(page, 'mode-start').click();
      await expect(at(page, 'ladder')).toHaveText('Vector - RUNG 4 OF 6');

      await at(page, 'pause').click();
      await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
      await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
      await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
      await at(page, 'reset-data').click();
      await at(page, 'reset-confirm').click();
      expect(await saved(page, SAVE_KEY)).toBeNull();

      await page.locator('[data-pf="panel-settings"] button', { hasText: 'Close' }).click();
      await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
      await expect(at(page, 'panel-pause')).toBeHidden();

      // Play the rung out. The striker is pointed at the player's own mouth,
      // so the result arrives whatever the opponent does with its turns.
      const frames = await playUntil(page, 2500, 'left', async () => {
        return (await turnText(page)) === 'FULL TIME';
      });
      expect(frames).toBeLessThan(2500);

      // Nothing at all: not the rung, not the result, not the counters.
      expect(await saved(page, SAVE_KEY)).toBeNull();
      await at(page, 'change-mode').click();
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 1 of 6, Sparks');
    },
  );

  test('is reachable from settings and nowhere else on the way there', async ({ page }) => {
    // "Reachable from settings" is a claim about the journey: the control is
    // not on the menu, not in the HUD and not on the pause panel itself.
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await expect(at(page, 'reset-data')).toBeHidden();
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    await expect(at(page, 'reset-data')).toBeHidden();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    await expect(at(page, 'reset-data')).toBeVisible();
  });
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  chooseMode,
  launchAim,
  openGame,
  playUntil,
  scores,
  strikeAim,
  turnText,
} from './support/game';

/**
 * Item I5, method T, evidence `playwright/persistence`:
 *
 *   "Nothing about a match in progress is written to storage: after a mid-match
 *    reload the game starts fresh, while ladder progress, best results per
 *    mode, lifetime counters and settings survive."
 *
 * BOTH HALVES IN ONE TEST, because the criterion is one claim about one
 * reload: a suite that proved the fresh start in one test and the survival in
 * another would never have asserted that the same reload does both.
 *
 * THE DOCUMENT THIS TEST READS IS ONE THE GAME WROTE. Nothing here is seeded.
 * A ladder rung is played to a real win through SPEC section 5.0's own
 * controls, the theme is changed through the settings panel, and every mode is
 * chosen in the menu, so each stored value under assertion arrived through a
 * control a player can reach. Item I4's spec next door seeds a document
 * instead, and the two together close the loop: this one proves the shape is
 * written, that one proves it is read.
 *
 * THE MATCH THAT IS ABANDONED IS HOTSEAT, and the reason is certainty. SPEC
 * section 9's Hotseat has no opponent routine at all, so this test drives both
 * humans at the same mouth and a goal arrives because the test put it there;
 * against a routine that plays its own turns a scoreline is something the
 * match decides, and one engine's run of a First-to-N against Ace played four
 * hundred seconds without a goal while the other two scored in twenty. What
 * has to be certain here is that a goal exists on the board at the moment of
 * the reload, so it is made certain rather than hoped for.
 *
 * "NOTHING ABOUT A MATCH IN PROGRESS" IS ASSERTED AS THE WHOLE DOCUMENT, not
 * as the absence of a field somebody thought to name. The stored text is
 * captured before the reload and compared byte for byte after it, and the
 * counters are pinned against a mid-match scoreline that is deliberately not
 * zero: a goal was scored in the abandoned match, and the lifetime totals do
 * not know about it.
 *
 * TIME IS THE TEST'S from before the navigation, so a whole rung is seconds of
 * wall clock rather than minutes of waiting.
 */

const SAVE_KEY = 'pocket-football:save';

/** SPEC section 10's second rung, which is where winning the first leaves it. */
const SECOND_RUNG = 'Bolt';

/** The settings the three starts below leave behind, field by field. */
const EXPECTED_SETTINGS = {
  mode: 'hotseat',
  duration: 120,
  target: 7,
  difficulty: 'ace',
  guide: false,
  theme: 'dark',
  muted: false,
  volume: 1,
  motion: 'system',
  surfaceScale: 100,
};

interface Stored {
  readonly progress: { readonly ladderRung: number };
  readonly settings: Record<string, unknown>;
  readonly records: Record<string, { goalsFor: number; goalsAgainst: number } | null>;
  readonly counters: {
    readonly matchesPlayed: number;
    readonly goalsFor: number;
    readonly goalsAgainst: number;
  };
}

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function savedText(page: Page): Promise<string> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
  expect(text).not.toBeNull();
  return text ?? '';
}

function parsed(text: string): Stored {
  return JSON.parse(text) as Stored;
}

/**
 * Hotseat, driven by the test on BOTH sides at the same mouth, until a goal
 * lands. The shared `playBothSides` plays to a whistle; this match is meant to
 * be abandoned rather than finished, so the drive stops at the first goal and
 * the First-to-7 target is never approached.
 */
async function driveToOneGoal(page: Page, budget: number): Promise<number> {
  for (let frames = 0; frames < budget; frames += 4) {
    await advance(page, 4);
    const board = await scores(page);
    if (board.player + board.opponent >= 1) {
      return frames + 4;
    }
    const state = await turnText(page);
    if (state === 'PLAYER 1 IS AIMING') {
      await launchAim(page, strikeAim(await centres(page), 'right'));
    } else if (state === 'PLAYER 2 IS AIMING') {
      const scene = await centres(page);
      await launchAim(
        page,
        strikeAim(
          { player: scene.opponent, opponent: scene.player, ball: scene.ball },
          'right',
        ),
      );
    }
  }
  return budget;
}

/** Pause, change the theme through the settings panel, and quit to the menu. */
async function chooseDarkThemeAndQuit(page: Page): Promise<void> {
  await at(page, 'pause').click();
  await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
  await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
  await page.getByLabel('Dark').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('[data-pf="panel-settings"] button', { hasText: 'Close' }).click();
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Quit' }).click();
  await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
}

test.describe('PF-10 persistence across a mid-match reload, item I5', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test(
    'starts fresh after a mid-match reload while everything earned survives',
    { tag: '@drive' },
    async ({ page }) => {
      await page.clock.install({ time: 0 });
      await page.setViewportSize({ width: 1280, height: 900 });

      // A first match, started only to leave the first-ever state behind and
      // to put SPEC section 17's match length, difficulty and theme on record.
      await openGame(page);
      await chooseMode(page, {
        mode: 'quick',
        duration: 120,
        difficulty: 'ace',
        guide: true,
      });
      await at(page, 'mode-start').click();
      await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
      await chooseDarkThemeAndQuit(page);

      // THE LADDER RUNG, WON FOR REAL. The scripted striker attacks the
      // opponent's mouth until the rung's own First-to-N target is reached.
      await chooseMode(page, { mode: 'ladder' });
      await at(page, 'mode-start').click();
      await expect(at(page, 'ladder')).toHaveText('Sparks - RUNG 1 OF 6');
      const rungFrames = await playUntil(page, 2500, 'right', async () => {
        return (await turnText(page)) === 'FULL TIME';
      });
      expect(rungFrames).toBeLessThan(2500);
      const rungScore = await scores(page);
      expect(rungScore.player).toBe(3);
      await expect(at(page, 'result')).toHaveText('You win!');

      // SPEC section 16, at the whistle: the rung, the mode's best result and
      // the lifetime counters, all from the one match just played.
      const afterRung = parsed(await savedText(page));
      expect(afterRung.progress.ladderRung).toBe(2);
      expect(afterRung.records['ladder']).toEqual({
        goalsFor: rungScore.player,
        goalsAgainst: rungScore.opponent,
      });
      expect(afterRung.counters).toEqual({
        matchesPlayed: 1,
        goalsFor: rungScore.player,
        goalsAgainst: rungScore.opponent,
      });
      expect(afterRung.settings['theme']).toBe('dark');

      // A SECOND MATCH, ABANDONED IN PROGRESS, with a goal on the board.
      await at(page, 'change-mode').click();
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      await expect(at(page, 'mode-ladder-rung')).toHaveText(
        `Ladder: rung 2 of 6, ${SECOND_RUNG}`,
      );
      // The guide is left OFF, and the choice is deliberate: Hotseat plays at
      // Casual, whose SPEC section 11 default is ON, so a stored false is a
      // value the menu could only be showing because it was stored.
      await chooseMode(page, { mode: 'hotseat', target: 7 });
      await at(page, 'mode-start').click();
      await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);

      const goalFrames = await driveToOneGoal(page, 900);
      expect(goalFrames).toBeLessThan(900);
      const abandoned = await scores(page);
      expect(abandoned.player + abandoned.opponent).toBeGreaterThanOrEqual(1);
      // Still running: a First to 7 cannot have finished on one goal.
      expect(await turnText(page)).not.toBe('FULL TIME');

      // The document as it stands with a goal on the board and the match
      // still live. Nothing beyond the start's own settings write has happened
      // since the whistle of the rung before it.
      const beforeReload = await savedText(page);
      const midMatch = parsed(beforeReload);
      expect(midMatch.progress.ladderRung).toBe(2);
      expect(midMatch.counters).toEqual(afterRung.counters);
      expect(midMatch.records).toEqual(afterRung.records);
      expect(Object.keys(midMatch).sort()).toEqual([
        'counters',
        'progress',
        'records',
        'settings',
        'version',
      ]);

      await page.reload();

      // HALF ONE: the game starts fresh. The menu is back, no match is
      // running, and the abandoned scoreline is nowhere.
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      await expect(at(page, 'turn')).toHaveText('MENU');
      expect(await scores(page)).toEqual({ player: 0, opponent: 0 });
      // And this is not a first launch, because the seen flag survived too.
      await expect(at(page, 'panel-how-to-play')).toBeHidden();

      // HALF TWO: everything the criterion names survived, byte for byte.
      expect(await savedText(page)).toBe(beforeReload);
      // Read back from the page rather than reused, so the assertions below
      // are about what the reloaded session is holding and the name is true.
      const afterReload = parsed(await savedText(page));
      // Ladder progress, in the document and as the menu reads it back.
      expect(afterReload.progress.ladderRung).toBe(2);
      await expect(at(page, 'mode-ladder-rung')).toHaveText(
        `Ladder: rung 2 of 6, ${SECOND_RUNG}`,
      );
      // Best results per mode, and the mode nobody has a result in yet.
      expect(afterReload.records['ladder']).toEqual({
        goalsFor: rungScore.player,
        goalsAgainst: rungScore.opponent,
      });
      expect(afterReload.records['hotseat']).toBeNull();
      // Lifetime counters, unchanged by a match abandoned with a goal in it.
      expect(afterReload.counters).toEqual({
        matchesPlayed: 1,
        goalsFor: rungScore.player,
        goalsAgainst: rungScore.opponent,
      });
      // SPEC section 17's settings, every field of them, including the match
      // length and the difficulty that the last mode chosen does not itself
      // carry, and the four reserved for the parts that own their controls.
      expect(afterReload.settings).toEqual(EXPECTED_SETTINGS);
      // And as the chrome and the menu show them.
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(at(page, 'mode-hotseat')).toBeChecked();
      await expect(at(page, 'target-7')).toBeChecked();
      await expect(at(page, 'mode-guide')).not.toBeChecked();
    },
  );
});

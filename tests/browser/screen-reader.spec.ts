import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  pauseClock,
  playBothSides,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item G4's ARMOUR, and armour is not closure.
 *
 *   "A polite live region mirrors play state in words and an assertive region
 *    carries goals and results, such that a screen reader user can follow and
 *    complete a full match."
 *
 * G4 IS A DEMONSTRATION ITEM. It closes at the recorded session ACCEPTANCE
 * section 4 describes, with VoiceOver on iOS and NVDA on Windows, a complete
 * match played without looking at the screen and the mirror navigated as well
 * as the regions listened to. Nothing in this file can close it, and nothing in
 * this file claims to: what it does is play a whole match with the screen
 * irrelevant, write down everything the two regions said, and require the
 * transcript to be one a player could have followed. If that stops being true,
 * this reddens months before anybody sets up a capture.
 *
 * THE TRANSCRIPT IS THE SUBJECT. Every other test of this machinery asserts a
 * mechanism: the floor, the coalescing, the edge detection, the words for one
 * state. A reader does not experience mechanisms; they experience the sequence,
 * and the two failures that matter to them are a sequence with a hole in it and
 * a sequence that repeats itself. Both are only visible over a match.
 *
 * DRIVEN IN HOTSEAT, so the scoreline is certain rather than earned: SPEC
 * section 3 credits the mouth the ball entered, so both humans attacking one
 * mouth put goals past the side that owns it, and full time arrives with a
 * result rather than a coin.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

interface Said {
  readonly polite: string[];
  readonly assertive: string[];
}

/**
 * Watch both regions for the rest of the test.
 *
 * A MutationObserver rather than a poll, because a poll between two driven
 * frames reads whatever happens to be in the element and misses anything the
 * queue replaced in between; what a reader hears is every mutation.
 */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __pfHeard?: { polite: string[]; assertive: string[] } };
    store.__pfHeard = { polite: [], assertive: [] };
    for (const [marker, into] of [
      ['live-polite', 'polite'],
      ['live-assertive', 'assertive'],
    ] as const) {
      const target = document.querySelector(`[data-pf="${marker}"]`);
      if (!(target instanceof HTMLElement)) {
        throw new Error(`the ${marker} region is not in the document`);
      }
      new MutationObserver(() => {
        store.__pfHeard?.[into].push(target.textContent ?? '');
      }).observe(target, { childList: true, characterData: true, subtree: true });
    }
  });
}

async function heard(page: Page): Promise<Said> {
  return page.evaluate(() => {
    const store = window as unknown as { __pfHeard?: { polite: string[]; assertive: string[] } };
    return store.__pfHeard ?? { polite: [], assertive: [] };
  });
}

/** The three lines the mirror holds, which is the representation half. */
async function mirror(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ['mirror-ball', 'mirror-player', 'mirror-opponent'].map((marker) => {
      const element = document.querySelector(`[data-pf="${marker}"]`);
      return element?.textContent ?? '';
    }),
  );
}

test.describe('PF-15 a whole match in words, item G4 armour', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('says enough to follow a whole match, and never says it twice', {
    tag: '@drive',
  }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await startMatch(page, { mode: 'hotseat', target: 3 });
    // AND STOPPED: the match below is made of the frames it charges.
    await pauseClock(page);
    await listen(page);

    const opening = await mirror(page);
    expect(opening[0]).toBe('Ball: middle third, centre lane, 50 percent across.');
    expect(opening[1]).toContain('left third');
    expect(opening[2]).toContain('right third');

    // AN AIM IS TAKEN BY HAND FIRST, and it has to be: the scripted striker
    // below sets both sliders and launches between two driven frames, so the
    // aim exists and is gone again without a frame in between for the queue to
    // publish on. A player adjusting an angle spends frames doing it, which is
    // what this reproduces.
    await at(page, 'aim-angle').fill('42');
    await advance(page, 3);
    expect(
      (await heard(page)).polite.some((line) =>
        /^Aim \d+ degrees, power \d+ percent$/.test(line),
      ),
      'the aim reaches the polite channel while a turn is being taken',
    ).toBe(true);
    await at(page, 'aim-cancel').click();
    await advance(page, 3);

    const frames = await playBothSides(page, 3000, 'right');
    expect(frames, 'the match finished inside the budget').toBeLessThan(3000);
    expect(await turnText(page)).toBe('FULL TIME');

    const said = await heard(page);

    // ONE: THERE IS A TRANSCRIPT AT ALL. A region nobody wrote to is the
    // failure this whole item exists to prevent, and it looks like silence
    // rather than like an error.
    expect(said.polite.length, 'the polite region said something').toBeGreaterThan(10);
    expect(said.assertive.length, 'the assertive region said something').toBeGreaterThan(0);

    // TWO: THE SEQUENCE IS FOLLOWABLE. Both humans took turns, the ball was in
    // play between them, and the whistle was announced; a reader who heard only
    // "in play" would know a match was happening and nothing else.
    const politeText = said.polite.join('\n');
    for (const needed of ['Player 1 is aiming.', 'Player 2 is aiming.', 'In play.']) {
      expect(politeText, needed).toContain(needed);
    }

    // THREE: THE OUTCOMES ARE ON THE OTHER CHANNEL, and every one of them says
    // who scored and what the score became.
    const goals = said.assertive.filter((line) => line.startsWith('Goal to '));
    expect(goals.length, 'every goal was announced').toBeGreaterThanOrEqual(3);
    for (const goal of goals) {
      expect(goal).toMatch(/^Goal to .+\. \d+ to \d+\.$/);
    }
    expect(said.assertive[said.assertive.length - 1]).toMatch(/^Full time\. .+ \d+ to \d+\.$/);

    // FOUR: NOTHING IS SAID TWICE IN A ROW. A region that repeats a line a
    // reader has already heard is a region they learn to ignore, and the
    // coalescing queue exists precisely so that it cannot.
    for (const channel of [said.polite, said.assertive] as const) {
      for (let at = 1; at < channel.length; at += 1) {
        expect(channel[at], `repeated: ${String(channel[at])}`).not.toBe(channel[at - 1]);
      }
    }

    // FIVE: THE MIRROR MOVED WITH THE MATCH. It is the representation half, so
    // it is not announced at all; what it has to be is different at the end of
    // a match from what it was at kick off, and still a description.
    const closing = await mirror(page);
    expect(closing).not.toEqual(opening);
    for (const line of closing) {
      expect(line).toMatch(/^.+: .+ (third|unknown).*\.$/);
    }
  });

  test('keeps the page usable as a document while an overlay is open', {
    tag: '@drive',
  }, async ({ page }) => {
    // The other half of "follow a match": a reader who pauses has to be told
    // what happened, and the regions are OUTSIDE the app column precisely so
    // that item G9 trap cannot silence them.
    await page.clock.install({ time: 0 });
    await startMatch(page, { mode: 'first-to', target: 3 });
    await pauseClock(page);
    await listen(page);
    await advance(page, 4);

    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    await advance(page, 4);
    expect((await heard(page)).polite).toContain('Paused.');

    // The regions are reachable: neither is inside the inert column, and the
    // announcer they sit in is not inert either.
    const reachable = await page.evaluate(() =>
      ['live-polite', 'live-assertive'].map((marker) => {
        const element = document.querySelector(`[data-pf="${marker}"]`);
        if (!(element instanceof HTMLElement)) {
          return 'missing';
        }
        return element.closest('[inert]') === null ? 'live' : 'inert';
      }),
    );
    expect(reachable).toEqual(['live', 'live']);

    // And the mirror IS inside it, which is correct: while a modal dialog is
    // open the pitch behind it is background, and a reader is in the dialog.
    const covered = await page.evaluate(() => {
      const element = document.querySelector('[data-pf="play-mirror"]');
      if (!(element instanceof HTMLElement)) {
        return 'missing';
      }
      return element.closest('[inert]') === null ? 'live' : 'inert';
    });
    expect(covered).toBe('inert');

    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-pause')).toBeHidden(SETTLE);
    await advance(page, 4);
    const afterwards = await page.evaluate(() => {
      const element = document.querySelector('[data-pf="play-mirror"]');
      if (!(element instanceof HTMLElement)) {
        return 'missing';
      }
      return element.closest('[inert]') === null ? 'live' : 'inert';
    });
    expect(afterwards).toBe('live');
  });
});

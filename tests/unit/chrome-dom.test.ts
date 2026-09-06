import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { setVelocity } from '../../src/core/bodies';
import { FIXED_STEP } from '../../src/core/config';
import { createMatch } from '../../src/core/match';
import { set } from '../../src/core/vec2';
import { mountChrome } from '../../src/ui/layout';
import { censusControls, findAllByTag, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * Item M1's automated half: no pointer coordinate is hit-tested against a
 * chrome rectangle anywhere in the source, and the chrome builds no canvas.
 *
 * WHAT THE SCAN SEES. Two matchers over every file under src/. The first
 * catches a pointer coordinate read through its property form - event
 * handlers and captured pointer objects both read `event.clientX`, never a
 * bare identifier - and deliberately does NOT catch the bare local named
 * `offsetX` in the opponent routine, which is geometry, not a pointer. The
 * second catches the rectangle and point-dispatch queries a hand-rolled hit
 * test is built from. Both arms of the BlackJack defect this rule exists to
 * prevent: two overlapping rectangles consulted by hand, which a real
 * element hit-test cannot produce.
 *
 * THE EXEMPTION LISTS ARE PART OF THE GATE. They were empty until the
 * pointer aiming part, which earned exactly one entry: `render/input.ts`
 * owns the mapping from CSS pixels into the logical design space, so it
 * reads a pointer coordinate and the surface rectangle by design. It is
 * named here, in the same change that added it, and the inventory below
 * pins both lists by text AND by length, so a second site doing the same
 * thing reddens the suite rather than joining the list.
 *
 * A SCAN THAT CANNOT FAIL IS NOT A SCAN. The positive controls below prove
 * both matchers fire, including on the exact string a future hit test
 * would write; the negative control proves the opponent routine's bare
 * `offsetX` stays out of the report. The inventory at the end pins the
 * matchers, the controls and the empty exemptions as source, so an edit
 * that blinds the scan reddens the suite even though the tree it scans is
 * clean.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const SOURCE_ROOT = path.join(PROJECT_ROOT, 'src');
const THIS_FILE = path.resolve(fileURLToPath(import.meta.url));

const POINTER_COORDINATE = /\.(?:clientX|clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;
const RECT_HIT_TEST = /\b(?:getBoundingClientRect|getClientRects|elementFromPoint|elementsFromPoint)\b/;

/** Checked exemptions: a path may hold a pattern only by name, here. */
const EXEMPT_COORDINATE: readonly string[] = ['render/input.ts'];
const EXEMPT_RECT: readonly string[] = ['render/input.ts'];

/** Strings that must fire the coordinate matcher. */
const POSITIVE_COORDINATES: readonly string[] = [
  "canvas.addEventListener('pointermove', (event) => aim(event.clientX));",
  'const x = pointer.pageY;',
  'if (event.screenX > rect.left) {',
  'dragTo(event.offsetY);',
];

/** Strings that must fire the rectangle matcher. */
const POSITIVE_RECTANGLES: readonly string[] = [
  'const box = element.getBoundingClientRect();',
  'if (elementFromPoint(x, y) === panel) {',
  'const rects = node.getClientRects();',
  'overlayHitTest(node.elementsFromPoint(x, y));',
];

/** Strings that must stay out of the report. */
const NEGATIVE_CONTROLS: readonly string[] = [
  // The opponent routine's strike geometry: a bare local, not a pointer read.
  'const offsetX = striker.x - ball.x;',
  'const gap = Math.hypot(offsetX, offsetY);',
  // An identifier that merely contains one of the names.
  'const clientXPath = computePath();',
  'this.getBoundingClientRectCached = null;',
];

function walkSource(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSource(absolute, into);
      continue;
    }
    if (entry.isFile()) {
      into.push(absolute);
    }
  }
}

function filesMatching(pattern: RegExp, exempt: readonly string[]): string[] {
  const files: string[] = [];
  walkSource(SOURCE_ROOT, files);
  const hits: string[] = [];
  for (const absolute of files) {
    const relative = path.relative(SOURCE_ROOT, absolute).split(path.sep).join('/');
    if (exempt.includes(relative)) {
      continue;
    }
    if (pattern.test(readFileSync(absolute, 'utf8'))) {
      hits.push(relative);
    }
  }
  return hits.sort();
}

describe('PF-13 no chrome rectangle is ever hit-tested', () => {
  it('finds no pointer coordinate read under src/', () => {
    expect(filesMatching(POINTER_COORDINATE, EXEMPT_COORDINATE)).toEqual([]);
  });

  it('finds no rectangle or point-dispatch query under src/', () => {
    expect(filesMatching(RECT_HIT_TEST, EXEMPT_RECT)).toEqual([]);
  });

  it('finds neither pattern in the chrome, with no exemption possible', () => {
    const uiRoot = path.join(SOURCE_ROOT, 'ui');
    const files: string[] = [];
    walkSource(uiRoot, files);
    expect(files.length).toBeGreaterThan(0);
    for (const absolute of files) {
      const text = readFileSync(absolute, 'utf8');
      expect(POINTER_COORDINATE.test(text), path.relative(SOURCE_ROOT, absolute)).toBe(false);
      expect(RECT_HIT_TEST.test(text), path.relative(SOURCE_ROOT, absolute)).toBe(false);
    }
  });

  it('keeps the chrome free of renderer imports', () => {
    const uiRoot = path.join(SOURCE_ROOT, 'ui');
    const files: string[] = [];
    walkSource(uiRoot, files);
    for (const absolute of files) {
      const text = readFileSync(absolute, 'utf8');
      expect(/from\s+'[^']*render\//.test(text), path.relative(SOURCE_ROOT, absolute)).toBe(
        false,
      );
    }
  });

  it('fires on the strings a real hit test would write', () => {
    expect(POSITIVE_COORDINATES.length).toBeGreaterThanOrEqual(4);
    expect(POSITIVE_RECTANGLES.length).toBeGreaterThanOrEqual(4);
    for (const text of POSITIVE_COORDINATES) {
      expect(POINTER_COORDINATE.test(text), text).toBe(true);
    }
    for (const text of POSITIVE_RECTANGLES) {
      expect(RECT_HIT_TEST.test(text), text).toBe(true);
    }
  });

  it('leaves the strike geometry and plain identifiers alone', () => {
    for (const text of NEGATIVE_CONTROLS) {
      expect(POINTER_COORDINATE.test(text), text).toBe(false);
      expect(RECT_HIT_TEST.test(text), text).toBe(false);
    }
  });

  it('pins the matchers, the controls and the empty exemptions as source', () => {
    const source = readFileSync(THIS_FILE, 'utf8');
    expect(source).toContain(
      'const POINTER_COORDINATE = ' +
        String.raw`/\.(?:clientX|clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;`,
    );
    expect(source).toContain(
      'const RECT_HIT_TEST = ' +
        String.raw`/\b(?:getBoundingClientRect|getClientRects|elementFromPoint|elementsFromPoint)\b/;`,
    );
    expect(source).toContain(
      [
        "const EXEMPT_COORDINATE: readonly string[] = ['render/input.ts'];",
        "const EXEMPT_RECT: readonly string[] = ['render/input.ts'];",
      ].join('\n'),
    );
    // The exemption is exactly one module wide, and it is the one that owns
    // the pointer mapping. A second hit-test site is a defect and not a
    // second name here, so the lists are pinned by length as well as by text.
    expect(EXEMPT_COORDINATE).toEqual(['render/input.ts']);
    expect(EXEMPT_RECT).toEqual(['render/input.ts']);
    expect(NEGATIVE_CONTROLS).toHaveLength(4);
  });
});

describe('PF-13 the chrome is real DOM around the surface', () => {
  it('builds the whole chrome as elements, and not one of them is a canvas', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      mountChrome(host as unknown as HTMLElement, { match: createMatch(), onThemeChange: () => undefined });
      const root = host as unknown as FakeElement;
      expect(findAllByTag(root, 'CANVAS')).toEqual([]);
      expect(findAllByTag(root, 'BUTTON').length).toBeGreaterThan(0);
      expect(findAllByTag(root, 'INPUT').length).toBeGreaterThan(0);
      // The HUD leads the document; the canvas the surface part mounts later
      // lands after it in reading order.
      expect(root.children[0]).toBe(findByMarker(root, 'hud'));
    } finally {
      installed.restore();
    }
  });

  it('freezes the focusable controls of the whole chrome, all screens together', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      // The chrome as the composition root mounts it, mode menu included,
      // so the census describes the chrome the game actually ships. It grew
      // at PF-9 by SPEC section 13's three further game-over actions and by
      // SPEC section 9's menu, at PF-10 by SPEC section 17's Reset all
      // data and the two halves of its in-place confirmation, and at PF-14 by
      // SPEC section 2.1's portrait hint and the four play-surface sizes
      // QUALITY-BAR section 4 offers; nothing that was here was removed or
      // renamed at any of them.
      mountChrome(host as unknown as HTMLElement, {
        match: createMatch(),
        onThemeChange: () => undefined,
        modes: {
          initial: { kind: 'quick', duration: 60, difficulty: 'casual' },
          guideOn: true,
          onStart: () => undefined,
          onPlayAgain: () => undefined,
          onChangeMode: () => undefined,
          onNextOpponent: () => undefined,
          onRestartLadder: () => undefined,
          onHowToDismissed: () => undefined,
          ladderRung: () => 1,
          gameOver: () => ({ opponentName: 'Opponent' }),
        },
      });
      const census = censusControls(host as unknown as FakeElement);
      expect(census).toEqual([
        'Pause',
        'Dismiss',
        'Quick Match',
        'First to N',
        'Ladder',
        'Hotseat',
        '60 seconds',
        '90 seconds',
        '120 seconds',
        '3 goals',
        '5 goals',
        '7 goals',
        'Casual',
        'Pro',
        'Ace',
        'Aim guide',
        'Start',
        'How to play',
        'Resume',
        'Settings',
        'How to play',
        'Quit',
        'System',
        'Light',
        'Dark',
        '100%',
        '125%',
        '150%',
        '200%',
        'Reset all data',
        'Confirm reset',
        'Cancel reset',
        'Close',
        'Close',
        'Play Again',
        'Change mode',
        'Next opponent',
        'Restart ladder',
      ]);
    } finally {
      installed.restore();
    }
  });

  it('derives every panel from the readout, with no second copy of the state', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      const match = createMatch();
      const chrome = mountChrome(host as unknown as HTMLElement, { match, onThemeChange: () => undefined });
      const root = host as unknown as FakeElement;
      const pausePanel = findByMarker(root, 'panel-pause');
      const pauseControl = findByMarker(root, 'pause');

      // MENU at mount: the control is present and refused, no panel is open.
      expect(pauseControl?.getAttribute('aria-disabled')).toBe('true');
      expect(pausePanel?.hidden).toBe(true);

      match.dispatch({ kind: 'start' });
      chrome.sync();
      expect(pauseControl?.getAttribute('aria-disabled')).toBe('false');
      expect(pausePanel?.hidden).toBe(true);

      match.dispatch({ kind: 'pause' });
      chrome.sync();
      expect(pausePanel?.hidden).toBe(false);

      match.dispatch({ kind: 'resume' });
      chrome.sync();
      expect(pausePanel?.hidden).toBe(true);

      match.dispatch({ kind: 'pause' });
      chrome.sync();
      match.dispatch({ kind: 'quit' });
      chrome.sync();
      expect(pausePanel?.hidden).toBe(true);
      expect(pauseControl?.getAttribute('aria-disabled')).toBe('true');
    } finally {
      installed.restore();
    }
  });

  it('closes the pause stack with the pause, and keeps escape resuming after a sub-panel', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      const match = createMatch();
      const chrome = mountChrome(host as unknown as HTMLElement, {
        match,
        onThemeChange: () => undefined,
      });
      const root = host as unknown as FakeElement;
      const pausePanel = findByMarker(root, 'panel-pause');
      const settingsPanel = findByMarker(root, 'panel-settings');

      match.dispatch({ kind: 'start' });
      chrome.sync();
      match.dispatch({ kind: 'pause' });
      chrome.sync();
      expect(pausePanel?.hidden).toBe(false);

      // Open settings from the pause panel's own button, and put it away
      // with Escape: focus comes back to that button, inside the pause
      // panel, so the overlay beneath is still escapable.
      const pauseButtons = pausePanel === undefined ? [] : findAllByTag(pausePanel, 'BUTTON');
      expect(pauseButtons.map((button) => button.textContent)).toEqual([
        'Resume',
        'Settings',
        'How to play',
        'Quit',
      ]);
      pauseButtons[1]?.dispatch('click');
      expect(settingsPanel?.hidden).toBe(false);
      settingsPanel?.dispatch('keydown', { key: 'Escape' });
      expect(settingsPanel?.hidden).toBe(true);
      expect(installed.document.activeElement).toBe(pauseButtons[1]);

      // Resuming from beneath an open sub-panel closes the whole stack:
      // a settings overlay over a running match is a panel nobody opened.
      pauseButtons[1]?.dispatch('click');
      expect(settingsPanel?.hidden).toBe(false);
      const resumeButton = pauseButtons[0];
      resumeButton?.dispatch('click');
      expect(match.readout().state.kind).toBe('PLAYER_TURN');
      expect(pausePanel?.hidden).toBe(true);
      expect(settingsPanel?.hidden).toBe(true);
    } finally {
      installed.restore();
    }
  });

  it('hands focus back to the pause control when the game-over panel closes', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      const match = createMatch({ target: 1 });
      const chrome = mountChrome(host as unknown as HTMLElement, {
        match,
        onThemeChange: () => undefined,
      });
      const root = host as unknown as FakeElement;
      const gamePanel = findByMarker(root, 'panel-game-over');
      const pauseControl = findByMarker(root, 'pause');

      // Drive a real match to a deterministic first goal: the same helpers
      // the turn-flow tests use to set up a scenario place the ball before
      // the right mouth with the speed to finish the job.
      match.dispatch({ kind: 'start' });
      set(match.world.ball.position, 1100, 360);
      setVelocity(match.world.ball, 400, 0);
      let guard = 0;
      while (match.readout().state.kind !== 'GAME_OVER') {
        match.update(FIXED_STEP);
        guard += 1;
        if (guard > 100000) {
          throw new Error('the match never reached GAME_OVER');
        }
      }
      chrome.sync();
      expect(gamePanel?.hidden).toBe(false);
      expect(match.readout().scoring.player).toBe(1);
      expect(installed.document.activeElement?.textContent).toBe('Play Again');

      // Play Again restarts in place, the panel closes, and focus lands on
      // the stable pause control instead of dropping to the body.
      const playAgain = findAllByTag(gamePanel as FakeElement, 'BUTTON')[0];
      playAgain?.dispatch('click');
      expect(match.readout().state.kind).toBe('PLAYER_TURN');
      expect(gamePanel?.hidden).toBe(true);
      expect(installed.document.activeElement).toBe(pauseControl);
    } finally {
      installed.restore();
    }
  });

  it('writes the theme override where the stylesheet reads it, then clears it', () => {
    const installed = installFakeDocument();
    try {
      const host = installed.document.createElement('div');
      let reRendered = 0;
      mountChrome(host as unknown as HTMLElement, {
        match: createMatch(),
        onThemeChange: () => {
          reRendered += 1;
        },
      });
      const root = host as unknown as FakeElement;
      const inputs = findAllByTag(root, 'INPUT');
      // Seven from PF-14: the three theme radios, then the four play-surface
      // sizes. The theme group is still the first three and is named here, so
      // an index below cannot quietly land on a different control.
      expect(inputs).toHaveLength(7);
      expect(inputs.map((input) => input.getAttribute('aria-label'))).toEqual([
        'System',
        'Light',
        'Dark',
        '100%',
        '125%',
        '150%',
        '200%',
      ]);
      const radios = inputs.slice(0, 3);

      // A browser checks the radio before its change event arrives; the
      // dispatch below follows the same order.
      radios[1]!.checked = true;
      radios[1]?.dispatch('change');
      expect(installed.document.documentElement.dataset['theme']).toBe('light');
      expect(reRendered).toBe(1);

      radios[2]!.checked = true;
      radios[2]?.dispatch('change');
      expect(installed.document.documentElement.dataset['theme']).toBe('dark');
      expect(reRendered).toBe(2);

      radios[0]!.checked = true;
      radios[0]?.dispatch('change');
      expect(installed.document.documentElement.dataset['theme']).toBeUndefined();
      expect(reRendered).toBe(3);
    } finally {
      installed.restore();
    }
  });
});

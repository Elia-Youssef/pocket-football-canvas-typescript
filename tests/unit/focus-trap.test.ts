import { describe, expect, it } from 'vitest';

import { createMatch } from '../../src/core/match';
import { mountChrome } from '../../src/ui/layout';
import { chromeOptions, modeWiring } from './support/chrome-options';
import { findAllByTag, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * Item G9's trap, in the half a browser cannot see: WHICH elements the wiring
 * takes out of reach while an overlay is open, and in what ORDER it lets them
 * back in.
 *
 * WHY A UNIT TEST AS WELL AS A BROWSER ONE. `tests/browser/focus.spec.ts` walks
 * real Tab presses on three engines, which is the only honest way to grade
 * "traps focus" and is where the criterion is closed. What a Tab walk cannot
 * show is the stack: a trap built around the WRONG panel still traps, and a
 * trap that let the opener stay inert while focus went back to it drops focus on
 * the document body in a way that looks, from the outside, exactly like a panel
 * closing. Both of those are decisions in `ui/layout.ts` and both are asserted
 * here over the element set itself.
 *
 * THE ORDERING CLAUSE IS NOT THEORETICAL. Three keyboard tests failed on it
 * before the wiring learned to lift the trap first, and the failure was silent:
 * `focus()` on an inert element does nothing at all and reports nothing.
 */

/** The two elements standing in for the column the composition root mounts. */
interface Rig {
  readonly host: FakeElement;
  readonly chrome: ReturnType<typeof mountChrome>;
  readonly match: ReturnType<typeof createMatch>;
  readonly background: readonly FakeElement[];
  readonly document: ReturnType<typeof installFakeDocument>['document'];
  readonly close: () => void;
}

function rig(): Rig {
  const installed = installFakeDocument();
  const host = installed.document.createElement('div');
  const stage = installed.document.createElement('div');
  stage.dataset['pf'] = 'stage';
  const aimRow = installed.document.createElement('div');
  aimRow.dataset['pf'] = 'aim-controls';
  host.appendChild(stage);
  host.appendChild(aimRow);
  const match = createMatch({ target: 1 });
  const chrome = mountChrome(
    host as unknown as HTMLElement,
    chromeOptions({
      match,
      background: [stage as unknown as HTMLElement, aimRow as unknown as HTMLElement],
      modes: modeWiring(),
    }),
  );
  return {
    host,
    chrome,
    match,
    background: [stage, aimRow],
    document: installed.document,
    close: installed.restore,
  };
}

function panel(host: FakeElement, marker: string): FakeElement {
  const found = findByMarker(host, marker);
  if (found === undefined) {
    throw new Error(`the chrome carries no ${marker}`);
  }
  return found;
}

/** Every element the trap decides about, named so a failure says which. */
function inertState(harness: Rig): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const marker of [
    'hud',
    'portrait-hint',
    'stage',
    'aim-controls',
    'panel-mode',
    'panel-pause',
    'panel-settings',
    'panel-how-to-play',
    'panel-game-over',
  ]) {
    state[marker] = panel(harness.host, marker).inert;
  }
  return state;
}

describe('PF-15 the focus trap, item G9', () => {
  it('leaves the whole column reachable while no overlay is open', () => {
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      expect(harness.chrome.modalMarker()).toBeNull();
      for (const [marker, inert] of Object.entries(inertState(harness))) {
        expect(inert, marker).toBe(false);
      }
    } finally {
      harness.close();
    }
  });

  it('takes everything but the open overlay out of reach', () => {
    const harness = rig();
    try {
      // The menu is open at mount, which is the state a first launch lands in.
      expect(harness.chrome.modalMarker()).toBe('panel-mode');
      expect(inertState(harness)).toEqual({
        hud: true,
        'portrait-hint': true,
        stage: true,
        'aim-controls': true,
        'panel-mode': false,
        'panel-pause': true,
        'panel-settings': true,
        'panel-how-to-play': true,
        'panel-game-over': true,
      });
    } finally {
      harness.close();
    }
  });

  it('follows the stack when one overlay opens over another', () => {
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      expect(harness.chrome.modalMarker()).toBe('panel-pause');
      expect(panel(harness.host, 'panel-pause').inert).toBe(false);

      // Settings opens from the pause panel's own button and sits above it.
      const buttons = findAllByTag(panel(harness.host, 'panel-pause'), 'BUTTON');
      buttons[1]?.dispatch('click');
      expect(harness.chrome.modalMarker()).toBe('panel-settings');
      expect(panel(harness.host, 'panel-settings').inert).toBe(false);
      // The panel UNDERNEATH is background now, which is the clause a trap
      // built around the bottom of the stack would get wrong.
      expect(panel(harness.host, 'panel-pause').inert).toBe(true);
      expect(panel(harness.host, 'hud').inert).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('lifts the trap off a control before it hands focus back to it', () => {
    // THE ORDERING CLAUSE. `focus()` on an inert element does nothing and says
    // nothing, so a panel that restored focus before the trap came off would
    // drop focus on the document body every time it closed.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      const pausePanel = panel(harness.host, 'panel-pause');
      const buttons = findAllByTag(pausePanel, 'BUTTON');
      const settingsButton = buttons[1];
      settingsButton?.dispatch('click');

      // Escape closes settings and hands focus back to the button that opened
      // it, which is inside the pause panel and has to be live by then.
      panel(harness.host, 'panel-settings').dispatch('keydown', { key: 'Escape' });
      expect(panel(harness.host, 'panel-settings').hidden).toBe(true);
      // That focus ARRIVED is the whole assertion: the fake document refuses
      // `focus()` inside an inert subtree the way the platform does, so an
      // opener still trapped leaves `activeElement` where it was. An
      // `expect(active.inert).toBe(false)` beside it would be a fact about the
      // control rather than about the trap, since `inert` is only ever written
      // to panel roots and background elements.
      expect(harness.document.activeElement).toBe(settingsButton);
      // And the stack settles back around the panel underneath.
      expect(harness.chrome.modalMarker()).toBe('panel-pause');
      expect(pausePanel.inert).toBe(false);
      expect(panel(harness.host, 'hud').inert).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('lifts the trap off an overlay before it takes focus itself', () => {
    // The same rule read the other way round: a panel opening from inside
    // another one was that one's background a moment ago and is still inert,
    // so its own first control would be refused the focus it is given.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      const buttons = findAllByTag(panel(harness.host, 'panel-pause'), 'BUTTON');
      buttons[1]?.dispatch('click');
      const active = harness.document.activeElement;
      // The settings panel puts focus on its first TAB STOP, which is the
      // checked theme radio; `chrome-panels.test.ts` freezes that list. The fake
      // document refuses focus inside an inert subtree, so arriving here at all
      // is the assertion: without the lift, focus would still be on the pause
      // panel's Settings button.
      expect(active).not.toBe(buttons[1]);
      expect(active?.parentElement?.textContent).toBe('System');
    } finally {
      harness.close();
    }
  });

  it('brings focus back to the menu control that opened How to play', () => {
    // THE ONE RESTORE ROUTE NOTHING COVERED. Every other invoker in `layout.ts`
    // is found by its stable marker and asserted somewhere; the menu's was the
    // last control in the panel's list, which is the How to play button only
    // for as long as nothing is added after it. It is by marker now, and this is
    // the walk that says which control focus comes back to.
    const harness = rig();
    try {
      harness.chrome.sync();
      const menu = panel(harness.host, 'panel-mode');
      expect(menu.hidden).toBe(false);
      const opener = panel(menu, 'mode-how-to');
      opener.dispatch('click');
      const howTo = panel(harness.host, 'panel-how-to-play');
      expect(howTo.hidden).toBe(false);

      howTo.dispatch('keydown', { key: 'Escape' });
      expect(howTo.hidden).toBe(true);
      expect(harness.document.activeElement).toBe(opener);
      // And the menu underneath is live again, which is what makes that focus
      // move possible at all.
      expect(menu.inert).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('puts the tab boundary on the checked member of a radio group', () => {
    // FOUND BY THE ADVERSARIAL PASS, AND REACHABLE BY A RETURNING PLAYER. HTML's
    // radio button group rule puts the CHECKED member of a named group in
    // sequential focus order and moves between the rest with the arrows, so a
    // boundary taken from the order the panel was built in names an element the
    // platform never focuses. With Dark stored, a Shift+Tab on `theme-dark` was
    // compared against `theme-system`, matched neither end, fell through to the
    // platform, and left the overlay for the document body with the whole column
    // around it inert: a trap with a hole in it, and the stored choice is
    // exactly what a returning player opens Settings with.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      findAllByTag(panel(harness.host, 'panel-pause'), 'BUTTON')[1]?.dispatch('click');

      const settings = panel(harness.host, 'panel-settings');
      const system = panel(settings, 'theme-system');
      const dark = panel(settings, 'theme-dark');
      const close = panel(settings, 'settings-close');
      // What a click on Dark leaves behind: the platform moves `checked` within
      // the group, and nothing else about the panel changes.
      system.checked = false;
      dark.checked = true;

      dark.focus();
      expect(harness.document.activeElement).toBe(dark);
      let prevented = 0;
      settings.dispatch('keydown', {
        key: 'Tab',
        shiftKey: true,
        preventDefault: () => {
          prevented += 1;
        },
      });
      expect(prevented).toBe(1);
      expect(harness.document.activeElement).toBe(close);

      // And forwards off the last control, the cycle comes back to the checked
      // radio rather than to the first one in the group.
      settings.dispatch('keydown', {
        key: 'Tab',
        shiftKey: false,
        preventDefault: () => {
          prevented += 1;
        },
      });
      expect(prevented).toBe(2);
      expect(harness.document.activeElement).toBe(dark);
    } finally {
      harness.close();
    }
  });

  it('gives the whole column back when the last overlay closes', () => {
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      expect(harness.chrome.modalMarker()).toBe('panel-pause');

      harness.match.dispatch({ kind: 'resume' });
      harness.chrome.sync();
      expect(harness.chrome.modalMarker()).toBeNull();
      for (const [marker, inert] of Object.entries(inertState(harness))) {
        expect(inert, marker).toBe(false);
      }
    } finally {
      harness.close();
    }
  });

  it('closes the whole pause stack and leaves nothing inert behind it', () => {
    // The pause stack closes with the pause, whatever dismissed it, and three
    // panels can close in one sync. A trap reapplied per close rather than from
    // the settled stack would leave one of them inert over a running match.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      const buttons = findAllByTag(panel(harness.host, 'panel-pause'), 'BUTTON');
      buttons[1]?.dispatch('click');
      expect(harness.chrome.modalMarker()).toBe('panel-settings');

      harness.match.dispatch({ kind: 'resume' });
      harness.chrome.sync();
      expect(panel(harness.host, 'panel-settings').hidden).toBe(true);
      expect(panel(harness.host, 'panel-pause').hidden).toBe(true);
      expect(harness.chrome.modalMarker()).toBeNull();
      for (const [marker, inert] of Object.entries(inertState(harness))) {
        expect(inert, marker).toBe(false);
      }
    } finally {
      harness.close();
    }
  });

  it('writes the trap on an edge and not on every sync', () => {
    // `inert` changes what assistive technology can see, so a per-frame
    // assignment is a per-frame tree change; the chrome syncs sixty times a
    // second. The count is the assertion, because a state that is correct and
    // rewritten constantly looks identical to one that is not.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      const hud = panel(harness.host, 'hud');
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      expect(hud.inert).toBe(true);
      const writes = harness.host.attributeWrites;
      for (let at = 0; at < 60; at += 1) {
        harness.chrome.sync();
      }
      expect(hud.inert).toBe(true);
      expect(harness.host.attributeWrites).toBe(writes);
    } finally {
      harness.close();
    }
  });

  it('names the three dismissible overlays, and the two that are not', () => {
    // The criterion says Escape dismisses every DISMISSIBLE overlay, so which
    // ones those are is part of the claim rather than an implementation detail.
    // The menu has nothing to go back to and SPEC section 13's game-over panel
    // offers four ways back in, so neither answers Escape at all.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      const pausePanel = panel(harness.host, 'panel-pause');

      for (const [open, marker] of [
        [1, 'panel-settings'],
        [2, 'panel-how-to-play'],
      ] as const) {
        findAllByTag(pausePanel, 'BUTTON')[open]?.dispatch('click');
        expect(panel(harness.host, marker).hidden, marker).toBe(false);
        panel(harness.host, marker).dispatch('keydown', { key: 'Escape' });
        expect(panel(harness.host, marker).hidden, marker).toBe(true);
        expect(pausePanel.hidden, marker).toBe(false);
      }

      // The third answers Escape with a resume, because the panel IS the pause.
      pausePanel.dispatch('keydown', { key: 'Escape' });
      expect(harness.match.readout().state.kind).toBe('PLAYER_TURN');
      harness.chrome.sync();
      expect(pausePanel.hidden).toBe(true);

      // And the two that are not: Escape leaves each of them where it was.
      // SPEC section 7's chart takes a quit from PAUSED, so the match is paused
      // again on the way to the menu rather than quit out of a live turn.
      harness.match.dispatch({ kind: 'pause' });
      harness.match.dispatch({ kind: 'quit' });
      harness.chrome.sync();
      const menu = panel(harness.host, 'panel-mode');
      expect(menu.hidden).toBe(false);
      menu.dispatch('keydown', { key: 'Escape' });
      expect(menu.hidden).toBe(false);
      expect(harness.match.readout().state.kind).toBe('MENU');
    } finally {
      harness.close();
    }
  });

  it('wraps a Tab at either end of the open overlay back into it', () => {
    // NATIVE INERT DOES NOT CLOSE THE CYCLE, which is the measured reason this
    // handler exists at all: with the whole column inert, a Tab at the last
    // control still moves focus to the DOCUMENT, and the walk out of an open
    // overlay lands on `<body>` before coming back. Item C12's own clause is
    // that no state change leaves focus on the document body.
    const harness = rig();
    try {
      harness.match.dispatch({ kind: 'start' });
      harness.chrome.sync();
      harness.match.dispatch({ kind: 'pause' });
      harness.chrome.sync();
      const pausePanel = panel(harness.host, 'panel-pause');
      const buttons = findAllByTag(pausePanel, 'BUTTON');
      expect(buttons).toHaveLength(4);
      const first = buttons[0];
      const last = buttons[3];

      let prevented = 0;
      const tab = (shiftKey: boolean): void => {
        pausePanel.dispatch('keydown', {
          key: 'Tab',
          shiftKey,
          preventDefault: () => {
            prevented += 1;
          },
        });
      };

      // Forward from the last control comes back to the first.
      last?.focus();
      tab(false);
      expect(harness.document.activeElement).toBe(first);
      // Backward from the first goes to the last.
      tab(true);
      expect(harness.document.activeElement).toBe(last);
      expect(prevented).toBe(2);

      // And in the middle of the walk the handler does nothing at all, so the
      // platform keeps deciding the order: only the two boundaries are ours.
      buttons[1]?.focus();
      tab(false);
      expect(harness.document.activeElement).toBe(buttons[1]);
      tab(true);
      expect(harness.document.activeElement).toBe(buttons[1]);
      expect(prevented).toBe(2);
    } finally {
      harness.close();
    }
  });
});

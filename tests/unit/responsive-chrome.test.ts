import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createMatch } from '../../src/core/match';
import { NEW_SETTINGS, SURFACE_SCALES } from '../../src/core/storage';
import { BREAKPOINTS } from '../../src/ui/breakpoints';
import { createPortraitHint } from '../../src/ui/components/portrait-hint';
import { mountChrome } from '../../src/ui/layout';
import { FakeText, censusControls, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * Items F1, F3, F4 and F6, the half automation can reach without a browser:
 * the chrome the responsive arrangement adds, and the stylesheet rules that
 * arrangement is made of.
 *
 * THE HINT IS A BAR IN THE FLOW AND THE STYLESHEET IS WHERE THAT IS TRUE, so
 * this file reads chrome.css as text as well as building the chrome. A
 * property that only a browser can measure is graded in the browser specs
 * beside these; what is pinned here is everything a document-level test can
 * see, which is most of it: the element exists, it is not an overlay, the
 * dismissal is the hidden attribute, the insets are added where the controls
 * are, and no threshold has crept back into a media query.
 *
 * ARMOUR, NOT CLOSURE, FOR ITEM F4. The safe-area insets close by the scripted
 * capture at the demonstration session, on a device that has a notch. What is
 * here is the machinery that capture will exercise: the four reads, and every
 * bar and panel that adds them.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const STYLESHEET = path.join(PROJECT_ROOT, 'src', 'ui', 'components', 'chrome.css');
const ENTRY = path.join(PROJECT_ROOT, 'src', 'main.ts');

const stylesheetText = readFileSync(STYLESHEET, 'utf8');
const entryText = readFileSync(ENTRY, 'utf8');

/** Comments removed, so a rule quoted in prose is not read as a rule. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const CSS = withoutComments(stylesheetText);

/** Every rule whose selector matches, as the block text between its braces. */
function rulesFor(selector: string): string[] {
  const found: string[] = [];
  for (const block of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((block[1] ?? '').includes(selector)) {
      found.push(block[2] ?? '');
    }
  }
  return found;
}

/** True where some rule matching the selector carries the declaration. */
function declares(selector: string, declaration: string): boolean {
  return rulesFor(selector).some((body) => body.includes(declaration));
}

/**
 * The one rule whose selector is EXACTLY this, which is what an inset
 * assertion needs: `.pf-hud` also appears in four other selectors, and a
 * per-breakpoint rule carrying the same inset would answer for the base rule
 * that had stopped carrying it.
 */
function ruleFor(selector: string): string {
  for (const block of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((block[1] ?? '').trim() === selector) {
      return block[2] ?? '';
    }
  }
  throw new Error(`the stylesheet has no rule for exactly ${JSON.stringify(selector)}`);
}

function declaresInset(selector: string, inset: string): boolean {
  return ruleFor(selector).includes(`var(--pf-safe-${inset})`);
}

describe('PF-14 the responsive chrome', () => {
  describe('SPEC section 2.1 s portrait hint', () => {
    it('is a bar with a line of text and one control, and nothing else', () => {
      const installed = installFakeDocument();
      try {
        const hint = createPortraitHint({ onDismiss: () => undefined });
        const root = hint.root as unknown as FakeElement;
        expect(root.className).toBe('pf-portrait-hint');
        expect(root.dataset['pf']).toBe('portrait-hint');
        // Not a panel: an overlay is what would cover a control, and the
        // panel frame is what every overlay in this chrome is built from.
        expect(root.className).not.toContain('pf-panel');
        expect(censusControls(root)).toEqual(['Dismiss']);
        const line = findByMarker(root, 'hint-text');
        expect(line?.tagName).toBe('P');
        // It suggests and it does not instruct: SPEC section 2.1 refuses to
        // gate play on orientation, so the line has to say the game plays.
        expect(line?.textContent).toContain('Rotate');
        expect(line?.textContent).toContain('plays fully in portrait');
      } finally {
        installed.restore();
      }
    });

    it('shows until it is put away, and says so through the hidden attribute', () => {
      const installed = installFakeDocument();
      try {
        let dismissals = 0;
        const hint = createPortraitHint({
          onDismiss: () => {
            dismissals += 1;
          },
        });
        const root = hint.root as unknown as FakeElement;
        expect(root.hidden).toBe(false);
        expect(hint.isDismissed()).toBe(false);
        findByMarker(root, 'hint-dismiss')?.dispatch('click');
        expect(root.hidden).toBe(true);
        expect(hint.isDismissed()).toBe(true);
        expect(dismissals).toBe(1);
        // And it can be put back without raising the callback, which is what
        // Reset all data does: the store is what remembers, not the control.
        hint.setDismissed(false);
        expect(hint.isDismissed()).toBe(false);
        expect(dismissals).toBe(1);
      } finally {
        installed.restore();
      }
    });

    it('mounts between the HUD and the play surface, in the flow', () => {
      const installed = installFakeDocument();
      try {
        const host = installed.document.createElement('div');
        // A stand-in for the surface the composition root mounts first, so
        // the assertion is about the order the hint takes among siblings.
        const stage = installed.document.createElement('div');
        stage.dataset['pf'] = 'stage';
        host.appendChild(stage);
        mountChrome(host as unknown as HTMLElement, {
          match: createMatch(),
          onThemeChange: () => undefined,
        });
        const order = host.children.map((child) =>
          child instanceof FakeText ? '' : (child.dataset['pf'] ?? ''),
        );
        expect(order.slice(0, 3)).toEqual(['hud', 'portrait-hint', 'stage']);
      } finally {
        installed.restore();
      }
    });

    it('opens on the dismissal the store hands it, and reports the next one', () => {
      const installed = installFakeDocument();
      try {
        const host = installed.document.createElement('div');
        let dismissed = 0;
        mountChrome(host as unknown as HTMLElement, {
          match: createMatch(),
          onThemeChange: () => undefined,
          hintDismissed: true,
          onHintDismissed: () => {
            dismissed += 1;
          },
        });
        const root = host as unknown as FakeElement;
        expect(findByMarker(root, 'portrait-hint')?.hidden).toBe(true);
        expect(dismissed).toBe(0);
      } finally {
        installed.restore();
      }
    });
  });

  describe('QUALITY-BAR section 4 s play-surface size control', () => {
    it('offers the four sizes the stored settings name, and no others', () => {
      const installed = installFakeDocument();
      try {
        const host = installed.document.createElement('div');
        mountChrome(host as unknown as HTMLElement, {
          match: createMatch(),
          onThemeChange: () => undefined,
        });
        const root = host as unknown as FakeElement;
        expect(SURFACE_SCALES).toEqual([100, 125, 150, 200]);
        for (const percent of SURFACE_SCALES) {
          const radio = findByMarker(root, `surface-scale-${String(percent)}`);
          expect(radio?.tagName, String(percent)).toBe('INPUT');
          expect(radio?.type, String(percent)).toBe('radio');
          expect(radio?.getAttribute('name'), String(percent)).toBe('pf-surface-scale');
          expect(radio?.getAttribute('aria-label'), String(percent)).toBe(
            `${String(percent)}%`,
          );
        }
        expect(findByMarker(root, 'surface-scale-175')).toBeUndefined();
      } finally {
        installed.restore();
      }
    });

    it('opens on the stored size and raises the one that is chosen', () => {
      const installed = installFakeDocument();
      try {
        const host = installed.document.createElement('div');
        const raised: number[] = [];
        mountChrome(host as unknown as HTMLElement, {
          match: createMatch(),
          onThemeChange: () => undefined,
          initialSurfaceScale: 150,
          onSurfaceScaleChange: (percent) => raised.push(percent),
        });
        const root = host as unknown as FakeElement;
        expect(findByMarker(root, 'surface-scale-150')?.checked).toBe(true);
        expect(findByMarker(root, 'surface-scale-100')?.checked).toBe(false);
        // Opening on a stored value raises nothing: a control that announced
        // a change at mount would write the document on every load.
        expect(raised).toEqual([]);
        const chosen = findByMarker(root, 'surface-scale-200');
        if (chosen === undefined) {
          throw new Error('the settings panel offers no 200 percent size');
        }
        chosen.checked = true;
        chosen.dispatch('change');
        expect(raised).toEqual([200]);
        // The radio that was cleared raises nothing when it is told so.
        const cleared = findByMarker(root, 'surface-scale-150');
        if (cleared === undefined) {
          throw new Error('the settings panel offers no 150 percent size');
        }
        cleared.checked = false;
        cleared.dispatch('change');
        expect(raised).toEqual([200]);
      } finally {
        installed.restore();
      }
    });

    it('puts the size and the hint back when the data is reset', () => {
      const installed = installFakeDocument();
      try {
        const host = installed.document.createElement('div');
        const raised: number[] = [];
        let cleared = 0;
        mountChrome(host as unknown as HTMLElement, {
          match: createMatch(),
          onThemeChange: () => undefined,
          initialSurfaceScale: 200,
          hintDismissed: true,
          onSurfaceScaleChange: (percent) => raised.push(percent),
          onResetData: () => {
            cleared += 1;
          },
        });
        const root = host as unknown as FakeElement;
        expect(findByMarker(root, 'portrait-hint')?.hidden).toBe(true);
        findByMarker(root, 'reset-data')?.dispatch('click');
        findByMarker(root, 'reset-confirm')?.dispatch('click');
        expect(cleared).toBe(1);
        // The new-player value, taken from the stored settings rather than
        // written here a second time.
        expect(raised).toEqual([NEW_SETTINGS.surfaceScale]);
        expect(NEW_SETTINGS.surfaceScale).toBe(100);
        expect(findByMarker(root, 'surface-scale-100')?.checked).toBe(true);
        expect(findByMarker(root, 'surface-scale-200')?.checked).toBe(false);
        expect(findByMarker(root, 'portrait-hint')?.hidden).toBe(false);
      } finally {
        installed.restore();
      }
    });
  });

  describe('the stylesheet carries the arrangement and no thresholds', () => {
    it('declares no width or height media query at all', () => {
      // The breakpoints are resolved in ui/breakpoints.ts and pinned to the
      // design contract; a media query here would carry the same numbers
      // where nothing can read them back.
      expect(CSS).not.toMatch(/@media[^{]*\b(?:min|max)-(?:width|height)\b/);
      // The control, so a matcher that has stopped matching cannot report a
      // clean stylesheet forever.
      expect('@media (max-width: 767px) { .a { color: red; } }').toMatch(
        /@media[^{]*\b(?:min|max)-(?:width|height)\b/,
      );
      expect(CSS.length).toBeGreaterThan(0);
    });

    it('selects on the names the composition root writes, and only those', () => {
      const breakpoints = [...CSS.matchAll(/data-pf-breakpoint='([a-z]+)'/g)].map(
        (match) => match[1] ?? '',
      );
      const bars = [...CSS.matchAll(/data-pf-bars='([a-z]+)'/g)].map((match) => match[1] ?? '');
      expect(breakpoints.length).toBeGreaterThan(0);
      expect(bars.length).toBeGreaterThan(0);
      for (const name of breakpoints) {
        expect(BREAKPOINTS, name).toContain(name);
      }
      for (const name of bars) {
        expect(['sticky', 'static'], name).toContain(name);
      }
      // Portrait is the one breakpoint with a rule nothing else has, because
      // it is where SPEC section 2.1's hint is shown, and the rule that shows
      // it is keyed on that name and no other.
      expect(breakpoints).toContain('portrait');
      const shown = /:root\[data-pf-breakpoint='([a-z]+)'\] \.pf-portrait-hint/.exec(CSS);
      expect(shown?.[1]).toBe('portrait');
      // And the root writes both attributes, under the dataset spelling of
      // the same two names, so a rename in either file fails here.
      expect(entryText).toContain("root.dataset['pfBreakpoint']");
      expect(entryText).toContain("root.dataset['pfBars']");
    });

    it('sticks both bars above the threshold and neither below it', () => {
      const stuck = rulesFor("[data-pf-bars='sticky']");
      expect(stuck).toHaveLength(2);
      for (const body of stuck) {
        expect(body).toContain('position: sticky');
      }
      expect(declares("[data-pf-bars='sticky'] .pf-hud", 'inset-block-start: 0')).toBe(true);
      expect(declares("[data-pf-bars='sticky'] .pf-aim-controls", 'inset-block-end: 0')).toBe(
        true,
      );
      // Nothing is sticky outside that rule: a bar that stuck unconditionally
      // would consume a 256 px viewport whatever the attribute said.
      expect([...CSS.matchAll(/position:\s*sticky/g)]).toHaveLength(2);
      // Below the threshold the stage takes a viewport of its own instead, so
      // the bars scroll away rather than standing over the pitch.
      expect(declares("[data-pf-bars='static'] .pf-stage", 'min-block-size: 100dvh')).toBe(true);
    });

    it('keeps the play frame box-free and the overlays above the bars', () => {
      // QUALITY-BAR section 7: the frame around the canvas carries no box, or
      // the coordinate chain moves under the pointer mapping.
      const frame = ruleFor('.pf-play-frame');
      expect(frame).toContain('line-height: 0');
      expect(frame).not.toMatch(/\bborder\b/);
      expect(frame).not.toMatch(/\bpadding\b/);
      expect(frame).not.toMatch(/\btransform\b/);
      // A sticky bar painted over an open panel would be a control covering a
      // control, so the overlays sit above them.
      expect(declares('.pf-panel:not([hidden])', 'z-index: 2')).toBe(true);
      for (const body of rulesFor("[data-pf-bars='sticky']")) {
        expect(body).toContain('z-index: 1');
      }
    });

    it('reads all four safe-area insets, once, where viewport-fit can answer them', () => {
      for (const inset of ['top', 'right', 'bottom', 'left']) {
        expect(CSS, inset).toContain(`--pf-safe-${inset}: env(safe-area-inset-${inset})`);
        // Once, in one rule: a second read somewhere else is a second place
        // for the value to be got wrong, and the bars consume the property.
        expect(
          [...CSS.matchAll(new RegExp(`env\\(safe-area-inset-${inset}\\)`, 'g'))],
          inset,
        ).toHaveLength(1);
      }
    });

    it('adds the insets to every bar and panel that carries a control', () => {
      // Item F4's clause is about CONTROLS, and every control in this chrome
      // is in one of these three: the HUD, the aim row, or an overlay panel.
      expect(declaresInset('.pf-hud', 'top')).toBe(true);
      expect(declaresInset('.pf-hud', 'left')).toBe(true);
      expect(declaresInset('.pf-hud', 'right')).toBe(true);
      expect(declaresInset('.pf-aim-controls:not([hidden])', 'bottom')).toBe(true);
      expect(declaresInset('.pf-aim-controls:not([hidden])', 'left')).toBe(true);
      expect(declaresInset('.pf-aim-controls:not([hidden])', 'right')).toBe(true);
      for (const inset of ['top', 'right', 'bottom', 'left']) {
        expect(declaresInset('.pf-panel:not([hidden])', inset), inset).toBe(true);
      }
      // The control: a selector with no inset at all answers false, so the
      // helper is not reporting true for everything.
      expect(declaresInset('.pf-score', 'top')).toBe(false);
    });

    it('wraps the HUD rather than letting it overflow a narrow viewport', () => {
      // Item F2 is about the PAGE never scrolling sideways, and a single-line
      // bar of five readouts is the one element that would make it.
      expect(declares('.pf-hud', 'flex-wrap: wrap')).toBe(true);
      expect(declares('.pf-aim-controls:not([hidden])', 'flex-wrap: wrap')).toBe(true);
      expect(declares('.pf-portrait-hint:not([hidden])', 'flex-wrap: wrap')).toBe(true);
      // The aim ROW as well as the bar around it. Measured at 320 css pixels:
      // a stepper's label is a phrase, so the row's min-content width is wider
      // than the viewport and a flex item is never shrunk below that.
      expect(declares('.pf-aim-row:not([hidden])', 'flex-wrap: wrap')).toBe(true);
    });

    it('ties the class and attribute names to the composition root that writes them', () => {
      // The stylesheet and the root decide the same facts in two files, and a
      // class renamed in one of them is a layout that quietly stops applying.
      // This is the same tie render-surface.test.ts keeps for the theme query.
      expect(entryText).toContain("host.className = 'pf-app'");
      expect(entryText).toContain("stage.className = 'pf-stage'");
      expect(declares('.pf-app', 'flex-direction: column')).toBe(true);
      expect(declares('.pf-stage', 'position: relative')).toBe(true);
      // The two axes are answered separately, and each one anchors and scrolls
      // only where it overflows. The VALUES are tied here as well as the
      // names, because an inverted ternary is a single edit and would leave a
      // magnified pitch centred, with its start edge out of reach.
      expect(entryText).toContain("frame.dataset['pfFitX'] = over.across ? 'over' : 'fit';");
      expect(entryText).toContain("frame.dataset['pfFitY'] = over.down ? 'over' : 'fit';");
      expect(ruleFor(".pf-play-frame[data-pf-fit-x='over']")).toContain('justify-content: start');
      expect(ruleFor(".pf-play-frame[data-pf-fit-x='over']")).toContain('overflow-x: auto');
      expect(ruleFor(".pf-play-frame[data-pf-fit-y='over']")).toContain('align-content: start');
      expect(ruleFor(".pf-play-frame[data-pf-fit-y='over']")).toContain('overflow-y: auto');
      // And the base rule centres both and scrolls in neither, so a fraction
      // of a pixel of rounding cannot raise a scrollbar over a fitted pitch.
      expect(ruleFor('.pf-play-frame')).toContain('justify-content: center');
      expect(ruleFor('.pf-play-frame')).toContain('align-content: center');
      expect(ruleFor('.pf-play-frame')).toContain('overflow: hidden');
      // The two viewport reads, in the order the resolution rule takes them:
      // by width first, then height, which is what QUALITY-BAR section 5 asks
      // and what a swapped pair would silently invert. The sticky ternary is
      // tied whole for the same reason the fit ones are.
      expect(entryText).toContain('breakpointFor(window.innerWidth, window.innerHeight)');
      expect(entryText).toContain(
        "root.dataset['pfBars'] = barsStick(window.innerHeight) ? 'sticky' : 'static';",
      );
      // The fit is called with the box the root measured and the size the
      // store handed it. Both arguments are wiring no unit test can mount.
      expect(entryText).toContain('fitCssWidth(width, height, sizePercent)');
      // And the frame follows the play while it is magnified, because the
      // canvas has claimed both gestures that could otherwise pan it: the
      // circle that is about to launch while an aim can be taken, the ball at
      // every other moment.
      expect(entryText).toContain('frame.scrollLeft = at.left;');
      expect(entryText).toContain('frame.scrollTop = at.top;');
      expect(entryText).toContain(
        'const watched = input.allowed() ? context.aimWorld.player : world.ball;',
      );
    });
  });
});

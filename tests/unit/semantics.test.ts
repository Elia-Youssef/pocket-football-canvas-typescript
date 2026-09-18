import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ASSERTIVE_MARKER, POLITE_MARKER } from '../../src/ui/live-region';
import { MIRROR_MARKER } from '../../src/ui/components/play-mirror';

/**
 * Item G7: the document sets `lang`, exposes a single `h1`, uses meaningful
 * landmarks, and its title reflects the current state.
 *
 * THREE OF THE FOUR ARE PROPERTIES OF A STATIC FILE, so they are graded over
 * that file. `index.html` is the shipped document: it is what a browser parses
 * before a line of script runs, and it is where QUALITY-BAR section 4 requires
 * both live-region elements to be. The fourth clause, the title, is behaviour
 * and is graded in `play-mirror.test.ts` against the derivation and the root.
 *
 * WHY NOT LEAVE IT TO THE SCANNER. An automated scan is necessary and not
 * sufficient (QUALITY-BAR section 4), and on this page it is less than that:
 * every landmark and heading rule in the scanner is best-practice tagged, so
 * none of them runs under the WCAG 2.2 A and AA tag set item G1 is written
 * against. `tests/browser/axe.spec.ts` pins that taxonomy by rule id; this file
 * is what actually holds the structure in place.
 *
 * IT READS THE FILE AS TEXT and says so plainly, the way the workflow and
 * browser-gate inventories do: there is no parser here, a reflow can break an
 * assertion, and the break is loud and one line to fix. That is the price of
 * grading a document whose failure mode is a page that still works.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

function read(relative: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
}

const DOCUMENT = read('index.html');
const CHROME_CSS = read('src/ui/components/chrome.css');
const PANEL = read('src/ui/components/panel.ts');

/** Markup with the comments taken out: prose is not structure. */
const MARKUP = DOCUMENT.replace(/<!--[\s\S]*?-->/g, '');

/** Every opening tag in the markup, in document order. */
function tags(source: string): string[] {
  return [...source.matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((match) =>
    (match[0].startsWith('</') ? `/${match[1] ?? ''}` : (match[1] ?? '')).toLowerCase(),
  );
}

/** The one CSS rule body for a selector, comments removed. */
function ruleFor(selector: string): string {
  const source = CHROME_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const at = source.indexOf(`${selector} {`);
  if (at === -1) {
    throw new Error(`the chrome stylesheet has no rule for ${selector}`);
  }
  const open = source.indexOf('{', at);
  return source.slice(open + 1, source.indexOf('}', open));
}

describe('PF-15 the document, item G7', () => {
  it('declares its language on the root element', () => {
    expect(MARKUP).toContain('<html lang="en">');
    // And nowhere else, so the one declaration is the one a reader gets.
    expect([...MARKUP.matchAll(/\blang="/g)]).toHaveLength(1);
  });

  it('exposes exactly one h1, and no other heading level in the shell', () => {
    expect([...MARKUP.matchAll(/<h1\b/g)]).toHaveLength(1);
    expect(MARKUP).toContain('<h1 class="pf-visually-hidden">Pocket Football</h1>');
    // The panels keep their h2s and build them in script (`panel.ts`), so the
    // shell carries no second heading of any level to compete with the h1.
    expect([...MARKUP.matchAll(/<h[2-6]\b/g)]).toHaveLength(0);
    expect(PANEL).toContain("document.createElement('h2')");
  });

  it('holds every piece of page content inside one main landmark', () => {
    // THE CLAUSE THE SCANNER CANNOT SEE. A landmark that covers most of the page
    // satisfies "uses meaningful landmarks" to a reader skimming the source and
    // leaves whatever is outside it unreachable by landmark navigation. The
    // structure is therefore asserted rather than the presence of the element.
    expect([...MARKUP.matchAll(/<main\b/g)]).toHaveLength(1);
    // AND IT IS A LANDMARK, which is a separate fact from being a `main`
    // element: `role` overrides the implicit one, and `role="presentation"`
    // removes the landmark while leaving every structural assertion below true
    // (an `indexOf('<main>')` of a tag that gained an attribute is -1, which is
    // less than any real index, so the reading-order lines pass on the wreck).
    // The element carries no attribute at all, and that is what is asserted.
    expect(MARKUP).toContain('<main>');
    expect([...MARKUP.matchAll(/<main\b[^>]*>/g)].map((found) => found[0])).toEqual([
      '<main>',
    ]);
    const order = tags(MARKUP);
    const body = order.indexOf('body');
    const main = order.indexOf('main');
    const mainEnd = order.indexOf('/main');
    const bodyEnd = order.indexOf('/body');
    expect(body).toBeGreaterThan(-1);
    expect(main).toBe(body + 1);
    // Between the end of the landmark and the end of the document there is the
    // module script and nothing else. A script is not page content.
    expect(order.slice(mainEnd + 1, bodyEnd)).toEqual(['script', '/script']);
    // And the three things that ARE content are inside it, in reading order.
    const inside = order.slice(main, mainEnd);
    expect(inside).toContain('h1');
    expect(inside).toContain('div');
    expect(inside).toContain('p');
    expect(MARKUP.indexOf('<div id="app">')).toBeGreaterThan(MARKUP.indexOf('<main>'));
    expect(MARKUP.indexOf('<div id="app">')).toBeLessThan(MARKUP.indexOf('</main>'));
  });

  it('carries both live-region elements in the initial HTML', () => {
    // QUALITY-BAR section 4, and the reason is the first line: a region created
    // at the moment it has something to say is a region the assistive
    // technology was not yet watching, and that line goes unspoken.
    expect(MARKUP).toContain(`data-pf="${POLITE_MARKER}" aria-live="polite"`);
    expect(MARKUP).toContain(`data-pf="${ASSERTIVE_MARKER}" aria-live="assertive"`);
    // One of each, so a second polite region cannot arrive beside the queue.
    expect([...MARKUP.matchAll(/aria-live="polite"/g)]).toHaveLength(1);
    expect([...MARKUP.matchAll(/aria-live="assertive"/g)]).toHaveLength(1);
    // Atomic, so a partial rewrite is read as one message rather than as the
    // words that happened to change.
    expect([...MARKUP.matchAll(/aria-atomic="true"/g)]).toHaveLength(2);
    // Both empty at boot: a region with text in the markup announces nothing,
    // but it does mean a reader meets a stale line on the way down the page.
    expect(MARKUP).toContain(`data-pf="${POLITE_MARKER}" aria-live="polite" aria-atomic="true"></p>`);
    expect(
      MARKUP,
    ).toContain(`data-pf="${ASSERTIVE_MARKER}" aria-live="assertive" aria-atomic="true"></p>`);
    // And inside the landmark, so landmark navigation reaches them.
    expect(MARKUP.indexOf(`data-pf="${POLITE_MARKER}"`)).toBeLessThan(MARKUP.indexOf('</main>'));
  });

  it('puts the regions outside the app column the focus trap makes inert', () => {
    // Item G9's trap takes the whole column out of the accessibility tree while
    // an overlay is open, and inert content announces nothing: a region inside
    // #app would fall silent exactly when a panel had something to say.
    const app = MARKUP.indexOf('<div id="app">');
    expect(app).toBeGreaterThan(-1);
    expect(MARKUP.indexOf(`data-pf="${POLITE_MARKER}"`)).toBeGreaterThan(
      MARKUP.indexOf('</div>', app),
    );
    // The mirror, by contrast, IS in the column and is meant to be: it
    // describes the pitch an open overlay is covering.
    expect(DOCUMENT).not.toContain(MIRROR_MARKER);
  });

  it('hides the heading and the regions from sight, and from sight alone', () => {
    // THE RECIPE IS THE POINT. `display: none`, `visibility: hidden` and the
    // `hidden` attribute all take the element out of the accessibility tree as
    // well, which would leave the h1 and both live regions doing nothing at all.
    const rule = ruleFor('.pf-visually-hidden');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('clip-path: inset(50%)');
    expect(rule).toContain('overflow: hidden');
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    expect(rule).not.toMatch(/\bopacity\b/);
    // Pinned to the top corner: an absolutely positioned box with no offsets
    // keeps its static position, and the announcer's is a viewport down the
    // page, so that one pixel would give a page that fits a scrollbar.
    expect(rule).toContain('inset-block-start: 0');
    expect(rule).toContain('inset-inline-start: 0');
    // Nothing in the shell is hidden from the tree by attribute either.
    expect(MARKUP).not.toContain('aria-hidden');
    expect(MARKUP).not.toMatch(/<h1[^>]*\shidden\b/);
  });

  it('names every overlay as the dialog it is, and claims no more than that', () => {
    // Item G9 pairs the trap with the semantics assistive technology expects:
    // a dialog that traps focus without saying it is a dialog leaves a screen
    // reader announcing the page around it.
    expect(PANEL).toContain("root.setAttribute('role', 'dialog');");
    // AND NO `aria-modal` ANYWHERE. It declares that content outside the dialog
    // is not perceivable, and this document puts item G4's two live regions
    // outside `#app` on purpose so an open panel cannot silence them. The
    // modality is native `inert`, which takes everything else out of the tree
    // without making a claim about the regions; whether a given product still
    // announces a live region under `aria-modal` varies by product and was
    // measured nowhere, so the attribute went rather than the regions.
    // The attribute is named in the frame's header, which is where the reason
    // lives; what must not exist is the code that sets it.
    expect(PANEL).not.toContain("setAttribute('aria-modal'");
    expect(MARKUP).not.toContain('aria-modal');
    // Named by the heading it already shows, rather than by a second copy of
    // the same words written for assistive technology alone.
    expect(PANEL).toContain("root.setAttribute('aria-labelledby', headingIdFor(options.name));");
    expect(PANEL).toContain('heading.id = headingIdFor(options.name);');
  });

  it('gives the document a title the page starts from', () => {
    expect(MARKUP).toContain('<title>Pocket Football</title>');
    // The static title is the boot value; the composition root replaces it on
    // the first frame and `play-mirror.test.ts` grades what it replaces it with.
    expect([...MARKUP.matchAll(/<title>/g)]).toHaveLength(1);
  });
});

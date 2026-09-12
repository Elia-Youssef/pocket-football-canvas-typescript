/**
 * A stand-in document for the chrome tests, sized to exactly what the chrome
 * uses: element and text nodes, attributes, the dataset, the hidden flag,
 * the radio state, listeners and focus.
 *
 * NOT A BROWSER. The unit suite is headless and framework-free by
 * construction (the vitest config runs in node), so the chrome is built here
 * the way the surface tests build a canvas: the real factory functions run
 * against a fake `document` swapped onto globalThis, and every assertion is
 * against the tree the factories actually built. A component that grew a
 * dependency this stand-in does not answer would fail loudly with a missing
 * method rather than quietly passing.
 *
 * It contains no assertion and no expected value. Everything a criterion is
 * graded against is written in the test file that owns the criterion.
 */

export class FakeText {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class FakeElement {
  readonly tagName: string;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly dataset: Record<string, string> = {};
  readonly ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  attributeWrites = 0;
  textWrites = 0;
  hidden = false;
  checked = false;
  value = '';
  type = '';
  className = '';

  constructor(tag: string, owner: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = owner;
  }

  get textContent(): string {
    let out = '';
    for (const child of this.children) {
      out += child instanceof FakeText ? child.value : child.textContent;
    }
    return out;
  }

  set textContent(value: string) {
    this.textWrites += 1;
    this.children.length = 0;
    this.children.push(new FakeText(value));
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributeWrites += 1;
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
    if (node instanceof FakeElement) {
      node.parentElement = this;
    }
    this.children.push(node);
    return node;
  }

  append(...nodes: readonly (FakeElement | FakeText)[]): void {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  insertBefore<T extends FakeElement | FakeText>(
    node: T,
    reference: FakeElement | FakeText | null,
  ): T {
    const at = reference === null ? this.children.length : this.children.indexOf(reference);
    if (at < 0) {
      throw new Error('the reference node is not a child of this element');
    }
    if (node instanceof FakeElement) {
      node.parentElement = this;
    }
    this.children.splice(at, 0, node);
    return node;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /** Test-side dispatch to the listeners a component registered. */
  dispatch(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

export class FakeDocument {
  readonly documentElement = new FakeElement('html', this);
  readonly body = new FakeElement('body', this);
  activeElement: FakeElement | null = null;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(value: string): FakeText {
    return new FakeText(value);
  }
}

export type FakeNode = FakeElement | FakeText;

export interface InstalledDocument {
  /** The one fake document every step of a test runs against. */
  readonly document: FakeDocument;
  /** Put the real document back. Always called, in a finally. */
  readonly restore: () => void;
}

/**
 * Swap one fake document in for the whole of a test, so every factory call
 * and every focus move lands in the same tree. The chrome reads the global
 * `document` at call time, which is what makes the swap and the restore
 * enough.
 */
export function installFakeDocument(): InstalledDocument {
  const fake = new FakeDocument();
  const original = globalThis.document;
  globalThis.document = fake as unknown as Document;
  return {
    document: fake,
    restore: (): void => {
      globalThis.document = original;
    },
  };
}

/**
 * The tags a platform makes focusable on their own, with no attribute asked
 * for. `INPUT` of type `hidden` is the one exception the platform itself
 * makes, and it is written out rather than assumed, because a census that
 * quietly skipped a control would be the defect this census exists to catch.
 *
 * THE ONES DECIDED BY AN ATTRIBUTE ARE NOT LISTED HERE. A link and an area are
 * focusable only with an `href`; `audio` and `video` only with `controls`; and
 * a `summary` only as the summary OF a details element, which is a fact about
 * its parent. All four are answered below.
 */
const NATIVELY_FOCUSABLE = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'IFRAME',
  'OBJECT',
  'EMBED',
]);

/** The tags whose own `disabled` attribute takes them out of the tab order. */
const DISABLEABLE = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'FIELDSET',
  'OPTGROUP',
  'OPTION',
]);

/** Embedded media, focusable exactly while it offers its own controls. */
const MEDIA = new Set(['AUDIO', 'VIDEO']);

/** The tags that may not contain interactive content, so the walk stops. */
const LEAF_CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** The element a details would open on: its first summary child, if it has one. */
function summaryOf(details: FakeElement): FakeElement | undefined {
  for (const child of details.children) {
    if (!(child instanceof FakeText) && child.tagName === 'SUMMARY') {
      return child;
    }
  }
  return undefined;
}

/**
 * Whether this element is FOCUSABLE AT ALL, by a tab or by a script.
 *
 * THE RULE THIS IMPLEMENTS, stated because the two readings differ and the
 * census depends on which one is meant. "Focusable at all" is the wider one:
 * everything the HTML standard puts in sequential focus navigation, PLUS
 * `tabindex="-1"`, which a tab walk skips and a script can still focus and a
 * panel can still hand focus to. It is the reading a freeze wants, because a
 * control the chrome moves focus to is a control a reviewer has to see. What
 * it excludes is what nothing can focus: a form control carrying `disabled`,
 * and a hidden input.
 *
 * BY FOCUSABILITY, NOT BY TAG NAME. This used to answer for `BUTTON` and
 * `INPUT` alone, so a `<select>`, a `<textarea>`, an `<a href>`, a div
 * carrying `tabindex` or anything `contenteditable` could be added to a panel
 * with every chrome test still green: the census froze the two tags it knew
 * and called the answer the whole chrome. Then it answered for those and still
 * missed a `<summary>`, an `<iframe>`, an `<audio controls>`, a `<video
 * controls>`, an `<object>` and an `<embed>` - the media ones being exactly
 * what the audio part will bring. Everything the standard enumerates is
 * enumerated here, so an addition of any shape reddens the freeze.
 *
 * THE PARENT IS PASSED BECAUSE ONE ANSWER NEEDS IT. A `summary` is focusable
 * as the summary OF a details element and is ordinary markup anywhere else,
 * which is a fact about where it sits rather than about what it is.
 */
export function isFocusable(node: FakeElement, parent?: FakeElement): boolean {
  if (DISABLEABLE.has(node.tagName) && node.getAttribute('disabled') !== null) {
    return false;
  }
  const tabindex = node.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '') {
    return true;
  }
  const editable = node.getAttribute('contenteditable');
  if (editable !== null && editable !== 'false') {
    return true;
  }
  if (node.tagName === 'A' || node.tagName === 'AREA') {
    return node.getAttribute('href') !== null;
  }
  if (node.tagName === 'INPUT' && node.type === 'hidden') {
    return false;
  }
  if (MEDIA.has(node.tagName)) {
    return node.getAttribute('controls') !== null;
  }
  if (node.tagName === 'SUMMARY') {
    return parent !== undefined && parent.tagName === 'DETAILS' && summaryOf(parent) === node;
  }
  return NATIVELY_FOCUSABLE.has(node.tagName);
}

/**
 * The accessible name a census entry carries: a button by its own text, and
 * everything else by its label, falling back to the `title` an embedded frame
 * carries instead of one and then to its text. A control with none of the
 * three answers the empty string, which is a census entry a reader has to
 * account for rather than an absence they cannot see.
 */
function visibleLabel(node: FakeElement): string | undefined {
  let parent = node.parentElement;
  while (parent !== null) {
    if (parent.tagName === 'LABEL') {
      return parent.textContent;
    }
    parent = parent.parentElement;
  }
  return undefined;
}

function accessibleName(node: FakeElement): string {
  if (node.tagName === 'BUTTON') {
    return node.textContent;
  }
  if (node.tagName === 'INPUT') {
    // Chrome choices and ranges are real visible label rows. Treating an
    // aria-label as equivalent here would let a sighted-invisible control pass
    // the census this helper freezes.
    return visibleLabel(node) ?? '';
  }
  return node.getAttribute('aria-label') ?? node.getAttribute('title') ?? node.textContent;
}

/**
 * The focusable controls in `root`, in document order, by accessible name.
 * Controls inside a hidden subtree are still censused, because presence and
 * visibility are two different assertions; the tests that need them separated
 * make both.
 */
export function censusControls(root: FakeElement): string[] {
  return focusableControls(root).map(accessibleName);
}

/** The focusable elements behind a census, retained for marker assertions. */
export function focusableControls(root: FakeElement): FakeElement[] {
  const controls: FakeElement[] = [];
  function walk(node: FakeElement): void {
    for (const child of node.children) {
      if (child instanceof FakeText) {
        continue;
      }
      if (isFocusable(child, node)) {
        controls.push(child);
      }
      // A focusable wrapper is still walked into, because a control inside one
      // is reachable too: only the tags that may hold no interactive content
      // end the walk.
      if (!LEAF_CONTROLS.has(child.tagName)) {
        walk(child);
      }
    }
  }
  walk(root);
  return controls;
}

/** Every element in the tree with the tag, including `root` itself. */
export function findAllByTag(root: FakeElement, tag: string): FakeElement[] {
  const found: FakeElement[] = [];
  function walk(node: FakeElement): void {
    if (node.tagName === tag) {
      found.push(node);
    }
    for (const child of node.children) {
      if (!(child instanceof FakeText)) {
        walk(child);
      }
    }
  }
  walk(root);
  return found;
}

/** The first element in the tree carrying the `data-pf` marker. */
export function findByMarker(root: FakeElement, marker: string): FakeElement | undefined {
  if (root.dataset['pf'] === marker) {
    return root;
  }
  for (const child of root.children) {
    if (child instanceof FakeText) {
      continue;
    }
    const found = findByMarker(child, marker);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** The observable mutation kinds a chrome sync must leave at zero when static. */
export function writeCounts(root: FakeElement): { attributes: number; text: number } {
  let attributes = root.attributeWrites;
  let text = root.textWrites;
  for (const child of root.children) {
    if (!(child instanceof FakeText)) {
      const nested = writeCounts(child);
      attributes += nested.attributes;
      text += nested.text;
    }
  }
  return { attributes, text };
}

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
    this.children.length = 0;
    this.children.push(new FakeText(value));
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
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
 * The focusable controls in `root`, in document order, by accessible name:
 * a button by its text, an input by its label. Controls inside a hidden
 * subtree are still censused, because presence and visibility are two
 * different assertions; the tests that need them separated make both.
 */
export function censusControls(root: FakeElement): string[] {
  const names: string[] = [];
  function walk(node: FakeElement): void {
    for (const child of node.children) {
      if (child instanceof FakeText) {
        continue;
      }
      if (child.tagName === 'BUTTON') {
        names.push(child.textContent);
      } else if (child.tagName === 'INPUT') {
        names.push(child.getAttribute('aria-label') ?? '');
      } else {
        walk(child);
      }
    }
  }
  walk(root);
  return names;
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

/**
 * The denylist behind `no-dom`.
 *
 * Item M3 forbids "any DOM or canvas type" inside core. Taken narrowly that is
 * a handful of names; taken as the rule is meant, it is every platform surface
 * that would make a core module unplayable headlessly, because the property the
 * boundary buys is that a whole match can be simulated with no browser at all.
 * So the list reaches past the document tree into timers that imply a frame
 * clock, storage, network, events, observers, workers and audio.
 *
 * Two entries are worth their own sentence.
 *
 *   `setTimeout` and friends are banned in core even though they exist in every
 *   runtime. DESIGN section 8 requires the opponent's delay to be a countdown
 *   inside the fixed step rather than a scheduled callback, so a core module
 *   that reaches for a timer has already left the deterministic simulation.
 *
 *   `crypto` is banned for the same reason `Math.random` is: SPEC section 6 and
 *   STACK section 3 put every draw on the seeded stream, and a second source of
 *   randomness would break a seeded transcript without failing anything else.
 *
 * Breadth here is close to free, because the rule only ever fires on a name
 * that resolves to no declaration. A core module that declares its own `Node`,
 * `Text` or `MediaKind` type, or imports one from a sibling, is untouched.
 *
 * THAT IS ALSO THE ANSWER TO THE OVER-REACH. The derived set below carries
 * names that are not the document tree at all: `structuredClone`, `TextEncoder`
 * and `URL` are declared in the DOM library and are therefore banned in core as
 * UNRESOLVED references, along with a couple of dozen ordinary words the same
 * library happens to declare. That is deliberate rather than accidental, and it
 * is bounded in exactly one way: declaring the name in the file, or importing
 * it, resolves the reference and the rule says nothing. Core lints clean today
 * with none of those escapes needed.
 *
 * THE LIST IS NO LONGER THE WHOLE ANSWER, and it never should have been. A
 * hand-written denylist reports the names somebody thought of, which is a
 * different property from the one item M3 states: `type A = ChildNode` passed
 * every gate this project has, and so did `EventListener` and `Blob`, because
 * nobody had listed them. `DOM_LIB_NAMES` below closes that by deriving the set
 * from the type definitions the build itself compiles against, so a name is
 * banned in core because it IS a DOM global rather than because it was
 * remembered. The hand list stays, and stays first, for the three things a
 * derivation cannot state: the entries that are here for a reason of this
 * project's own (`setTimeout`, `crypto`, `Date`), the family prefixes that
 * cover names no library file declares today, and a working rule on a machine
 * where the derivation found nothing to read.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const PLATFORM_GLOBALS = new Set([
  // Window, document and the rest of the browser object model.
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'self',
  'globalThis',
  'parent',
  'top',
  'frames',
  'opener',
  'origin',
  'alert',
  'confirm',
  'print',
  'matchMedia',
  'getComputedStyle',
  'getSelection',
  'devicePixelRatio',
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'scrollX',
  'scrollY',
  'visualViewport',
  'Window',
  'Document',
  'Navigator',
  'Location',
  'History',
  'Screen',
  'Element',
  'Node',
  'NodeList',
  'ShadowRoot',
  'Text',
  'Range',
  'Selection',
  'CustomElementRegistry',
  'customElements',

  // Frame clock, wall clock and idle scheduling.
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'performance',
  'Performance',
  // `Date` is declared by the ES library rather than the DOM one, so the
  // derivation below will never reach it, and it is banned in core for this
  // project's own reason: time is an INPUT to the simulation. A core module
  // that reads the wall clock has left the seeded, replayable model, and a
  // seeded transcript that no longer reproduces is the defect that follows.
  'Date',
  // Scheduling by microtask is scheduling. The fixed step is the only order
  // core has, and a callback that runs "later" is outside it.
  'queueMicrotask',

  // Storage.
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
  'Storage',

  // Network.
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Request',
  'Response',
  'Headers',
  'FormData',

  // Events, observers and input.
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'Event',
  'CustomEvent',
  'EventTarget',
  'UIEvent',
  'InputEvent',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'PerformanceObserver',
  'ReportingObserver',

  // Workers and cross-document messaging.
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'MessageChannel',
  'MessagePort',
  'BroadcastChannel',
  'postMessage',
  'importScripts',

  // Drawing surfaces and geometry.
  'ImageData',
  'ImageBitmap',
  'Image',
  'Audio',
  'Path2D',
  'createImageBitmap',

  // Randomness that is not the seeded stream.
  'crypto',
]);

/**
 * Whole families, so a name nobody thought to list is still caught. Each
 * pattern is anchored and requires the family prefix to be followed by a
 * capital, which keeps `Mediator` and `Audible` out of it.
 */
export const PLATFORM_PREFIXES = [
  /^HTML[A-Z]/,
  /^SVG[A-Z]/,
  /^Canvas[A-Z]/,
  /^Offscreen[A-Z]/,
  /^WebGL/,
  /^CSS/,
  /^DOM[A-Z]/,
  /^Audio[A-Z]/,
  /^Media[A-Z]/,
  /^Pointer[A-Z]/,
  /^Keyboard[A-Z]/,
  /^Mouse[A-Z]/,
  /^Touch[A-Z]/,
  /^Wheel[A-Z]/,
  /^Focus[A-Z]/,
  /^Drag[A-Z]/,
  /^Clipboard[A-Z]/,
  /^GPU[A-Z]/,
];

/**
 * Every name a TypeScript library file declares at its top level.
 *
 * Column zero is the whole of the test, and it is exact rather than
 * approximate: every member of an interface in those files is indented, and
 * every top-level declaration begins at the margin. Exported so the derivation
 * is graded on a string this project writes rather than only on whatever
 * version of the library happens to be installed.
 */
export function topLevelDeclarations(text) {
  const names = new Set();
  const pattern =
    /^(?:interface|type|declare\s+(?:var|let|const|function|namespace|enum|abstract\s+class|class))\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of String(text).matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The DOM globals, derived from the installed TypeScript library files at the
 * moment this plugin is loaded.
 *
 * WHY DERIVE RATHER THAN LIST. Item M3 forbids "any DOM or canvas type" in
 * core, and a hand-written list answers a narrower question: the names somebody
 * thought to write down. `lib.dom.d.ts` is the file the compiler itself uses to
 * decide what a DOM name is, and `tsconfig.json` puts it in `lib`, so a name
 * declared there is a name a core module can reach for and get.
 *
 * THE ES FILES ARE SUBTRACTED, and that subtraction is what makes the result
 * usable. `lib.dom.d.ts` redeclares nothing from the language, but the two sets
 * do overlap on names the language owns, and banning `Array`, `Map`, `Math` or
 * `Promise` inside core would be absurd. So a name qualifies only when the DOM
 * file declares it and no `lib.es*.d.ts` does.
 *
 * A MISSING LIBRARY IS NOT A SILENT WEAKENING. If the files cannot be read the
 * set is empty, the hand list and the prefixes still enforce the rule, and
 * `DOM_LIB_ORIGIN` is null so the unit suite fails by name rather than the
 * boundary quietly narrowing.
 *
 * THE STRICTNESS OF THIS BOUNDARY IS NOW COUPLED TO THE COMPILER VERSION, and
 * that is the price of deriving rather than listing. 2021 names come out of
 * typescript 6.0.3, read from 98 library files, 2.83 MiB, in 46 to 49 ms at
 * each plugin load. A compiler release that ADDS a DOM name tightens item M3's
 * rule loudly: a core module that used the name starts failing lint the day the
 * bump lands. One that REMOVES a name loosens the rule in silence, which is the
 * direction worth watching, because `.github/dependabot.yml` ignores typescript
 * MAJORS only and a minor rides the weekly toolchain group. The size is pinned
 * in a band by tests/unit/core-boundary.test.ts so a release that moved the set
 * far is reported rather than absorbed.
 */
function deriveDomLibNames() {
  try {
    const require = createRequire(import.meta.url);
    const libraries = path.join(
      path.dirname(require.resolve('typescript/package.json')),
      'lib',
    );
    const dom = topLevelDeclarations(
      readFileSync(path.join(libraries, 'lib.dom.d.ts'), 'utf8'),
    );
    for (const file of readdirSync(libraries)) {
      if (!/^lib\.es.*\.d\.ts$/.test(file)) {
        continue;
      }
      for (const name of topLevelDeclarations(
        readFileSync(path.join(libraries, file), 'utf8'),
      )) {
        dom.delete(name);
      }
    }
    return { names: dom, origin: path.join(libraries, 'lib.dom.d.ts') };
  } catch (error) {
    return { names: new Set(), origin: null, error: String(error) };
  }
}

const derived = deriveDomLibNames();

/** Names `lib.dom.d.ts` declares and no ES library file does. */
export const DOM_LIB_NAMES = derived.names;

/** The file the set above came from, or null when it could not be read. */
export const DOM_LIB_ORIGIN = derived.origin;

/** True when a name belongs to the platform surface core may not reach for. */
export function isPlatformGlobalName(name) {
  if (typeof name !== 'string' || name === '') {
    return false;
  }
  if (PLATFORM_GLOBALS.has(name)) {
    return true;
  }
  if (DOM_LIB_NAMES.has(name)) {
    return true;
  }
  return PLATFORM_PREFIXES.some((pattern) => pattern.test(name));
}

/** `/// <reference lib="dom" />`, which would pull the whole surface back in. */
export const DOM_LIB_REFERENCE = /^\/\s*<reference\s+lib\s*=\s*["']dom/i;

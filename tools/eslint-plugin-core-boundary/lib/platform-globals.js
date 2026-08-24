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
 */

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

  // Frame clock and idle scheduling.
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

/** True when a name belongs to the platform surface core may not reach for. */
export function isPlatformGlobalName(name) {
  if (typeof name !== 'string' || name === '') {
    return false;
  }
  if (PLATFORM_GLOBALS.has(name)) {
    return true;
  }
  return PLATFORM_PREFIXES.some((pattern) => pattern.test(name));
}

/** `/// <reference lib="dom" />`, which would pull the whole surface back in. */
export const DOM_LIB_REFERENCE = /^\/\s*<reference\s+lib\s*=\s*["']dom/i;

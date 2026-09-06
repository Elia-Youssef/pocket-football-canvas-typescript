/*
 * Every shape of the mouse-and-touch listener item C9 forbids, in one file
 * that exists to be rejected.
 *
 * The boundary test asserts BOTH directions over this file: every marked line
 * is reported by the rule the marker names, and no line without a marker is
 * reported at all. Without the second direction a rule that reported
 * everything would pass the first.
 *
 * This file is excluded from tsc and from the shipping lint. It is input to a
 * test and is never part of the build.
 */

declare const surface: HTMLCanvasElement;
declare const page: Window;
declare const handler: (event: Event) => void;

surface.addEventListener('mousedown', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('mousemove', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('mouseup', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('mouseleave', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('mousewheel', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('dblclick', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener

surface.addEventListener('touchstart', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('touchmove', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('touchend', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('touchcancel', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener

// The HTML drag family and the auxiliary button. An input path built on these
// is a SECOND input path by any reading, and it is the shape a rule that only
// knew about mouse and touch would have let through.
surface.addEventListener('dragstart', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('dragover', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('dragend', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('drop', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface.addEventListener('auxclick', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener

// Removing one is registering one somewhere, so both methods are read.
surface.removeEventListener('mouseout', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener

// A template with nothing interpolated is a string, and a bracketed method
// name is the same method. Neither is a way round the rule.
surface.addEventListener(`mouseover`, handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener
surface['addEventListener']('mouseenter', handler); // @expect pointer-events/no-mouse-or-touch-listeners:legacyListener

// The same listener as a handler property, which is where a second input path
// usually arrives: one line, no registration call, and no capture rules.
surface.onmousedown = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
surface.ontouchstart = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
surface.ondblclick = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
surface.ondragstart = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
surface.ondrop = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
surface.onauxclick = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
page.onmousemove = handler; // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler

// And as an object literal handed to something that will assign it.
export const wiring = {
  onmouseup: handler, // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
  ontouchmove: handler, // @expect pointer-events/no-mouse-or-touch-listeners:legacyHandler
};

/*
 * The near misses, in a file the pointer-events rule must leave completely
 * alone. The boundary test asserts this file produces ZERO messages.
 *
 * It is the control for the rule's SCOPE rather than for its content. A rule
 * that reported `click`, or an identifier with the word mouse in it, would be
 * switched off within a week, and every real Pointer Events listener in the
 * project would be reported along with it.
 */

declare const surface: HTMLCanvasElement;
declare const control: HTMLButtonElement;
declare const chooser: HTMLInputElement;
declare const frame: HTMLElement;
declare const handler: (event: Event) => void;

// The whole pointer path, which is what the project is made of.
surface.addEventListener('pointerdown', handler);
surface.addEventListener('pointermove', handler);
surface.addEventListener('pointerup', handler);
surface.addEventListener('pointercancel', handler);
surface.addEventListener('lostpointercapture', handler);

// Activation and form events. `click` is fired for a pointer, for a touch and
// for Enter or Space on a focused control, so banning it would ban the one
// event that makes a button reachable by all three input methods.
control.addEventListener('click', handler);
control.onclick = handler;
chooser.addEventListener('change', handler);
chooser.addEventListener('input', handler);
frame.addEventListener('keydown', handler);
frame.addEventListener('focus', handler);

// Identifiers that merely contain one of the words.
export const mouse = { position: 0 };
export const touched = false;
export const onMouseWheelPolicy = 'documented elsewhere';
export function touchDown(): boolean {
  return touched;
}

// An event name the rule cannot read statically, which is its stated limit:
// nothing here is a name to judge, and a rule that guessed would report every
// listener in the project.
declare const chosen: string;
surface.addEventListener(chosen, handler);
surface.addEventListener(`pointer${chosen}`, handler);

// THE TWO STATED EVASIONS, carried here so the limit is tested rather than
// merely admitted. Neither is reported, and the rule's own docstring says why
// and says what closes each instead: the shipping lint reading the whole of
// src/, and item M1's scan over the chrome. Both would read as deliberate to
// any reviewer, which is the standard the boundary plugin is held to as well.
const add = surface.addEventListener.bind(surface);
add('mousedown', handler);
surface.setAttribute('onmousedown', 'aim()');

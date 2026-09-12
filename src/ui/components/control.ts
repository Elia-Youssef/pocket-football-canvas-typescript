/**
 * The chrome control vocabulary: the three native controls this game offers
 * (button, choice and range), their stable markers, and the one refusal rule.
 *
 * A refusal is deliberately not the HTML `disabled` attribute. QUALITY-BAR
 * section 3 keeps an unavailable control visible and focusable, so the
 * platform must still deliver an event and this module must decline it. One
 * predicate makes that behaviour and its marker contract common to every
 * chrome control instead of five local readings that can drift apart.
 */

export interface ButtonOptions {
  readonly marker: string;
  readonly label: string;
  readonly className: string;
  readonly onActivate: () => void;
  readonly refused?: boolean;
}

export interface ChoiceOptions {
  readonly marker: string;
  readonly group: string;
  readonly label: string;
  readonly type: 'checkbox' | 'radio';
  readonly onChange: (control: HTMLInputElement) => void;
  readonly onRefused?: () => void;
  readonly value?: string;
  readonly refused?: boolean;
}

export interface RangeOptions {
  readonly marker: string;
  readonly label: string;
  readonly high: number;
  readonly step: number;
  readonly onInput: (value: number) => void;
  readonly refused?: boolean;
}

export interface ChoiceControl {
  readonly root: HTMLLabelElement;
  readonly input: HTMLInputElement;
}

export interface RangeControl {
  readonly root: HTMLLabelElement;
  readonly input: HTMLInputElement;
}

/** The one reading of the unavailable-in-place convention. */
export function refused(control: HTMLElement): boolean {
  return control.getAttribute('aria-disabled') === 'true';
}

/**
 * Write the refusal state only on an edge. Native controls still receive the
 * attribute, but this avoids an attribute mutation every animation frame.
 */
export function setRefused(control: HTMLElement, value: boolean): void {
  setAttributeIfChanged(control, 'aria-disabled', value ? 'true' : 'false');
}

/** Attribute writes are observable by assistive technology, so avoid no-ops. */
export function setAttributeIfChanged(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

/** Text replacement clears and rebuilds a subtree; only do it for a new value. */
export function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

/** Hidden is a property write too, so it follows the same edge-only rule. */
export function setHiddenIfChanged(element: HTMLElement, value: boolean): void {
  if (element.hidden !== value) {
    element.hidden = value;
  }
}

/** A range's visible thumb must keep the value the game actually holds. */
export function setValueIfChanged(control: HTMLInputElement, value: string): void {
  if (control.value !== value) {
    control.value = value;
  }
}

/** Checked is likewise a reflected control state, not a per-frame assignment. */
export function setCheckedIfChanged(control: HTMLInputElement, value: boolean): void {
  if (control.checked !== value) {
    control.checked = value;
  }
}

export function createButton(options: ButtonOptions): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = options.className;
  control.dataset['pf'] = options.marker;
  control.textContent = options.label;
  if (options.refused === true) {
    control.setAttribute('aria-disabled', 'true');
  }
  control.addEventListener('click', () => {
    if (refused(control)) {
      return;
    }
    options.onActivate();
  });
  return control;
}

/**
 * A choice is a real `<label>` row. The label text is visible and supplies the
 * native input's accessible name; an ARIA-only name cannot satisfy this shape.
 */
export function createChoice(options: ChoiceOptions): ChoiceControl {
  const root = document.createElement('label');
  root.className = 'pf-choice';

  const input = document.createElement('input');
  input.type = options.type;
  input.setAttribute('name', options.group);
  input.className = 'pf-choice-input';
  input.dataset['pf'] = options.marker;
  if (options.value !== undefined) {
    input.value = options.value;
  }
  if (options.refused === true) {
    input.setAttribute('aria-disabled', 'true');
  }

  const text = document.createElement('span');
  text.className = 'pf-choice-label';
  text.textContent = options.label;

  input.addEventListener('change', () => {
    if (refused(input)) {
      options.onRefused?.();
      return;
    }
    options.onChange(input);
  });
  root.append(input, text);
  return { root, input };
}

/** A range carries the same visible-label contract as a native choice. */
export function createRange(options: RangeOptions): RangeControl {
  const root = document.createElement('label');
  root.className = 'pf-control-row pf-range-control';

  const text = document.createElement('span');
  text.className = 'pf-control-label';
  text.textContent = options.label;

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'pf-aim-slider';
  input.dataset['pf'] = options.marker;
  input.setAttribute('min', '0');
  input.setAttribute('max', String(options.high));
  input.setAttribute('step', String(options.step));
  input.value = '0';
  if (options.refused === true) {
    input.setAttribute('aria-disabled', 'true');
  }
  input.addEventListener('input', () => {
    if (refused(input)) {
      return;
    }
    options.onInput(Number(input.value));
  });
  root.append(text, input);
  return { root, input };
}

/**
 * The frame every panel shares, SPEC sections 12, 13 and 17: one overlay
 * root, a heading, and the body the panel's own controls land in.
 *
 * REAL DOM. The overlay is a div the browser stacks above the play surface;
 * its controls are buttons and inputs the platform hit-tests, so nothing in
 * here ever compares a pointer coordinate against a rectangle. Visibility is
 * the `hidden` attribute and nothing else, which is what keeps a closed
 * panel out of the tab order without removing it: the elements stay in the
 * document exactly as they are built, once, and a restart never rebuilds
 * them (SPEC section 13).
 *
 * FOCUS MOVES WITH THE PANEL. QUALITY-BAR section 3: an overlay takes focus
 * when it opens and restores it when it closes, so a control that opened a
 * panel hands focus back and not to the body. Escape closes a dismissible
 * panel through the callback the wiring supplies, because what closing means
 * (resume the match, or merely put the panel away) is the wiring's decision,
 * not the frame's.
 */

export interface PanelOptions {
  /** The stable `data-pf` marker, `panel-` prefixed by the caller. */
  readonly name: string;
  readonly heading: string;
  /** Escape closes the panel, via `onEscape`. */
  readonly dismissible?: boolean;
  readonly onEscape?: () => void;
}

export interface Panel {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  /** A control or a line of text, appended to the body in call order. */
  addControl(control: HTMLElement, focusTarget?: HTMLElement): void;
  addText(text: string): HTMLParagraphElement;
  isOpen(): boolean;
  /** Open the panel and put focus on its first control. */
  show(invoker?: HTMLElement): void;
  /** Close the panel and hand focus back to whoever opened it. */
  hide(): void;
  /**
   * The controls, in tab order; the census and the focus move read it.
   *
   * THE LIVE LIST, NOT A COPY, AND THAT IS THE CONTRACT. One array is handed to
   * every caller and `addControl` appends to it, so a reference taken before a
   * panel finished building itself keeps growing as the rest of it lands. The
   * `readonly` element type is what stops a caller writing to the array; it
   * says nothing about the array standing still.
   *
   * WHY IT IS NOT A COPY. Every caller reads it and none keeps it: the wiring
   * asks for it to find a control by marker at the moment a panel opens, and
   * the censuses ask for it to count what is there now. Both want the present
   * state, which is what the live list is; a caller that wants a snapshot takes
   * one with a spread. tests/unit/chrome-panels.test.ts pins the aliasing.
   */
  controls(): readonly HTMLElement[];
}

/**
 * The tags a control the panel can put focus on. A line of text is a control
 * in the census but never a focus target: HTMLElement.focus exists on every
 * element, and following the first entry blindly would park focus on a
 * paragraph.
 */
function focusable(element: HTMLElement): boolean {
  const tag = element.tagName;
  return tag === 'BUTTON' || tag === 'INPUT';
}

export function createPanel(options: PanelOptions): Panel {
  const root = document.createElement('div');
  root.className = 'pf-panel';
  root.dataset['pf'] = options.name;
  root.hidden = true;

  const card = document.createElement('div');
  card.className = 'pf-panel-card';

  const heading = document.createElement('h2');
  heading.className = 'pf-panel-heading';
  heading.textContent = options.heading;

  const body = document.createElement('div');
  body.className = 'pf-panel-body';

  const added: HTMLElement[] = [];
  let opener: HTMLElement | null = null;

  if (options.dismissible === true) {
    root.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        options.onEscape?.();
      }
    });
  }

  root.append(card);
  card.append(heading, body);

  return {
    root,
    heading,

    addControl(control: HTMLElement, focusTarget: HTMLElement = control): void {
      added.push(focusTarget);
      body.appendChild(control);
    },

    addText(text: string): HTMLParagraphElement {
      const line = document.createElement('p');
      line.className = 'pf-panel-text';
      line.textContent = text;
      body.appendChild(line);
      return line;
    },

    isOpen(): boolean {
      return !root.hidden;
    },

    show(invoker?: HTMLElement): void {
      opener = invoker ?? null;
      root.hidden = false;
      for (const control of added) {
        if (focusable(control)) {
          control.focus();
          break;
        }
      }
    },

    hide(): void {
      root.hidden = true;
      opener?.focus();
      opener = null;
    },

    controls(): readonly HTMLElement[] {
      // The live list by reference, which the interface above states and pins.
      return added;
    },
  };
}

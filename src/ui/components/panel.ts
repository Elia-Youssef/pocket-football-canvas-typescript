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
 *
 * IT IS A DIALOG WHOSE MODALITY IS THE PLATFORM'S. Every panel here covers the
 * whole viewport and takes focus, so the root carries `role="dialog"` and is
 * named by its own heading; item G9's trap is native `inert` on everything else
 * and belongs to the wiring, which is the only thing that knows which panel is
 * on top.
 *
 * AND IT CARRIES NO `aria-modal`, which it did until the PF-15 review. That
 * attribute tells assistive technology that content OUTSIDE the dialog is not
 * perceivable, and item G4 puts the two live regions deliberately outside it:
 * `index.html` places them outside `#app` precisely so the trap cannot silence
 * them, and a pause is one of the two moments a reader most needs to hear
 * something. `inert` already removes everything else from the accessibility
 * tree, so the attribute added a promise about the regions rather than about the
 * trap, and whether a given product still announces a live region under it
 * varies by product and was measured nowhere. The modality is the thing that is
 * true, and it is the platform's.
 */

export interface PanelOptions {
  /** The stable `data-pf` marker, `panel-` prefixed by the caller. */
  readonly name: string;
  readonly heading: string;
  /** Escape closes the panel, via `onEscape`. */
  readonly dismissible?: boolean;
  readonly onEscape?: () => void;
}

/**
 * A set of choices that belong together, and the visible line that names them.
 *
 * WHY A GROUP AT ALL. A panel body is a flat column, so a screen reader meeting
 * "System" has nothing to say what the choice is OF: the name of the setting was
 * a paragraph two stops earlier with no relationship to the radios under it.
 * Native radios already group by their shared `name`, but that grouping carries
 * no label; `role="radiogroup"` with `aria-labelledby` pointing at the line that
 * is already on the screen is what attaches the two, and it attaches the words
 * the sighted player reads rather than a second copy of them written for
 * assistive technology alone.
 */
export interface PanelGroup {
  readonly root: HTMLElement;
  /** The line naming the group, which is also what labels it. */
  readonly label: HTMLParagraphElement;
  /** A control inside the group, registered in the panel's own tab order. */
  addControl(control: HTMLElement, focusTarget?: HTMLElement): void;
}

export interface Panel {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  /** A control or a line of text, appended to the body in call order. */
  addControl(control: HTMLElement, focusTarget?: HTMLElement): void;
  addText(text: string): HTMLParagraphElement;
  /**
   * A labelled radio group, appended to the body in call order. Controls added
   * to it land in the panel's one tab order exactly where they were added, so
   * the census and the focus move see no difference.
   */
  addRadioGroup(name: string, label: string): PanelGroup;
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

/**
 * The radio group a control belongs to, or null where it is not a radio.
 *
 * READ OFF THE `name` ATTRIBUTE, because that attribute IS the platform's
 * grouping rule and `createChoice` is what writes it. `instanceof
 * HTMLInputElement` is the narrowing to reach for and it is the wrong one here:
 * the chrome's unit tests build a fake document whose elements answer the same
 * shape without being that class, and the whole chrome already types its
 * controls this way.
 */
function radioGroupOf(element: HTMLElement): string | null {
  if (element.tagName !== 'INPUT') {
    return null;
  }
  const control = element as HTMLInputElement;
  if (control.type !== 'radio') {
    return null;
  }
  const group = control.getAttribute('name');
  return group === null || group === '' ? null : group;
}

/** The id a panel's heading takes, so its root can be named by it. */
export function headingIdFor(name: string): string {
  return `${name}-heading`;
}

export function createPanel(options: PanelOptions): Panel {
  const root = document.createElement('div');
  root.className = 'pf-panel';
  root.dataset['pf'] = options.name;
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  // Named by the heading it already shows, rather than by an aria-label that
  // would be a second copy of the same words for the two audiences to disagree
  // over. QUALITY-BAR section 4's h1 is the document's; these stay h2s.
  root.setAttribute('aria-labelledby', headingIdFor(options.name));

  const card = document.createElement('div');
  card.className = 'pf-panel-card';

  const heading = document.createElement('h2');
  heading.className = 'pf-panel-heading';
  heading.id = headingIdFor(options.name);
  heading.textContent = options.heading;

  const body = document.createElement('div');
  body.className = 'pf-panel-body';

  const added: HTMLElement[] = [];
  let opener: HTMLElement | null = null;

  /** The member of a radio group the platform puts in the tab order: the checked one. */
  function checkedIn(group: string): HTMLElement | null {
    for (const element of added) {
      if (radioGroupOf(element) === group && (element as HTMLInputElement).checked) {
        return element;
      }
    }
    return null;
  }

  /**
   * The controls a Tab can actually land on, in the order it lands on them.
   *
   * A RADIO GROUP IS ONE TAB STOP AND NOT FOUR, and reading it as four opened a
   * hole in the trap. HTML's radio button group rule puts the CHECKED member in
   * sequential focus order and moves between the rest with the arrows, so a
   * boundary taken from the build order is the wrong element the moment a stored
   * choice is anything but the first: with Dark in force, a Shift+Tab on
   * `theme-dark` was compared against `theme-system`, matched neither end, fell
   * through to the platform, and left the overlay for the document body with
   * everything around it inert. The stored choice is exactly what a returning
   * player opens Settings with, so this was reachable and not theoretical.
   *
   * IT IS ALSO WHERE FOCUS GOES IN. `show` opens on `stops()[0]`, which under
   * the build-order reading was an UNCHECKED radio, announced as "not checked"
   * while the setting it names was in force.
   *
   * A group's controls are added together, so taking the group's stop at the
   * position of its first member keeps the walk in the order the panel was
   * built in and names the same element the platform would.
   */
  function stops(): HTMLElement[] {
    const walk: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const element of added) {
      if (!focusable(element)) {
        continue;
      }
      const group = radioGroupOf(element);
      if (group === null) {
        walk.push(element);
        continue;
      }
      if (seen.has(group)) {
        continue;
      }
      seen.add(group);
      // A group with nothing checked has no checked member to name, and the
      // platform falls back to its first; so does this.
      walk.push(checkedIn(group) ?? element);
    }
    return walk;
  }

  /**
   * The two keys a panel answers: Escape, where it is dismissible, and Tab at
   * either end of its own control list.
   *
   * WHY TAB IS HANDLED AT ALL, since item G9's trap is native `inert`. Inert is
   * what stops focus reaching anything OUTSIDE the panel, and it does that
   * completely. What it does not do is close the cycle: a Tab at the last
   * control of the document moves focus to the document itself, and the next
   * Tab comes back in, so a walk out of an open overlay lands on `<body>`.
   * Measured on Chromium with the whole column inert: pause-settings,
   * pause-how-to, pause-quit, body. Item C12's own clause is that no state
   * change leaves focus on the document body, and a trap that puts it there
   * once per cycle is a trap with a hole in it, so the two boundaries wrap.
   *
   * THE LIST IS THE PANEL'S OWN, which is what makes this two lines rather than
   * a focus-order implementation. `added` is the order the panel was built in
   * and the order `show` puts focus into, so a wrap is the first or last of it
   * and nothing here has to guess what a platform considers focusable.
   *
   * TAB IS NOT ONE OF THE KEYS SPEC SECTION 5.1 CLAIMS. The play surface calls
   * `preventDefault` for the four arrows, Space and Enter, and it is inert while
   * any panel is open in any case, so there is no collision to have.
   */
  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (options.dismissible === true) {
        options.onEscape?.();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const walk = stops();
    const first = walk[0];
    const last = walk[walk.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = root.ownerDocument.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

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

    addRadioGroup(name: string, text: string): PanelGroup {
      const group = document.createElement('div');
      group.className = 'pf-panel-group';
      group.dataset['pf'] = name;
      group.setAttribute('role', 'radiogroup');

      const label = document.createElement('p');
      label.className = 'pf-panel-text';
      label.id = `${name}-label`;
      label.textContent = text;
      group.setAttribute('aria-labelledby', label.id);

      group.appendChild(label);
      body.appendChild(group);
      return {
        root: group,
        label,

        addControl(control: HTMLElement, focusTarget: HTMLElement = control): void {
          // The SAME list the panel's own `addControl` appends to, so a control
          // in a group is in the tab order where it was added and the census
          // cannot tell the two routes apart.
          added.push(focusTarget);
          group.appendChild(control);
        },
      };
    },

    isOpen(): boolean {
      return !root.hidden;
    },

    show(invoker?: HTMLElement): void {
      opener = invoker ?? null;
      root.hidden = false;
      stops()[0]?.focus();
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

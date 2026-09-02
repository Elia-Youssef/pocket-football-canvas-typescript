/**
 * The settings panel, SPEC section 17, as far as this part owns it.
 *
 * The theme control is the one setting whose machinery exists today: the
 * token stylesheet already answers `data-theme` on the root element, both
 * ways round, so the control writes that attribute and nothing else. It
 * wraps the platform read rather than replacing it - System clears the
 * attribute, and the pitch palette follows through the composition root,
 * which still asks the stylesheet's media query for the variant whenever no
 * override is in force. The settings whose owners have not landed yet
 * (modes, match length, sound, the play-surface size) are absent rather than
 * stubbed: a control that only pretends to work is the defect this part
 * exists to keep off the canvas.
 *
 * RESET ALL DATA IS CONFIRMED IN PLACE, IN THE DOCUMENT. SPEC section 17 asks
 * for a confirmation and QUALITY-BAR section 3 decides what one may be: not
 * `window.confirm`, which blocks the frame loop and is a control this project
 * cannot style, size or put a focus ring on. The two-step is a pair of real
 * buttons that are always in the tree and `aria-disabled` until the reset is
 * armed, exactly as the pause control and the game-over actions are, so
 * arming and disarming cannot drop a focused element on the floor. Arming
 * moves focus to Cancel rather than to Confirm: the destructive control is
 * never the one under the next Enter.
 *
 * THE REFUSAL IS REAL AND NOT ONLY ANNOUNCED. `aria-disabled` is a promise to
 * a screen reader, not a lock the platform enforces, so an unarmed Confirm
 * ignores the click it is given rather than relying on the attribute.
 *
 * THE NOTICE IS PART OF THE FEATURE. QUALITY-BAR section 8 makes persistence
 * best effort by design and requires settings to say so plainly, because
 * script-writable storage is deleted by browsers that have never heard of this
 * game.
 */

import { THEME_SETTINGS } from '../../core/storage';
import type { ThemeSetting } from '../../core/storage';
import { createPanel } from './panel';
import type { Panel } from './panel';

/**
 * The three states SPEC section 17 gives the theme setting. The union itself
 * is `core/storage.ts`'s, because the stored settings own the values and a
 * second copy here would be a second place for them to disagree.
 */
export type ThemeChoice = ThemeSetting;

export const THEME_CHOICES: readonly ThemeChoice[] = THEME_SETTINGS;

/** The label each choice carries, which is also its accessible name. */
const CHOICE_LABELS: Readonly<Record<ThemeChoice, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** QUALITY-BAR section 8's plain statement about where progress lives. */
const STORAGE_NOTICE =
  'Progress is stored in this browser only. Clearing this browser can clear it too.';

/** What the panel says while the reset is armed, and after it has run. */
const RESET_PROMPT =
  'This clears ladder progress, best results, lifetime counters and every setting. ' +
  'It cannot be undone.';
const RESET_DONE = 'All saved data cleared.';

export interface SettingsPanelOptions {
  readonly onThemeChange: (theme: ThemeChoice) => void;
  /** SPEC section 17's Reset all data, raised only after the confirmation. */
  readonly onReset: () => void;
  readonly onClose: () => void;
  readonly onEscape: () => void;
}

export interface SettingsPanel extends Panel {
  /** Checks the radio for `theme` without raising a change. */
  select(theme: ThemeChoice): void;
}

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const panel = createPanel({
    name: 'panel-settings',
    heading: 'Settings',
    dismissible: true,
    onEscape: options.onEscape,
  });

  panel.addText('Colour theme');

  const radios = new Map<ThemeChoice, HTMLInputElement>();
  for (const choice of THEME_CHOICES) {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.setAttribute('name', 'pf-theme');
    radio.value = choice;
    radio.setAttribute('aria-label', CHOICE_LABELS[choice]);
    radio.className = 'pf-choice-input';
    radio.addEventListener('change', () => {
      if (radio.checked) {
        options.onThemeChange(choice);
      }
    });
    radios.set(choice, radio);
    panel.addControl(radio);
  }

  const notice = document.createElement('p');
  notice.className = 'pf-panel-text';
  notice.dataset['pf'] = 'storage-notice';
  notice.textContent = STORAGE_NOTICE;
  panel.addControl(notice);

  function button(marker: string, label: string): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'pf-choice-button';
    control.dataset['pf'] = marker;
    control.textContent = label;
    panel.addControl(control);
    return control;
  }

  const reset = button('reset-data', 'Reset all data');

  const prompt = document.createElement('p');
  prompt.className = 'pf-panel-text';
  prompt.dataset['pf'] = 'reset-prompt';
  prompt.textContent = '';
  panel.addControl(prompt);

  const confirmReset = button('reset-confirm', 'Confirm reset');
  const cancelReset = button('reset-cancel', 'Cancel reset');

  /** True while the confirmation is showing, which is the only live state. */
  let armed = false;

  function refused(control: HTMLButtonElement): boolean {
    return control.getAttribute('aria-disabled') === 'true';
  }

  function refresh(): void {
    reset.setAttribute('aria-disabled', armed ? 'true' : 'false');
    confirmReset.setAttribute('aria-disabled', armed ? 'false' : 'true');
    cancelReset.setAttribute('aria-disabled', armed ? 'false' : 'true');
  }

  reset.addEventListener('click', () => {
    if (refused(reset)) {
      return;
    }
    armed = true;
    prompt.textContent = RESET_PROMPT;
    refresh();
    // The safe half of the pair takes focus, so the destructive one is never
    // the control the next activation lands on.
    cancelReset.focus();
  });

  cancelReset.addEventListener('click', () => {
    if (refused(cancelReset)) {
      return;
    }
    armed = false;
    prompt.textContent = '';
    refresh();
    reset.focus();
  });

  confirmReset.addEventListener('click', () => {
    if (refused(confirmReset)) {
      return;
    }
    armed = false;
    options.onReset();
    prompt.textContent = RESET_DONE;
    refresh();
    reset.focus();
  });

  refresh();

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pf-choice-button';
  close.dataset['pf'] = 'settings-close';
  close.textContent = 'Close';
  close.addEventListener('click', options.onClose);
  panel.addControl(close);

  return {
    ...panel,

    /**
     * Opened disarmed, always. A confirmation armed in an earlier visit and
     * left behind by an Escape or by the pause stack closing would put the
     * destructive control one activation away before the player has done
     * anything at all in this one.
     */
    show(invoker?: HTMLElement): void {
      armed = false;
      prompt.textContent = '';
      refresh();
      panel.show(invoker);
    },

    select(theme: ThemeChoice): void {
      for (const [choice, radio] of radios) {
        radio.checked = choice === theme;
      }
    },
  };
}

/**
 * The settings panel, SPEC section 17, as far as this part owns it.
 *
 * The theme control is the one setting whose machinery existed at the chrome
 * part: the token stylesheet already answers `data-theme` on the root element,
 * both ways round, so the control writes that attribute and nothing else. It
 * wraps the platform read rather than replacing it - System clears the
 * attribute, and the pitch palette follows through the composition root,
 * which still asks the stylesheet's media query for the variant whenever no
 * override is in force. The settings whose owners have not landed yet
 * (modes, match length, sound) are absent rather than stubbed: a control that
 * only pretends to work is the defect this part exists to keep off the canvas.
 *
 * THE PLAY-SURFACE SIZE IS THE SECOND CONTROL WITH REAL MACHINERY BEHIND IT.
 * QUALITY-BAR section 4 gives it 100 / 125 / 150 / 200 percent and SPEC
 * section 17 says why it is not a duplicate of browser zoom: zoom shrinks the
 * canvas CSS box along with the viewport, so the pitch redraws at the same
 * physical size and magnifies nothing, while this raises the logical-to-CSS
 * scale and is therefore the only path the pitch has to being larger. The
 * offered values are `core/storage.ts`'s, because the stored settings own them
 * and a second list here would be a second place for them to disagree; what
 * this panel raises is the chosen number, and the composition root applies it
 * to the fit and writes it to the document.
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

import { SURFACE_SCALES, THEME_SETTINGS } from '../../core/storage';
import type { ThemeSetting } from '../../core/storage';
import {
  createButton,
  createChoice,
  setCheckedIfChanged,
  setRefused,
  setTextIfChanged,
} from './control';
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
  /** QUALITY-BAR section 4's play-surface size, in percent. */
  readonly onSurfaceScaleChange: (percent: number) => void;
  /** SPEC section 17's Reset all data, raised only after the confirmation. */
  readonly onReset: () => void;
  readonly onClose: () => void;
  readonly onEscape: () => void;
}

export interface SettingsPanel extends Panel {
  /** Checks the radio for `theme` without raising a change. */
  select(theme: ThemeChoice): void;
  /** Checks the radio for `percent` without raising a change. */
  selectSurfaceScale(percent: number): void;
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
    const control = createChoice({
      marker: `theme-${choice}`,
      group: 'pf-theme',
      label: CHOICE_LABELS[choice],
      type: 'radio',
      value: choice,
      onChange: (radio) => {
      if (radio.checked) {
        options.onThemeChange(choice);
      }
      },
    });
    const radio = control.input;
    radios.set(choice, radio);
    panel.addControl(control.root, radio);
  }

  panel.addText('Play surface size');

  const sizes = new Map<number, HTMLInputElement>();
  for (const percent of SURFACE_SCALES) {
    const control = createChoice({
      marker: `surface-scale-${String(percent)}`,
      group: 'pf-surface-scale',
      label: `${String(percent)}%`,
      type: 'radio',
      value: String(percent),
      onChange: (radio) => {
      if (radio.checked) {
        options.onSurfaceScaleChange(percent);
      }
      },
    });
    const radio = control.input;
    sizes.set(percent, radio);
    panel.addControl(control.root, radio);
  }

  const notice = panel.addText(STORAGE_NOTICE);
  notice.dataset['pf'] = 'storage-notice';

  const prompt = panel.addText('');
  prompt.dataset['pf'] = 'reset-prompt';

  /** True while the confirmation is showing, which is the only live state. */
  let armed = false;

  function refresh(): void {
    setRefused(reset, armed);
    setRefused(confirmReset, !armed);
    setRefused(cancelReset, !armed);
  }

  const reset = createButton({
    marker: 'reset-data',
    label: 'Reset all data',
    className: 'pf-choice-button',
    onActivate: () => {
      armed = true;
      setTextIfChanged(prompt, RESET_PROMPT);
      refresh();
      // The safe half of the pair takes focus, so the destructive one is never
      // the control the next activation lands on.
      cancelReset.focus();
    },
  });
  panel.addControl(reset);

  const confirmReset = createButton({
    marker: 'reset-confirm',
    label: 'Confirm reset',
    className: 'pf-choice-button',
    onActivate: () => {
      armed = false;
      options.onReset();
      setTextIfChanged(prompt, RESET_DONE);
      refresh();
      reset.focus();
    },
  });
  panel.addControl(confirmReset);

  const cancelReset = createButton({
    marker: 'reset-cancel',
    label: 'Cancel reset',
    className: 'pf-choice-button',
    onActivate: () => {
      armed = false;
      setTextIfChanged(prompt, '');
      refresh();
      reset.focus();
    },
  });
  panel.addControl(cancelReset);

  refresh();

  const close = createButton({
    marker: 'settings-close',
    label: 'Close',
    className: 'pf-choice-button',
    onActivate: options.onClose,
  });
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
      setTextIfChanged(prompt, '');
      refresh();
      panel.show(invoker);
    },

    select(theme: ThemeChoice): void {
      for (const [choice, radio] of radios) {
        setCheckedIfChanged(radio, choice === theme);
      }
    },

    selectSurfaceScale(percent: number): void {
      for (const [offered, radio] of sizes) {
        setCheckedIfChanged(radio, offered === percent);
      }
    },
  };
}

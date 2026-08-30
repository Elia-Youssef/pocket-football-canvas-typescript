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
 * (modes, match length, sound, persistence) are absent rather than stubbed:
 * a control that only pretends to work is the defect this part exists to
 * keep off the canvas.
 */

import { createPanel } from './panel';
import type { Panel } from './panel';

/** The three states SPEC section 17 gives the theme setting. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** The label each choice carries, which is also its accessible name. */
const CHOICE_LABELS: Readonly<Record<ThemeChoice, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export interface SettingsPanelOptions {
  readonly onThemeChange: (theme: ThemeChoice) => void;
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

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pf-choice-button';
  close.textContent = 'Close';
  close.addEventListener('click', options.onClose);
  panel.addControl(close);

  return {
    ...panel,
    select(theme: ThemeChoice): void {
      for (const [choice, radio] of radios) {
        radio.checked = choice === theme;
      }
    },
  };
}

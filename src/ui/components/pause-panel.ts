/**
 * The pause panel, SPEC section 7: the face of the PAUSED state.
 *
 * It carries the ways out of the state the chart draws - resume, or quit to
 * the menu - and the two chrome panels a paused player is allowed to reach,
 * settings and how-to-play, which stack above it and leave the match where
 * it is. Escape is a resume, because the panel IS the pause: dismissing it
 * and letting the match run on are the same act. What each button does is
 * the wiring's business; this module only names and raises it.
 */

import { createPanel } from './panel';
import type { Panel } from './panel';

export interface PausePanelOptions {
  readonly onResume: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHowToPlay: () => void;
  readonly onQuit: () => void;
  /** Escape, which the wiring answers with a resume intent. */
  readonly onEscape: () => void;
}

export function createPausePanel(options: PausePanelOptions): Panel {
  const panel = createPanel({
    name: 'panel-pause',
    heading: 'Paused',
    dismissible: true,
    onEscape: options.onEscape,
  });

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'pf-choice-button';
    control.textContent = label;
    control.addEventListener('click', onClick);
    return control;
  }

  panel.addControl(button('Resume', options.onResume));
  panel.addControl(button('Settings', options.onOpenSettings));
  panel.addControl(button('How to play', options.onOpenHowToPlay));
  panel.addControl(button('Quit', options.onQuit));
  return panel;
}

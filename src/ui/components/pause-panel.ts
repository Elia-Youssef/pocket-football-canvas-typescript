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

import { createButton } from './control';
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

  panel.addControl(
    createButton({
      marker: 'pause-resume',
      label: 'Resume',
      className: 'pf-choice-button',
      onActivate: options.onResume,
    }),
  );
  panel.addControl(
    createButton({
      marker: 'pause-settings',
      label: 'Settings',
      className: 'pf-choice-button',
      onActivate: options.onOpenSettings,
    }),
  );
  panel.addControl(
    createButton({
      marker: 'pause-how-to',
      label: 'How to play',
      className: 'pf-choice-button',
      onActivate: options.onOpenHowToPlay,
    }),
  );
  panel.addControl(
    createButton({
      marker: 'pause-quit',
      label: 'Quit',
      className: 'pf-choice-button',
      onActivate: options.onQuit,
    }),
  );
  return panel;
}

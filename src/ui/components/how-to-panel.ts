/**
 * The how-to-play panel: the two moves the game is made of, in plain text.
 *
 * The wording states only what the simulation already does - drag back from
 * your circle to aim, release to launch - and nothing about modes, aiming
 * aids or scoring targets that later parts own. Like every panel it is real
 * DOM text, resizable and translatable later, never glyphs on the canvas.
 */

import { createPanel } from './panel';
import type { Panel } from './panel';

export interface HowToPanelOptions {
  readonly onClose: () => void;
  readonly onEscape: () => void;
}

export function createHowToPanel(options: HowToPanelOptions): Panel {
  const panel = createPanel({
    name: 'panel-how-to-play',
    heading: 'How to play',
    dismissible: true,
    onEscape: options.onEscape,
  });

  panel.addText('Drag back from your circle to aim. Release to launch it at the ball.');
  panel.addText('Knock the ball past your opponent and fully over the goal line to score.');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pf-choice-button';
  close.textContent = 'Close';
  close.addEventListener('click', options.onClose);
  panel.addControl(close);

  return panel;
}

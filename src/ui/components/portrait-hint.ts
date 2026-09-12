import { createButton } from './control';

/**
 * SPEC section 2.1's portrait hint: a dismissible, non-blocking line that
 * suggests rotating for a larger pitch and never gates play.
 *
 * IT IS A BAR IN THE FLOW, NOT AN OVERLAY, and that is the whole of "covers no
 * control". A panel positioned over the page can be moved until it happens to
 * miss every control, and then a later part adds a control underneath it; a
 * bar that takes its own row in the document cannot cover anything at any
 * viewport, at any text size, in any orientation. The five overlays this
 * chrome does have are match state or a player's own request; a hint nobody
 * asked for is neither.
 *
 * WHEN IT SHOWS IS THE STYLESHEET'S, NOT THIS MODULE'S. The composition root
 * writes the resolved breakpoint onto the root element and the stylesheet
 * shows this bar in `portrait` alone, so there is no second copy of the
 * breakpoint rule here to drift away from `ui/breakpoints.ts`. What this
 * module owns is the DISMISSAL: `hidden` when the player has put it away, and
 * the callback that lets the composition root remember that across sessions.
 *
 * THE TEXT PROMISES NOTHING IT CANNOT KEEP. SPEC section 2.1 refuses to gate
 * play on orientation, so the line says the game plays here and offers the
 * rotation as an improvement rather than as an instruction.
 */

/** SPEC section 2.1: a suggestion, and a statement that nothing is blocked. */
const HINT_TEXT = 'Rotate for a larger pitch. The game plays fully in portrait.';

/** The label on the control that puts it away, which is also its name. */
const DISMISS_LABEL = 'Dismiss';

export interface PortraitHintOptions {
  /** Raised when the player puts the hint away, so the dismissal can persist. */
  readonly onDismiss: () => void;
}

export interface PortraitHint {
  readonly root: HTMLElement;
  /** The control, kept for the census and for anything placing focus. */
  readonly dismiss: HTMLButtonElement;
  isDismissed(): boolean;
  /** Put the hint back, or away, without raising the callback. */
  setDismissed(dismissed: boolean): void;
}

export function createPortraitHint(options: PortraitHintOptions): PortraitHint {
  const root = document.createElement('div');
  root.className = 'pf-portrait-hint';
  root.dataset['pf'] = 'portrait-hint';

  const line = document.createElement('p');
  line.className = 'pf-hint-text';
  line.dataset['pf'] = 'hint-text';
  line.textContent = HINT_TEXT;

  const dismiss = createButton({
    marker: 'hint-dismiss',
    label: DISMISS_LABEL,
    className: 'pf-hint-dismiss',
    onActivate: () => {
      root.hidden = true;
      options.onDismiss();
    },
  });

  root.append(line, dismiss);

  return {
    root,
    dismiss,

    isDismissed(): boolean {
      // Compared rather than returned: the platform type admits `until-found`
      // beside the boolean, and a hint the browser could reveal on a find is
      // not a hint the player put away.
      return root.hidden === true;
    },

    setDismissed(dismissed: boolean): void {
      root.hidden = dismissed;
    },
  };
}

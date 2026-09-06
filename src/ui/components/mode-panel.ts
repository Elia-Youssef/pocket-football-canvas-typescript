/**
 * The mode menu, SPEC section 9: the four modes and the numbers each of them
 * varies, plus SPEC section 11's aim-guide setting and the way into How to
 * Play before a match exists.
 *
 * REAL DOM, AND REFUSED IN PLACE. Every choice is a radio the platform owns,
 * every group stays in the document in every mode, and a group the chosen mode
 * does not use carries `aria-disabled="true"` and ignores its own change
 * rather than vanishing (QUALITY-BAR section 3, and the same rule the pause
 * control follows). A group that disappeared when the mode changed would drop
 * a focused element on the floor and would make the menu a different shape
 * every time it opened.
 *
 * THE PANEL HOLDS THE CHOICE, THE ROOT HOLDS THE CONSEQUENCES. Nothing here
 * builds a match, seeds a stream or reads storage: `choice()` answers with the
 * `ModeChoice` the controls currently name and `onStart` hands it over. The
 * ladder's rung is not a control at all, because SPEC section 9 says the
 * ladder is played in order and progress persists: the rung is read from the
 * progress the composition root holds and is shown here rather than chosen.
 */

import type { Difficulty, ModeChoice, ModeKind } from '../../core/modes';
import {
  DEFAULT_DURATION,
  DEFAULT_TARGET,
  FIRST_TO_TARGETS,
  LADDER_TOTAL,
  QUICK_DURATIONS,
  difficultyOf,
  guideOnByDefault,
  rungAt,
} from '../../core/modes';
import { formatNumber } from './clock';
import { createPanel } from './panel';
import type { Panel } from './panel';

/** SPEC section 9's four modes, in the order the section lists them. */
const MODE_LABELS: Readonly<Record<ModeKind, string>> = {
  quick: 'Quick Match',
  'first-to': 'First to N',
  ladder: 'Ladder',
  hotseat: 'Hotseat',
};

const MODE_ORDER: readonly ModeKind[] = ['quick', 'first-to', 'ladder', 'hotseat'];

/** SPEC section 8's three difficulties, as the menu names them. */
const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  casual: 'Casual',
  pro: 'Pro',
  ace: 'Ace',
};

const DIFFICULTY_ORDER: readonly Difficulty[] = ['casual', 'pro', 'ace'];

/** Which modes read which group, which is the whole of the refusal rule. */
const USES_DURATION: readonly ModeKind[] = ['quick'];
const USES_TARGET: readonly ModeKind[] = ['first-to', 'hotseat'];
const USES_DIFFICULTY: readonly ModeKind[] = ['quick', 'first-to'];

export interface ModePanelOptions {
  /** The mode the menu opens on, which is the composition root's default. */
  readonly initial: ModeChoice;
  /** SPEC section 11's guide setting, as the initial mode defaults it. */
  readonly guideOn: boolean;
  readonly onStart: (choice: ModeChoice, guideOn: boolean) => void;
  readonly onHowToPlay: () => void;
}

export interface ModePanel extends Panel {
  /** The mode the controls currently name. */
  choice(): ModeChoice;
  /** SPEC section 11's setting as the checkbox currently has it. */
  guideOn(): boolean;
  /** Show the rung the ladder would resume at, and start the ladder there. */
  setLadderRung(position: number): void;
  /** Set the guide checkbox without raising a change, for a mode's default. */
  setGuide(on: boolean): void;
}

/** One group of radios, and the modes that read it. */
interface Group {
  readonly inputs: () => Iterable<HTMLInputElement>;
  readonly applies: readonly ModeKind[];
}

export function createModePanel(options: ModePanelOptions): ModePanel {
  const panel = createPanel({ name: 'panel-mode', heading: 'Choose a mode' });

  let kind: ModeKind = options.initial.kind;
  let duration = options.initial.kind === 'quick' ? options.initial.duration : DEFAULT_DURATION;
  let target =
    options.initial.kind === 'first-to' || options.initial.kind === 'hotseat'
      ? options.initial.target
      : DEFAULT_TARGET;
  let difficulty: Difficulty =
    options.initial.kind === 'quick' || options.initial.kind === 'first-to'
      ? options.initial.difficulty
      : 'casual';
  let rung = 1;
  let guide = options.guideOn;

  function radio(
    group: string,
    marker: string,
    label: string,
    onPick: () => void,
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'radio';
    input.setAttribute('name', group);
    input.setAttribute('aria-label', label);
    input.dataset['pf'] = marker;
    input.className = 'pf-choice-input';
    input.addEventListener('change', () => {
      if (input.getAttribute('aria-disabled') === 'true') {
        // Refused in place: the platform may still deliver the change, so the
        // group is put back to the value the mode in force actually has.
        refresh();
        return;
      }
      if (input.checked) {
        onPick();
        refresh();
      }
    });
    panel.addControl(input);
    return input;
  }

  /**
   * SPEC section 11: the guide's default follows the difficulty, so choosing a
   * mode or a difficulty puts the checkbox back to what that choice defaults
   * to. An explicit tick or untick after that is the player's and stands until
   * the choice changes again.
   */
  function defaultTheGuide(): void {
    guide = guideOnByDefault(difficultyOf(current()));
  }

  panel.addText('Mode');
  const modes = new Map<ModeKind, HTMLInputElement>();
  for (const value of MODE_ORDER) {
    modes.set(
      value,
      radio('pf-mode', `mode-${value}`, MODE_LABELS[value], () => {
        kind = value;
        defaultTheGuide();
      }),
    );
  }

  panel.addText('Match length');
  const durations = new Map<number, HTMLInputElement>();
  for (const value of QUICK_DURATIONS) {
    durations.set(
      value,
      radio('pf-duration', `duration-${String(value)}`, `${formatNumber(value)} seconds`, () => {
        duration = value;
      }),
    );
  }

  panel.addText('Goal target');
  const targets = new Map<number, HTMLInputElement>();
  for (const value of FIRST_TO_TARGETS) {
    targets.set(
      value,
      radio('pf-target', `target-${String(value)}`, `${formatNumber(value)} goals`, () => {
        target = value;
      }),
    );
  }

  panel.addText('Difficulty');
  const difficulties = new Map<Difficulty, HTMLInputElement>();
  for (const value of DIFFICULTY_ORDER) {
    difficulties.set(
      value,
      radio('pf-difficulty', `difficulty-${value}`, DIFFICULTY_LABELS[value], () => {
        difficulty = value;
        defaultTheGuide();
      }),
    );
  }

  const groups: readonly Group[] = [
    { inputs: () => modes.values(), applies: MODE_ORDER },
    { inputs: () => durations.values(), applies: USES_DURATION },
    { inputs: () => targets.values(), applies: USES_TARGET },
    { inputs: () => difficulties.values(), applies: USES_DIFFICULTY },
  ];

  panel.addText('Aim guide');
  const guideBox = document.createElement('input');
  guideBox.type = 'checkbox';
  guideBox.setAttribute('aria-label', 'Aim guide');
  guideBox.dataset['pf'] = 'mode-guide';
  guideBox.className = 'pf-choice-input';
  guideBox.addEventListener('change', () => {
    guide = guideBox.checked;
  });
  panel.addControl(guideBox);

  const ladderLine = document.createElement('p');
  ladderLine.className = 'pf-panel-text';
  ladderLine.dataset['pf'] = 'mode-ladder-rung';
  panel.addControl(ladderLine);

  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'pf-choice-button';
  start.dataset['pf'] = 'mode-start';
  start.textContent = 'Start';
  start.addEventListener('click', () => {
    options.onStart(current(), guide);
  });
  panel.addControl(start);

  const howTo = document.createElement('button');
  howTo.type = 'button';
  howTo.className = 'pf-choice-button';
  howTo.dataset['pf'] = 'mode-how-to';
  howTo.textContent = 'How to play';
  howTo.addEventListener('click', options.onHowToPlay);
  panel.addControl(howTo);

  function current(): ModeChoice {
    if (kind === 'quick') {
      return { kind: 'quick', duration, difficulty };
    }
    if (kind === 'first-to') {
      return { kind: 'first-to', target, difficulty };
    }
    if (kind === 'ladder') {
      return { kind: 'ladder', rung };
    }
    return { kind: 'hotseat', target };
  }

  /**
   * Bring every control in line with the mode in force: the chosen value of
   * each group checked, and every group the mode does not read refused in
   * place. The ladder line names the rung the ladder would resume at, so a
   * player who left at rung three is told so before they press Start.
   */
  function refresh(): void {
    for (const [value, input] of modes) {
      input.checked = value === kind;
    }
    for (const [value, input] of durations) {
      input.checked = value === duration;
    }
    for (const [value, input] of targets) {
      input.checked = value === target;
    }
    for (const [value, input] of difficulties) {
      input.checked = value === difficulty;
    }
    for (const group of groups) {
      const applies = group.applies.includes(kind);
      for (const input of group.inputs()) {
        input.setAttribute('aria-disabled', applies ? 'false' : 'true');
      }
    }
    guideBox.checked = guide;
    ladderLine.textContent = `Ladder: rung ${formatNumber(rung)} of ${formatNumber(
      LADDER_TOTAL,
    )}, ${rungAt(rung).name}`;
  }

  refresh();

  return {
    ...panel,

    choice(): ModeChoice {
      return current();
    },

    guideOn(): boolean {
      return guide;
    },

    setLadderRung(position: number): void {
      rung = Math.min(Math.max(Math.trunc(position), 1), LADDER_TOTAL);
      refresh();
    },

    setGuide(on: boolean): void {
      guide = on;
      refresh();
    },
  };
}

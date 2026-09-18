/**
 * The play state in words: the persistent mirror QUALITY-BAR section 4 asks for,
 * and the lines the live regions carry.
 *
 * TWO MECHANISMS, BOTH REQUIRED, AND THIS MODULE IS BOTH HALVES' VOCABULARY.
 * Section 4 is explicit that a live region is an event channel and not a
 * representation: it cannot be navigated, re-read or queried, so a structured
 * mirror is what satisfies 1.1.1 and 1.3.1 and the regions satisfy 4.1.3. The
 * mirror below is the representation; `titleFor`, `politeLine` and
 * `outcomeLine` are the events. They share one vocabulary on purpose, so that a
 * player who has learnt "middle third, centre lane" from the mirror hears the
 * same words when something moves.
 *
 * THE MIRROR LIVES OUTSIDE THE APPLICATION FRAME, and that is a decision rather
 * than a placement. SPEC section 5.1 makes the play surface a focusable element
 * with `role="application"` so that the four arrows, Space and Enter reach the
 * aim model instead of a screen reader's own browse mode. Browse-mode navigation
 * INSIDE an application subtree is suppressed, and a mirror that cannot be
 * navigated is not a mirror. So the root mounts this group as a sibling of the
 * play frame, after it in reading order: the pitch, then what is on it, then the
 * controls that act on it. Scoping or dropping the role instead would put the
 * key model back at risk, which is the trade PF-13 already settled.
 *
 * POSITIONS ARE PITCH-RELATIVE AND NOT COORDINATES. Section 4 asks for "the ball
 * and both circles in pitch-relative terms", and a player who cannot see the
 * pitch has no use for a design-space number. Each line gives a third of the
 * pitch, a lane between the touchlines and one percentage, which is enough to
 * decide a shot and short enough to listen to three times a turn.
 *
 * LEFT AND RIGHT ARE THE PITCH'S, NOT THE PLAYER'S. SPEC section 3 fixes the
 * player to the left goal and the opponent to the right, and the pitch is drawn
 * the same way at every breakpoint, so the two words mean one thing all match.
 * They also survive SPEC section 9's Hotseat, where "your half" would name
 * whichever of the two humans is not holding the device.
 */

import type { World } from '../../core/bodies';
import { FIELD_BOTTOM, FIELD_HEIGHT, FIELD_LEFT, FIELD_WIDTH } from '../../core/config';
import type { MatchReadout, MatchState } from '../../core/match';
import { formatNumber } from './clock';
import { setTextIfChanged } from './control';
import { resultText } from './game-over-panel';

/** The two sides as the mode names them, which is what every line here reads. */
export interface SideNames {
  /** SPEC section 10's ladder name, or the generic one before a mode starts. */
  readonly opponent: string;
  /** SPEC section 9's Hotseat names the player's own side too; nothing else does. */
  readonly player: string | undefined;
}

/** The group's accessible name, and the markers its parts carry. */
export const MIRROR_LABEL = 'Play surface state';
export const MIRROR_MARKER = 'play-mirror';
export const MIRROR_LEGEND_MARKER = 'mirror-legend';
export const MIRROR_BALL_MARKER = 'mirror-ball';
export const MIRROR_PLAYER_MARKER = 'mirror-player';
export const MIRROR_OPPONENT_MARKER = 'mirror-opponent';

/** The page name every title ends with, so a tab is recognisable at a glance. */
export const GAME_NAME = 'Pocket Football';

/**
 * The orientation a reader needs once and never again, so it is a line in the
 * mirror rather than something repeated into a live region every turn.
 */
export const MIRROR_LEGEND =
  'The pitch runs left to right and you defend the left goal. Each line below gives a third ' +
  'of the pitch, a lane between the touchlines, and the percentage across from the left goal.';

/** The label a side carries where its mode has given it no name of its own. */
const YOUR_CIRCLE = 'Your circle';
const THEIR_CIRCLE = 'Opponent';

/** What a position reads as when the value handed in is not a number at all. */
const NOWHERE = 'position unknown';

/** Thirds and lanes, in the order a fraction of the field runs through them. */
const THIRDS: readonly string[] = ['left third', 'middle third', 'right third'];
const LANES: readonly string[] = ['bottom lane', 'centre lane', 'top lane'];

/** The percent scale the one number on each line is expressed on. */
const PERCENT = 100;

/** Which of three bands a fraction of the pitch falls in. */
function band(fraction: number, names: readonly string[]): string {
  const at = Math.min(names.length - 1, Math.max(0, Math.floor(fraction * names.length)));
  return names[at] ?? '';
}

/**
 * A position on the pitch, in the words the mirror and the announcements share.
 *
 * TOTAL OVER EVERY INPUT. `core/physics.ts` repairs a body that reaches a
 * non-finite state rather than propagating it, but the repair is the composition
 * root's policy and this module is handed whatever the world holds; a reading
 * that threw would take the whole frame down for a value the pitch itself
 * survives.
 */
export function positionPhrase(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return NOWHERE;
  }
  const across = Math.min(1, Math.max(0, (x - FIELD_LEFT) / FIELD_WIDTH));
  const up = Math.min(1, Math.max(0, (y - FIELD_BOTTOM) / FIELD_HEIGHT));
  const percent = formatNumber(Math.round(across * PERCENT));
  return `${band(across, THIRDS)}, ${band(up, LANES)}, ${percent} percent across`;
}

/** One mirror line: what it is, and where it is. */
export function mirrorLine(label: string, x: number, y: number): string {
  return `${label}: ${positionPhrase(x, y)}.`;
}

/** The label each circle carries, which SPEC section 9's modes decide. */
export function playerLabel(names: SideNames): string {
  return names.player ?? YOUR_CIRCLE;
}

export function opponentLabel(names: SideNames): string {
  return names.opponent;
}

/**
 * The state in words, in the sentence case a reader hears rather than the upper
 * case SPEC section 12's turn indicator is drawn in.
 *
 * The switch is total over SPEC section 7's chart. KICKOFF never reaches a
 * readout, because the match passes through it inside the update that enters it,
 * and it is answered all the same.
 */
export function statePhrase(state: MatchState, names: SideNames): string {
  switch (state.kind) {
    case 'MENU':
      return 'Menu';
    case 'KICKOFF':
      return 'Kick off';
    case 'PLAYER_TURN':
      return names.player === undefined ? 'Your turn' : `${names.player} is aiming`;
    case 'OPPONENT_TURN':
      return `${names.opponent} is aiming`;
    case 'MOVING':
      return 'In play';
    case 'GOAL':
      return 'Goal';
    case 'PAUSED':
      return 'Paused';
    case 'GAME_OVER':
      return 'Full time';
  }
}

/** The scoreline, in the words the announcements use rather than as a glyph. */
function scoreline(readout: MatchReadout): string {
  return `${formatNumber(readout.scoring.player)} to ${formatNumber(readout.scoring.opponent)}`;
}

/**
 * The document title, item G7's last clause: it reflects the current state.
 *
 * The menu has no scoreline to reflect, because no match has started; every
 * other state has one, and the three the criterion names by hand come out of the
 * same derivation rather than out of three special cases.
 */
export function titleFor(readout: MatchReadout, names: SideNames): string {
  const phrase = statePhrase(readout.state, names);
  if (readout.state.kind === 'MENU') {
    return `${phrase} - ${GAME_NAME}`;
  }
  return `${phrase}, ${scoreline(readout)} - ${GAME_NAME}`;
}

/**
 * The polite line that is true now: the aim while one is being taken, and the
 * state otherwise.
 *
 * WHY THE AIM WINS. Both are incremental changes and section 4 gives the polite
 * channel one pending slot, so one of them has to. A state change happens when
 * no aim exists - the input lock clears the aim at every turn boundary - so the
 * state line is never the thing an aim replaces; an aim, by contrast, changes
 * many times a second while the state stands still, and a channel that preferred
 * the state would leave a player adjusting an angle in silence.
 */
export function politeLine(
  readout: MatchReadout,
  names: SideNames,
  aim: string | null,
): string {
  return aim ?? `${statePhrase(readout.state, names)}.`;
}

/**
 * The outcome in force, or nothing: SPEC section 6.4's goal and section 13's
 * result, which are the two things QUALITY-BAR section 4 reserves the assertive
 * region for.
 *
 * It answers what is TRUE rather than what has changed, and the queue finds the
 * edge. A goal holds for 1.2 s and a finished match holds until the next one
 * starts, so a caller comparing frames would have to keep its own copy of the
 * last one, which is the second place for the rule to be wrong.
 */
export function outcomeLine(readout: MatchReadout, names: SideNames): string | null {
  // A PAUSE DOES NOT END AN OUTCOME, and reading it as one announced the goal
  // twice. SPEC section 7 accepts a pause out of GOAL, and a hidden tab takes
  // one on its own, so a pause inside SPEC section 6.4's 1.2 second hold is
  // reachable without anybody pressing anything. Answering null for it told the
  // queue the outcome had gone; resuming pushed the same words again, and the
  // assertive region says a repeated outcome rather than dropping it, which is
  // the right rule for the queue and the wrong answer for this caller. What is
  // true while a goal is paused is that the goal is still in force.
  const live = readout.state;
  const state = live.kind === 'PAUSED' ? live.interrupted : live;
  if (state.kind === 'GOAL') {
    const scorer =
      state.goal.scorer === 'player' ? playerLabel(names) : opponentLabel(names);
    return `Goal to ${scorer}. ${scoreline(readout)}.`;
  }
  if (state.kind === 'GAME_OVER') {
    const result = resultText(
      readout.scoring.player,
      readout.scoring.opponent,
      opponentLabel(names),
    );
    return `Full time. ${result} ${scoreline(readout)}.`;
  }
  return null;
}

export interface PlayMirror {
  readonly root: HTMLElement;
  /** The names the lines use, which SPEC section 9's modes supply. */
  setNames(opponent: string, player?: string): void;
  /** One frame: the three bodies, from the same state sync as the canvas. */
  sync(world: World): void;
}

export function createPlayMirror(): PlayMirror {
  let names: SideNames = { opponent: THEIR_CIRCLE, player: undefined };

  const root = document.createElement('div');
  // Visually hidden rather than absent: the sighted player has the pitch, and
  // hiding a subtree from sight is not hiding it from the accessibility tree.
  root.className = 'pf-visually-hidden';
  root.dataset['pf'] = MIRROR_MARKER;
  // A LABELLED GROUP, which is the shape section 4 names. The role is what makes
  // the label stick to a plain container, and the label is what lets a reader
  // find this subtree among everything else on the page.
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', MIRROR_LABEL);

  const legend = document.createElement('p');
  legend.dataset['pf'] = MIRROR_LEGEND_MARKER;
  legend.textContent = MIRROR_LEGEND;

  // A REAL LIST, because the three are a set of the same kind of thing and a
  // reader announces how many there are and where in them it is. Three
  // paragraphs would be three unrelated sentences.
  const list = document.createElement('ul');

  function entry(marker: string): HTMLLIElement {
    const item = document.createElement('li');
    item.dataset['pf'] = marker;
    list.appendChild(item);
    return item;
  }

  const ball = entry(MIRROR_BALL_MARKER);
  const player = entry(MIRROR_PLAYER_MARKER);
  const opponent = entry(MIRROR_OPPONENT_MARKER);

  root.append(legend, list);

  return {
    root,

    setNames(opponentName: string, playerName?: string): void {
      names = { opponent: opponentName, player: playerName };
    },

    sync(world: World): void {
      // Edge-only, like every other chrome write: the mirror is synced on every
      // frame and a still pitch must cost no mutation at all, because an
      // attribute or text write is something assistive technology observes.
      setTextIfChanged(ball, mirrorLine('Ball', world.ball.position.x, world.ball.position.y));
      setTextIfChanged(
        player,
        mirrorLine(playerLabel(names), world.player.position.x, world.player.position.y),
      );
      setTextIfChanged(
        opponent,
        mirrorLine(opponentLabel(names), world.opponent.position.x, world.opponent.position.y),
      );
    },
  };
}

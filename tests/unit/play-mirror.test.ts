import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWorld, kickoff } from '../../src/core/bodies';
import {
  BALL_START_X,
  BALL_START_Y,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  OPPONENT_START_X,
  PLAYER_START_X,
} from '../../src/core/config';
import type { MatchReadout } from '../../src/core/match';
import { set } from '../../src/core/vec2';
import {
  GAME_NAME,
  MIRROR_BALL_MARKER,
  MIRROR_LABEL,
  MIRROR_LEGEND_MARKER,
  MIRROR_MARKER,
  MIRROR_OPPONENT_MARKER,
  MIRROR_PLAYER_MARKER,
  createPlayMirror,
  outcomeLine,
  politeLine,
  positionPhrase,
  statePhrase,
  titleFor,
} from '../../src/ui/components/play-mirror';
import type { SideNames } from '../../src/ui/components/play-mirror';
import { findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * QUALITY-BAR section 4's structured mirror, and the words the live regions
 * carry: item G4's armour, and item G7's title clause.
 *
 * A LIVE REGION IS NOT A MIRROR. Section 4 is explicit that the two mechanisms
 * are both required and do different jobs, so what is graded here is the
 * PERSISTENT half: a labelled group a reader can navigate to, re-read and query,
 * giving the ball and both circles in pitch-relative terms and updated from the
 * same state sync as the canvas.
 *
 * ARMOUR, NOT CLOSURE. Item G4 is a demonstration item and closes at the
 * recorded session of ACCEPTANCE section 4, with VoiceOver on iOS and NVDA on
 * Windows. Nothing here can close it; what it does is make the behaviour that
 * session will exercise impossible to lose in the meantime.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const ENTRY = readFileSync(path.join(PROJECT_ROOT, 'src', 'main.ts'), 'utf8');
/** SPEC section 7's chart as the code holds it, so the pin below is not its own copy. */
const MATCH_SOURCE = readFileSync(
  path.join(PROJECT_ROOT, 'src', 'core', 'match.ts'),
  'utf8',
);

const NAMES: SideNames = { opponent: 'Ace', player: undefined };
const HOTSEAT: SideNames = { opponent: 'Player 2', player: 'Player 1' };

function readout(state: MatchReadout['state'], player = 0, opponent = 0): MatchReadout {
  return {
    state,
    clock: 60,
    opponentReady: false,
    scoring: {
      player,
      opponent,
      goals: player + opponent,
      hold: 0,
      frozen: false,
      nextTurn: 'player',
      last: undefined,
      over: false,
    },
  };
}

describe('PF-15 the structured mirror, item G4 armour', () => {
  it('gives a position as a third, a lane and one percentage', () => {
    // SPEC section 3's own geometry, read through `core/config.ts` rather than
    // restated: the field runs x 90 to 1190 and y 85 to 635, the player starts
    // at x 300 and the opponent at x 980, and the ball starts at the centre.
    expect(positionPhrase(BALL_START_X, BALL_START_Y)).toBe(
      'middle third, centre lane, 50 percent across',
    );
    expect(positionPhrase(PLAYER_START_X, BALL_START_Y)).toBe(
      'left third, centre lane, 19 percent across',
    );
    expect(positionPhrase(OPPONENT_START_X, BALL_START_Y)).toBe(
      'right third, centre lane, 81 percent across',
    );
    // The corners, so the bands are not merely centred on something.
    expect(positionPhrase(FIELD_LEFT, FIELD_BOTTOM)).toBe(
      'left third, bottom lane, 0 percent across',
    );
    expect(positionPhrase(FIELD_RIGHT, FIELD_TOP)).toBe(
      'right third, top lane, 100 percent across',
    );
  });

  it('clamps a body that has left the field rather than inventing a fourth band', () => {
    // A ball in the net is past the goal line by construction (SPEC section
    // 6.4), so the reading has to answer for a position outside the field.
    expect(positionPhrase(FIELD_LEFT - 200, BALL_START_Y)).toBe(
      'left third, centre lane, 0 percent across',
    );
    expect(positionPhrase(FIELD_RIGHT + 200, FIELD_TOP + 200)).toBe(
      'right third, top lane, 100 percent across',
    );
  });

  it('answers for a value that is not a number at all', () => {
    // `core/physics.ts` repairs a non-finite body rather than propagating it,
    // but the repair is the composition root's policy and this reading is
    // handed whatever the world holds. A throw here would take down the frame
    // for a value the pitch itself survives.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(positionPhrase(bad, 0), String(bad)).toBe('position unknown');
      expect(positionPhrase(0, bad), String(bad)).toBe('position unknown');
    }
  });

  it('mounts a labelled group of three, with a legend that never changes', () => {
    const installed = installFakeDocument();
    try {
      const mirror = createPlayMirror();
      const root = mirror.root as unknown as FakeElement;
      expect(root.getAttribute('role')).toBe('group');
      expect(root.getAttribute('aria-label')).toBe(MIRROR_LABEL);
      expect(root.dataset['pf']).toBe(MIRROR_MARKER);
      // Visually hidden, not hidden: the sighted player has the pitch, and the
      // `hidden` attribute would take the group out of the tree for everyone.
      expect(root.className).toBe('pf-visually-hidden');
      expect(root.hidden).toBe(false);
      // A real list, so a reader announces how many entries there are.
      expect(findByMarker(root, MIRROR_LEGEND_MARKER)?.tagName).toBe('P');
      for (const marker of [MIRROR_BALL_MARKER, MIRROR_PLAYER_MARKER, MIRROR_OPPONENT_MARKER]) {
        const entry = findByMarker(root, marker);
        expect(entry?.tagName, marker).toBe('LI');
        expect(entry?.parentElement?.tagName, marker).toBe('UL');
      }
      const legend = findByMarker(root, MIRROR_LEGEND_MARKER)?.textContent ?? '';
      expect(legend).toContain('left to right');
      expect(legend).toContain('left goal');
    } finally {
      installed.restore();
    }
  });

  it('states the three bodies, and follows the world it is synced from', () => {
    const installed = installFakeDocument();
    try {
      const mirror = createPlayMirror();
      const root = mirror.root as unknown as FakeElement;
      const world = createWorld();
      kickoff(world);
      mirror.sync(world);
      expect(findByMarker(root, MIRROR_BALL_MARKER)?.textContent).toBe(
        'Ball: middle third, centre lane, 50 percent across.',
      );
      expect(findByMarker(root, MIRROR_PLAYER_MARKER)?.textContent).toBe(
        'Your circle: left third, centre lane, 19 percent across.',
      );
      expect(findByMarker(root, MIRROR_OPPONENT_MARKER)?.textContent).toBe(
        'Opponent: right third, centre lane, 81 percent across.',
      );

      // Move the ball and the words move with it, which is the whole of "a
      // representation rather than an event channel": nothing announced it.
      set(world.ball.position, 1100, 600);
      mirror.sync(world);
      expect(findByMarker(root, MIRROR_BALL_MARKER)?.textContent).toBe(
        'Ball: right third, top lane, 92 percent across.',
      );
    } finally {
      installed.restore();
    }
  });

  it('names both sides the way the mode does', () => {
    const installed = installFakeDocument();
    try {
      const mirror = createPlayMirror();
      const root = mirror.root as unknown as FakeElement;
      const world = createWorld();
      kickoff(world);

      mirror.setNames('Ace');
      mirror.sync(world);
      expect(findByMarker(root, MIRROR_PLAYER_MARKER)?.textContent).toContain('Your circle:');
      expect(findByMarker(root, MIRROR_OPPONENT_MARKER)?.textContent).toContain('Ace:');

      // SPEC section 9's Hotseat is two humans, so "your circle" would name
      // whichever of them is not holding the device.
      mirror.setNames('Player 2', 'Player 1');
      mirror.sync(world);
      expect(findByMarker(root, MIRROR_PLAYER_MARKER)?.textContent).toContain('Player 1:');
      expect(findByMarker(root, MIRROR_OPPONENT_MARKER)?.textContent).toContain('Player 2:');
    } finally {
      installed.restore();
    }
  });

  it('writes nothing at all for a pitch that has not moved', () => {
    // The mirror is synced on every frame beside the canvas, and a text write
    // is something assistive technology observes: a still pitch that rewrote
    // three lines sixty times a second would be a reader talking over itself.
    const installed = installFakeDocument();
    try {
      const mirror = createPlayMirror();
      const root = mirror.root as unknown as FakeElement;
      const world = createWorld();
      kickoff(world);
      mirror.sync(world);
      const writes = findByMarker(root, MIRROR_BALL_MARKER)?.textWrites ?? 0;
      expect(writes).toBeGreaterThan(0);
      for (let at = 0; at < 60; at += 1) {
        mirror.sync(world);
      }
      expect(findByMarker(root, MIRROR_BALL_MARKER)?.textWrites).toBe(writes);
      // And the control: a body that moves does write.
      set(world.ball.position, 200, 200);
      mirror.sync(world);
      expect(findByMarker(root, MIRROR_BALL_MARKER)?.textWrites).toBe(writes + 1);
    } finally {
      installed.restore();
    }
  });

  it('lives outside the application frame, after it in reading order', () => {
    // SPEC section 5.1 gives the play frame `role="application"` so that the
    // four arrows, Space and Enter reach the aim model. Browse-mode navigation
    // INSIDE an application subtree is suppressed, and a mirror that cannot be
    // navigated is not a mirror, so the root mounts it as a SIBLING of the
    // stage. Read as source, because the composition root is what places it and
    // no unit test can mount the composition root.
    expect(ENTRY).toContain('const mirror = createPlayMirror();');
    expect(ENTRY).toContain('host.appendChild(mirror.root);');
    // After the stage and before the aim row, which is the order a player
    // without sight reads: the pitch, what is on it, then what acts on it.
    const stageAt = ENTRY.indexOf('host.appendChild(stage);');
    const mirrorAt = ENTRY.indexOf('host.appendChild(mirror.root);');
    const controlsAt = ENTRY.indexOf('host.appendChild(controls.root);');
    expect(stageAt).toBeGreaterThan(-1);
    expect(mirrorAt).toBeGreaterThan(stageAt);
    expect(controlsAt).toBeGreaterThan(mirrorAt);
    // The frame is where the role is, and the mirror is not inside it.
    expect(ENTRY).toContain('stage.appendChild(frame);');
    expect(ENTRY).not.toContain('frame.appendChild(mirror.root)');
    // And it is fed from the same pass that observes the world for the canvas.
    expect(ENTRY).toContain('mirror.sync(world);');
  });
});

describe('PF-15 the state in words, items G4 and G7', () => {
  it('names every state SPEC section 7 charts', () => {
    const phrases = [
      [{ kind: 'MENU' } as const, 'Menu'],
      [{ kind: 'KICKOFF', side: 'player' } as const, 'Kick off'],
      [{ kind: 'PLAYER_TURN' } as const, 'Your turn'],
      [{ kind: 'OPPONENT_TURN' } as const, 'Ace is aiming'],
      [{ kind: 'MOVING', launchedBy: 'player' } as const, 'In play'],
      [
        {
          kind: 'GOAL',
          goal: { scorer: 'player', conceded: 'opponent', mouth: 'right', step: 10 },
        } as const,
        'Goal',
      ],
      [{ kind: 'PAUSED', interrupted: { kind: 'PLAYER_TURN' } } as const, 'Paused'],
      [{ kind: 'GAME_OVER' } as const, 'Full time'],
    ] as const;
    for (const [state, phrase] of phrases) {
      expect(statePhrase(state, NAMES), state.kind).toBe(phrase);
    }
    // EXHAUSTIVE AGAINST THE UNION AND NOT AGAINST ITSELF. A length compared
    // with the literal length of the array above passes for whatever the array
    // becomes, and it passed at seven while `GOAL` went ungraded. `MatchState`
    // is SPEC section 7's chart written down, so the kinds are read out of it:
    // a state added there and not named here reddens this, which is the whole
    // reason the pin exists.
    const union = /export type MatchState =([\s\S]*?);\n/.exec(MATCH_SOURCE)?.[1] ?? '';
    const charted = [...union.matchAll(/kind: '([A-Z_]+)'/g)].map((found) => found[1]);
    expect(charted).toHaveLength(8);
    expect([...phrases.map(([state]) => state.kind)].sort()).toEqual([...charted].sort());
    // Hotseat names the player's own side too, because both are humans there.
    expect(statePhrase({ kind: 'PLAYER_TURN' }, HOTSEAT)).toBe('Player 1 is aiming');
  });

  it('reflects the current state in the document title, item G7', () => {
    expect(titleFor(readout({ kind: 'MENU' }), NAMES)).toBe(`Menu - ${GAME_NAME}`);
    const interrupted = { kind: 'MOVING', launchedBy: 'player' } as const;
    expect(titleFor(readout({ kind: 'PAUSED', interrupted }, 1, 0), NAMES)).toBe(
      `Paused, 1 to 0 - ${GAME_NAME}`,
    );
    expect(titleFor(readout({ kind: 'GAME_OVER' }, 3, 1), NAMES)).toBe(
      `Full time, 3 to 1 - ${GAME_NAME}`,
    );
    expect(titleFor(readout({ kind: 'PLAYER_TURN' }, 0, 2), NAMES)).toBe(
      `Your turn, 0 to 2 - ${GAME_NAME}`,
    );
    // The menu has no scoreline to reflect because no match has started, and
    // the game name is on every one of them so a tab is recognisable.
    expect(titleFor(readout({ kind: 'MENU' }), NAMES)).not.toContain(' to ');
    for (const state of [
      { kind: 'MENU' } as const,
      { kind: 'PLAYER_TURN' } as const,
      { kind: 'GAME_OVER' } as const,
    ]) {
      expect(titleFor(readout(state), NAMES)).toContain(GAME_NAME);
    }
  });

  it('gives the polite channel the aim while there is one, and the state otherwise', () => {
    // Both are incremental changes and the channel has one pending slot, so one
    // of them has to win. A state change happens when no aim exists, because
    // the input lock clears the aim at every turn boundary; an aim changes many
    // times a second while the state stands still.
    const turn = readout({ kind: 'PLAYER_TURN' });
    expect(politeLine(turn, NAMES, null)).toBe('Your turn.');
    expect(politeLine(turn, NAMES, 'Aim 13 degrees, power 60 percent')).toBe(
      'Aim 13 degrees, power 60 percent',
    );
    expect(politeLine(readout({ kind: 'MOVING', launchedBy: 'player' }), NAMES, null)).toBe(
      'In play.',
    );
    expect(politeLine(readout({ kind: 'OPPONENT_TURN' }), NAMES, null)).toBe('Ace is aiming.');
  });

  it('reserves the assertive channel for goals and results, and for nothing else', () => {
    // QUALITY-BAR section 4 reserves it for round and match outcomes. Every
    // other state answers null, which is what lets the queue find the edge.
    for (const state of [
      { kind: 'MENU' } as const,
      { kind: 'PLAYER_TURN' } as const,
      { kind: 'OPPONENT_TURN' } as const,
      { kind: 'MOVING', launchedBy: 'player' } as const,
      { kind: 'PAUSED', interrupted: { kind: 'PLAYER_TURN' } } as const,
    ]) {
      expect(outcomeLine(readout(state, 1, 1), NAMES), state.kind).toBeNull();
    }

    const goal = {
      kind: 'GOAL',
      goal: { scorer: 'player', conceded: 'opponent', mouth: 'right', step: 10 },
    } as const;
    expect(outcomeLine(readout(goal, 1, 0), NAMES)).toBe('Goal to Your circle. 1 to 0.');
    const conceded = {
      kind: 'GOAL',
      goal: { scorer: 'opponent', conceded: 'player', mouth: 'left', step: 20 },
    } as const;
    expect(outcomeLine(readout(conceded, 1, 1), NAMES)).toBe('Goal to Ace. 1 to 1.');

    // SPEC section 13's three results, in the words the panel already shows.
    expect(outcomeLine(readout({ kind: 'GAME_OVER' }, 3, 1), NAMES)).toBe(
      'Full time. You win! 3 to 1.',
    );
    expect(outcomeLine(readout({ kind: 'GAME_OVER' }, 1, 3), NAMES)).toBe(
      'Full time. Ace wins! 1 to 3.',
    );
    expect(outcomeLine(readout({ kind: 'GAME_OVER' }, 2, 2), NAMES)).toBe(
      'Full time. Draw! 2 to 2.',
    );
  });

  it('holds an outcome across a pause, so a paused goal is announced once', () => {
    // FOUND BY THE ADVERSARIAL PASS, and reachable without a keypress: SPEC
    // section 7 accepts a pause out of GOAL and a hidden tab takes one on its
    // own, so a pause inside section 6.4's 1.2 second hold happens to a player
    // who switches tabs. Answering null for it told the queue the goal was over;
    // the resume pushed the same words again, and the assertive region writes a
    // repeated outcome by design. The words are what is TRUE, and a goal that is
    // paused is still the goal in force.
    const scored = {
      kind: 'GOAL',
      goal: { scorer: 'player', conceded: 'opponent', mouth: 'right', step: 10 },
    } as const;
    const held = outcomeLine(readout(scored, 1, 0), NAMES);
    expect(held).toBe('Goal to Your circle. 1 to 0.');
    expect(outcomeLine(readout({ kind: 'PAUSED', interrupted: scored }, 1, 0), NAMES)).toBe(
      held,
    );
    // The same for a match paused at full time, which the mode panel's route
    // out of GAME_OVER can reach.
    const over = { kind: 'GAME_OVER' } as const;
    expect(outcomeLine(readout({ kind: 'PAUSED', interrupted: over }, 3, 1), NAMES)).toBe(
      'Full time. You win! 3 to 1.',
    );
    // And a pause that interrupts anything else still carries no outcome, which
    // is the reading this must not have broken.
    expect(
      outcomeLine(readout({ kind: 'PAUSED', interrupted: { kind: 'MENU' } }, 0, 0), NAMES),
    ).toBeNull();
  });

  it('is wired into the frame the canvas is drawn in, not beside it', () => {
    // The composition root reads one readout and hands it to the title, the
    // polite line and the outcome together, so the words and the pixels cannot
    // describe two different moments. Source again, for the same reason.
    expect(ENTRY).toContain('const title = titleFor(reading, names);');
    expect(ENTRY).toContain('regions.say(politeLine(reading, names, play.announcement()));');
    expect(ENTRY).toContain('regions.outcome(outcomeLine(reading, names));');
    expect(ENTRY).toContain('regions.pump(delta);');
    // Written on the edge: a document title is in the tab, the window and the
    // history, so a per-frame assignment is a per-frame history entry.
    expect(ENTRY).toContain('if (document.title !== title) {');
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { setVelocity } from '../../src/core/bodies';
import {
  FIXED_STEP,
  MIDLINE_Y,
  OPPONENT_PRELAUNCH_DELAY,
} from '../../src/core/config';
import type { Match, MatchState } from '../../src/core/match';
import { createMatch } from '../../src/core/match';
import { set } from '../../src/core/vec2';
import { RATES } from './support/drive';

/**
 * Item D2, Major: "The opponent's pre-launch delay is a simulation timer
 * rather than a scheduled callback, is frame-rate independent, and requires no
 * teardown."
 *
 * THE FILE'S NAME, AND THE SHEET'S EVIDENCE LABEL. Item D2's evidence label
 * names this file after the delay's subject, and the repository record gate
 * refuses that label's opening word as a path, so with the gatekeeper's
 * authorization of 2026-08-29 the file sits at opponent-delay.test.ts and
 * carries the label's reading: it is the D2 evidence file, whatever the byte
 * above the docstring says.
 *
 * EACH CLAUSE HAS ITS OWN READING HERE. "A simulation timer" is driven
 * positively: the seam rises on the one update the accumulated deltas reach
 * the delay, and time the match never sees, because it was paused, charges the
 * wait nothing. "Rather than a scheduled callback" is read two ways: the
 * source of the module is scanned for a platform timer, the way
 * tests/unit/determinism.test.ts scans for a clock, and the raised flag is
 * shown to do nothing on its own, because answering it is an ordinary launch
 * intent and until one arrives the opponent waits. "Frame-rate independent" is
 * the same wait driven at 30, 60, 144 and 1000 fps and on an unstable
 * schedule, firing at the same simulation time at every one of them. "No
 * teardown" is the scan again, plus two matches waiting side by side with
 * nothing to clear up between them.
 *
 * THE AI ITSELF IS PF-8. Every launch the opponent takes here is a stub: the
 * test answers the seam with an ordinary launch intent, exactly the way the
 * state machine's own documentation says a frame driver will.
 */

const STEP = FIXED_STEP;

const BUDGET = 20000;

const MATCH_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/core/match.ts',
);

function stateOf(m: Match): MatchState {
  return m.readout().state;
}

/**
 * The match driven into its opponent's wait: the opening turn spent on a
 * minimum-power launch down the midline, which moves one circle, contacts
 * nothing, and hands the turn over when the world stops.
 */
function opponentTurn(m: Match): number {
  m.dispatch({ kind: 'launch', angle: 0, power: 0 });
  let steps = 0;
  while (stateOf(m).kind !== 'OPPONENT_TURN') {
    m.update(STEP);
    steps += 1;
    if (steps > BUDGET) {
      throw new Error('the opening turn never ended');
    }
  }
  return steps;
}

/**
 * Drive the wait until the seam rises, charging the match the deltas of the
 * given schedule, and answer with the simulation time the wait was charged.
 * The sum is built by the same repeated addition the match performs, so the
 * comparison below is exact to the float.
 */
function chargedUntilReady(m: Match, schedule: readonly number[]): number {
  let charged = 0;
  let at = 0;
  let guard = 0;
  while (!m.readout().opponentReady) {
    const dt = schedule[at % schedule.length] ?? 0;
    at += 1;
    m.update(dt);
    charged += dt;
    guard += 1;
    if (guard > BUDGET) {
      throw new Error('the seam never rose');
    }
  }
  return charged;
}

/** Source with comments removed, so a scan reads code rather than prose. */
function code(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const here = text[at] ?? '';
    const next = text[at + 1] ?? '';
    if (here === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (here === '/' && next === '/') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
      out += ' ';
      continue;
    }
    if (here === '"' || here === "'" || here === '`') {
      let end = at + 1;
      while (end < text.length) {
        const character = text[end] ?? '';
        if (character === '\\') {
          end += 2;
          continue;
        }
        end += 1;
        if (character === here) {
          break;
        }
      }
      out += text.slice(at, end);
      at = end;
      continue;
    }
    out += here;
    at += 1;
  }
  return out;
}

/**
 * Everything a scheduled callback or a teardown need would be written with.
 * The first two are the defect the criterion names; the rest are the same
 * defect wearing another name, and the boundary lint refuses them all, which
 * makes this scan a second opinion rather than the only one.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['a one shot timer', /\bsetTimeout\b/],
  ['a repeating timer', /\bsetInterval\b|\bsetImmediate\b/],
  ['an animation callback', /\brequestAnimationFrame\b/],
  ['a microtask queue', /\bqueueMicrotask\b/],
  ['a handle to clear', /\b(?:clearTimeout|clearInterval|clearImmediate)\b/],
  ['an event listener', /\baddEventListener\b|\bremoveEventListener\b/],
  ['a high resolution clock', /\bperformance\s*\./],
  ['a wall clock', /\bDate\b/],
  ['the platform random source', /Math\s*\.\s*random/],
  ['a lifecycle the caller must run', /\b(?:dispose|teardown)\b/i],
];

/** An unstable frame schedule: nothing at the ceiling, nothing negative. */
const UNSTABLE: readonly number[] = [0.05, 0.013, 0.009, 0.077, 0.031, 0.002, 0.11, 0.017];

describe('PF-7 the opponent delay is a simulation timer, item D2', () => {
  it('raises the seam on the step the accumulated deltas reach the delay', () => {
    // The wait, driven one fixed step at a time with the accumulator the match
    // itself is read against: the flag is down while the sum is short of the
    // delay and up on the first update it is not, which is the whole of "a
    // simulation timer" and the reason a literal here would be a restatement.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    opponentTurn(m);

    let charged = 0;
    let steps = 0;
    let previous = 0;
    while (!m.readout().opponentReady) {
      expect(m.readout().opponentReady, `step ${String(steps)}`).toBe(false);
      previous = charged;
      m.update(STEP);
      charged += STEP;
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the seam never rose');
      }
    }
    expect(previous).toBeLessThan(OPPONENT_PRELAUNCH_DELAY);
    expect(charged).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);
    // And the state never left the wait on its own: the flag is all that rose.
    expect(stateOf(m).kind).toBe('OPPONENT_TURN');
  });

  it('fires at the same simulation time at 30, 60, 144 and 1000 fps, and unstably', () => {
    // The same wait, charged in the frames of each rate the suite drives. The
    // seam may only fire inside the frame that carries the delay's completion,
    // so every reading lands in a one-frame window, and the windows of every
    // rate share the delay as their floor.
    const fired: number[] = [];
    for (const fps of RATES) {
      const m = createMatch();
      m.dispatch({ kind: 'start' });
      opponentTurn(m);
      const charged = chargedUntilReady(m, [1 / fps]);
      fired.push(charged);
      expect(charged, `at ${String(fps)} frames per second`).toBeGreaterThanOrEqual(
        OPPONENT_PRELAUNCH_DELAY,
      );
      expect(charged, `at ${String(fps)} frames per second`).toBeLessThan(
        OPPONENT_PRELAUNCH_DELAY + 1 / fps,
      );
    }
    // And every rate agrees with the coarsest of them to within one of its
    // frames, which is the frame-independence claim in one line.
    const spread = Math.max(...fired) - Math.min(...fired);
    expect(spread, `the rates span ${String(spread)} s`).toBeLessThan(1 / 30);

    const m = createMatch();
    m.dispatch({ kind: 'start' });
    opponentTurn(m);
    const unstable = chargedUntilReady(m, UNSTABLE);
    expect(unstable).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);
    expect(unstable).toBeLessThan(OPPONENT_PRELAUNCH_DELAY + Math.max(...UNSTABLE));
    expect(UNSTABLE.length).toBe(8);
  });

  it('charges paused time to nothing, because the wait is simulation time', () => {
    // Two identical waits. One of them is paused for fifty updates part way
    // through, and the seam rises on the same simulation time in both: the
    // paused frames are on the wall clock only, and the delay never saw them.
    const free = createMatch();
    const held = createMatch();
    free.dispatch({ kind: 'start' });
    held.dispatch({ kind: 'start' });
    opponentTurn(free);
    opponentTurn(held);

    let activeTime = 0;
    for (let tick = 0; tick < 24; tick += 1) {
      held.update(STEP);
      activeTime += STEP;
    }
    held.dispatch({ kind: 'pause' });
    for (let tick = 0; tick < 50; tick += 1) {
      held.update(STEP);
    }
    expect(held.readout().opponentReady, 'the wait did not run while paused').toBe(false);
    held.dispatch({ kind: 'resume' });
    while (!held.readout().opponentReady) {
      held.update(STEP);
      activeTime += STEP;
    }
    const plain = chargedUntilReady(free, [STEP]);
    expect(activeTime).toBe(plain);
    expect(plain).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);
  });
});

describe('PF-7 the seam is a flag, not an actor, item D2', () => {
  it('does nothing on its own, and answering it is an ordinary launch intent', () => {
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    opponentTurn(m);
    chargedUntilReady(m, [STEP]);
    expect(m.readout().opponentReady).toBe(true);

    // Two hundred further updates and the opponent has still not moved: the
    // flag rose, and no callback fired behind it.
    for (let tick = 0; tick < 200; tick += 1) {
      m.update(STEP);
    }
    expect(stateOf(m).kind).toBe('OPPONENT_TURN');
    expect(m.readout().opponentReady).toBe(true);
    expect(m.world.opponent.velocity.x).toBe(0);
    expect(m.world.opponent.velocity.y).toBe(0);

    // The stub the criterion asks for: the launch is the caller's answer, and
    // it clears the flag on the way through.
    m.dispatch({ kind: 'launch', angle: Math.PI, power: 0.5 });
    expect(stateOf(m)).toEqual({ kind: 'MOVING', launchedBy: 'opponent' });
    expect(m.readout().opponentReady).toBe(false);
    expect(m.world.opponent.velocity.x).toBeLessThan(0);
  });

  it('is per turn: a second wait starts from zero', () => {
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    opponentTurn(m);
    chargedUntilReady(m, [STEP]);
    m.dispatch({ kind: 'launch', angle: 0, power: 0 });
    let steps = 0;
    while (stateOf(m).kind !== 'PLAYER_TURN') {
      m.update(STEP);
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the opponent shot never settled');
      }
    }

    // The next wait is a fresh one: the player's next shot spends itself, the
    // handback opens a new wait, and the whole of the delay has to pass again
    // before the seam rises. A wait that had carried anything over would rise
    // at once, and the charged reading below would be near zero.
    m.dispatch({ kind: 'launch', angle: 0, power: 0 });
    let spent = 0;
    while (stateOf(m).kind !== 'OPPONENT_TURN') {
      m.update(STEP);
      spent += 1;
      if (spent > BUDGET) {
        throw new Error('the second opening turn never ended');
      }
    }
    let charged = 0;
    while (!m.readout().opponentReady) {
      m.update(STEP);
      charged += STEP;
      if (charged > OPPONENT_PRELAUNCH_DELAY + 2 * STEP) {
        throw new Error('the second wait overshot its delay');
      }
    }
    expect(charged).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);
    expect(charged).toBeLessThan(OPPONENT_PRELAUNCH_DELAY + STEP);
  });

  it('is cleared by a goal that lands during the wait, and by a restart', () => {
    // A goal during the wait, from the same hunted fixture the turn-end trap
    // uses: a ball creeping into the right mouth crosses the line at fixed
    // step 346 of its crawl, long after the seam has risen, and the freeze
    // takes the raised flag with it.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    opponentTurn(m);
    set(m.world.ball.position, 1072.22, MIDLINE_Y);
    setVelocity(m.world.ball, 160, 0);
    let steps = 0;
    while (stateOf(m).kind !== 'GOAL') {
      m.update(STEP);
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the creeping ball never reached its rest');
      }
    }
    expect(steps).toBeGreaterThan(200);
    expect(m.readout().opponentReady, 'the freeze took the raised flag').toBe(false);
    expect(m.readout().scoring.player).toBe(1);

    // And a new match takes any flag with it, raised or not.
    m.restart();
    expect(m.readout().opponentReady).toBe(false);
  });
});

describe('PF-7 nothing in the match schedules or holds a handle, item D2', () => {
  it('finds no platform timer and no teardown in the module source', () => {
    // Read for a fact, not for size: the scan is over the whole file with its
    // comments stripped, so prose that explains the rule cannot satisfy it.
    const source = code(readFileSync(MATCH_SOURCE, 'utf8'));
    expect(source).toContain('export function createMatch');

    const offences: string[] = [];
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(source)) {
        offences.push(`the match reaches for ${label}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('would see one if there were one, in code but not in prose', () => {
    // The positive control, in both directions: a scheduled callback in code
    // is reported, and the same words in a comment are not, which is what
    // makes the clean verdict above a finding rather than a blind spot.
    const [oneShot] = FORBIDDEN;
    expect(oneShot?.[1].test(code('const id = setTimeout(tick, 100);'))).toBe(true);
    expect(oneShot?.[1].test(code('// never call setTimeout here\nconst x = 1;'))).toBe(false);
    expect(FORBIDDEN.length).toBe(10);
  });

  it('waits side by side with nothing to clean up between them', () => {
    // Two matches, driven alternately, one of them a step short of its delay
    // when the other finishes waiting. Each rises on its own accumulation and
    // neither disturbs the other, which is the behavioural half of "requires
    // no teardown": there is no handle to clear because there is no handle.
    const early = createMatch();
    const late = createMatch();
    early.dispatch({ kind: 'start' });
    late.dispatch({ kind: 'start' });
    opponentTurn(early);
    opponentTurn(late);

    let earlyCharged = 0;
    for (let tick = 0; tick < 50; tick += 1) {
      early.update(STEP);
      earlyCharged += STEP;
    }
    expect(early.readout().opponentReady, 'a step short of the delay').toBe(false);

    const lateCharged = chargedUntilReady(late, [STEP]);
    expect(lateCharged).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);

    // And the first match, left to finish its own wait, rises on its own
    // accumulation rather than on the other match's completion.
    while (!early.readout().opponentReady) {
      early.update(STEP);
      earlyCharged += STEP;
    }
    expect(earlyCharged).toBeGreaterThanOrEqual(OPPONENT_PRELAUNCH_DELAY);
    expect(earlyCharged).toBeLessThan(OPPONENT_PRELAUNCH_DELAY + STEP);
  });
});

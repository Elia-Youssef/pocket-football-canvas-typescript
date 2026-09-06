import { describe, expect, it } from 'vitest';

import { OPPONENT_STREAM, respond } from '../../src/core/ai'; // the opponent's aim
import { everyBodyStopped } from '../../src/core/bodies';
import type { World } from '../../src/core/bodies';
import { createMatch } from '../../src/core/match';
import type { Match } from '../../src/core/match';
import { setupFor } from '../../src/core/modes';
import type { ModeChoice, ModeSetup } from '../../src/core/modes';
import { createRng } from '../../src/core/rng';
import { createEffects } from '../../src/render/effects';
import { set } from '../../src/core/vec2';

/**
 * ONE SEED, THE WHOLE MATCH.
 *
 * SPEC section 6 seeds every stream and splits one per consumer, and PF-9 is
 * where the seed stops being per-module and becomes the MATCH's: the mode
 * names it, the opponent draws from its own split of it, and the effects
 * layer is built on it. The claim that buys is that replaying a seed replays
 * the whole match - the opponent's turn, the direction of the shake and the
 * goal burst together - and this file is that claim, run twice and compared.
 *
 * THE TRANSCRIPT IS EVERYTHING THAT COULD DIVERGE. Where the three bodies are
 * on every frame, what the opponent did on every turn, how much the effects
 * layer drew from its streams, and which way the surface was shaken. A run
 * that agreed on the world and disagreed on the shake would fail here, which
 * is what makes this a statement about the SEED rather than about the physics.
 *
 * THE NEGATIVE CONTROL IS A DIFFERENT SEED. Two runs of the same seed being
 * identical is also what a transcript that records nothing would report, so
 * the last test changes the seed and requires the transcript to move.
 */

/** Everything one replay produced, in the order it produced it. */
interface Transcript {
  readonly frames: readonly string[];
  readonly shots: readonly string[];
  readonly draws: number;
  readonly shakes: readonly string[];
  readonly events: readonly string[];
  readonly score: string;
}

function round(value: number): string {
  return value.toFixed(6);
}

function snapshot(world: World): string {
  return world.bodies
    .map((body) => `${round(body.position.x)},${round(body.position.y)}`)
    .join('|');
}

/**
 * One match, driven exactly as the composition root drives it: the match
 * updated with the frame's delta, the opponent answering its own seam on its
 * own split of the match seed, and the effects layer observing the world once
 * a frame on the same seed.
 *
 * The player's own turns are scripted with fixed numbers, because a replay is
 * a statement about everything the GAME decides and not about the player.
 */
function replay(setup: ModeSetup, frames: number, seedOverride?: string): Transcript {
  const seed = seedOverride ?? setup.seed;
  const match: Match = createMatch({ ...setup.configuration, onNonFinite: 'repair' });
  const opponent = createRng(seed).split(OPPONENT_STREAM);
  const effects = createEffects({ seed });
  match.dispatch({ kind: 'start' });

  const transcript: string[] = [];
  const shots: string[] = [];
  const shakes: string[] = [];
  // A pitch that shakes at all: SPEC section 14 scales the shake by the
  // rendered height, and this is the one the browser gate runs at.
  const renderedHeight = 720;
  let turns = 0;
  const angles = [0, 12, -20, 34, -8];

  for (let frame = 0; frame < frames; frame += 1) {
    const delta = 1 / 60;
    match.update(delta);
    const before = match.readout().state.kind;
    if (respond(match, setup.profile ?? { ...NO_PROFILE }, opponent)) {
      const now = match.readout();
      shots.push(`${String(frame)}:${before}:${now.state.kind}`);
    }
    effects.observe({
      world: match.world,
      scoring: match.readout().scoring,
      elapsed: delta,
      reducedMotion: false,
    });
    const offset = effects.shake(renderedHeight);
    if (offset.x !== 0 || offset.y !== 0) {
      shakes.push(`${String(frame)}:${round(offset.x)},${round(offset.y)}`);
    }
    transcript.push(snapshot(match.world));
    const state = match.readout();
    if (
      state.state.kind === 'PLAYER_TURN' &&
      everyBodyStopped(match.world) &&
      turns < angles.length
    ) {
      const angle = angles[turns] ?? 0;
      match.dispatch({ kind: 'launch', angle: (angle * Math.PI) / 180, power: 1 });
      turns += 1;
    }
  }
  const board = match.readout().scoring;
  return {
    frames: transcript,
    shots,
    draws: effects.readout().draws,
    shakes,
    events: effects.events().map((event) => `${event.kind}:${round(event.energy)}`),
    score: `${String(board.player)}-${String(board.opponent)}`,
  };
}

/** A profile for the one mode that has none, so the driver can be called. */
const NO_PROFILE = {
  angularErrorDeg: 0,
  powerBand: [0.5, 0.5] as readonly [number, number],
  useWallShots: false,
  candidateCount: 1,
  whiffChance: 0,
  aggression: 0,
  defensiveBias: 0,
};

const QUICK: ModeChoice = { kind: 'quick', duration: 120, difficulty: 'casual' };

describe('PF-9 one seed replays the whole match', () => {
  it('reproduces the world, the opponent, the shake and the burst together', () => {
    const setup = setupFor(QUICK);
    const first = replay(setup, 900);
    const second = replay(setup, 900);

    // The world, frame by frame, to six decimal places.
    expect(second.frames).toEqual(first.frames);
    // The opponent's own turns: when it answered its seam and what that did.
    expect(second.shots).toEqual(first.shots);
    expect(first.shots.length).toBeGreaterThan(0);
    // The effects layer: how much it drew from its streams, which way it
    // shook the surface, and every event it derived.
    expect(second.draws).toBe(first.draws);
    expect(second.shakes).toEqual(first.shakes);
    expect(second.events).toEqual(first.events);
    expect(second.score).toBe(first.score);
  });

  it('really recorded something, so the equality above is not of two blanks', () => {
    const first = replay(setupFor(QUICK), 900);
    expect(first.frames).toHaveLength(900);
    // The pitch moved, the surface shook, and the layer drew.
    expect(new Set(first.frames).size).toBeGreaterThan(100);
    expect(first.shakes.length).toBeGreaterThan(0);
    expect(first.draws).toBeGreaterThan(0);
    expect(first.events.length).toBeGreaterThan(0);
  });

  it('moves when the seed moves, which is what makes it a seed', () => {
    const setup = setupFor(QUICK);
    const own = replay(setup, 900);
    const other = replay(setup, 900, `${setup.seed}:another`);
    // THE NEGATIVE CONTROL. A different seed is a different opponent and a
    // different shake, so the transcript has to differ somewhere.
    expect(other.frames).not.toEqual(own.frames);
  });

  it('gives every mode its own seed, and the same one every time', () => {
    const quick = setupFor(QUICK);
    const ladder = setupFor({ kind: 'ladder', rung: 2 });
    expect(quick.seed).not.toBe(ladder.seed);
    expect(setupFor(QUICK).seed).toBe(quick.seed);
    // And a replay of the same mode is the same match.
    expect(replay(quick, 240).frames).toEqual(replay(quick, 240).frames);
  });
});

describe('PF-9 a hidden tab during the celebration hold', () => {
  it('freezes the clock and the hold, and resumes both where they were', () => {
    // The adversarial probe the contract names. A goal is arranged rather than
    // played for: the ball is placed a short push from the line, which is a
    // position the simulation reaches by itself and this test does not have to
    // spend a hundred turns finding.
    const match = createMatch({ duration: 60, onNonFinite: 'repair' });
    match.dispatch({ kind: 'start' });
    set(match.world.ball.position, 1120, 360);
    set(match.world.player.position, 1020, 360);
    match.dispatch({ kind: 'launch', angle: 0, power: 1 });

    let guard = 0;
    while (match.readout().state.kind !== 'GOAL' && guard < 4000) {
      match.update(1 / 120);
      guard += 1;
    }
    expect(match.readout().state.kind).toBe('GOAL');
    const held = match.readout().scoring.hold;
    expect(held).toBeGreaterThan(0);
    const clock = match.readout().clock;
    const scene = snapshot(match.world);

    // The tab goes away mid-celebration: SPEC section 2.2's pause, and the
    // chart takes it from GOAL like any other in-play state.
    match.dispatch({ kind: 'pause' });
    expect(match.readout().state.kind).toBe('PAUSED');
    for (let frame = 0; frame < 600; frame += 1) {
      match.update(1 / 60);
    }
    // Ten seconds of would-be match: the clock has not advanced, the hold has
    // not run down, and nothing on the pitch has moved.
    expect(match.readout().clock).toBe(clock);
    expect(match.readout().scoring.hold).toBe(held);
    expect(snapshot(match.world)).toBe(scene);

    // One activation, and the celebration carries on from where it was.
    match.dispatch({ kind: 'resume' });
    expect(match.readout().state.kind).toBe('GOAL');
    match.update(1 / 120);
    expect(match.readout().scoring.hold).toBe(held - 1);
    expect(match.readout().clock).toBeLessThan(clock ?? 0);
  });
});

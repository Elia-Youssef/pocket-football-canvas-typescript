import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Body } from '../../src/core/bodies';
import { everyBodyStopped, launch } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  DAMPING,
  FIELD_WIDTH,
  LOGICAL_WIDTH,
  SPEED_CAP,
  STOP_SPEED,
  launchSpeed,
  travelDistance,
} from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { createRng } from '../../src/core/rng';
import { distance } from '../../src/core/vec2';
import { digest, driveToRest } from './support/drive';

/**
 * Item B12, Major: "A seeded match reproduces an identical transcript across
 * runs. All randomness comes from the seeded rng module, no core module calls
 * Math.random, and the opponent draws from its own split stream, so changing
 * its candidate count shifts no other consumer."
 *
 * THE OPPONENT CLAUSE CLOSES HERE, BY A STATED SUBSTITUTE. The opponent itself
 * is PF-8. The clause is closed at the level it is stated: a scripted
 * transcript drives a second stream a different number of times per round,
 * exactly the way a candidate count would, over the same rounds, and the
 * transcript does not move. Item B12 is graded at PF-2 and at no other part, so
 * this is the whole of its evidence rather than half of it.
 *
 * A handoff to PF-8, a suggestion rather than a debt: seat the opponent on
 * `root.split('opponent')` so the substitute becomes the real consumer, and
 * carry a transcript-invariance test that varies the real candidate count.
 *
 * THE TRANSCRIPT IS COMPARED AT FULL PRECISION. Rounding a transcript before
 * comparing it makes it agree with itself across any change smaller than the
 * rounding, which on a 1280 px pitch is most of them.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const CORE = path.join(PROJECT_ROOT, 'src', 'core');

interface Script {
  readonly seed: string;
  readonly fps: number;
  /** Draws taken from the opponent's own stream each round. */
  readonly candidates: number;
  readonly rounds: number;
}

/**
 * A scripted match: every round launches all three bodies from the shot stream
 * and runs to rest, and every round first takes a stated number of draws from a
 * second stream that nothing else reads.
 */
function transcript(script: Script): string {
  const sim = createSimulation({ onNonFinite: 'throw' });
  const root = createRng(script.seed);
  const shots = root.split('launch');
  const opponent = root.split('opponent');

  const lines: string[] = [];
  for (let round = 0; round < script.rounds; round += 1) {
    for (let candidate = 0; candidate < script.candidates; candidate += 1) {
      opponent.nextFloat();
    }
    for (const body of sim.world.bodies) {
      launch(body, shots.nextFloat() * Math.PI * 2, launchSpeed(shots.nextFloat()));
    }
    driveToRest(sim, script.fps);
    lines.push(`${String(round)} ${digest(sim.world)}`);
  }
  return lines.join('\n');
}

const BASE: Script = { seed: 'pocket-football', fps: 60, candidates: 1, rounds: 6 };

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
 * Sources of non-determinism a core module may not reach for. The first is the
 * one item B12 names; the rest are the same defect wearing a different name,
 * and the boundary lint already refuses them, which is what makes this scan a
 * second opinion rather than the only one.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['the platform random source', /Math\s*\.\s*random/],
  ['the platform crypto source', /\bcrypto\b/],
  ['a high resolution clock', /\bperformance\s*\./],
  ['a wall clock', /\bDate\b/],
  ['a timer', /\b(?:setTimeout|setInterval|requestAnimationFrame)\b/],
];

describe('PF-2 a seeded match reproduces itself, item B12', () => {
  it('produces an identical transcript across runs', () => {
    const first = transcript(BASE);
    const second = transcript(BASE);
    expect(second).toBe(first);
    // A transcript of nothing would also agree with itself.
    expect(first.split('\n')).toHaveLength(BASE.rounds);
    expect(first.length).toBeGreaterThan(200);
  });

  it('produces a different transcript from a different seed', () => {
    expect(transcript({ ...BASE, seed: 'another-seed' })).not.toBe(transcript(BASE));
  });

  it('produces the same transcript at every frame rate', () => {
    const baseline = transcript(BASE);
    for (const fps of [30, 144, 1000]) {
      expect(transcript({ ...BASE, fps }), `at ${String(fps)} frames per second`).toBe(baseline);
    }
  });

  it('does not move when a second consumer changes how much it draws', () => {
    // The opponent clause, at the level PF-2 can close it: the candidate count
    // is the draw count, and the shot stream is a different consumer.
    const baseline = transcript(BASE);
    for (const candidates of [0, 2, 3, 17]) {
      expect(transcript({ ...BASE, candidates }), `${String(candidates)} candidates`).toBe(
        baseline,
      );
    }
  });
});

describe('PF-3 the scripted match is a match with collisions in it, item B12', () => {
  it('puts bodies in contact in the rounds the transcript above replays', () => {
    // A transcript agrees with itself whatever happened inside it, so what PF-3
    // owes item B12 is the reading that says what did: the same script, driven
    // a step at a time rather than a frame at a time, puts pairs in contact.
    // Without it the determinism claim would hold just as well over six rounds
    // in which three bodies never met, and PF-3 is the part that made them.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const shots = createRng(BASE.seed).split('launch');
    const inContact = (): boolean => {
      const world = sim.world;
      const pairs: ReadonlyArray<readonly [Body, Body]> = [
        [world.player, world.opponent],
        [world.player, world.ball],
        [world.opponent, world.ball],
      ];
      return pairs.some(([a, b]) => distance(a.position, b.position) <= a.radius + b.radius + 1e-9);
    };

    let contacts = 0;
    let steps = 0;
    for (let round = 0; round < BASE.rounds; round += 1) {
      for (const body of sim.world.bodies) {
        launch(body, shots.nextFloat() * Math.PI * 2, launchSpeed(shots.nextFloat()));
      }
      while (!everyBodyStopped(sim.world)) {
        sim.step();
        steps += 1;
        expect(steps).toBeLessThan(20000);
        contacts += inContact() ? 1 : 0;
      }
    }
    expect(contacts).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(1000);
  });
});

describe('PF-2 the seeded stream, item B12', () => {
  it('replays a stream exactly from the same seed, and differs from another', () => {
    const draws = (seed: string): number[] => {
      const stream = createRng(seed).split('shot');
      return Array.from({ length: 20 }, () => stream.nextUint32());
    };
    expect(draws('one')).toEqual(draws('one'));
    // Twenty distinct values rather than one value twenty times, so the
    // agreement above is an agreement about a sequence.
    expect(new Set(draws('one')).size).toBe(20);
    expect(createRng('one').split('shot').nextUint32()).not.toBe(
      createRng('two').split('shot').nextUint32(),
    );
  });

  it('gives each consumer a stream nothing else can shift', () => {
    const heavy = createRng('shared');
    const quiet = createRng('shared');

    const heavyOpponent = heavy.split('opponent');
    const heavyShots = heavy.split('launch');
    const quietShots = quiet.split('launch');

    for (let draw = 0; draw < 1000; draw += 1) {
      heavyOpponent.nextFloat();
    }

    const shifted = Array.from({ length: 50 }, () => heavyShots.nextUint32());
    const untouched = Array.from({ length: 50 }, () => quietShots.nextUint32());
    expect(shifted).toEqual(untouched);
    // And the two streams are not the same stream, which is what makes the
    // agreement above mean something.
    expect(heavy.split('opponent').nextUint32()).not.toBe(heavyShots.nextUint32());
  });

  it('does not advance a parent by splitting it', () => {
    const early = createRng('parent');
    const late = createRng('parent');
    early.split('a');
    early.split('b');
    early.split('c');
    expect(early.nextUint32()).toBe(late.nextUint32());
  });

  it('names the stream it is, so a transcript can say which consumer drew', () => {
    const root = createRng('named');
    expect(root.path).toBe('');
    expect(root.split('opponent').path).toBe('opponent');
    expect(root.split('opponent').split('candidate').path).toBe('opponent/candidate');
    expect(root.split('opponent').seed).toBe('named');
    // A nested stream is not its parent, and a differently nested one is not
    // its sibling either.
    expect(root.split('opponent').split('candidate').nextUint32()).not.toBe(
      root.split('opponent').nextUint32(),
    );
  });

  it('draws floats in the unit interval and integers in the range asked for', () => {
    // Counted rather than asserted per draw: twenty thousand assertions cost a
    // second, and this suite is run once per mutation entry by the harness.
    const rng = createRng('ranges').split('probe');
    let lowest = 1;
    let highest = 0;
    let outside = 0;
    for (let draw = 0; draw < 20000; draw += 1) {
      const value = rng.nextFloat();
      if (!(value >= 0 && value < 1)) {
        outside += 1;
      }
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
    expect(outside).toBe(0);
    expect(lowest).toBeLessThan(0.001);
    expect(highest).toBeGreaterThan(0.999);

    const counts = [0, 0, 0];
    const integers = createRng('ranges').split('buckets');
    let malformed = 0;
    for (let draw = 0; draw < 30000; draw += 1) {
      const value = integers.nextInt(0, 3);
      if (!Number.isInteger(value) || value < 0 || value >= 3) {
        malformed += 1;
        continue;
      }
      counts[value] = (counts[value] ?? 0) + 1;
    }
    expect(malformed).toBe(0);
    for (const count of counts) {
      // A modulo fold over a 32-bit draw would still land inside this band, so
      // the band is a smoke test on the range rather than a claim about bias.
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }

    // A range that is not a range is a defect in the caller, not a draw.
    expect(() => integers.nextInt(5, 5)).toThrow(RangeError);
    expect(() => integers.nextInt(9, 2)).toThrow(RangeError);
    expect(() => integers.nextInt(0.5, 4)).toThrow(RangeError);
  });

  it('refuses a span wider than one draw rather than never returning', () => {
    // A span past 2 ** 32 puts the rejection ceiling at zero, so every draw is
    // rejected and an unguarded loop never returns. The guard is a refusal, and
    // it has to be a refusal rather than a silent fold: a caller asking for a
    // range this generator cannot serve is asking the wrong question.
    const rng = createRng('wide').split('probe');
    expect(() => rng.nextInt(0, 2 ** 32 + 1)).toThrow(RangeError);
    expect(() => rng.nextInt(-1, 2 ** 32)).toThrow(RangeError);
    // The widest span it CAN serve is exactly one draw, and that one answers.
    const widest = rng.nextInt(0, 2 ** 32);
    expect(Number.isInteger(widest)).toBe(true);
    expect(widest).toBeGreaterThanOrEqual(0);
    expect(widest).toBeLessThan(2 ** 32);
  });

  it('rejects out-of-range draws rather than folding them, at an awkward span', () => {
    // The rejection path, at a span chosen so a modulo fold is measurable: with
    // a span of three quarters of the draw space, the quarter above the span
    // folds onto the first third of it, which would arrive half the time
    // instead of a third. Rejection is what keeps the three thirds equal.
    const span = 3 * 2 ** 30;
    const third = 2 ** 30;
    const rng = createRng('awkward').split('probe');
    const counts = [0, 0, 0];
    const draws = 30000;
    let outside = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      const value = rng.nextInt(0, span);
      if (!Number.isInteger(value) || value < 0 || value >= span) {
        outside += 1;
        continue;
      }
      const bucket = Math.floor(value / third);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    expect(outside).toBe(0);
    // A fold would leave half the draws in the first bucket and a quarter in
    // each of the others. Rejection leaves a third in each, so a band of four
    // points either side of a third separates them by more than four points and
    // sits fourteen standard deviations from the honest answer.
    for (const count of counts) {
      expect(count).toBeGreaterThan(draws / 3 - 0.04 * draws);
      expect(count).toBeLessThan(draws / 3 + 0.04 * draws);
    }
    expect(counts.reduce((all, count) => all + count, 0)).toBe(draws);
  });

  it('divides a draw by the whole draw space, so a float is under one', () => {
    // The upper bound of nextFloat is an arithmetic property of the divisor
    // rather than something a sample can show: the largest draw over 2 ** 32 is
    // under one, and the same draw over 2 ** 32 - 1 is exactly one.
    const largest = 2 ** 32 - 1;
    expect(largest / 2 ** 32).toBeLessThan(1);
    expect(largest / (2 ** 32 - 1)).toBe(1);

    // And the divisor the module actually uses, pinned by running two copies of
    // one stream side by side. A different divisor changes every value here.
    const asFloat = createRng('float-form').split('probe');
    const asInteger = createRng('float-form').split('probe');
    for (let draw = 0; draw < 200; draw += 1) {
      expect(asFloat.nextFloat()).toBe(asInteger.nextUint32() / 4294967296);
    }
  });

  it('opens on a different draw when a seed or a path differs by one character', () => {
    // The testable half of the expansion's claim. This is not a statement about
    // avalanche quality, which nothing here measures; it is the property the
    // stream naming depends on, that two neighbouring names are two streams.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['opponent', 'opponenu'],
      ['opponent', 'ppponent'],
      ['launch', 'launcj'],
      ['shot1', 'shot2'],
      ['a', 'b'],
    ];
    for (const [one, other] of pairs) {
      expect(
        createRng('seed').split(one).nextUint32(),
        `paths ${one} and ${other}`,
      ).not.toBe(createRng('seed').split(other).nextUint32());
    }
    for (const [one, other] of pairs) {
      expect(
        createRng(one).split('probe').nextUint32(),
        `seeds ${one} and ${other}`,
      ).not.toBe(createRng(other).split('probe').nextUint32());
    }
    expect(pairs).toHaveLength(5);
  });
});

describe('PF-2 nothing in core reaches for another source, item B12', () => {
  const files = readdirSync(CORE)
    .filter((name) => name.endsWith('.ts'))
    .sort();

  it('reads every core module, so the sweep is not a sweep over nothing', () => {
    // Named rather than counted, so the sweep cannot quietly stop reading one
    // of them, and open ended, so the part that adds the next one does not
    // have to come back here to say so.
    for (const name of ['bodies.ts', 'config.ts', 'physics.ts', 'rng.ts', 'vec2.ts']) {
      expect(files, name).toContain(name);
    }
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('finds no other source of randomness and no clock read', () => {
    const offences: string[] = [];
    for (const name of files) {
      const source = code(readFileSync(path.join(CORE, name), 'utf8'));
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(source)) {
          offences.push(`${name} reaches for ${label}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('would see one if there were one, in code but not in prose', () => {
    // The positive control. A scan that has stopped matching reports a clean
    // tree forever, and a scan that reads comments reports a defect in a file
    // that only explains the rule, which is what these modules do.
    const [randomness] = FORBIDDEN;
    expect(randomness?.[1].test(code('export const roll = Math.random();'))).toBe(true);
    expect(randomness?.[1].test(code('/* never call Math.random here */'))).toBe(false);
    expect(randomness?.[1].test(code('// Math.random is banned\nconst x = 1;'))).toBe(false);
    // The rng module explains the rule in prose and does not break it.
    const rngSource = readFileSync(path.join(CORE, 'rng.ts'), 'utf8');
    expect(/Math\.random/.test(rngSource)).toBe(true);
    expect(/Math\.random/.test(code(rngSource))).toBe(false);
  });
});

describe('PF-2 SPEC section 6.1 required invariant', () => {
  it('re-derives it from the constants, with the numbers written out', () => {
    // "(SPEED_CAP - STOP_THRESHOLD) / -ln(DAMPING) >= 1.5 * (fieldWidth / 2 +
    // ballRadius). At these values that is 1048 >= 852."
    const reach = (1200 - 6) / -Math.log(0.32);
    const required = 1.5 * (1100 / 2 + 18);
    expect(Math.round(reach)).toBe(1048);
    expect(required).toBe(852);
    expect(reach).toBeGreaterThanOrEqual(required);

    // The same statement from the symbols, so a constant that moves moves this.
    const fromConstants = (SPEED_CAP - STOP_SPEED) / -Math.log(DAMPING);
    expect(fromConstants).toBe(reach);
    expect(fromConstants).toBe(travelDistance(SPEED_CAP));
    expect(1.5 * (FIELD_WIDTH / 2 + BALL_RADIUS)).toBe(required);
    expect(fromConstants).toBeGreaterThanOrEqual(1.5 * (FIELD_WIDTH / 2 + BALL_RADIUS));

    // It also holds on the wider reading of "field width", the design space
    // rather than the playable bounds, which is the only other reading the
    // sentence has. 1048 clears 987 as well, so the invariant does not depend
    // on which of the two was meant.
    expect(1.5 * (LOGICAL_WIDTH / 2 + BALL_RADIUS)).toBe(987);
    expect(fromConstants).toBeGreaterThanOrEqual(1.5 * (LOGICAL_WIDTH / 2 + BALL_RADIUS));
  });
});

import { describe, expect, it } from 'vitest';

import {
  ANNOUNCE_INTERVAL,
  ASSERTIVE_MARKER,
  POLITE_MARKER,
  createLiveRegions,
} from '../../src/ui/live-region';
import { installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * Item G4's queue: QUALITY-BAR section 4's announcement rule, graded here
 * because it is the half of the item a demonstration session cannot fail well.
 *
 * WHERE THIS CAME FROM. The rule lived in `ui/components/aim-controls.ts` from
 * PF-6, where the aim readout was the only live region in the game and carried
 * the floor and the coalescing by itself. Section 4 asks for ONE queue and both
 * region elements in the initial HTML, so both moved here; what was graded in
 * `discrete-aim.test.ts` under "at most twice a second" is graded below, over
 * the same shape, with controls that rig could not carry.
 *
 * THE FLOOR IS PINNED BY LITERAL AS WELL AS BY THE SYMBOL. Driving a bound with
 * the constant that defines it passes for whatever value the constant takes, so
 * the half second is written out here and the export is compared with it.
 *
 * ARMOUR, NOT CLOSURE, for item G4: the item is a DEMONSTRATION and only the
 * recorded session with VoiceOver and NVDA closes it (ACCEPTANCE section 4).
 * What is here is the behaviour that session will exercise and the proof it
 * cannot silently stop working in the meantime.
 */

interface Rig {
  readonly polite: FakeElement;
  readonly assertive: FakeElement;
  readonly regions: ReturnType<typeof createLiveRegions>;
  readonly close: () => void;
}

function rig(): Rig {
  const installed = installFakeDocument();
  const polite = installed.document.createElement('p');
  polite.dataset['pf'] = POLITE_MARKER;
  const assertive = installed.document.createElement('p');
  assertive.dataset['pf'] = ASSERTIVE_MARKER;
  return {
    polite,
    assertive,
    regions: createLiveRegions(
      polite as unknown as HTMLElement,
      assertive as unknown as HTMLElement,
    ),
    close: installed.restore,
  };
}

describe('PF-15 the one announcement queue, item G4 armour', () => {
  it('holds QUALITY-BAR section 4 floor at half a second, by literal', () => {
    expect(ANNOUNCE_INTERVAL).toBe(0.5);
    // The two markers `index.html` carries. A rename on one side alone would
    // leave the composition root looking up an element that is not there.
    expect(POLITE_MARKER).toBe('live-polite');
    expect(ASSERTIVE_MARKER).toBe('live-assertive');
  });

  it('writes the first change of a still period at once', () => {
    const harness = rig();
    try {
      harness.regions.say('Your turn.');
      harness.regions.pump(0);
      expect(harness.polite.textContent).toBe('Your turn.');
      // And the assertive region has nothing to say, so it stays empty rather
      // than echoing the polite one.
      expect(harness.assertive.textContent).toBe('');
    } finally {
      harness.close();
    }
  });

  it('writes at most once every half second, and writes the newest', () => {
    const harness = rig();
    try {
      harness.regions.say('Aim 10 degrees');
      harness.regions.pump(0);
      expect(harness.polite.textContent).toBe('Aim 10 degrees');

      // A held arrow sweeps 240 degrees a second, so the region would be
      // rewritten every frame without the floor. Twenty frames of 20 ms is
      // 0.4 s, which is inside it.
      for (let at = 1; at <= 20; at += 1) {
        harness.regions.say(`Aim ${String(10 + at)} degrees`);
        harness.regions.pump(0.02);
      }
      expect(harness.polite.textContent).toBe('Aim 10 degrees');
      expect(harness.regions.readout().since).toBeCloseTo(0.4, 9);

      // Past the floor, and what lands is the NEWEST value rather than the
      // oldest one queued behind it: the coalescing half of the rule.
      harness.regions.say('Aim 99 degrees');
      harness.regions.pump(0.12);
      expect(harness.polite.textContent).toBe('Aim 99 degrees');
      expect(harness.regions.readout().since).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('says nothing again about a line it has already said', () => {
    const harness = rig();
    try {
      harness.regions.say('In play.');
      harness.regions.pump(0);
      expect(harness.polite.textContent).toBe('In play.');
      const writes = harness.polite.textWrites;
      for (let at = 0; at < 10; at += 1) {
        harness.regions.say('In play.');
        harness.regions.pump(0.2);
      }
      // Not one further write, which is what keeps a screen reader from
      // repeating a state that has not changed for two seconds.
      expect(harness.polite.textWrites).toBe(writes);
    } finally {
      harness.close();
    }
  });

  it('carries an outcome at once, and never drops one', () => {
    const harness = rig();
    try {
      // An outcome does not wait for the floor: the assertive region exists to
      // interrupt, and a goal announced half a second late is a goal announced
      // over the aim readout that followed it.
      //
      // THE FLOOR IS PUT DOWN FIRST, because that is the only state in which
      // this asserts anything. The queue opens AT the floor so the first line is
      // prompt, and an outcome measured there would be admitted by a queue that
      // made outcomes wait like everything else; a polite write is what takes
      // `since` to zero, and the outcome below arrives 16 ms into that interval.
      harness.regions.say('In play.');
      harness.regions.pump(0);
      expect(harness.polite.textContent).toBe('In play.');
      expect(harness.regions.readout().since).toBe(0);

      harness.regions.say('Your turn.');
      harness.regions.outcome('Goal to you. 1 to 0.');
      harness.regions.pump(0.016);
      expect(harness.assertive.textContent).toBe('Goal to you. 1 to 0.');
      // And it RESETS the floor, so the polite line it interrupted waits its
      // turn rather than being spoken over the top of it.
      expect(harness.polite.textContent).toBe('In play.');
      expect(harness.regions.readout().since).toBe(0);

      harness.regions.pump(ANNOUNCE_INTERVAL);
      expect(harness.polite.textContent).toBe('Your turn.');
    } finally {
      harness.close();
    }
  });

  it('queues two outcomes in one frame and loses neither', () => {
    const harness = rig();
    try {
      harness.regions.outcome('Goal to you. 1 to 0.');
      harness.regions.outcome(null);
      harness.regions.outcome('Goal to Ace. 1 to 1.');
      expect(harness.regions.readout().waiting).toBe(2);

      harness.regions.pump(0.016);
      expect(harness.assertive.textContent).toBe('Goal to you. 1 to 0.');
      expect(harness.regions.readout().waiting).toBe(1);

      // AND THE SECOND WAITS FOR THE FLOOR. A frame later is 16 ms later, and
      // an element rewritten 16 ms after it was written is an element whose
      // first words nobody reached: dropping an outcome by another name. The
      // queue holds it instead, which is what "never dropped" has to mean for
      // a channel that carries one line at a time.
      harness.regions.pump(0.016);
      expect(harness.assertive.textContent).toBe('Goal to you. 1 to 0.');
      expect(harness.regions.readout().waiting).toBe(1);

      harness.regions.pump(ANNOUNCE_INTERVAL);
      expect(harness.assertive.textContent).toBe('Goal to Ace. 1 to 1.');
      expect(harness.regions.readout().waiting).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('announces a state that persists exactly once, and the next one after it', () => {
    const harness = rig();
    try {
      // SPEC section 6.4 holds a goal for 1.2 s, which is 72 frames at 60 fps,
      // and the composition root hands this the outcome in force on every one
      // of them. The edge is found here rather than by the caller.
      for (let at = 0; at < 72; at += 1) {
        harness.regions.outcome('Goal to you. 1 to 0.');
        harness.regions.pump(1 / 60);
      }
      expect(harness.assertive.textContent).toBe('Goal to you. 1 to 0.');
      expect(harness.assertive.textWrites).toBe(1);

      // Play resumes, the outcome goes, and the next goal is a new one.
      harness.regions.outcome(null);
      harness.regions.pump(1 / 60);
      harness.regions.outcome('Goal to you. 2 to 0.');
      harness.regions.pump(1 / 60);
      expect(harness.assertive.textContent).toBe('Goal to you. 2 to 0.');
      expect(harness.assertive.textWrites).toBe(2);
    } finally {
      harness.close();
    }
  });

  it('writes an outcome whose words repeat, because none may be dropped', () => {
    // THE ONE PLACE THE EDGE-ONLY RULE IS DELIBERATELY BROKEN. A live region
    // announces a MUTATION, so an outcome compared against what the element
    // already reads would go unspoken whenever two of them happen to match.
    // The queue's own edge check is what stops the repeat arriving at all; if
    // one does arrive, it is written.
    const harness = rig();
    try {
      harness.regions.outcome('Full time. Draw! 1 to 1.');
      harness.regions.pump(0);
      harness.regions.outcome(null);
      harness.regions.outcome('Full time. Draw! 1 to 1.');
      // The floor between one outcome and the next applies to a repeat like any
      // other: it is a second announcement, and it is written.
      harness.regions.pump(ANNOUNCE_INTERVAL);
      expect(harness.assertive.textContent).toBe('Full time. Draw! 1 to 1.');
      expect(harness.assertive.textWrites).toBe(2);
    } finally {
      harness.close();
    }
  });

  it('charges a delta that is negative or not a number no time at all', () => {
    // The same reading QUALITY-BAR section 7 gives the simulation. A frame
    // driver handing back a NaN would otherwise open the floor forever.
    const harness = rig();
    try {
      harness.regions.say('First.');
      harness.regions.pump(0);
      harness.regions.say('Second.');
      for (const delta of [Number.NaN, -10, Number.POSITIVE_INFINITY, 0]) {
        harness.regions.pump(delta);
      }
      expect(harness.polite.textContent).toBe('First.');
      harness.regions.pump(ANNOUNCE_INTERVAL);
      expect(harness.polite.textContent).toBe('Second.');
    } finally {
      harness.close();
    }
  });

  it('refuses to go quiet when the floor is removed, which is the control', () => {
    // THE NEGATIVE CONTROL FOR THE FLOOR. Every assertion above is about a
    // write that does NOT happen, and a queue that had stopped writing at all
    // would satisfy most of them. This drives the same twenty frames past the
    // floor and requires twenty-one distinct lines to reach the region, so a
    // queue that swallowed everything fails here.
    const harness = rig();
    try {
      for (let at = 0; at <= 20; at += 1) {
        harness.regions.say(`Aim ${String(at)} degrees`);
        harness.regions.pump(ANNOUNCE_INTERVAL);
        expect(harness.polite.textContent).toBe(`Aim ${String(at)} degrees`);
      }
      // The count the REGION took, which is the only one worth asserting: a
      // counter incremented once per iteration and then compared with the
      // iteration count is a loop bound compared with itself.
      expect(harness.polite.textWrites).toBe(21);
    } finally {
      harness.close();
    }
  });
});

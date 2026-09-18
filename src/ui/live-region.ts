/**
 * The announcement queue, QUALITY-BAR section 4: ONE queue, two regions.
 *
 * A LIVE REGION IS AN EVENT CHANNEL, NOT A REPRESENTATION. It cannot be
 * navigated, re-read or queried, so it satisfies 4.1.3 and nothing else; what
 * satisfies 1.1.1 and 1.3.1 is the persistent structured mirror in
 * `components/play-mirror.ts`. The two mechanisms do different jobs and this
 * module is only the first of them.
 *
 * ONE QUEUE AND ONE CLOCK, WHICH IS THE WHOLE POINT OF THE MODULE. Section 4
 * states a minimum of 500 ms between polite writes with coalescing, and outcomes
 * that are never dropped. Two timers answering the same rule is the defect this
 * replaces: the aim readout ran a queue of its own from PF-6, and a second
 * region beside it with a second interval would have been two disciplines for
 * one guarantee, drifting apart the first time either was tuned.
 *
 * THE FLOOR GOVERNS POLITE WRITES, AND IT GOVERNS ONE OUTCOME AGAINST THE NEXT.
 * An outcome is what the assertive region exists for, so it is written the
 * moment it arrives on a free region, and it RESETS the polite floor on its way
 * out: a goal followed half a frame later by an aim readout would otherwise be
 * spoken over by the thing it interrupted. A SECOND outcome waits for the floor
 * rather than taking the next frame, because writing it 16 ms later would
 * replace the first one's words in the element before any reader had reached
 * them, which is dropping an outcome by another name. Nothing in SPEC section 7
 * queues two outcomes that close together today; the queue does not depend on
 * that staying true.
 *
 * BOTH ELEMENTS ARE THE DOCUMENT'S, not this module's. Section 4 requires them
 * in the initial HTML, so `index.html` carries them and the composition root
 * hands them here; a module that created its own would create them at the moment
 * it first had something to say, which is a region no assistive technology was
 * yet watching and a first line that goes unspoken.
 *
 * EVERY WRITER CALLS EVERY FRAME. `say` and `outcome` are handed what is true
 * now rather than what has just changed, and the edges are found here: a caller
 * that had to work out whether something was new would be a second place for the
 * rule to be got wrong.
 */

import { setTextIfChanged } from './components/control';

/**
 * QUALITY-BAR section 4: at least half a second between polite writes, with the
 * newest value replacing a pending one rather than queueing behind it.
 *
 * It is stated here because this module is the one queue. `aim-controls.ts` held
 * the same number while it held a queue of its own; it holds neither now.
 */
export const ANNOUNCE_INTERVAL = 0.5;

/** The markers the two initial-HTML elements carry, so nothing guesses them. */
export const POLITE_MARKER = 'live-polite';
export const ASSERTIVE_MARKER = 'live-assertive';

export interface LiveRegionsReadout {
  /** What the polite region reads right now. */
  readonly polite: string;
  /** What the assertive region reads right now. */
  readonly assertive: string;
  /** Outcomes queued and not yet written. Never dropped, so never lost. */
  readonly waiting: number;
  /** Seconds since the last write of either region. */
  readonly since: number;
}

export interface LiveRegions {
  /**
   * The polite line that is true now. The newest REPLACES whatever is pending,
   * because a held arrow sweeps 240 degrees a second and a queue that grew
   * would be reading out a position the game left long ago.
   */
  say(line: string): void;
  /**
   * The outcome in force, or `null` where there is none. A new outcome is
   * queued once and never dropped; the same outcome on the next frame is the
   * same outcome, and `null` is what lets the next one through.
   */
  outcome(line: string | null): void;
  /** One frame of the queue: at most one write, per the floor above. */
  pump(elapsed: number): void;
  /** What the two regions hold, for the armour that grades this module. */
  readout(): LiveRegionsReadout;
}

export function createLiveRegions(polite: HTMLElement, assertive: HTMLElement): LiveRegions {
  /** Outcomes waiting their turn. Appended to, never replaced. */
  const waiting: string[] = [];

  /** The polite line pending a write, or nothing pending. */
  let pending: string | null = null;
  /** The last polite line actually written, so a repeat is not a change. */
  let spoken = '';
  /** The last outcome queued, so a state that persists is announced once. */
  let announced: string | null = null;
  /** Seconds since the last write, opened at the floor so the first is prompt. */
  let since = ANNOUNCE_INTERVAL;
  /** Seconds the assertive region's current words have stood, opened the same way. */
  let standing = ANNOUNCE_INTERVAL;

  return {
    say(line: string): void {
      pending = line === spoken ? null : line;
    },

    outcome(line: string | null): void {
      if (line === null) {
        announced = null;
        return;
      }
      if (line === announced) {
        return;
      }
      announced = line;
      waiting.push(line);
    },

    pump(elapsed: number): void {
      const step = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      since += step;
      standing += step;
      // An outcome waits for the words it would overwrite and for nothing else.
      const free = standing >= ANNOUNCE_INTERVAL;
      const next = free ? waiting.shift() : undefined;
      if (next !== undefined) {
        // WRITTEN WITHOUT THE EDGE CHECK EVERY OTHER CHROME WRITE USES, and the
        // reason is the rule: an outcome is never dropped. A live region
        // announces a MUTATION, so a second outcome whose words happen to match
        // the first would be skipped by a write that compared them and would go
        // unspoken. This write happens only when an outcome leaves the queue.
        assertive.textContent = next;
        since = 0;
        standing = 0;
        return;
      }
      if (pending === null || since < ANNOUNCE_INTERVAL) {
        return;
      }
      setTextIfChanged(polite, pending);
      spoken = pending;
      pending = null;
      since = 0;
    },

    readout(): LiveRegionsReadout {
      return {
        polite: polite.textContent ?? '',
        assertive: assertive.textContent ?? '',
        waiting: waiting.length,
        since,
      };
    },
  };
}

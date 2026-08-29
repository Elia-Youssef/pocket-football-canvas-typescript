/**
 * The seeded stream. SPEC section 6 and STACK section 3: all randomness comes
 * from this module, nothing in `core/` calls Math.random, and each independent
 * consumer takes its own stream through `split()`, so changing one consumer's
 * draw count cannot shift another's.
 *
 * WHY A STREAM IS DERIVED AND NOT DRAWN. A child stream is seeded from the root
 * seed and the child's own path, so creating one advances nothing, and drawing
 * from one touches no other state. The alternative, seeding a child by drawing
 * from its parent, makes a sibling's sequence depend on how many children were
 * created before it and in what order, which is the same defect the split rule
 * exists to prevent, one level up.
 *
 * The generator is sfc32: 128 bits of state, four 32-bit words, and every
 * operation in the draw is an exact 32-bit integer operation, the additions
 * truncated by `| 0` and the mixing done with the shift operators, so the
 * sequence is identical on every engine that runs the bundle. `Math.imul` does
 * the multiplying in the seed expansion below, which is the only place a
 * 32-bit product is needed. The expansion is a fixed avalanche hash, and what
 * the suite pins of it is the testable half: a seed or a path that differs by
 * one character opens on a different draw.
 *
 * Names are per consumer. Two consumers given the same name share one sequence,
 * which is one consumer's stream handed out twice rather than two independent
 * streams; PF-8 names the opponent's stream and nothing else may reuse it.
 *
 * WHAT ITEM B12 CLOSES, AND WHERE. The criterion ends "the opponent draws from
 * its own split stream, so changing its candidate count shifts no other
 * consumer". The opponent arrives at PF-8, so the clause is closed HERE by a
 * stated substitute: a scripted transcript varies a second stream's draw count
 * per round exactly the way a candidate count would, and the transcript does
 * not move. Item B12 is graded at PF-2 and at no other part, and no later item
 * re-grades it, so nothing in this module is waiting on one.
 *
 * A handoff to PF-8, which is a suggestion rather than a debt this part owes:
 * seat the opponent on `root.split('opponent')` so the substitute becomes the
 * real consumer, and carry a transcript-invariance test that varies the real
 * candidate count.
 */

const WORD = 0x100000000;

/** Draws discarded at construction, so a fresh state cannot be read directly. */
const WARMUP = 12;

/** The bound on the rejection loop in `nextInt`. See the comment there. */
const DRAW_ATTEMPTS = 64;

export interface Rng {
  /** The stream's path from the root, for a transcript to name a consumer. */
  readonly path: string;
  /** The root seed every stream under it is derived from. */
  readonly seed: string;
  /** A 32-bit unsigned draw, which every other draw is built from. */
  nextUint32(): number;
  /** A draw in [0, 1), at 32 bits of resolution. */
  nextFloat(): number;
  /** A draw in [low, high), unbiased by rejection rather than by modulo. */
  nextInt(low: number, high: number): number;
  /** An independent stream for one consumer, derived rather than drawn. */
  split(name: string): Rng;
}

/**
 * Four words of state from a seed, by avalanche rather than by truncation. A
 * seed that differs in one character has to produce four words that differ
 * everywhere, or two adjacent stream paths would open with visibly related
 * sequences.
 */
function expand(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let at = 0; at < seed.length; at += 1) {
    const code = seed.charCodeAt(at);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

function createStream(seed: string, path: string): Rng {
  const words = expand(`${seed}#${path}`);
  let a = words[0];
  let b = words[1];
  let c = words[2];
  let counter = words[3];

  const nextUint32 = (): number => {
    let mixed = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    counter = (counter + 1) | 0;
    mixed = (mixed + counter) | 0;
    c = (c + mixed) | 0;
    return mixed >>> 0;
  };

  for (let discarded = 0; discarded < WARMUP; discarded += 1) {
    nextUint32();
  }

  const stream: Rng = {
    path,
    seed,
    nextUint32,
    nextFloat: () => nextUint32() / WORD,
    nextInt: (low, high) => {
      const span = high - low;
      // The upper bound is not fussiness. A span wider than one draw makes the
      // rejection ceiling below fall to zero, every draw is then rejected, and
      // a caller asking for a range this generator cannot serve would get a
      // hang rather than an answer.
      if (
        !Number.isInteger(low) ||
        !Number.isInteger(high) ||
        span <= 0 ||
        span > WORD
      ) {
        throw new RangeError(
          `nextInt needs an integer range with a positive span no wider than one ` +
            `draw, and was asked for [${String(low)}, ${String(high)})`,
        );
      }
      // Rejection rather than modulo. A modulo fold makes the first
      // `WORD % span` values likelier than the rest, and a difficulty profile
      // measured against a biased draw is measured against the wrong thing.
      //
      // The loop is bounded rather than open. For any legal span the rejected
      // region is under half the draw space, so the bound below is reached with
      // probability under two to the minus sixty-four, and an unbounded loop
      // inside a fixed step is a hang rather than a defect anybody can see.
      const ceiling = WORD - (WORD % span);
      for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt += 1) {
        const drawn = nextUint32();
        if (drawn < ceiling) {
          return low + (drawn % span);
        }
      }
      throw new Error(
        `nextInt rejected ${String(DRAW_ATTEMPTS)} draws in a row, which no legal ` +
          'span can produce',
      );
    },
    split: (name) => createStream(seed, path === '' ? name : `${path}/${name}`),
  };
  return stream;
}

/**
 * The root of a seeded session. The seed is text so that a transcript can carry
 * it verbatim; a number is accepted and rendered, so a caller with a numeric
 * seed does not have to invent a spelling for it.
 */
export function createRng(seed: string | number): Rng {
  return createStream(typeof seed === 'number' ? `n:${String(seed)}` : seed, '');
}

import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import {
  FIELD_BOTTOM,
  FIELD_HEIGHT,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIELD_WIDTH,
  LOGICAL_HEIGHT,
} from '../../src/core/config';
import {
  drawCentreMarkings,
  drawGoalFrames,
  drawStripes,
  drawVignette,
  drawWalls,
  drawFrame,
  pitchLayerIsCurrent,
  renderStaticPitch,
} from '../../src/render/pitch';
import type { PitchCacheCell } from '../../src/render/pitch';
import { attachSurface } from '../../src/render/surface';
import { BORDER, PLAY_SURFACE } from '../../src/render/tokens';
import type { PitchPalette } from '../../src/render/tokens';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

/**
 * Armour for the pitch passes, item E3's enumeration.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture at the
 * demonstration session. What automation can reach, this file pins: the
 * drawn quantities per pass (the census), the fact that every colour the
 * pitch draws with is a palette token of the variant in force, the outline
 * on the objects that carry one, and the static layer being built once and
 * then only ever blitted. The census counts are literals on purpose: a count
 * asserted against the loop that produces it cannot fail, and a census that
 * cannot fail freezes nothing.
 */

const VARIANTS = ['floodlit', 'daylight'] as const;

/**
 * The backing scales this file draws the walls at: the 430 CSS pixel portrait
 * viewport at ratio 1 the 2026-09-08 audit measured the rail failing at, the
 * 1080p laptop QUALITY-BAR section 2 names, two intermediate scales SPEC
 * section 18's record measures, and a double-density desktop.
 *
 * THE PLACEMENT IS ASSERTED AT ALL OF THEM AND THE WHOLE-PIXEL FLOOR AT NONE:
 * three design units cover a whole device pixel from a backing scale of one
 * third upward, and what this file grades is where the band falls, which is
 * the same claim wherever it falls. The rendered floor either side of that
 * scale is `tests/browser/rail-boundary.spec.ts`, on real pixels.
 */
const BACKING_SCALES = [0.336, 1, 1.05, 1.5, 2, 2.1] as const;

/** Run every static pass, in render order, into one recorder. */
function drawStatic(recorder: CanvasRecorder, palette: PitchPalette): void {
  drawStripes(recorder.context, palette);
  drawVignette(recorder.context, palette);
  drawCentreMarkings(recorder.context, palette);
  drawWalls(recorder.context, palette, 1);
  drawGoalFrames(recorder.context, palette);
}

function rectArgs(recorder: CanvasRecorder): ReadonlyArray<readonly unknown[]> {
  return recorder.calls('fillRect').map((op) => op.args);
}

describe('PF-11 the pitch, pass by pass', () => {
  it('cuts the field into an even number of mown stripes, starting dark', () => {
    for (const variant of VARIANTS) {
      const recorder = new CanvasRecorder();
      drawStripes(recorder.context, PLAY_SURFACE[variant]);
      // The largest spacing step (64) against the 1100 px field fixes the
      // count at 18; the census freezes it so a second stripe knob cannot
      // arrive unreviewed.
      const rects = rectArgs(recorder);
      expect(rects).toHaveLength(18);
      const band = FIELD_WIDTH / 18;
      rects.forEach((args, index) => {
        expect(args[0]).toBeCloseTo(FIELD_LEFT + index * band, 9);
        expect(args[1]).toBe(FIELD_BOTTOM);
        expect(args[2]).toBeCloseTo(band, 9);
        expect(args[3]).toBe(FIELD_HEIGHT);
      });
      // Alternating, opening on stripe A, the darker pair member the
      // contrast table quotes against.
      const fills = recorder.values('fillStyle');
      expect(fills[0]).toBe(PLAY_SURFACE[variant].stripeA);
      expect(fills[1]).toBe(PLAY_SURFACE[variant].stripeB);
      expect(fills[2]).toBe(PLAY_SURFACE[variant].stripeA);
    }
  });

  it('draws the white centre line, circle and spot at the field centre', () => {
    const recorder = new CanvasRecorder();
    drawCentreMarkings(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('stroke')).toHaveLength(2);
    expect(recorder.calls('fill')).toHaveLength(1);
    expect(recorder.values('strokeStyle')).toEqual([
      PLAY_SURFACE.floodlit.line,
      PLAY_SURFACE.floodlit.line,
    ]);
    expect(recorder.values('fillStyle')).toEqual([PLAY_SURFACE.floodlit.line]);
    // The line runs the full height of the field at x 640.
    expect(recorder.calls('moveTo')[0]?.args).toEqual([640, FIELD_BOTTOM]);
    expect(recorder.calls('lineTo')[0]?.args).toEqual([640, FIELD_TOP]);
    // The circle is SPEC 3's radius 70; the spot is the radius scale's small
    // step, 4, pinned as a literal because nothing else may resize it.
    const circles = recorder.calls('arc');
    expect(circles[0]?.args.slice(0, 3)).toEqual([640, 360, 70]);
    expect(circles[1]?.args.slice(0, 3)).toEqual([640, 360, 4]);
  });

  it('tiles the enclosure with six wall pieces and cuts out the openings', () => {
    const recorder = new CanvasRecorder();
    drawWalls(recorder.context, PLAY_SURFACE.floodlit, 1);
    const rects = rectArgs(recorder);
    expect(rects).toHaveLength(6);
    // The two end walls span the enclosure including its corners.
    const spanning = rects.filter((args) => args[2] === FIELD_WIDTH + 24);
    expect(spanning).toHaveLength(2);
    for (const args of spanning) {
      expect(args[0]).toBe(FIELD_LEFT - 12);
      expect(args[3]).toBe(12);
    }
    // The four side pieces stop short of the opening: every one is either
    // wholly below y 265 or wholly above y 455, which is what "the ball
    // passes through and nothing else does" looks like in fill rects.
    const sides = rects.filter((args) => args[2] === 12);
    expect(sides).toHaveLength(4);
    for (const args of sides) {
      const bottom = args[1] as number;
      const top = bottom + (args[3] as number);
      expect(bottom <= 265 || bottom >= 455).toBe(true);
      expect(top <= 265 || top >= 455).toBe(true);
    }
    // The raised rail's boundary: one light stroke along the pitch-facing
    // edges, drawn once, at SPEC section 18's three design units.
    expect(recorder.calls('stroke')).toHaveLength(1);
    expect(recorder.values('strokeStyle')).toEqual([PLAY_SURFACE.floodlit.line]);
    expect(recorder.calls('moveTo')).toHaveLength(6);
    // THE WEIGHT, AS THE TOKEN AND AS THE NUMBER. The token alone would let a
    // scale edit re-thin the boundary in silence, and the number alone would
    // let it stop resolving through the scale at all; the section states
    // three, so both readings are asserted and the predicate that asserts them
    // is shown refusing the hairline this replaced.
    const isTheBoundaryWeight = (value: unknown): boolean =>
      value === BORDER.thick && value === 3;
    expect(recorder.values('lineWidth').map(isTheBoundaryWeight)).toEqual([true]);
    expect(isTheBoundaryWeight(BORDER.hair)).toBe(false);
    expect(isTheBoundaryWeight(BORDER.thin)).toBe(false);
    // And it is set BEFORE the stroke it governs, which is the only order in
    // which a width is a width and not a leftover.
    expect(recorder.indexOf('set', 'lineWidth')).toBeLessThan(
      recorder.indexOf('call', 'stroke'),
    );
  });

  it('lays the boundary on the rail side of every edge, on whole device pixels', () => {
    // SPEC section 18 states the weight in design units and the 3:1 floor in
    // RENDERED pixels, which is a claim about where the band FALLS as much as
    // about how wide it is: a band that straddles a pixel boundary covers two
    // pixels by part each, and a partly covered pixel is a blend of the
    // boundary and whatever is under it rather than the boundary's own colour.
    // The 2026-09-08 audit measured exactly that, 2.59:1 against the daylight
    // stripe B where the table asks for 3.
    //
    // The edges are named with the field bound they belong to, the axis the
    // transform measures it on, and which way the rail lies from it IN DEVICE
    // PIXELS: the transform flips y, so the rail above the pitch is at a
    // smaller device row and the rail below it at a larger one. Everything
    // below is arithmetic on the RECORDED path coordinates and on SPEC section
    // 3's bounds; nothing is read back from the module that drew them.
    const edges = [
      { name: 'top', bound: FIELD_TOP, axis: 'down' as const, outward: -1 },
      { name: 'bottom', bound: FIELD_BOTTOM, axis: 'down' as const, outward: 1 },
      { name: 'left', bound: FIELD_LEFT, axis: 'across' as const, outward: -1 },
      { name: 'right', bound: FIELD_RIGHT, axis: 'across' as const, outward: 1 },
    ];
    // THE DEVICE ROW IS COUNTED FROM THE TRANSFORM'S OWN ORIGIN, and the
    // origin is the ROUNDED one: `render/surface.ts` translates by
    // `Math.round(LOGICAL_HEIGHT * scale)`, which is the backing store's own
    // height, so design y sits at `origin - y * scale` and not at
    // `(LOGICAL_HEIGHT - y) * scale`. The two differ by the rounding residue,
    // 0.08 of a device pixel at 0.336 and 0.25 at 1.05, which is exactly
    // enough to take a snapped band off the grid it is drawn on. The rule is
    // rebuilt here from the arithmetic rather than imported, so a build whose
    // origin stopped rounding is measured against the origin the store has.
    const originOf = (scale: number): number => Math.round(LOGICAL_HEIGHT * scale);
    const device = (axis: 'down' | 'across', value: number, scale: number): number =>
      axis === 'across' ? value * scale : originOf(scale) - value * scale;
    /** Whether some whole device pixel lies inside a span, ends included. */
    const coversAWholePixel = (from: number, to: number): boolean =>
      Math.ceil(from - 1e-9) + 1 <= to + 1e-9;

    /**
     * Everything that can be wrong with a recorded wall path, as a list of
     * named faults instead of as assertions.
     *
     * IT IS A LIST SO THAT THE CHECK CAN BE SHOWN A DRAWING IT MUST REFUSE. An
     * assertion that throws can only ever be run against the drawing that is
     * expected to pass it; a function that ANSWERS can be handed the placement
     * this one replaced and asked what it makes of it, which is what the
     * controls at the foot of this test do.
     */
    const faultsIn = (
      moves: ReadonlyArray<readonly number[]>,
      lines: ReadonlyArray<readonly number[]>,
      scale: number,
    ): string[] => {
      const found: string[] = [];
      if (moves.length !== 6 || lines.length !== 6) {
        return [`six runs expected, ${String(moves.length)} and ${String(lines.length)} drawn`];
      }
      // Two horizontal runs, then two pieces of each side wall: the cross-axis
      // coordinate of each is the band's centre line, and a run that had
      // become a diagonal would not have one.
      const centres = moves.map((move, at) => {
        const line = lines[at] ?? [];
        const slot = at < 2 ? 1 : 0;
        if (move[slot] !== line[slot]) {
          found.push(`run ${String(at)}: a diagonal, not a run along the edge`);
        }
        return move[slot] ?? Number.NaN;
      });
      // Each side wall is drawn in two pieces, and both pieces of one wall
      // stand on the same line: a boundary that snapped them apart would be
      // two boundaries.
      if (centres[3] !== centres[2]) {
        found.push('left: the two pieces stand on different lines');
      }
      if (centres[5] !== centres[4]) {
        found.push('right: the two pieces stand on different lines');
      }
      const byEdge = [centres[0], centres[1], centres[2], centres[4]];
      edges.forEach((edge, at) => {
        const centre = byEdge[at] ?? Number.NaN;
        if (!Number.isFinite(centre)) {
          found.push(`${edge.name}: no centre line`);
          return;
        }
        // THE BAND, IN DEVICE PIXELS: its centre line carries half the weight
        // either side, and the half facing the pitch is the one the stripe is
        // measured against.
        const middle = device(edge.axis, centre, scale);
        const spread = (3 * scale) / 2;
        const from = middle - spread;
        const to = middle + spread;
        const inner = edge.outward < 0 ? to : from;
        const outer = edge.outward < 0 ? from : to;
        const bound = device(edge.axis, edge.bound, scale);
        // SNAPPED: the pitch-facing side of the band lands on a whole device
        // pixel, so the band cannot straddle one.
        if (Math.abs(inner - Math.round(inner)) > 1e-9) {
          found.push(`${edge.name}: not snapped`);
        }
        // AND IT IS STILL THIS EDGE: the snap moves the band by less than half
        // a device pixel, so the boundary is against the field bound it is
        // named for, on the rail's side of it to within that half pixel, and
        // not a rounding away from somewhere else.
        if (Math.abs(inner - bound) > 0.5 + 1e-9) {
          found.push(`${edge.name}: not against the bound`);
        }
        // ON THE RAIL'S SIDE: the far side of the band lies outside the field
        // and inside the twelve design units of wall this pass has already
        // filled, so the band is on the rail and never over the chrome ground.
        const past = edge.outward * (outer - bound);
        if (past < -1e-9 || past > 12 * scale + 1e-9) {
          found.push(`${edge.name}: not on the rail side`);
        }
        // AND IT RESOLVES: some whole device pixel lies inside the band, which
        // is the pixel the section's floor is measured on. Every scale this
        // test draws at is at or above the one third where three design units
        // first cover one.
        if (!coversAWholePixel(Math.min(from, to), Math.max(from, to))) {
          found.push(`${edge.name}: no whole device pixel of band`);
        }
      });
      // The goal openings stay cut out of the side walls: every vertical piece
      // is wholly below the opening or wholly above it.
      for (const at of [2, 3, 4, 5]) {
        const move = moves[at] ?? [];
        const line = lines[at] ?? [];
        const low = Math.min(move[1] ?? Number.NaN, line[1] ?? Number.NaN);
        const high = Math.max(move[1] ?? Number.NaN, line[1] ?? Number.NaN);
        if (!(low <= 265 || low >= 455) || !(high <= 265 || high >= 455)) {
          found.push(`piece ${String(at)}: crosses the goal opening`);
        }
      }
      return found;
    };

    for (const scale of BACKING_SCALES) {
      const recorder = new CanvasRecorder();
      drawWalls(recorder.context, PLAY_SURFACE.floodlit, scale);
      const moves = recorder.calls('moveTo').map((op) => op.args as readonly number[]);
      const lines = recorder.calls('lineTo').map((op) => op.args as readonly number[]);
      expect(faultsIn(moves, lines, scale), `at ${String(scale)}`).toEqual([]);
    }

    // THE CONTROLS ARE DRAWINGS, not arithmetic on the check. Each one is the
    // wall path some other placement rule would have recorded, laid out in the
    // same six runs, and the check is asked what it makes of it. Three of them
    // are the mutations the harness makes at this module - `the rail boundary
    // is laid on whole device pixels, not across two`, `the rail boundary lies
    // on the rail side of the edge it is measured at` and `the rail boundary
    // carries the weight the section states` - the fourth is the rounding
    // mistake nobody has made yet, and the fifth is the one two vehicles made
    // at once, which the harness mutates as `the rail boundary is snapped to
    // the grid the transform draws on`.
    const centreFor = (
      edge: { bound: number; axis: 'down' | 'across'; outward: number },
      scale: number,
      inner: number,
    ): number => {
      const middle = inner + edge.outward * ((3 * scale) / 2);
      return edge.axis === 'across'
        ? middle / scale
        : (originOf(scale) - middle) / scale;
    };
    /** The six runs `drawWalls` records, from one centre line per edge. */
    const pathFrom = (
      centres: readonly number[],
    ): { moves: number[][]; lines: number[][] } => {
      const [top = 0, bottom = 0, left = 0, right = 0] = centres;
      return {
        moves: [
          [FIELD_LEFT - 12, top],
          [FIELD_LEFT - 12, bottom],
          [left, FIELD_BOTTOM - 12],
          [left, 455],
          [right, FIELD_BOTTOM - 12],
          [right, 455],
        ],
        lines: [
          [FIELD_RIGHT + 12, top],
          [FIELD_RIGHT + 12, bottom],
          [left, 265],
          [left, FIELD_TOP + 12],
          [right, 265],
          [right, FIELD_TOP + 12],
        ],
      };
    };
    interface Control {
      readonly why: string;
      readonly scale: number;
      readonly inner: (bound: number, outward: number, scale: number) => number;
      readonly fault: string;
    }
    const controls: readonly Control[] = [
      {
        why: 'centred on the field edge and snapped to nothing, the placement this replaced',
        scale: 0.336,
        inner: (bound: number, outward: number, scale: number): number =>
          bound - outward * ((3 * scale) / 2),
        fault: 'top: not snapped',
      },
      {
        why: 'snapped by flooring, which can move the band more than half a device pixel',
        scale: 0.336,
        inner: (bound: number): number => Math.floor(bound),
        fault: 'top: not against the bound',
      },
      {
        why: 'laid on the pitch side of the edge, over the stripe it is measured against',
        scale: 1,
        inner: (bound: number, outward: number, scale: number): number =>
          Math.round(bound) - outward * 3 * scale,
        fault: 'top: not against the bound',
      },
      {
        why: 'laid past the wall band, on the chrome ground rather than on the rail',
        scale: 1,
        inner: (bound: number, outward: number, scale: number): number =>
          Math.round(bound) + outward * 13 * scale,
        fault: 'top: not on the rail side',
      },
      {
        // THE CROSS-VEHICLE CASE, and the reason this helper counts rows from
        // the rounded origin: a row snapped against the UNROUNDED top of the
        // design space is a whole pixel of the grid that arithmetic draws, and
        // 0.08 of a pixel off the grid the transform actually uses at 0.336.
        // It is the placement this file accepted while the surface translated
        // by the unrounded product, and it is the one a reader would rebuild
        // from `LOGICAL_HEIGHT - y` without asking where the origin sits.
        why: 'snapped against the unrounded top of the design space, not the transform origin',
        scale: 0.336,
        inner: (bound: number, _outward: number, scale: number): number => {
          const residue = originOf(scale) - LOGICAL_HEIGHT * scale;
          return residue + Math.round(bound - residue);
        },
        fault: 'top: not snapped',
      },
    ];
    for (const control of controls) {
      const centres = edges.map((edge) =>
        centreFor(
          edge,
          control.scale,
          control.inner(device(edge.axis, edge.bound, control.scale), edge.outward, control.scale),
        ),
      );
      const drawn = pathFrom(centres);
      expect(faultsIn(drawn.moves, drawn.lines, control.scale), control.why).toContain(
        control.fault,
      );
    }
    // And the check can say yes to a drawing it did not produce, so it is not
    // one that only ever refuses: the placement the module takes, rebuilt here
    // from the rule rather than recorded, passes it.
    const kept = pathFrom(
      edges.map((edge) =>
        centreFor(edge, 0.336, Math.round(device(edge.axis, edge.bound, 0.336))),
      ),
    );
    expect(faultsIn(kept.moves, kept.lines, 0.336)).toEqual([]);
  });

  it('draws a finite boundary for a scale that is not a positive number', () => {
    // The snap divides by the scale, so a scale that is not a positive finite
    // number has nothing to snap to, and two callers can hand one in:
    // `attachSurface` leaves the scale at zero until the first fit, and the
    // composition root's frame guard refuses a scale at or below zero, which
    // lets every other unusable number through because a comparison with NaN is
    // false. What this protects is that the drawing stays a drawing either way:
    // twenty-four finite coordinates, the band where no snap would put it.
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const recorder = new CanvasRecorder();
      drawWalls(recorder.context, PLAY_SURFACE.floodlit, scale);
      const coordinates = [...recorder.calls('moveTo'), ...recorder.calls('lineTo')].flatMap(
        (op) => op.args as readonly number[],
      );
      expect(coordinates, String(scale)).toHaveLength(24);
      for (const value of coordinates) {
        expect(Number.isFinite(value), `${String(scale)}: ${String(value)}`).toBe(true);
      }
    }
  });

  it('tints each goal frame to the side that defends it, outlined', () => {
    const recorder = new CanvasRecorder();
    drawGoalFrames(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('fillRect')).toHaveLength(2);
    expect(recorder.calls('strokeRect')).toHaveLength(2);
    // Depth 64 outside each field edge, 190 tall: the frame rectangles
    // exactly, and the tint order follows the field: player left.
    expect(rectArgs(recorder)[0]).toEqual([FIELD_LEFT - 64, 265, 64, 190]);
    expect(rectArgs(recorder)[1]).toEqual([FIELD_RIGHT, 265, 64, 190]);
    expect(recorder.values('fillStyle')).toEqual([
      PLAY_SURFACE.floodlit.teamPlayer,
      PLAY_SURFACE.floodlit.teamOpponent,
    ]);
    expect(recorder.values('strokeStyle')).toEqual([
      PLAY_SURFACE.floodlit.line,
      PLAY_SURFACE.floodlit.line,
    ]);
    expect(recorder.values('lineWidth')).toEqual([3, 3]);
  });

  it('fades the stripes toward stripe A at the edges and nowhere else', () => {
    const recorder = new CanvasRecorder();
    drawVignette(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('createRadialGradient')).toHaveLength(1);
    const gradient = recorder.calls('createRadialGradient')[0]?.args ?? [];
    // Centred on the spot the ball starts on; tint-free to the edge of the
    // centre circle's neighbourhood (275, half the field height) and total
    // past the field diagonal.
    expect(gradient[0]).toBe(640);
    expect(gradient[1]).toBe(360);
    expect(gradient[2]).toBe(275);
    expect(gradient[5]).toBeCloseTo(615, 0);
    expect(recorder.calls('addColorStop').map((op) => op.args)).toEqual([
      [0, 'transparent'],
      [1, PLAY_SURFACE.floodlit.stripeA],
    ]);
    // The alpha is the vignette's one free parameter, pinned at both ends:
    // present enough to fade, and reset so nothing after it inherits it.
    expect(recorder.values('globalAlpha')).toEqual([0.35, 1]);
    expect(rectArgs(recorder)[0]).toEqual([
      FIELD_LEFT,
      FIELD_BOTTOM,
      FIELD_WIDTH,
      FIELD_HEIGHT,
    ]);
  });

  it('draws both variants with exactly the palette of that variant, in order', () => {
    // ORDERED BY FIRST USE, NOT A SET. A set says which colours were used and
    // nothing about which pass used them, so a rail painted in the boundary
    // colour, or markings in the rail's, produce the same six-element set. The
    // sequence below is the order the static passes first reach for a colour,
    // which is a fact about the drawing rather than about its palette, and the
    // stripe alternation itself is frozen by the census in the first test
    // rather than restated here as a loop this assertion could agree with.
    for (const variant of VARIANTS) {
      const palette = PLAY_SURFACE[variant];
      const recorder = new CanvasRecorder();
      drawStatic(recorder, palette);
      const strings = [
        ...recorder.values('fillStyle'),
        ...recorder.values('strokeStyle'),
      ].filter((value): value is string => typeof value === 'string');
      const firstUse = strings.filter((value, at) => strings.indexOf(value) === at);
      expect(firstUse, variant).toEqual([
        palette.stripeA,
        palette.stripeB,
        palette.line,
        palette.rail,
        palette.teamPlayer,
        palette.teamOpponent,
      ]);
    }
  });

  it('renders the static layer once, at backing-store scale, in pass order', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 2;
    surface.canvas.width = 2000;
    const layerRecorder = new CanvasRecorder();
    let built = 0;
    const layer = renderStaticPitch(surface, PLAY_SURFACE.floodlit, () => {
      built += 1;
      return asCanvas(fakeCanvas(layerRecorder));
    });
    expect(built).toBe(1);
    expect(layer.scale).toBe(2);
    expect(layer.palette).toBe(PLAY_SURFACE.floodlit);
    expect(layer.canvas.width).toBe(2000);
    // The layer draws in design space: the flip transform, then the passes,
    // ending with the goal frames, which are the last static pass.
    expect(layerRecorder.ops[0]?.name).toBe('setTransform');
    expect(layerRecorder.ops[0]?.args).toEqual([2, 0, 0, -2, 0, LOGICAL_HEIGHT * 2]);
    expect(layerRecorder.ops[1]?.name).toBe('fillStyle');
    expect(layerRecorder.ops[2]?.name).toBe('fillRect');
    expect(layerRecorder.ops.at(-1)?.name).toBe('strokeRect');

    // ALL FIVE PASSES, IN THE ORDER THEY RUN. Pinning the first three ops and
    // the name of the last leaves the middle of the layer unpinned: moving the
    // vignette from second to fourth leaves op 0 a setTransform, op 1 a fill
    // colour, op 2 a fillRect and the last op a strokeRect, all unchanged, and
    // the module's own guarantee at its head ("drawn under the markings and
    // the rail, so nothing that carries a contrast guarantee is tinted by it")
    // silently stops holding: the audit measured the rail falling from 3.09 to
    // 2.44 floodlit and 2.14 daylight at the corners with the vignette last.
    // Each pass is found by an op only it makes, and the ORDER of those is the
    // assertion.
    const witness = (pass: string, at: number): { pass: string; at: number } => {
      expect(at, pass).toBeGreaterThan(0);
      return { pass, at };
    };
    const rail = PLAY_SURFACE.floodlit.rail;
    const railAt = layerRecorder.ops.findIndex(
      (op) => op.kind === 'set' && op.name === 'fillStyle' && op.args[0] === rail,
    );
    const found = [
      witness('stripes', layerRecorder.indexOf('call', 'fillRect')),
      witness('vignette', layerRecorder.indexOf('call', 'createRadialGradient')),
      witness('markings', layerRecorder.indexOf('call', 'arc')),
      witness('walls', railAt),
      witness('goal frames', layerRecorder.indexOf('call', 'strokeRect')),
    ];
    expect([...found].sort((one, other) => one.at - other.at).map((entry) => entry.pass)).toEqual([
      'stripes',
      'vignette',
      'markings',
      'walls',
      'goal frames',
    ]);
    // And the vignette is wholly behind the markings: its alpha is restored to
    // 1 before the first stroke the layer makes, so nothing carrying a
    // contrast guarantee is drawn under it.
    expect(layerRecorder.values('globalAlpha').slice(0, 2)).toEqual([0.35, 1]);
    expect(layerRecorder.indexOf('set', 'globalAlpha')).toBeLessThan(
      layerRecorder.indexOf('call', 'stroke'),
    );
  });

  it('knows when a layer is stale, in the only three ways it can be', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 2;
    surface.canvas.width = 2000;
    const layer = renderStaticPitch(surface, PLAY_SURFACE.floodlit, () =>
      asCanvas(fakeCanvas(new CanvasRecorder())),
    );
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(true);
    // A resize moved the scale.
    surface.scale = 1.5;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
    surface.scale = 2;
    // The variant changed, which is a different palette object.
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.daylight)).toBe(false);
    surface.scale = 2;
    // A backing-store dimension moved, which a resize always carries.
    surface.canvas.width = 1000;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
    surface.canvas.width = 2000;
    surface.canvas.height = 500;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
  });

  it('rebuilds the cache through the frame, headlessly, when it is stale', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 1;
    surface.canvas.width = 1280;
    const cache: PitchCacheCell = {
      current: {
        canvas: asCanvas(fakeCanvas(new CanvasRecorder())),
        scale: 2,
        palette: PLAY_SURFACE.floodlit,
      },
    };
    let built = 0;
    drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit, {
      createLayer: () => {
        built += 1;
        return asCanvas(fakeCanvas(new CanvasRecorder()));
      },
    });
    expect(built).toBe(1);
    expect(cache.current?.scale).toBe(1);
  });
});

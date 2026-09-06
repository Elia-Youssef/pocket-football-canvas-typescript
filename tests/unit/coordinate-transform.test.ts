import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AimState } from '../../src/core/aiming';
import { createWorld } from '../../src/core/bodies';
import type { MatchState } from '../../src/core/match';
import { attachAimInput, toDesignPoint } from '../../src/render/input';

/**
 * Item C5, method T, evidence `unit/coordinate-transform`:
 *
 *   "Drag distance is measured in logical design space at every viewport
 *    scale and device pixel ratio, so the drag constants behave identically
 *    on a phone and on a desktop."
 *
 * THIS IS THE ITEM THE PART EXISTS FOR, and QUALITY-BAR section 7 records the
 * defect: an earlier build shipped a pointer helper that silently returned
 * `720 - correctY`, and it gated seventy points of aiming criteria. So the
 * assertions below are on the LOGICAL delta rather than on the pixel delta,
 * and the CSS numbers they are driven with are worked out by hand rather than
 * taken from the mapping under test. At the three scales used here the same
 * 30 design-unit drag arrives as 30, 15 and 7.5 CSS pixels, which is the
 * sentence "identically on a phone and on a desktop" in numbers.
 *
 * THE DEVICE PIXEL RATIO IS NOT IN THE CHAIN, and the two tests that say so
 * prove different things, which is worth stating plainly rather than letting
 * one borrow the other's credit. The behavioural one sets the surface's
 * backing store to three sizes for one CSS rectangle and shows the design
 * delta does not move: that refutes a mapping which scaled by the backing
 * store, and only that. The defect QUALITY-BAR section 7 actually names is a
 * `devicePixelRatio` read multiplied into the chain, and nothing about a
 * function's output can refute a read it does not make, so the assertion that
 * closes it is the source scan at the end of this file. It has its own
 * mutation entry, which puts the ratio into the mapping and requires the scan
 * to catch it.
 *
 * The 30 and the 180 are written out. Asserting a bound against the symbol
 * that defines it passes for whatever value the symbol takes.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const INPUT_SOURCE = path.join(PROJECT_ROOT, 'src', 'render', 'input.ts');

/** SPEC section 3's logical design space, written out for the arithmetic. */
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

const PLAYER_TURN: MatchState = { kind: 'PLAYER_TURN' };

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FakePointerEvent {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface FakeSurface {
  /** The canvas the input module is handed. */
  readonly canvas: HTMLCanvasElement;
  /** The rectangle the next event will read. Moved to model a scroll. */
  rect: Rect;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  /** The backing store, which is the device pixel ratio's only footprint. */
  backing: { width: number; height: number };
  captured(): number | null;
  rectReads(): number;
  fire(type: string, event: FakePointerEvent): void;
}

/**
 * A canvas stand-in with the four surfaces the input module actually uses:
 * listeners, a rectangle, a pointer capture and the element's own style and
 * dataset. The unit suite runs headless on purpose (vitest.config.ts), so the
 * alternative to a stand-in is not a real canvas, it is no test.
 */
function fakeSurface(): FakeSurface {
  const handlers = new Map<string, (event: FakePointerEvent) => void>();
  const style: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const backing = { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT };
  let box: Rect = { left: 0, top: 0, width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT };
  let capture: number | null = null;
  let reads = 0;
  const element = {
    style,
    dataset,
    get width(): number {
      return backing.width;
    },
    get height(): number {
      return backing.height;
    },
    addEventListener(type: string, handler: (event: FakePointerEvent) => void): void {
      handlers.set(type, handler);
    },
    getBoundingClientRect(): Rect {
      reads += 1;
      return { ...box };
    },
    setPointerCapture(pointerId: number): void {
      capture = pointerId;
    },
    hasPointerCapture(pointerId: number): boolean {
      return capture === pointerId;
    },
    releasePointerCapture(pointerId: number): void {
      if (capture === pointerId) {
        capture = null;
      }
    },
  };
  return {
    canvas: element as unknown as HTMLCanvasElement,
    get rect(): Rect {
      return box;
    },
    set rect(next: Rect) {
      box = next;
    },
    style,
    dataset,
    backing,
    captured: (): number | null => capture,
    rectReads: (): number => reads,
    fire(type: string, event: FakePointerEvent): void {
      handlers.get(type)?.(event);
    },
  };
}

interface Harness {
  readonly surface: FakeSurface;
  readonly launches: AimState[];
  refresh(): void;
  preview(): { reach: number; launchable: boolean; power01: number } | null;
}

function harness(state: () => MatchState = () => PLAYER_TURN): Harness {
  const surface = fakeSurface();
  const launches: AimState[] = [];
  const input = attachAimInput({
    canvas: surface.canvas,
    world: createWorld(),
    state,
    onLaunch: (aim) => {
      launches.push(aim);
    },
  });
  return {
    surface,
    launches,
    refresh: () => {
      input.refresh();
    },
    preview: () => {
      const live = input.preview();
      return live === null
        ? null
        : { reach: live.reach, launchable: live.launchable, power01: live.aim.power01 };
    },
  };
}

/** The viewport point a design point sits at, worked out from the rectangle. */
function clientOf(rect: Rect, designX: number, designY: number): FakePointerEvent {
  return {
    pointerId: 1,
    clientX: rect.left + (designX * rect.width) / LOGICAL_WIDTH,
    clientY: rect.top + ((LOGICAL_HEIGHT - designY) * rect.height) / LOGICAL_HEIGHT,
  };
}

describe('PF-5 the pointer mapping, item C5', () => {
  it('maps a viewport point into the design space, origin at the bottom left', () => {
    const full = { left: 0, top: 0, width: 1280, height: 720 };
    expect(toDesignPoint(full, 0, 0)).toEqual({ x: 0, y: 720 });
    expect(toDesignPoint(full, 1280, 720)).toEqual({ x: 1280, y: 0 });
    expect(toDesignPoint(full, 640, 360)).toEqual({ x: 640, y: 360 });

    // Half scale: every CSS pixel is two design units, in both axes.
    const half = { left: 0, top: 0, width: 640, height: 360 };
    expect(toDesignPoint(half, 320, 180)).toEqual({ x: 640, y: 360 });
    expect(toDesignPoint(half, 0, 360)).toEqual({ x: 0, y: 0 });

    // Offset in both axes at once, which is what a letterbox is.
    const boxed = { left: 137.5, top: 42.25, width: 640, height: 360 };
    expect(toDesignPoint(boxed, 137.5, 42.25)).toEqual({ x: 0, y: 720 });
    expect(toDesignPoint(boxed, 457.5, 222.25)).toEqual({ x: 640, y: 360 });
  });

  it('measures the drag in design units at three viewport scales', () => {
    // The same 30-unit drag, arriving as three different CSS distances. The
    // press is at the player's own circle centre, design (300, 360), because
    // that is where an aim is allowed to begin.
    const cases: ReadonlyArray<readonly [string, Rect, number]> = [
      ['a desktop at full size', { left: 0, top: 0, width: 1280, height: 720 }, 30],
      ['a half-size surface', { left: 0, top: 0, width: 640, height: 360 }, 15],
      ['a phone at a quarter', { left: 0, top: 0, width: 320, height: 180 }, 7.5],
    ];
    for (const [name, rect, cssDelta] of cases) {
      const test = harness();
      test.surface.rect = rect;
      const press = clientOf(rect, 300, 360);
      test.surface.fire('pointerdown', press);
      test.surface.fire('pointermove', {
        pointerId: 1,
        clientX: press.clientX + cssDelta,
        clientY: press.clientY,
      });
      const preview = test.preview();
      expect(preview?.reach, name).toBeCloseTo(30, 9);
      // Exactly at the minimum, so the release launches: SPEC section 5 says
      // BELOW the minimum cancels, and 30 is not below 30.
      expect(preview?.launchable, name).toBe(true);
      expect(preview?.power01, name).toBeCloseTo(0, 12);
    }
  });

  it('measures the maximum in design units too, at every scale', () => {
    for (const rect of [
      { left: 0, top: 0, width: 1280, height: 720 },
      { left: 0, top: 0, width: 320, height: 180 },
    ]) {
      const test = harness();
      test.surface.rect = rect;
      const press = clientOf(rect, 300, 360);
      test.surface.fire('pointerdown', press);
      // 179 and 180 design units, and then 400, which is well past the clamp.
      for (const [design, expectedReach] of [
        [179, 179],
        [180, 180],
        [400, 180],
      ] as const) {
        test.surface.fire('pointermove', {
          pointerId: 1,
          clientX: press.clientX + (design * rect.width) / LOGICAL_WIDTH,
          clientY: press.clientY,
        });
        expect(test.preview()?.reach, `${String(rect.width)} at ${String(design)}`).toBeCloseTo(
          expectedReach,
          9,
        );
      }
      // And the strength saturates with the arrow, on the one power scale.
      expect(test.preview()?.power01).toBe(1);
    }
  });

  it('is unchanged by the backing store, which is the only footprint a ratio has here', () => {
    const rect = { left: 0, top: 0, width: 640, height: 360 };
    const reaches: number[] = [];
    for (const ratio of [1, 2, 2.5]) {
      const test = harness();
      test.surface.rect = rect;
      test.surface.backing.width = Math.round(rect.width * ratio);
      test.surface.backing.height = Math.round(rect.height * ratio);
      const press = clientOf(rect, 300, 360);
      test.surface.fire('pointerdown', press);
      test.surface.fire('pointermove', {
        pointerId: 1,
        clientX: press.clientX + 45,
        clientY: press.clientY - 30,
      });
      reaches.push(test.preview()?.reach ?? -1);
    }
    // 45 by 30 CSS pixels at half scale is 90 by 60 design units, which is a
    // 108.166 unit drag whatever the display density is.
    expect(reaches).toHaveLength(3);
    for (const reach of reaches) {
      expect(reach).toBeCloseTo(Math.hypot(90, 60), 9);
    }
    expect(new Set(reaches).size).toBe(1);
  });

  it('is unchanged by a letterbox that offsets both axes', () => {
    const test = harness();
    test.surface.rect = { left: 137.5, top: 42.25, width: 640, height: 360 };
    const press = clientOf(test.surface.rect, 300, 360);
    expect(press.clientX).toBeCloseTo(287.5, 9);
    expect(press.clientY).toBeCloseTo(222.25, 9);
    test.surface.fire('pointerdown', press);
    // Up and to the left in viewport terms, which is up and to the left in
    // design terms once the y axis has flipped.
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX - 30,
      clientY: press.clientY - 20,
    });
    expect(test.preview()?.reach).toBeCloseTo(Math.hypot(60, 40), 9);
    expect(test.preview()?.launchable).toBe(true);
  });

  it('survives a page scroll between the press and the release', () => {
    const test = harness();
    test.surface.rect = { left: 0, top: 100, width: 1280, height: 720 };
    const press = clientOf(test.surface.rect, 300, 360);
    expect(press.clientY).toBeCloseTo(460, 9);
    test.surface.fire('pointerdown', press);

    // The page scrolls 60 CSS pixels under a finger that has not moved: the
    // rectangle rises by 60 and so does the pointer's client coordinate.
    test.surface.rect = { left: 0, top: 40, width: 1280, height: 720 };
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX,
      clientY: press.clientY - 60,
    });
    // Nothing was dragged, so nothing is aimed. A rectangle cached at the
    // press would read this as a 60 unit drag and a launchable shot.
    expect(test.preview()?.reach).toBeCloseTo(0, 9);
    expect(test.preview()?.launchable).toBe(false);

    // And a real drag after the scroll is measured from the same origin.
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 40,
      clientY: press.clientY - 60,
    });
    expect(test.preview()?.reach).toBeCloseTo(40, 9);
    // The rectangle was read once per event and never cached: three events
    // so far, three reads.
    expect(test.surface.rectReads()).toBe(3);
  });

  it('detects the raw-pixel reading the criterion exists to prevent', () => {
    // The negative control: the same classification applied to the CSS delta
    // rather than to the design delta. On a phone it disagrees with the
    // shipped reading about both of SPEC section 5's constants.
    const rawLaunchable = (cssDelta: number): boolean => cssDelta >= 30;
    const rawPower = (cssDelta: number): number =>
      (Math.min(Math.max(cssDelta, 30), 180) - 30) / 150;

    const phone = { left: 0, top: 0, width: 320, height: 180 };
    const test = harness();
    test.surface.rect = phone;
    const press = clientOf(phone, 300, 360);

    // 7.5 CSS pixels is 30 design units: launchable here, refused raw.
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 7.5,
      clientY: press.clientY,
    });
    expect(test.preview()?.launchable).toBe(true);
    expect(rawLaunchable(7.5)).toBe(false);

    // 30 CSS pixels is 120 design units: 60 percent power here, and the
    // weakest legal shot raw. The two readings are 450 px/s apart.
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 30,
      clientY: press.clientY,
    });
    expect(test.preview()?.power01).toBeCloseTo(0.6, 12);
    expect(rawPower(30)).toBe(0);
    expect(150 + 750 * 0.6 - (150 + 750 * rawPower(30))).toBeCloseTo(450, 9);
  });
});

describe('PF-5 the pointer gesture, armour for the clauses item C9 grades at PF-6', () => {
  it('takes a pointer capture on pointerdown and gives it back on release', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    expect(test.surface.captured()).toBeNull();
    test.surface.fire('pointerdown', press);
    expect(test.surface.captured()).toBe(1);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 60,
      clientY: press.clientY,
    });
    test.surface.fire('pointerup', { ...press, clientX: press.clientX + 60 });
    expect(test.surface.captured()).toBeNull();
    expect(test.launches).toHaveLength(1);
  });

  it('applies touch-action none for the capture only', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    expect(test.surface.style['touchAction']).toBe('pinch-zoom');
    test.surface.fire('pointerdown', press);
    expect(test.surface.style['touchAction']).toBe('none');
    test.surface.fire('pointerup', press);
    expect(test.surface.style['touchAction']).toBe('pinch-zoom');
  });

  it('ignores a second pointer arriving mid-drag', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 60,
      clientY: press.clientY,
    });
    expect(test.preview()?.reach).toBeCloseTo(60, 9);

    // A second finger lands on the circle and drags the other way. It is not
    // a second aim and it does not steal the first one.
    test.surface.fire('pointerdown', { ...press, pointerId: 2 });
    test.surface.fire('pointermove', {
      pointerId: 2,
      clientX: press.clientX - 170,
      clientY: press.clientY,
    });
    expect(test.surface.captured()).toBe(1);
    expect(test.preview()?.reach).toBeCloseTo(60, 9);

    // Its release launches nothing either; the first pointer still owns the
    // gesture and still finishes it.
    test.surface.fire('pointerup', { ...press, pointerId: 2 });
    expect(test.launches).toHaveLength(0);
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 60,
      clientY: press.clientY,
    });
    expect(test.launches).toHaveLength(1);
  });

  it('launches nothing on a release below the minimum', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 29,
      clientY: press.clientY,
    });
    expect(test.preview()?.launchable).toBe(false);
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 29,
      clientY: press.clientY,
    });
    expect(test.launches).toHaveLength(0);
    // And one unit further is a shot, so the refusal is the bound and not a
    // release that never launches anything.
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 30,
      clientY: press.clientY,
    });
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 30,
      clientY: press.clientY,
    });
    expect(test.launches).toHaveLength(1);
  });

  it('cancels without launching when the pointer is cancelled', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 90,
      clientY: press.clientY,
    });
    test.surface.fire('pointercancel', press);
    expect(test.launches).toHaveLength(0);
    expect(test.preview()).toBeNull();
    expect(test.surface.captured()).toBeNull();
    expect(test.surface.dataset['pfAim']).toBe('idle');
  });

  it('mirrors the aim phase onto the surface element', () => {
    const test = harness();
    const press = clientOf(test.surface.rect, 300, 360);
    expect(test.surface.dataset['pfAim']).toBe('idle');
    test.surface.fire('pointerdown', press);
    expect(test.surface.dataset['pfAim']).toBe('below-minimum');
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 29,
      clientY: press.clientY,
    });
    expect(test.surface.dataset['pfAim']).toBe('below-minimum');
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 30,
      clientY: press.clientY,
    });
    expect(test.surface.dataset['pfAim']).toBe('aiming');
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 30,
      clientY: press.clientY,
    });
    expect(test.surface.dataset['pfAim']).toBe('idle');
  });

  it('begins no aim in a state that refuses one', () => {
    let state: MatchState = { kind: 'OPPONENT_TURN' };
    const test = harness(() => state);
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    expect(test.preview()).toBeNull();
    expect(test.surface.captured()).toBeNull();
    expect(test.surface.dataset['pfAim']).toBe('idle');
    // The same press, once the turn is the player's, does begin one, so the
    // refusal above is the state and not the press.
    state = PLAYER_TURN;
    test.surface.fire('pointerdown', press);
    expect(test.preview()).not.toBeNull();
  });

  it('ends an aim the match stops allowing, without waiting for a pointer event', () => {
    // The hole this closes: the pause control is chrome and answers a keyboard
    // or a second finger while a drag is in progress, so a state change can
    // land between two pointer events. An aim that survived it would still be
    // drawn, still be adjustable, and still launch on release.
    let state: MatchState = PLAYER_TURN;
    const test = harness(() => state);
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 120,
      clientY: press.clientY,
    });
    expect(test.preview()?.launchable).toBe(true);
    expect(test.surface.captured()).toBe(1);

    state = { kind: 'PAUSED', interrupted: PLAYER_TURN };
    test.refresh();
    expect(test.preview()).toBeNull();
    expect(test.surface.dataset['pfAim']).toBe('idle');
    expect(test.surface.captured()).toBeNull();
    expect(test.surface.style['touchAction']).toBe('pinch-zoom');

    // And the release that follows launches nothing, because there is no
    // longer an aim for it to finish.
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 120,
      clientY: press.clientY,
    });
    expect(test.launches).toHaveLength(0);

    // The refresh leaves an allowed aim alone, so it is the lock and not a
    // reset of every gesture.
    state = PLAYER_TURN;
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 120,
      clientY: press.clientY,
    });
    test.refresh();
    expect(test.preview()?.launchable).toBe(true);
  });

  it('asks the lock again at the release, not only at the press', () => {
    let state: MatchState = PLAYER_TURN;
    const test = harness(() => state);
    const press = clientOf(test.surface.rect, 300, 360);
    test.surface.fire('pointerdown', press);
    test.surface.fire('pointermove', {
      pointerId: 1,
      clientX: press.clientX + 120,
      clientY: press.clientY,
    });
    expect(test.preview()?.launchable).toBe(true);
    // The pause control is chrome and acts between the press and the release.
    state = { kind: 'PAUSED', interrupted: PLAYER_TURN };
    test.surface.fire('pointerup', {
      pointerId: 1,
      clientX: press.clientX + 120,
      clientY: press.clientY,
    });
    expect(test.launches).toHaveLength(0);
    expect(test.preview()).toBeNull();
  });

  it('begins no aim on a press that misses your own circle', () => {
    const test = harness();
    // Fifty units to the right of the player centre, which is outside its
    // 34 unit radius; a hundred above it; and the opponent's own circle,
    // which is a circle but not yours.
    for (const [designX, designY] of [
      [350, 360],
      [300, 460],
      [980, 360],
    ] as const) {
      test.surface.fire('pointerdown', clientOf(test.surface.rect, designX, designY));
      expect(test.preview(), `${String(designX)},${String(designY)}`).toBeNull();
    }
    // The rim itself is on the circle: 34 units out, exactly.
    test.surface.fire('pointerdown', clientOf(test.surface.rect, 334, 360));
    expect(test.preview()).not.toBeNull();
  });

  it('earns its one exemption from the M1 source scan, and takes no other', () => {
    const source = readFileSync(INPUT_SOURCE, 'utf8');
    // Non-vacuous: the exemption exists because this module really does read
    // a pointer coordinate and really does query the rectangle.
    expect(source).toContain('event.clientX');
    expect(source).toContain('event.clientY');
    expect(source).toContain('canvas.getBoundingClientRect()');
    // QUALITY-BAR section 3 names three coordinate reads that are wrong here:
    // offsetX retargets under a capture, pageX breaks under a scroll, and
    // screenX is not in the viewport's frame at all.
    for (const banned of ['offsetX', 'offsetY', 'pageX', 'pageY', 'screenX', 'screenY']) {
      expect(source.includes(banned), banned).toBe(false);
    }
    // And the ratio is not in this chain, which is the whole of QUALITY-BAR
    // section 7's third failure mode.
    expect(source.includes('devicePixelRatio')).toBe(false);
  });
});

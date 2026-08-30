/**
 * A recording 2d context, for armour tests that census what the renderer
 * draws.
 *
 * ARMOUR, NOT CLOSURE: this file asserts nothing by itself. It exists because
 * the unit suite runs headless, so the only way a test can see a draw call is
 * if the context is a stand-in that writes down what it was asked to do and
 * does nothing else. Every assertion about the recorded calls lives in the
 * armour test that owns the criterion.
 *
 * The recorder implements exactly the surface the renderer uses and nothing
 * more, so a draw call through an API nobody declared fails loudly here
 * rather than silently vanishing. Property writes are recorded like calls:
 * "state set explicitly" is a claim the renderer makes, and a test can only
 * check a claim it can see.
 */

export interface RecordedOp {
  readonly kind: 'call' | 'set';
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A gradient stand-in whose stops are recorded like everything else. */
interface RecordedGradient {
  addColorStop(offset: number, colour: string): void;
}

export class CanvasRecorder {
  readonly ops: RecordedOp[] = [];

  readonly context: CanvasRenderingContext2D;

  private readonly last: Map<string, unknown> = new Map();

  constructor() {
    const ops = this.ops;
    const last = this.last;
    const record = (kind: 'call' | 'set', name: string, args: unknown[]): void => {
      ops.push({ kind, name, args });
      last.set(name, args[0]);
    };
    const call =
      (name: string) =>
      (...args: unknown[]): void => {
        record('call', name, args);
      };
    const target: Record<string, unknown> = {
      setTransform: call('setTransform'),
      save: call('save'),
      restore: call('restore'),
      beginPath: call('beginPath'),
      closePath: call('closePath'),
      moveTo: call('moveTo'),
      lineTo: call('lineTo'),
      arc: call('arc'),
      fill: call('fill'),
      stroke: call('stroke'),
      clip: call('clip'),
      translate: call('translate'),
      scale: call('scale'),
      fillRect: call('fillRect'),
      strokeRect: call('strokeRect'),
      fillText: call('fillText'),
      drawImage: call('drawImage'),
      createRadialGradient: (...args: unknown[]): RecordedGradient => {
        record('call', 'createRadialGradient', args);
        return {
          addColorStop: (offset: number, colour: string): void => {
            record('call', 'addColorStop', [offset, colour]);
          },
        };
      },
    };
    for (const name of [
      'fillStyle',
      'strokeStyle',
      'lineWidth',
      'globalAlpha',
      'font',
      'textAlign',
      'textBaseline',
    ]) {
      Object.defineProperty(target, name, {
        set: (value: unknown): void => {
          record('set', name, [value]);
        },
        get: (): unknown => last.get(name),
      });
    }
    this.context = target as unknown as CanvasRenderingContext2D;
  }

  /** Every recorded op of one kind and name, in order. */
  opsNamed(kind: 'call' | 'set', name: string): RecordedOp[] {
    return this.ops.filter((op) => op.kind === kind && op.name === name);
  }

  calls(name: string): RecordedOp[] {
    return this.opsNamed('call', name);
  }

  sets(name: string): RecordedOp[] {
    return this.opsNamed('set', name);
  }

  /** The recorded values of one property, in order. */
  values(name: string): unknown[] {
    return this.sets(name).map((op) => op.args[0]);
  }

  /** The index of an op's first occurrence, or -1, for order assertions. */
  indexOf(kind: 'call' | 'set', name: string): number {
    return this.ops.findIndex((op) => op.kind === kind && op.name === name);
  }
}

/** A canvas stand-in with its attributes and dataset readable by the test. */
export interface FakeCanvas {
  width: number;
  height: number;
  readonly style: Record<string, string>;
  readonly attrs: Map<string, string>;
  readonly dataset: Record<string, string>;
  snapshots: number;
  getContext(type: string): CanvasRenderingContext2D | null;
  toDataURL(): string;
  setAttribute(name: string, value: string): void;
}

/**
 * A canvas stand-in. Hand it a recorder and its context records; hand it to
 * `attachSurface` and the renderer draws through that context.
 */
export function fakeCanvas(recorder: CanvasRecorder): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    style: {},
    attrs: new Map<string, string>(),
    dataset: {},
    snapshots: 0,
    getContext(type: string): CanvasRenderingContext2D | null {
      return type === '2d' ? recorder.context : null;
    },
    toDataURL(): string {
      this.snapshots += 1;
      return `data:image/png;base64,${String(this.snapshots)}`;
    },
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    },
  };
  return canvas;
}

/** The canvas cast the renderer expects, for passing into render code. */
export function asCanvas(fake: FakeCanvas): HTMLCanvasElement {
  return fake as unknown as HTMLCanvasElement;
}

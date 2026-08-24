import type { TreeComparison } from './output-fingerprint.mjs';

export interface DeterminismRun {
  /** Label used in the report. */
  id: string;
  /** Output directory, relative to the project root. */
  outDir: string;
  /** TZ for the build process. */
  zone: string;
  /** The VITE_ prefixed value that must not reach the emitted bytes. */
  probe: string;
  /** The fake mtime stamped onto every input file before this run. */
  stamp: Date;
}

export interface DeterminismInputs {
  buildError: string | null;
  comparison: TreeComparison;
  inputStable: boolean;
  emittedCount: number;
}

export declare const RUNS: readonly DeterminismRun[];
export declare function verdict(inputs: DeterminismInputs): boolean;

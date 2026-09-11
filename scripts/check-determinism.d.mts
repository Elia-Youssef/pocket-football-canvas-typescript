import type { Tree, TreeComparison } from './output-fingerprint.mjs';

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

export interface BuildInvocation {
  /** Absolute output directory the run writes into. */
  outDir: string;
  /** The child's argument vector, composed from the run. */
  argv: string[];
  /** The child's environment, composed from the run. */
  env: Record<string, string | undefined>;
}

/** What one run was actually given, recorded as it was composed. */
export interface DeterminismRecord {
  id: string;
  stamp: Date;
  zone: string | undefined;
  probe: string | undefined;
  outDir: string | undefined;
}

export interface RunOutcome {
  emitted: Tree[];
  records: DeterminismRecord[];
  buildError: string | null;
}

export type Spawn = (
  file: string,
  argv: string[],
  options: Record<string, unknown>,
) => unknown;

export type Touch = (file: string, atime: Date, mtime: Date) => void;

export declare const RUNS: readonly DeterminismRun[];
export declare function buildInvocation(run: DeterminismRun): BuildInvocation;
export declare function build(run: DeterminismRun, spawn?: Spawn): string;
export declare function stampAll(
  files: string[],
  when: Date,
  touch?: Touch,
): number;
export declare function performRuns(options: {
  files: string[];
  runs: readonly DeterminismRun[];
  stamp?: (files: string[], when: Date) => unknown;
  run?: (run: DeterminismRun) => string;
  read?: (root: string) => Tree;
}): RunOutcome;
export declare function conditionRows(
  records: readonly DeterminismRecord[],
): string[][];
export declare function verdict(inputs: DeterminismInputs): boolean;

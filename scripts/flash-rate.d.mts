/** One admitted flash: which run it belongs to, where it landed, and when. */
export interface Onset {
  /** The driven match it came from, because each has a clock of its own. */
  run: number;
  /** The region index `src/render/effects.ts` grids the pitch into. */
  region: number;
  /** Seconds on that run's effects clock. */
  at: number;
}

/** One workload's readings, accumulated frame by frame. */
export interface Workload {
  name: string;
  frames: number;
  seconds: number;
  /** Every event the effects layer derived, admitted or refused. */
  events: number;
  /** Flashes the per-region limiter refused, which is what tests it. */
  refusals: number;
  /**
   * The same count per driven run, because each run builds its own effects
   * layer and its own counter. `refusals` is the sum; a caller that constructs
   * a workload by hand states the sum and needs no map.
   */
  refusalsPerRun?: Map<number, number>;
  /** The emergent flashes the limiter governs: impacts and wall bounces. */
  onsets: Onset[];
  /** SPEC section 14's authored goal celebration, bounded by SPEC section 6.4. */
  celebrations: Onset[];
}

export interface Measurement {
  at: number;
  /** The limiter's own constants, read back from the module being measured. */
  limiter: { perWindow: number; window: number };
  workloads: Workload[];
  refused: number;
}

export interface Verdict {
  /** The process exit status: zero passes. */
  status: number;
  /** The largest number of emergent flashes any region drew in any second. */
  worst: number;
  /** Every reason the run is not a pass, named one per line. */
  problems: string[];
  /** One line per workload, in the order they ran. */
  lines: string[];
}

export declare const FLASH_LIMIT: number;
export declare const WINDOW_SECONDS: number;
export declare const CELEBRATION_LIMIT: number;
export declare const EMERGENT_KINDS: string[];
export declare const REPORT_PATH: string;
export declare function rollingMaximum(times: readonly number[], window?: number): number;
export declare function regionMaxima(
  onsets: readonly Onset[],
  window?: number,
): Map<string, number>;
export declare function regionsTouched(onsets: readonly Onset[]): number;
export declare function workloadRows(workload: Workload): [string, string][];
export declare function verdict(measurement: Measurement, limit?: number): Verdict;
export declare function reportText(measurement: Measurement, decision: Verdict): string;
export declare function measure(): Promise<Measurement>;
export declare function main(): Promise<number>;

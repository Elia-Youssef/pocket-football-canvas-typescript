/**
 * The harness's types, hand-written beside it because `tsconfig.json` runs no
 * `allowJs` and the suite reaches this module from four unit test files.
 *
 * GITHUB section 7's record is not what this file protects; the type checker is.
 * The declaration is compared against the runtime module's own export list in
 * both directions by `tests/unit/declarations.test.ts`, so a name added here and
 * not in `mutation-check.mjs`, or removed there and left here, reddens the unit
 * suite rather than failing at run time in whichever test imported it. Signatures
 * are still outside that comparison and are stated here from the implementation.
 */

/** The three detectors the sweep can name; `browser` is the last resort. */
export type MutationDetector = 'unit' | 'lint' | 'browser';

/** One protected property, broken by replacing a line that exists today. */
export interface MutationEdit {
  item: string;
  name: string;
  file: string;
  find: string;
  replace: string;
  detectedBy: MutationDetector;
}

/** One protected property, broken by adding a file that does not exist today. */
export interface MutationAddition {
  item: string;
  name: string;
  file: string;
  content: string;
  detectedBy: MutationDetector;
}

export interface DetectorOutcome {
  passed: boolean;
  killed: boolean;
  output: string;
}

/** A killed detector is neither, which is why `error` is one of the three. */
export type EntryVerdict = 'detected' | 'missed' | 'error';

export interface TreeChange {
  path: string;
  was: string | null;
  now: string | null;
}

export interface Incident {
  entry: string;
  attempt: number;
  paths: string[];
  failed: string[];
  /** Whether the entry is measured again, which the incident line has to say. */
  rerun?: boolean;
}

/** `looked` false is "the socket listing could not be read", never "free". */
export interface PreviewReclaim {
  killed: number[];
  free: boolean;
  looked: boolean;
}

export declare const EDITS: readonly MutationEdit[];
export declare const ADDITIONS: readonly MutationAddition[];

export declare function parseListeners(
  listing: string,
  port: number,
  platform?: string,
): number[];
export declare function previewListeners(port?: number): number[] | null;
export declare function reapPreview(port?: number): PreviewReclaim;
export declare function browserDetectorArgs(whole: boolean): string[];

export declare function detectorOutcome(
  error: unknown,
  stdout?: string,
  stderr?: string,
): DetectorOutcome;
export declare function entryVerdict(outcome: DetectorOutcome): EntryVerdict;
export declare function sweepSummary(input: {
  total: number;
  ran: number;
  missed: number;
  stoppedAt?: string | null;
  stopReason?: string;
  incidents?: Incident[];
  finalDrift?: string[];
}): { status: number; lines: string[] };

export declare function filesUnder(root: string, skip?: Set<string>): string[];
export declare function treeListing(
  root?: string,
  skip?: Set<string>,
): Map<string, string>;
export declare function treeDrift(
  before: Map<string, string>,
  after: Map<string, string>,
): TreeChange[];
export declare function restorePlan(
  drift: TreeChange[],
  known: Map<string, unknown>,
): { restore: string[]; remove: string[] };
export declare function driftVerdict(input: {
  paths?: string[];
  failed?: string[];
  attempt?: number;
}): { stop: string | null; rerun: boolean };
export declare function incidentLines(incident: Incident): string[];

export declare function main(): number;

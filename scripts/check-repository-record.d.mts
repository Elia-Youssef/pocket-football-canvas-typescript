export interface RecordHit {
  line?: number;
  text: string;
  reason: string;
}

export interface CommitRecord {
  author: string;
  committer: string;
  message: string;
}

export declare const BRANCH_PATTERN: RegExp;
export declare const SUBJECT_PATTERN: RegExp;
export declare const CLOSES_PATTERN: RegExp;

export declare function isGameContextLine(line: string): boolean;
export declare function isGameContextPath(relative: string): boolean;

/** Tracked file text. The contextual carve-out applies. */
export declare function scanContent(text: string): RecordHit[];

/** Commit, identity, branch and pull request text. No carve-out applies. */
export declare function scanRecord(text: string): RecordHit[];

export declare function scanPath(relative: string): RecordHit[];
export declare function isReservedBasename(name: string): boolean;
export declare function isTextPath(relative: string): boolean;
export declare function isAscii(value: string): boolean;
export declare function findControlByte(value: string): number | null;
export declare function checkSubject(subject: string): string[];
export declare function requiresCloses(subject: string): boolean;
export declare function isDependabotPullRequest(): boolean;
export declare function isDependabotCommit(commit: CommitRecord): boolean;
export declare function checkBody(
  lines: string[],
  options: { requireCloses: boolean; dependencyUpdate?: boolean },
): string[];
export declare function checkCommitRecord(
  commit: CommitRecord,
  options?: { allowDependabotGeneratedMetadata?: boolean },
): string[];

export declare function shallowRefusal(output: string): string | null;
export declare function shallowState(read: () => string): {
  refusal: string | null;
};

export interface ParsedCommit {
  sha: string;
  author: string;
  committer: string;
  message: string;
}

export declare function parseCommitLog(log: string): {
  records: ParsedCommit[];
  fragments: string[];
};

export declare function main(): number;

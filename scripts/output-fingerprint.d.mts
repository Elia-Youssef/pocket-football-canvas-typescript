export interface TreeEntry {
  bytes: number;
  hash: string;
}

export type Tree = Map<string, TreeEntry>;

export interface TreeDifference {
  path: string;
  left: TreeEntry;
  right: TreeEntry;
}

export interface TreeComparison {
  identical: boolean;
  onlyInLeft: string[];
  onlyInRight: string[];
  differing: TreeDifference[];
}

export declare function hashBytes(data: Uint8Array | string): string;
export declare function readTree(root: string): Tree;
export declare function treeFingerprint(tree: Tree): string;
export declare function compareTrees(left: Tree, right: Tree): TreeComparison;

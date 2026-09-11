/**
 * Types for the pieces of the plugin the boundary test drives directly. The
 * plugin itself is plain JavaScript because ESLint loads it as-is from the
 * flat config, with no build step between writing a rule and running it.
 */

export declare function isCorePath(filename: unknown): boolean;

export declare const SURFACE_SEGMENTS: ReadonlySet<string>;
export declare const ENGINE_RENDERER: string;

export declare function specifierSegments(specifier: string): string[];
export declare function matchesSurfaceSegment(specifier: string): boolean;
export declare function matchesEngineRenderer(specifier: string): boolean;
export declare function readSpecifier(node: unknown): string | null;

export declare const PLATFORM_GLOBALS: ReadonlySet<string>;
export declare const PLATFORM_PREFIXES: readonly RegExp[];
export declare function isPlatformGlobalName(name: unknown): boolean;

export declare function topLevelDeclarations(text: string): Set<string>;
export declare const DOM_LIB_NAMES: ReadonlySet<string>;
export declare const DOM_LIB_ORIGIN: string | null;

/** One dependency that left the root, named by where it was written. */
export interface ReachEscape {
  from: string;
  specifier: string;
  resolved: string | null;
}

export interface ReachClosure {
  modules: string[];
  escapes: ReachEscape[];
}

export declare const MODULE_EXTENSIONS: readonly string[];
export declare function withoutComments(source: string): string;
export declare function importSpecifiers(source: string): string[];
export declare function modulesUnder(
  root: string,
  extensions?: readonly string[],
): string[];
export declare function isInside(root: string, file: string): boolean;
export declare function resolveSpecifier(
  fromFile: string,
  specifier: string,
): string | null;
export declare function importClosure(
  root: string,
  read?: (file: string, encoding: 'utf8') => string,
): ReachClosure;

declare const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
};

export default plugin;

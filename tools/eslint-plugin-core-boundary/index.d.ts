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

declare const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
};

export default plugin;

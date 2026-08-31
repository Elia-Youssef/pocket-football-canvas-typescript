/**
 * Types for the pieces of the plugin the C9 test drives directly. The plugin
 * itself is plain JavaScript because ESLint loads it as-is from the flat
 * config, with no build step between writing a rule and running it.
 */

export declare const LEGACY_EVENT: RegExp;
export declare const LEGACY_HANDLER: RegExp;
export declare const LISTENER_METHODS: ReadonlySet<string>;
export declare const noMouseOrTouchListeners: unknown;

declare const plugin: {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
};

export default plugin;

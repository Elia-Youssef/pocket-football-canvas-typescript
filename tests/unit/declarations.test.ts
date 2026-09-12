import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as determinism from '../../scripts/check-determinism.mjs';
import * as fingerprint from '../../scripts/output-fingerprint.mjs';
import * as record from '../../scripts/check-repository-record.mjs';
import * as boundary from '../../tools/eslint-plugin-core-boundary/index.js';
import * as pointer from '../../tools/eslint-plugin-pointer-events/index.js';

/**
 * The hand-written declarations, checked against the modules they describe.
 *
 * WHY THIS EXISTS. `tsconfig.json` includes `scripts` but not `tools`, and
 * `allowJs` is off, so neither the two lint plugins nor the three gate scripts
 * are type checked. The suite reaches all five through declarations written by
 * hand beside them, which means the declarations, and not the implementations,
 * decide what every test in this project believes about those modules. A
 * declaration that over-states its module type checks and fails at run time; a
 * declaration that under-states one hides an export nobody knows is there. The
 * evidence layer for four gates, three of them attached to Critical items,
 * rests on five files that nothing verified.
 *
 * WHAT IS COMPARED, AND WHAT IS NOT. The value exports only, in both
 * directions: a declaration file's `export declare` names plus `export
 * default`, against the runtime module namespace's own keys. Two things are
 * outside that, and both are stated here rather than left as silences.
 *
 * Types are not in the namespace: an interface that drifts is invisible to this
 * comparison, and what catches it is the type checker seeing the same file the
 * tests do.
 *
 * SIGNATURES ARE INVISIBLE TO IT TOO, and that is the same hazard wearing a
 * different hat. A declared `function shallowRefusal(output: string): string`
 * whose implementation returns `string | null` still matches by NAME, so this
 * test passes while every call site is type checked against a promise the
 * module does not keep. The name comparison catches the export that was added
 * or removed, which is the drift that happens when a module is edited and its
 * declaration is not; a changed signature is caught only where a test actually
 * uses the value in a way the wrong type would reject. Closing it properly
 * means generating the declarations from the implementations or type checking
 * the plugins themselves, which is a `tsconfig` change and a separate piece of
 * work.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

/**
 * The value names a declaration file declares.
 *
 * Anchored at the margin, because a declaration at the top level of the file is
 * the only one an importer can reach, and every nested one is indented.
 */
export function declaredValueExports(text: string): string[] {
  const names = new Set<string>();
  const pattern =
    /^export\s+declare\s+(?:const|let|var|function|class|abstract\s+class|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  if (/^export\s+default\s/m.test(text)) {
    names.add('default');
  }
  return [...names].sort();
}

/** Every name the two sides disagree about, said in the direction it drifted. */
function drift(declared: string[], exported: string[]): string[] {
  return [
    ...declared
      .filter((name) => !exported.includes(name))
      .map((name) => `declared but not exported: ${name}`),
    ...exported
      .filter((name) => !declared.includes(name))
      .map((name) => `exported but not declared: ${name}`),
  ].sort();
}

interface Subject {
  readonly label: string;
  readonly declaration: string;
  readonly namespace: object;
  /** A value export the suite would break without, so the pair is not empty. */
  readonly anchor: string;
}

const SUBJECTS: readonly Subject[] = [
  {
    label: 'scripts/check-determinism.mjs',
    declaration: 'scripts/check-determinism.d.mts',
    namespace: determinism,
    anchor: 'verdict',
  },
  {
    label: 'scripts/check-repository-record.mjs',
    declaration: 'scripts/check-repository-record.d.mts',
    namespace: record,
    anchor: 'checkCommitRecord',
  },
  {
    label: 'scripts/output-fingerprint.mjs',
    declaration: 'scripts/output-fingerprint.d.mts',
    namespace: fingerprint,
    anchor: 'compareTrees',
  },
  {
    label: 'tools/eslint-plugin-core-boundary/index.js',
    declaration: 'tools/eslint-plugin-core-boundary/index.d.ts',
    namespace: boundary,
    anchor: 'isCorePath',
  },
  {
    label: 'tools/eslint-plugin-pointer-events/index.js',
    declaration: 'tools/eslint-plugin-pointer-events/index.d.ts',
    namespace: pointer,
    anchor: 'LEGACY_EVENT',
  },
];

describe('the hand-written declarations describe the modules they stand for', () => {
  it('covers every module the suite reaches through a declaration', () => {
    // A list that quietly loses an entry would report five green comparisons of
    // four modules, so the count is pinned and each label is named.
    expect(SUBJECTS).toHaveLength(5);
    expect(SUBJECTS.map((subject) => subject.label)).toEqual([
      'scripts/check-determinism.mjs',
      'scripts/check-repository-record.mjs',
      'scripts/output-fingerprint.mjs',
      'tools/eslint-plugin-core-boundary/index.js',
      'tools/eslint-plugin-pointer-events/index.js',
    ]);
  });

  for (const subject of SUBJECTS) {
    it(`matches ${subject.label} export for export`, () => {
      const text = readFileSync(
        path.join(PROJECT_ROOT, subject.declaration),
        'utf8',
      );
      const declared = declaredValueExports(text);
      const exported = Object.keys(subject.namespace).sort();

      // Not vacuous in either direction: a parser that matched nothing and a
      // module that exported nothing would agree on an empty pair.
      expect(declared.length, `${subject.declaration} declares nothing`).toBeGreaterThan(
        0,
      );
      expect(declared, subject.declaration).toContain(subject.anchor);
      expect(drift(declared, exported), subject.label).toEqual([]);
    });
  }

  it('would see a drift in either direction', () => {
    // The negative control. Both halves, because a comparison that only looked
    // for names the declaration is missing would pass every declaration that
    // promises an export the module does not have, which is the half that type
    // checks and then fails at run time.
    expect(drift(['a', 'b'], ['a'])).toEqual(['declared but not exported: b']);
    expect(drift(['a'], ['a', 'b'])).toEqual(['exported but not declared: b']);
    expect(drift(['a'], ['a'])).toEqual([]);

    const control = [
      'export declare const kept: number;',
      'export declare function alsoKept(): void;',
      'export declare const extra: string;',
      'interface NotAValue { field: number }',
      'export type NorThis = NotAValue;',
      'declare const plugin: { rules: Record<string, unknown> };',
      'export default plugin;',
    ].join('\n');
    expect(declaredValueExports(control)).toEqual([
      'alsoKept',
      'default',
      'extra',
      'kept',
    ]);
    expect(drift(declaredValueExports(control), ['alsoKept', 'default', 'kept'])).toEqual(
      ['declared but not exported: extra'],
    );
  });
});

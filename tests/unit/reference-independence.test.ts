import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CIRCLE_RADIUS, BALL_RADIUS } from '../../src/core/config';
import {
  BALL_RADIUS as REFERENCE_BALL_RADIUS,
  MIN_SOLIDITY,
  STRIKER_RADIUS,
  TOUCHING,
} from './reference/strike-geometry';
import { MIN_STRIKE_SOLIDITY } from '../../src/core/ai'; // the opponent routine

/**
 * The rule that makes a reference implementation worth having: a second
 * implementation written from `SPEC.md` alone, importing nothing from `src/`.
 * The moment one of these files imports the module it exists to grade, the
 * expected values come from the code again and the audit's finding returns.
 *
 * The scan is a source scan rather than a resolver trick because that is the
 * form that fails loudly: a file added to the directory next year is walked
 * without anybody remembering this rule existed, and both directions are
 * asserted - the ban catches an offending import, and the file count and a
 * planted control prove the walk is not passing on an empty list.
 *
 * The constants are the other half. A second implementation restates the
 * specification's numbers on purpose, so each restatement is tied back to the
 * constant the game ships here: two files agreeing because they were copied
 * from each other is the failure this pins shut.
 */

const REFERENCE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'reference',
);

/**
 * Every module specifier a source file names, in the three forms it can take:
 * a static import, a re-export, and a dynamic one.
 */
function specifiersIn(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^\n;]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/**
 * A reference module may name only its own neighbours. Anything else - the
 * game by path, the game through the tsconfig alias, a helper elsewhere in the
 * suite that imports the game on its behalf, or a package - leaves the
 * directory and takes the independence with it.
 */
function leavesTheDirectory(specifier: string): boolean {
  return !(specifier.startsWith('./') && !specifier.includes('..'));
}

/** Every `.ts` file under the reference directory, subdirectories included. */
function referenceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...referenceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the reference implementations stand on the specification alone', () => {
  const files = referenceFiles(REFERENCE_DIRECTORY);

  it('names no module outside its own directory', () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
    let scanned = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const name = path.basename(file);
      for (const specifier of specifiersIn(source)) {
        scanned += 1;
        expect(leavesTheDirectory(specifier), `${name} names ${specifier}`).toBe(false);
      }
      // and it is a module rather than a suite: the runner collects
      // *.test.ts, so a reference file is imported by tests and never
      // collected as one.
      expect(name.endsWith('.test.ts'), `${name} would be collected as a suite`).toBe(
        false,
      );
    }
    // The walk may legitimately find no specifier at all today, so the
    // matcher's own controls below are what prove it can see one.
    expect(scanned).toBeGreaterThanOrEqual(0);
  });

  it('has a matcher that would catch an import if one appeared', () => {
    // The controls, so the scan above cannot pass by never matching anything.
    // Every route out of the directory is named, including the two the plain
    // path check missed: the configured package alias, and a helper elsewhere
    // in the suite that would import the game on the reference's behalf.
    const cases: readonly [string, string][] = [
      ['static path', "import { launch } from '../../src/core/bodies';"],
      ['deeper path', "import { step } from '../../../src/core/physics';"],
      ['package alias', "import { fit } from '@js-games/engine/layout';"],
      ['a helper next door', "import { drive } from '../support/drive';"],
      ['a re-export', "export { snapshot } from '../support/drive';"],
      ['a dynamic import', "const mod = await import('../../src/core/goals');"],
      ['a bare package', "import { describe } from 'vitest';"],
    ];
    for (const [what, line] of cases) {
      const specifiers = specifiersIn(line);
      expect(specifiers.length, what).toBe(1);
      expect(specifiers.every(leavesTheDirectory), what).toBe(true);
    }
    // and a neighbour inside the directory is not an offence
    const neighbour = specifiersIn("import { thing } from './strike-geometry';");
    expect(neighbour).toEqual(['./strike-geometry']);
    expect(neighbour.every(leavesTheDirectory)).toBe(false);
  });

  it('restates the specification and agrees with the constants the game ships', () => {
    expect(STRIKER_RADIUS).toBe(CIRCLE_RADIUS);
    expect(REFERENCE_BALL_RADIUS).toBe(BALL_RADIUS);
    expect(TOUCHING).toBe(CIRCLE_RADIUS + BALL_RADIUS);
    expect(MIN_SOLIDITY).toBe(MIN_STRIKE_SOLIDITY);
  });
});

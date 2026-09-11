/*
 * The negative control for the import-closure walk, first file.
 *
 * `src/core` has no subdirectory today and no core module imports anything
 * outside it, so the real tree can only ever prove the walk found nothing. This
 * tree is the half that proves the walk can find something: a core-shaped root
 * whose escape is reachable only by descending one directory and following one
 * import, so a walk that stopped at the top level, or one that read entry
 * points without following their dependencies, reports it clean.
 *
 * Nothing here is linted by the build (the lint script excludes this directory)
 * and nothing here is type checked (tsconfig.json excludes it). It is input to
 * tests/unit/core-boundary.test.ts and to nothing else.
 */

import { deepValue } from './sub/deep';

export const entryValue = deepValue;

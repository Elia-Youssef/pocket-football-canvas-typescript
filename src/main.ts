/**
 * Composition root. Empty of game code until PF-1 onward, and deliberately not
 * empty of behaviour.
 *
 * The entry has to leave an observable trace in the built bundle. A module that
 * only declares exports nothing imports is dead code to the bundler, so it is
 * dropped, and the two gates that measure the output would then be measuring an
 * empty file: item A6 would compare two builds of nothing and item A2's browser
 * checks would assert that a script which never ran did no harm. The call below
 * runs at module scope, which is the one shape that cannot be shaken out.
 *
 * The marker is also what the checklist reads to confirm the compiled entry
 * ran rather than merely being served (checks 4.2 and 4.3).
 *
 * No token import here yet: the token layer arrives at PF-1, and importing it
 * before it exists would put a literal in this file, which QUALITY-BAR section
 * 15 forbids from PF-1 onward.
 */

export const GAME_ID = 'pocket-football';

export function boot(): void {
  document.documentElement.dataset['game'] = GAME_ID;
}

boot();

/**
 * Composition root. Empty of game code until PF-2 onward, and deliberately not
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
 */

/*
 * Item E1, and the only import of the token layer anywhere in the project. It
 * belongs here because every custom property has to be defined before any
 * chrome renders, and because a stylesheet imported by the components that use
 * it is a stylesheet that some future component forgets to import. The test
 * asserts both halves: that this line exists, and that no other file has one.
 */
import './ui/tokens.css';

export const GAME_ID = 'pocket-football';

export function boot(): void {
  document.documentElement.dataset['game'] = GAME_ID;
}

boot();

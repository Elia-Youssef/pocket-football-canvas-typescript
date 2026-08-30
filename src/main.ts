/**
 * Composition root. Wires the token layer, the play surface and the DOM
 * chrome together, and owns every policy decision the layers above refuse to
 * make for themselves.
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
 * Item E1, and the only imports of the token layer anywhere in the project.
 * They belong here because every custom property has to be defined before any
 * chrome renders, and because a stylesheet imported by the components that use
 * it is a stylesheet that some future component forgets to import. The test
 * asserts both halves: that these lines exist here, and that no other file has
 * one. The chrome stylesheet comes after the tokens so its rules resolve
 * against a complete set.
 */
import './ui/tokens.css';
import './ui/components/chrome.css';

import { createWorld } from './core/bodies';
import { createMatch } from './core/match';
import { createSurface, resizeSurface, watchDeviceRatio } from './render/surface';
import { drawFrame } from './render/pitch';
import type { PitchCacheCell } from './render/pitch';
import { pitchFor } from './render/tokens';
import type { Theme } from './render/tokens';
import { mountChrome } from './ui/layout';

export const GAME_ID = 'pocket-football';

/** SPEC section 18: the chrome theme chooses the pitch's brightness variant. */
const THEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * The theme in force: a stored override first, the platform read otherwise.
 * The settings control writes the override where the stylesheet reads it; the
 * query above stays the platform half of the tie, asked only when no override
 * is in force, so the pitch variant and the chrome theme keep answering the
 * same question.
 */
function themeInForce(): Theme {
  const override = document.documentElement.dataset['theme'];
  if (override === 'dark' || override === 'light') {
    return override;
  }
  return window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light';
}

export function boot(): void {
  document.documentElement.dataset['game'] = GAME_ID;
}

/**
 * The play surface, mounted once. DESIGN section 8: nodes, listeners and
 * timers are created once and a restart mutates state, so the surface, the
 * world, the cache cell and the two observers here are created exactly one
 * time and nothing tears them down per frame.
 *
 * The palette is read per render rather than at mount, so a theme override
 * from the settings control re-renders the pitch in the variant the chrome
 * has just adopted; with no override the read lands on the same query the
 * stylesheet answers. The frame driver is likewise a later part: nothing
 * moves until aiming exists, so the scene is drawn at mount, on resize, and
 * when the device pixel ratio changes, which the resize observer cannot see
 * because the css box does not move when a window changes monitors.
 */
function mountPlaySurface(host: HTMLElement): { render: () => void } {
  const surface = createSurface(host);
  const world = createWorld();
  const cache: PitchCacheCell = { current: null };
  const render = (): void => {
    const width = host.clientWidth;
    if (width <= 0) {
      return;
    }
    resizeSurface(surface, width, window.devicePixelRatio);
    drawFrame(surface, cache, world, pitchFor(themeInForce()));
  };
  render();
  new ResizeObserver(render).observe(host);
  watchDeviceRatio(window, render);
  return { render };
}

/**
 * The whole game, in mount order: the surface, then the chrome that wraps it
 * as DOM. The match is the plain default - no clock, no target - because the
 * modes own both numbers and arrive with their own part; the chrome reads
 * whatever this match reports and shows it.
 */
function mount(host: HTMLElement): void {
  const play = mountPlaySurface(host);
  mountChrome(host, { match: createMatch(), onThemeChange: play.render });
}

boot();
const host = document.getElementById('app');
if (host === null) {
  throw new Error('the composition root found no #app host to mount the game in');
}
mount(host);

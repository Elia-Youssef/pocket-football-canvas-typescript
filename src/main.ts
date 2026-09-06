/**
 * Composition root. Wires the token layer and the play surface together, and
 * owns every policy decision the layers above refuse to make for themselves.
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

import { createWorld } from './core/bodies';
import { createSurface, resizeSurface, watchDeviceRatio } from './render/surface';
import { drawFrame } from './render/pitch';
import type { PitchCacheCell } from './render/pitch';
import { pitchFor } from './render/tokens';
import type { Theme } from './render/tokens';

export const GAME_ID = 'pocket-football';

/** SPEC section 18: the chrome theme chooses the pitch's brightness variant. */
const THEME_QUERY = '(prefers-color-scheme: dark)';

function themeInForce(): Theme {
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
 * The theme is read once, because the settings override that flips it is
 * PF-13's chrome and this part draws in the variant the platform is in. The
 * frame driver is likewise a later part: nothing moves until aiming exists,
 * so the scene is drawn at mount, on resize, and when the device pixel ratio
 * changes, which the resize observer cannot see because the css box does not
 * move when a window changes monitors.
 */
function mountPlaySurface(): void {
  const host = document.getElementById('app');
  if (host === null) {
    throw new Error('the composition root found no #app host to mount the surface in');
  }
  const surface = createSurface(host);
  const world = createWorld();
  const cache: PitchCacheCell = { current: null };
  const palette = pitchFor(themeInForce());
  const render = (): void => {
    const width = host.clientWidth;
    if (width <= 0) {
      return;
    }
    resizeSurface(surface, width, window.devicePixelRatio);
    drawFrame(surface, cache, world, palette);
  };
  render();
  new ResizeObserver(render).observe(host);
  watchDeviceRatio(window, render);
}

boot();
mountPlaySurface();

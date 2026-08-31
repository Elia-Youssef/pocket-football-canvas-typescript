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

import type { AimPreview, AimState } from './core/aiming';
import type { World } from './core/bodies';
import { createMatch } from './core/match';
import type { Match } from './core/match';
import { drawAimArrow } from './render/arrow';
import { kickoffFacing } from './render/entities';
import { attachAimInput } from './render/input';
import { createSurface, resizeSurface, watchDeviceRatio } from './render/surface';
import { drawFrame } from './render/pitch';
import type { FrameOptions, PitchCacheCell } from './render/pitch';
import { pitchFor } from './render/tokens';
import type { Theme } from './render/tokens';
import { mountChrome } from './ui/layout';

export const GAME_ID = 'pocket-football';

/** SPEC section 18: the chrome theme chooses the pitch's brightness variant. */
const THEME_QUERY = '(prefers-color-scheme: dark)';

/** The frame driver's deltas arrive in milliseconds and the game takes seconds. */
const MILLISECONDS_PER_SECOND = 1000;

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
 * The per-scene render inputs an aim supplies. The player's circle looks
 * where it is about to shoot, which is the facing `entities.ts` left as a
 * parameter for exactly this; the opponent keeps the derived kickoff facing,
 * because nothing in this part gives it an aim of its own.
 *
 * An absent option is absent rather than undefined, which is what
 * `exactOptionalPropertyTypes` asks of a pass-through.
 */
function frameOptionsFor(
  world: World,
  preview: AimPreview | null,
): FrameOptions | undefined {
  // A press that has not moved is an aim with no length and therefore no
  // direction, so the circle keeps the facing it already had rather than
  // snapping to whatever an atan2 of nothing happens to return.
  if (preview === null || preview.reach <= 0) {
    return undefined;
  }
  return {
    facing: {
      player: preview.aim.angleRad,
      opponent: kickoffFacing(world).opponent,
    },
  };
}

/**
 * The frame driver, and the one loop in the project. DESIGN section 8: it is
 * started once and never torn down, so a restart mutates state rather than
 * rebuilding the scene.
 *
 * The delta is the browser's own timestamp difference in seconds, handed
 * straight on. QUALITY-BAR section 7's clamp, the resume drop and the
 * treatment of a delta that is negative or not a number all live inside the
 * simulation, where they are already tested at every frame rate; a second
 * clamp here would be a second policy for the same fact.
 */
function startFrameDriver(step: (delta: number) => void): void {
  let previous: number | null = null;
  const frame = (now: number): void => {
    const delta = previous === null ? 0 : (now - previous) / MILLISECONDS_PER_SECOND;
    previous = now;
    step(delta);
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

/**
 * The play surface, mounted once, drawing the match's own world. DESIGN
 * section 8: nodes, listeners and timers are created once, so the surface,
 * the cache cell, the pointer input and the two observers here are created
 * exactly one time and nothing tears them down per frame.
 *
 * Sizing and drawing are separate. A backing store is resized when the css box
 * or the device pixel ratio changes and at no other moment, because assigning
 * a canvas width reallocates and clears it; the frame driver only draws.
 *
 * The palette is read per frame rather than at mount, so a theme override from
 * the settings control re-renders the pitch in the variant the chrome has just
 * adopted; with no override the read lands on the same query the stylesheet
 * answers.
 *
 * THE AIM PASS SITS WHERE DESIGN SECTION 7 PUTS IT, after the entities, and it
 * is appended by this root rather than inserted into `drawFrame`. The order is
 * the section's either way; the part that adds the effects in front of the
 * entities owns moving it inside, because that is the first moment the
 * difference between "after the frame" and "after the entities" exists.
 */
function mountPlaySurface(
  host: HTMLElement,
  match: Match,
): { render: () => void; refresh: () => void } {
  const surface = createSurface(host);
  const world = match.world;
  const cache: PitchCacheCell = { current: null };
  const input = attachAimInput({
    canvas: surface.canvas,
    world,
    state: () => match.readout().state,
    onLaunch: (aim: AimState) => {
      match.dispatch({ kind: 'launch', angle: aim.angleRad, power: aim.power01 });
    },
  });

  const fit = (): void => {
    const width = host.clientWidth;
    if (width <= 0) {
      return;
    }
    resizeSurface(surface, width, window.devicePixelRatio);
  };

  const render = (): void => {
    if (surface.scale <= 0) {
      return;
    }
    const palette = pitchFor(themeInForce());
    const preview = input.preview();
    // THE FRAME STARTS EMPTY. The cached pitch layer is opaque over the pitch
    // and transparent everywhere else, so blitting it leaves whatever was
    // outside the pitch on the previous frame exactly where it was. Nothing
    // drew out there until the aim arrow did: a circle resting against a wall
    // aims up to a hundred and eighty units past it, and every one of those
    // pixels would otherwise stay on the surface for the rest of the session.
    // Clearing belongs inside the frame composition, and the part that moves
    // the aim pass in there owns moving this with it.
    surface.context.save();
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.context.restore();
    drawFrame(surface, cache, world, palette, frameOptionsFor(world, preview));
    if (preview !== null) {
      drawAimArrow(surface.context, palette, world.player, preview);
    }
  };

  const refit = (): void => {
    fit();
    render();
  };

  refit();
  new ResizeObserver(refit).observe(host);
  watchDeviceRatio(window, refit);
  return { render, refresh: input.refresh };
}

/**
 * The whole game, in mount order: the surface, then the chrome that wraps it
 * as DOM, then the loop that drives both.
 *
 * The match repairs a value that is not a number rather than raising on it,
 * which is the policy `physics.ts` leaves to a composition root and the one a
 * shipping build takes: a poisoned body is put back where it was and play goes
 * on, where a raise would end the match on a defect the player did not cause.
 *
 * The match is otherwise the plain default, no clock and no target, because
 * the modes own both numbers and arrive with their own part. Starting it here
 * is provisional in the same way: SPEC section 9's mode menu is what will
 * start a match, and until it exists the root starts the default one so the
 * surface has a turn to aim in.
 */
function mount(host: HTMLElement): void {
  const match = createMatch({ onNonFinite: 'repair' });
  const play = mountPlaySurface(host, match);
  const chrome = mountChrome(host, { match, onThemeChange: play.render });
  match.dispatch({ kind: 'start' });
  startFrameDriver((delta) => {
    match.update(delta);
    // The lock, once a frame, before anything reads the aim: the match may
    // have left the player's turn since the last pointer event, and an aim
    // that outlives its own turn is what item C8 forbids.
    play.refresh();
    chrome.sync();
    play.render();
  });
}

boot();
const host = document.getElementById('app');
if (host === null) {
  throw new Error('the composition root found no #app host to mount the game in');
}
mount(host);

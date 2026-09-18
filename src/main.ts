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

import { OPPONENT_STREAM, respond } from './core/ai'; // the opponent's aim routine
import type { AimPreview, AimState } from './core/aiming';
import type { Body, World } from './core/bodies';
import type { AimGuide } from './core/guide';
import { predictGuide } from './core/guide';
import { createMatch } from './core/match';
import type { Match, MatchState } from './core/match';
import {
  guideShown,
  ladderComplete,
  ladderRungAfter,
  ladderStepFor,
  outcomeOf,
  setupFor,
} from './core/modes';
import type { ModeChoice, ModeSetup, ProgressStore } from './core/modes';
import { createRng } from './core/rng';
import type { Rng } from './core/rng';
import { choiceOf, createDataStore, recordResult, settingsAfter } from './core/storage';
import type { DataStore, KeyValueStore, ThemeSetting } from './core/storage';
import { createEffects } from './render/effects';
import type { Effects } from './render/effects';
import { glyphsForOpponent, kickoffFacing } from './render/entities';
import type { Facing, Glyphs } from './render/entities';
import { attachAimInput } from './render/input';
import {
  createSurface,
  fitCssWidth,
  resizeSurface,
  scrollToCentre,
  surfaceOverflow,
  watchDeviceRatio,
} from './render/surface';
import { drawFrame } from './render/pitch';
import type { FrameOptions, PitchCacheCell } from './render/pitch';
import { playSurfaceFor } from './render/tokens';
import type { Theme } from './render/tokens';
import { DEFAULT_ROOT_FONT_SIZE, barsStick, breakpointFor } from './ui/breakpoints';
import { createAimControls } from './ui/components/aim-controls';
import type { GameOverContext } from './ui/components/game-over-panel';
import { createPlayMirror, outcomeLine, politeLine, titleFor } from './ui/components/play-mirror';
import type { PlayMirror, SideNames } from './ui/components/play-mirror';
import { ASSERTIVE_MARKER, POLITE_MARKER, createLiveRegions } from './ui/live-region';
import { mountChrome } from './ui/layout';

/**
 * The marker the compiled module stamps on the document, which is how a browser
 * test tells a served bundle from a running one.
 *
 * NOT EXPORTED, BECAUSE NOTHING IMPORTS THIS MODULE. `main.ts` is the
 * composition root: it is the bundler's entry, it runs on import, and no other
 * module names it. An export here was a promise to a caller that does not
 * exist, and one nothing could grade - a unit test importing this file would
 * boot the game. What holds the value is `tests/browser/scaffold.spec.ts`,
 * which reads the attribute off the running page, which is the only place the
 * marker means anything.
 */
const GAME_ID = 'pocket-football';

/** SPEC section 18: the chrome theme chooses the pitch's brightness variant. */
const THEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * QUALITY-BAR section 4 and SPEC section 14: the motion policy, read HERE and
 * passed down, because nothing under `render/` may decide it. The stylesheet
 * answers the same query for the chrome, so the canvas and the DOM are in one
 * motion mode rather than two.
 *
 * THE PLATFORM AND NOTHING ELSE, deliberately. SPEC section 17 gives reduced
 * motion a system-or-always setting, and the theme's stored override is the
 * shape it will take; the difference is that the theme's override is answered
 * by `data-theme` blocks in the token stylesheet as well as here, and there is
 * no `data-motion` block to answer a motion one. An override read only here
 * would stop the canvas animating and leave every chrome duration where it
 * was, which is two motion modes at once and not what item E6 asks for. The
 * setting lands with the part that owns both halves.
 */
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * QUALITY-BAR section 5 and SPEC section 18: canvas pixels are untouched by
 * forced colours, so the play surface answers the query itself.
 *
 * READ HERE AND BESIDE THE THEME, for the same reason the theme is read here:
 * nothing under `render/` may ask the platform anything, and the stylesheet
 * answers the same query for the chrome, so the pitch and the DOM adopt one
 * palette rather than two. It takes PRECEDENCE over the theme for the play
 * surface and for nothing else, which is the whole of the section's "one set
 * replacing both brightness variants whichever theme is in force".
 */
const FORCED_COLORS_QUERY = '(forced-colors: active)';

/**
 * SPEC section 5.1: the play surface is a single focusable element with an
 * accessible name. The canvas cannot be that element: QUALITY-BAR section 1
 * keeps the scene out of the accessibility tree, so `surface.ts` marks it
 * `aria-hidden`, and an aria-hidden element may not be focusable. The frame
 * around it carries the tabindex, the name and every key instead, and the
 * scene stays hidden inside it until the accessible mirror lands with the
 * accessibility part.
 *
 * The role is `application` because the surface answers the four arrows,
 * Space and Enter itself: without it a screen reader in its own browse mode
 * keeps those keys and SPEC section 5.1's whole model is unreachable.
 */
const PLAY_SURFACE_LABEL = 'Play surface';
const PLAY_SURFACE_ROLE = 'application';

/** The frame driver's deltas arrive in milliseconds and the game takes seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * SPEC section 9's Hotseat, as the input models see it. Both turns belong to a
 * human there, so the state the aim models are asked about is a player's turn
 * whichever circle is acting; the MATCH stays in the turn it is really in, so
 * the launch intent still reaches the right body and every other refusal, the
 * pause and the game over included, is answered by the real state.
 */
const HUMAN_TURN: MatchState = Object.freeze({ kind: 'PLAYER_TURN' });

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

/**
 * The theme the chrome currently has in force, read back off the attribute the
 * chrome itself wrote. SPEC section 17 stores the setting and `ui/layout.ts`
 * owns the policy; this is the root reading the one place that policy lives,
 * which is the same attribute `themeInForce` above already consults, rather
 * than keeping a second copy of a value the chrome decides.
 */
function themeSetting(): ThemeSetting {
  const override = document.documentElement.dataset['theme'];
  return override === 'dark' || override === 'light' ? override : 'system';
}

/**
 * Whether motion is reduced. The query object is built once and asked every
 * frame: a `MediaQueryList` is live, so its `matches` follows a preference
 * changed mid-session, and building one per frame would put an allocation and
 * a platform call in the hot path QUALITY-BAR section 6 budgets.
 */
let motionQuery: MediaQueryList | null = null;

function reducedMotionInForce(): boolean {
  motionQuery ??= window.matchMedia(MOTION_QUERY);
  return motionQuery.matches;
}

/**
 * Whether forced colours are in force, read the same way and cached for the
 * same reason: the list is live, so a preference turned on mid-session moves
 * the pitch on the next frame, and the pitch cache invalidates on palette
 * identity rather than on a flag anybody has to remember to raise.
 */
let forcedColorsQuery: MediaQueryList | null = null;

function forcedColorsInForce(): boolean {
  forcedColorsQuery ??= window.matchMedia(FORCED_COLORS_QUERY);
  return forcedColorsQuery.matches;
}

/**
 * QUALITY-BAR section 8's dangerous half: `window.localStorage` can throw a
 * SecurityError on PROPERTY ACCESS, before any method is called, in a
 * partitioned or cookie-blocked context. This is the one expression that
 * touches the platform; `core/storage.ts` calls it inside its own try and
 * falls back to an in-memory store for the session, so the refusal is decided
 * where it can be tested headlessly rather than here where it cannot.
 */
function openStorage(): KeyValueStore {
  return window.localStorage;
}

/**
 * QUALITY-BAR section 5's breakpoint and its sticky-bar rule, resolved here
 * and written onto the root element where the stylesheet selects on them.
 *
 * THE NUMBERS LIVE IN ONE PLACE AND IT IS NOT THE STYLESHEET. `ui/breakpoints`
 * owns the three thresholds and a unit test holds them against the copy of
 * QUALITY-BAR section 5's own table in the design contract; a media query
 * would carry the same numbers as literals nothing can read back. What the
 * stylesheet gets is the answer, so it carries arrangement and no thresholds.
 *
 * The window is the one thing that can answer this and the one thing no module
 * below the root may ask, which is why the read is here. It is taken on every
 * refit rather than on a listener of its own: the play surface's own resize
 * observer already fires on the box changes an orientation change, a window
 * resize and this attribute's own effect all produce, so a second listener
 * would be a second answer to the same question.
 */
function applyViewport(): void {
  const root = document.documentElement;
  root.dataset['pfBreakpoint'] = breakpointFor(window.innerWidth, window.innerHeight);
  // THE SIZE THE PAGE IS LAID OUT AT, not the size a stylesheet asked for. The
  // sticky floor is 25 rem, so it follows a browser's own text-size setting and
  // an inline root font size alike, and the computed style is the one place that
  // answers both. It is read on the same refit as the two window figures.
  root.dataset['pfBars'] = barsStick(window.innerHeight, rootFontSize()) ? 'sticky' : 'static';
}

/** The root element's computed font size in CSS pixels, or the default if unreadable. */
function rootFontSize(): number {
  const size = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_ROOT_FONT_SIZE;
}

/** Stamp the marker. Called below, on import, and by nothing outside this file. */
function boot(): void {
  document.documentElement.dataset['game'] = GAME_ID;
}

/** An element `index.html` promises, found once and refused if it is missing. */
function required(marker: string): HTMLElement {
  const found = document.querySelector(`[data-pf="${marker}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`the document carries no ${marker} element`);
  }
  return found;
}

/**
 * WCAG 2.2 SC 2.4.11, Focus Not Obscured: the two sticky bars' heights, written
 * where `chrome.css` reads them as scroll padding.
 *
 * MEASURED RATHER THAN STATED. A bar is its content plus its padding plus
 * whatever the safe-area insets add, and the HUD grows a row when it wraps, so
 * no token could carry the number and a constant would be wrong at the first
 * breakpoint. The observer reads the BORDER box, which is the whole of what
 * stands over the page; the content box would leave the padding uncovered, and
 * the padding is most of a compact bar.
 *
 * ONE OBSERVER FOR BOTH, created once and never torn down (DESIGN section 8),
 * and the write is edge-only because a custom property on the root element is a
 * style invalidation for the whole document.
 */
function watchBars(top: HTMLElement, bottom: HTMLElement): void {
  const root = document.documentElement;
  const write = (name: string, size: number): void => {
    const value = `${String(Math.ceil(size))}px`;
    if (root.style.getPropertyValue(name) !== value) {
      root.style.setProperty(name, value);
    }
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const size = entry.borderBoxSize[0]?.blockSize ?? 0;
      write(entry.target === top ? '--pf-bar-top' : '--pf-bar-bottom', size);
    }
  });
  observer.observe(top);
  observer.observe(bottom);
}

/**
 * The other half of SC 2.4.11, and the half that is the platform's.
 *
 * Scroll padding declares the region a focused control has to end up inside;
 * something still has to ask for the scroll. Every engine scrolls a control into
 * view when it is focused by a keyboard, but `nearest` is the only request that
 * is a no-op when the control is already inside that region, so a pointer press
 * on a visible button moves nothing and a Tab that lands under a stuck bar does.
 *
 * WHAT IS INSIDE THE STAGE IS LEFT ALONE, and that is not caution. The play
 * frame is a scroll container of its own at QUALITY-BAR section 4's larger
 * sizes and the root already scrolls it once a frame to follow the play, so
 * asking the platform to scroll its contents as well would be two answers to
 * where the pitch should be looking.
 *
 * THE FRAME ITSELF IS NOT INSIDE IT, though, and it is a control: SPEC section
 * 5.1's keys reach the model through it, so it is a tab stop like the pause
 * button. Measured on webkit at 200 percent text on a 320 by 400 viewport,
 * where the bars are static and the page scrolls: the frame sat entirely below
 * the fold and focusing it moved nothing, because this handler skipped
 * everything the stage contained. Scrolling the PAGE to it is a different
 * question from scrolling the pitch inside it, and the page owes it the same
 * answer it owes every other control.
 */
function followFocus(stage: HTMLElement): void {
  document.addEventListener('focusin', (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const isPlayFrame = target.getAttribute('role') === 'application';
    if (stage.contains(target) && !isPlayFrame) {
      return;
    }
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/** Everything the play surface has to ask the root, and nothing it decides. */
interface PlayContext {
  readonly match: Match;
  /** SPEC section 4's canvas glyphs, as the configured mode currently names them. */
  readonly glyphs: () => Glyphs;
  /** The state the aim models answer to, which Hotseat translates. */
  readonly inputState: () => MatchState;
  /** The world an aim is taken in: Hotseat swaps the acting circle per turn. */
  readonly aimWorld: World;
  /** SPEC section 11: whether the guide is showing on this frame. */
  readonly guideShowing: () => boolean;
  /** Counted for SPEC section 19's first-two-turns rule. */
  readonly onLaunched: () => void;
  readonly onPause: () => void;
  /** SPEC section 14's motion set for the match in force, or none yet. */
  readonly effects: () => Effects | undefined;
  /** QUALITY-BAR section 4's play-surface size, as the store left it. */
  readonly initialSurfaceScale: number;
}

/**
 * The per-scene render inputs. The circle that is about to shoot looks where
 * it is shooting, which is the facing `entities.ts` left as a parameter for
 * exactly this; the other keeps the derived kickoff facing. The aim, the
 * guide and the effects state go the same way, because DESIGN section 7's
 * pass order is `drawFrame`'s and this root's job is to hand it what each pass
 * draws.
 *
 * THE ARROW AND THE GUIDE START AT THE SAME CIRCLE, which is the acting one:
 * in Hotseat the second human aims the opponent's circle, and an arrow drawn
 * from the player's would be pointing out of somebody else's body.
 *
 * An absent option is absent rather than undefined, which is what
 * `exactOptionalPropertyTypes` asks of a pass-through.
 */
function frameOptionsFor(
  world: World,
  context: PlayContext,
  preview: AimPreview | null,
): FrameOptions {
  const options: {
    glyphs: Glyphs;
    facing?: Facing;
    aim?: AimPreview;
    guide?: AimGuide;
    launcher?: Body;
    effects?: Effects;
  } = { glyphs: context.glyphs() };
  const running = context.effects();
  if (running !== undefined) {
    options.effects = running;
  }
  if (preview !== null) {
    const acting = context.aimWorld.player;
    options.aim = preview;
    options.launcher = acting;
    if (context.guideShowing()) {
      options.guide = predictGuide(acting, world.ball, preview.aim.angleRad);
    }
    // A press that has not moved is an aim with no length and therefore no
    // direction, so the circle keeps the facing it already had rather than
    // snapping to whatever an atan2 of nothing happens to return.
    if (preview.reach > 0) {
      const kickoff = kickoffFacing(world);
      options.facing =
        acting === world.opponent
          ? { player: kickoff.player, opponent: preview.aim.angleRad }
          : { player: preview.aim.angleRad, opponent: kickoff.opponent };
    }
  }
  return options;
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
 * THE STAGE IS THE BOX THE PITCH IS FITTED INTO, and it exists so that the
 * measurement is stable. It is the flex row between the two chrome bars, so
 * its size is decided by the layout above it and never by what is inside it;
 * the frame fills it absolutely and is where a magnified surface overflows, so
 * a scrollbar raised inside the frame cannot change the box the fit was
 * computed from. SPEC section 2.1's letterbox is the difference between the
 * two: the surface takes the largest 1280 x 720 box the stage allows and is
 * centred in it, and the bands are whatever is left in the axis that did not
 * bind.
 *
 * THE SIZE SETTING MULTIPLIES THE CSS BOX AND NOTHING ELSE. `resizeSurface`
 * still takes one CSS width and derives everything from it, so the logical
 * space is untouched at every setting and SPEC section 6.1's drag constants
 * keep their meaning; what changes is how many CSS pixels one design unit is
 * drawn across, which is exactly what QUALITY-BAR section 4 asks the setting
 * to do and what browser zoom cannot.
 *
 * The palette is read per frame rather than at mount, so a theme override from
 * the settings control re-renders the pitch in the variant the chrome has just
 * adopted; with no override the read lands on the same query the stylesheet
 * answers. The motion policy is read the same way and for the same reason.
 *
 * EVERY PASS IS `drawFrame`'S, DESIGN section 7's order included. This root
 * decides the policies the renderer may not decide for itself, hands the
 * effects layer the world once a frame, and draws once.
 */
function mountPlaySurface(
  host: HTMLElement,
  context: PlayContext,
): {
  render: () => void;
  refresh: (elapsed: number) => void;
  setScale: (percent: number) => void;
  /** QUALITY-BAR section 4's structured mirror, fed from the same sync. */
  mirror: PlayMirror;
  /** The aim line for the one announcement queue, or nothing to state. */
  announcement: () => string | null;
  /** The column's non-chrome elements, which item G9's trap makes inert. */
  background: readonly HTMLElement[];
  /** The two sticky bars' bottom half, for the scroll padding SC 2.4.11 needs. */
  aimBar: HTMLElement;
  /** The box the pitch is fitted into, which scrolls itself when magnified. */
  stage: HTMLElement;
} {
  const match = context.match;
  const stage = document.createElement('div');
  stage.className = 'pf-stage';
  stage.dataset['pf'] = 'stage';
  host.appendChild(stage);

  const frame = document.createElement('div');
  frame.className = 'pf-play-frame';
  frame.dataset['pf'] = 'play-frame';
  frame.setAttribute('tabindex', '0');
  frame.setAttribute('role', PLAY_SURFACE_ROLE);
  frame.setAttribute('aria-label', PLAY_SURFACE_LABEL);
  stage.appendChild(frame);

  const surface = createSurface(frame);
  const world = match.world;
  const cache: PitchCacheCell = { current: null };
  const input = attachAimInput({
    canvas: surface.canvas,
    world: context.aimWorld,
    state: context.inputState,
    onLaunch: (aim: AimState) => {
      match.dispatch({ kind: 'launch', angle: aim.angleRad, power: aim.power01 });
      context.onLaunched();
    },
    surface: frame,
    onPause: context.onPause,
  });

  // QUALITY-BAR section 4's structured mirror, mounted AFTER the play frame and
  // OUTSIDE it. Outside, because SPEC section 5.1's `role="application"` on the
  // frame suppresses the browse-mode navigation a mirror exists to be read with;
  // after it, because the reading order a player without sight follows is the
  // pitch, then what is on it, then the controls that act on it. The module's
  // own header carries the whole of the decision.
  const mirror = createPlayMirror();
  host.appendChild(mirror.root);

  // SPEC section 5.0's no-drag path, mounted after the surface so it follows
  // the pitch in reading order and in the tab order. Every control asks the
  // one input module for an aim; nothing here reaches the match directly.
  const controls = createAimControls({
    onAim: (angleRad: number, power01: number) => {
      input.setAim(angleRad, power01);
    },
    onLaunch: () => {
      input.launch();
    },
    onCancel: () => {
      input.cancel();
    },
  });
  host.appendChild(controls.root);

  let sizePercent = context.initialSurfaceScale;
  let magnified = false;

  const fit = (): void => {
    // The breakpoint first, because it decides the arrangement the box below
    // is then measured in: reading the stage before the attributes are in
    // force would fit the surface to the layout the last viewport had.
    applyViewport();
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    // Below one css pixel there is no box to fit anything into, and the fit's
    // own one-pixel floor would answer a surface larger than what it was
    // given, which is the one case that would be tagged as magnified at the
    // default size.
    if (width < 1 || height < 1) {
      return;
    }
    const cssWidth = fitCssWidth(width, height, sizePercent);
    // An axis larger than its stage stops being centred: a centred overflow
    // puts its own start edge out of reach of every scroll position, so the
    // frame anchors THAT AXIS and leaves the other one centred, which is what
    // keeps the letterbox band the fit still allows.
    const over = surfaceOverflow(width, height, cssWidth);
    frame.dataset['pfFitX'] = over.across ? 'over' : 'fit';
    frame.dataset['pfFitY'] = over.down ? 'over' : 'fit';
    magnified = over.across || over.down;
    resizeSurface(surface, cssWidth, window.devicePixelRatio);
  };

  /**
   * Keep the play in view while the surface is larger than the frame.
   *
   * WHY THE FRAME IS SCROLLED FOR THE PLAYER RATHER THAN BY THEM. The canvas
   * covers the whole frame at any size above the fit, and the canvas has
   * already claimed both gestures that could pan it: `touch-action` is
   * `pinch-zoom` so a finger is an aim and never a scroll, and the four arrows
   * belong to SPEC section 5.1's keyboard model while the frame has focus.
   * Handing either of them to the scroller would take drag-to-aim away, so
   * neither is asked for: the frame follows the play instead, which is what a
   * magnified view is for. QUALITY-BAR section 4 makes this setting the only
   * path a low-vision player has to a larger pitch, and a larger pitch nobody
   * can pan would be a pitch with most of itself out of reach.
   *
   * WHAT IT FOLLOWS IS WHAT MATTERS NOW: the acting circle while an aim can be
   * taken, because that is where a drag begins and where the arrow is drawn,
   * and the ball at every other moment, because that is the play. The two
   * cannot both be held at 200 percent on a small screen - the window is a
   * fraction of the pitch by definition - so the choice is made rather than
   * split. An aim is only ever taken at rest, so the point does not move while
   * a finger is down and nothing slides under it mid-drag.
   *
   * A clamped scroll cannot lose the point it was aimed at, because the point
   * is inside the surface and the clamp keeps the window inside it too.
   */
  const follow = (): void => {
    if (!magnified) {
      return;
    }
    const watched = input.allowed() ? context.aimWorld.player : world.ball;
    const at = scrollToCentre(
      surface,
      watched.position.x,
      watched.position.y,
      frame.clientWidth,
      frame.clientHeight,
    );
    frame.scrollLeft = at.left;
    frame.scrollTop = at.top;
  };

  const render = (): void => {
    if (surface.scale <= 0) {
      return;
    }
    const palette = playSurfaceFor(themeInForce(), forcedColorsInForce());
    drawFrame(surface, cache, world, palette, frameOptionsFor(world, context, input.preview()));
    follow();
  };

  const refit = (): void => {
    fit();
    render();
  };

  /**
   * One frame of input: the lock, then every held key advanced by the frame's
   * own elapsed seconds, then the controls brought in line with the aim that
   * produced. The elapsed time is the browser's own and never a frame count,
   * because SPEC section 5.1's hold rates are stated in real seconds.
   *
   * The effects layer is observed here rather than in `render`, because it has
   * to see the world exactly once per update and `render` is also called by a
   * resize and by a theme change, which advance no time at all. There is no
   * effects layer at all until a mode has started a match, which is the one
   * state where nothing on the pitch is moving by construction.
   *
   * A PAUSED MATCH CHARGES THE EFFECTS CLOCK NOTHING. SPEC section 7 says of
   * PAUSED that entering it "zeroes nothing and steps no simulation", and
   * `render/effects.ts` states its own clock as advancing by the seconds the
   * world advanced by. The world advances by none while the match is paused, so
   * the pass observes the frame and charges no time: a celebration or a trail
   * interrupted by a pause resumes exactly where it stopped, instead of having
   * aged out behind the overlay while the pitch under it was frozen. The frame
   * is still observed rather than skipped, because the layer samples each body
   * to derive its contacts and a skipped frame would leave it comparing the
   * next real frame against a stale sample.
   *
   * MENU AND GAME_OVER ARE FROZEN TOO AND ARE DELIBERATELY NOT GATED HERE.
   * Neither is a state play resumes from, so neither has anything to resume:
   * the celebration still running when the whistle goes is meant to finish, and
   * a match left for the menu is replaced by a fresh effects layer the moment
   * the next one starts. The pause is the one freeze that has another side.
   */
  const refresh = (elapsed: number): void => {
    input.refresh(elapsed);
    controls.sync(input.preview(), input.allowed());
    const reading = match.readout();
    const frozen = reading.state.kind === 'PAUSED';
    context.effects()?.observe({
      world,
      scoring: reading.scoring,
      elapsed: frozen ? 0 : elapsed,
      reducedMotion: reducedMotionInForce(),
    });
    // THE SAME SYNC THE CANVAS READS, which is what QUALITY-BAR section 4 asks
    // of the mirror: one pass over one world, so the words and the pixels can
    // never describe two different moments.
    mirror.sync(world);
  };

  refit();
  new ResizeObserver(refit).observe(stage);
  // AND ONE OF THE TWO BARS, because QUALITY-BAR section 5's sticky floor is a
  // height in REM and therefore a question about the text as well as about the
  // viewport. The stage alone cannot answer it: under the static arrangement the
  // stage takes a viewport of its own, so shrinking the bars back changes
  // nothing about its box and a text size going back down would never be
  // noticed. The aim bar is one of the two bars the threshold is about and its
  // height follows the text exactly, so it is the honest second subject.
  new ResizeObserver(refit).observe(controls.root);
  watchDeviceRatio(window, refit);
  return {
    render,
    refresh,
    mirror,
    announcement: () => controls.announcement(),
    background: [stage, mirror.root, controls.root],
    aimBar: controls.root,
    stage,

    setScale(percent: number): void {
      sizePercent = percent;
      refit();
    },
  };
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
 * ONE MATCH, RECONFIGURED. SPEC section 9's modes differ in the clock, the
 * target and the opponent; the match takes the first two through its own
 * configure intent and this root takes the third, so nothing here builds a
 * second match, a second world or a second listener when the mode changes.
 *
 * ONE SEED PER MATCH, AND EVERY STREAM DERIVED FROM IT. The mode names the
 * seed, the opponent draws from its own split of it and the effects layer is
 * built on it, so replaying a seed replays the opponent's turn, the direction
 * of the shake and the goal burst together (SPEC section 6). The effects layer
 * is rebuilt with each match for exactly that reason: it holds no node, no
 * listener and no timer, and a match that inherited a half-spent stream would
 * not replay.
 *
 * SPEC SECTION 2.2's HIDDEN TAB IS A PAUSE INTENT AND NOTHING MORE. The
 * listener is added once, it raises the same intent the pause control raises,
 * and the match's own chart refuses it outside the four in-play states. The
 * clock cannot advance while it is refused, because a paused match steps
 * nothing at all, and the overlay the chrome derives from PAUSED is what asks
 * for the one activation that resumes.
 */
function mount(host: HTMLElement): void {
  // SPEC section 16's stored document, behind `core/modes.ts`'s progress seam.
  // Constructing it cannot fail: a platform that refuses storage outright, a
  // document that will not parse and a value out of range all resolve to the
  // new-player data inside the module, which is what makes "saved state cannot
  // stop the game starting" a property of the type rather than a promise.
  // The host is the column QUALITY-BAR section 5's arrangement is built in:
  // the HUD, the hint, the stage and the aim controls, top to bottom, with the
  // stylesheet deciding which of them stick. The class is written here rather
  // than in index.html because the arrangement is this root's, and the
  // stylesheet stays class-based like every other rule in it.
  host.className = 'pf-app';

  // QUALITY-BAR section 4's two live regions, which `index.html` carries so
  // that both exist before anything has a first line to say. One queue owns
  // them; this root only hands it the elements and, once a frame, what is true.
  const regions = createLiveRegions(required(POLITE_MARKER), required(ASSERTIVE_MARKER));

  const store: DataStore = createDataStore(openStorage);
  // Everything that only wants the ladder rung or the onboarding flag keeps
  // talking to the narrow seam, so the widening below is visible where it is
  // used rather than everywhere.
  const progress: ProgressStore = store;
  const match = createMatch({ onNonFinite: 'repair' });

  // SPEC section 17: the menu opens on the settings the last start left, and
  // the ladder's rung is progress rather than a setting, so it arrives beside
  // them. A new player gets SPEC section 9's own defaults, because that is what
  // the stored settings are initialised to.
  const startingChoice: ModeChoice = choiceOf(
    store.data().settings,
    store.data().progress.ladderRung,
  );

  let setup: ModeSetup = setupFor(startingChoice);
  let guideEnabled = store.data().settings.guide;
  // QUALITY-BAR section 4's play-surface size, which PF-10 reserved in the
  // document and this part gives a control. The root holds it because the fit
  // is the root's; the panel raises the change and the store keeps it.
  let surfaceScale = store.data().settings.surfaceScale;
  let opponent: Rng | undefined;
  let effects: Effects | undefined;
  let turnsTaken = 0;
  let firstEverMatch = false;
  let recorded = true;

  /** SPEC section 9: Hotseat is the mode with no opponent profile at all. */
  function hotseat(): boolean {
    return setup.profile === undefined;
  }

  /** True while the second human is the one at the controls. */
  function secondHuman(): boolean {
    return hotseat() && match.readout().state.kind === 'OPPONENT_TURN';
  }

  function inputState(): MatchState {
    return secondHuman() ? HUMAN_TURN : match.readout().state;
  }

  /**
   * The world an aim is taken in. Built once and answering from the match, so
   * the pointer input holds one reference for the life of the game; what it
   * swaps in Hotseat is which body the aim belongs to, which is every
   * body-anchored reading the aim models make: the press that begins a drag,
   * the point a tap aims from, the direction a keyboard aim opens at and the
   * circle the arrow and the guide are drawn from.
   */
  const aimWorld: World = {
    get player(): Body {
      return secondHuman() ? match.world.opponent : match.world.player;
    },
    get opponent(): Body {
      return secondHuman() ? match.world.player : match.world.opponent;
    },
    ball: match.world.ball,
    bodies: match.world.bodies,
  };

  // SPEC section 5.1: Escape with no aim active opens the pause overlay, and
  // SPEC section 2.2's hidden tab raises the same intent. The surface and the
  // platform both come through here, so there is one way into PAUSED and not
  // three. The chrome is synced at once so that focus reaches the panel in the
  // same task the key was pressed in.
  function pauseNow(): void {
    match.dispatch({ kind: 'pause' });
    chrome.sync();
  }

  // THE SURFACE IS MOUNTED BEFORE THE CHROME, AND FIVE CLOSURES HERE NAME A
  // `chrome` DECLARED BELOW IT. That is a real temporal dependency and it is
  // written down rather than left to be re-derived: `pauseNow` above, and the
  // theme, size, hint and reset callbacks in the `mountChrome` options, all
  // read `chrome`, and every one of them is a callback the platform raises. The
  // earliest any of them can run is a pointer press or a key, which is a task
  // after this whole function has returned, so the binding is always
  // initialised by then. The order cannot simply be swapped: the chrome's own
  // options call `play.render()` and `play.setScale()`, so the two mounts refer
  // to each other and one of them has to be second. What would break this is a
  // closure here being CALLED during the mount rather than stored by it, which
  // would reach the binding in its temporal dead zone and raise; the two mount
  // functions store their callbacks and call none of them.
  const play = mountPlaySurface(host, {
    match,
    glyphs: () => glyphsForOpponent(setup.opponentName),
    inputState,
    aimWorld,
    guideShowing: () => guideShown(guideEnabled, firstEverMatch, turnsTaken),
    onLaunched: () => {
      turnsTaken += 1;
    },
    onPause: pauseNow,
    effects: () => effects,
    initialSurfaceScale: surfaceScale,
  });

  /** A fresh match on the mode in force: its own seed, and its own streams. */
  function beginMatch(): void {
    turnsTaken = 0;
    recorded = false;
    opponent = createRng(setup.seed).split(OPPONENT_STREAM);
    effects = createEffects({ seed: setup.seed });
  }

  function startMode(choice: ModeChoice, guide?: boolean): void {
    setup = setupFor(choice);
    // SPEC section 11's default is the mode's own; the menu may override it
    // for the match it starts, and a ladder step that never passes through the
    // menu takes the new rung's default instead.
    guideEnabled = guide ?? setup.guideDefault;
    // SPEC section 16: a start is where the settings are written, and the only
    // moment before the whistle that anything is written at all. The read is
    // taken FIRST, because `playedBefore` is a fact about the session that is
    // beginning and the write below is what ends it being true.
    const stored = store.data();
    firstEverMatch = !stored.progress.playedBefore;
    store.save({
      ...stored,
      progress: { ...stored.progress, playedBefore: true },
      settings: settingsAfter(stored.settings, setup.choice, guideEnabled),
    });
    beginMatch();
    match.dispatch({ kind: 'configure', configuration: setup.configuration });
    chrome.applyMode(setup);
    // The mirror and the announcements name the two sides the way the HUD does,
    // from the same mode and in the same call, so a ladder rung cannot be
    // announced by one name and mirrored by another.
    play.mirror.setNames(setup.opponentName, setup.playerName);
    chrome.setGuide(guideEnabled);
    match.dispatch({ kind: 'start' });
    chrome.sync();
  }

  /** SPEC section 13's Play Again: the same mode, the same seed, from the top. */
  function playAgain(): void {
    beginMatch();
    match.restart();
    chrome.sync();
  }

  /**
   * SPEC section 13's Change mode: back to the menu. The rung the menu offers
   * is the store's, read by the menu itself every time it opens, so every
   * route back to it agrees.
   */
  function changeMode(): void {
    match.dispatch({ kind: 'quit' });
    chrome.sync();
  }

  function nextOpponent(): void {
    match.dispatch({ kind: 'quit' });
    startMode({ kind: 'ladder', rung: progress.read().ladderRung });
  }

  function restartLadder(): void {
    match.dispatch({ kind: 'quit' });
    progress.write({ ...progress.read(), ladderRung: 1 });
    startMode({ kind: 'ladder', rung: 1 });
  }

  /**
   * SPEC sections 9 and 16 at the whistle: the ladder advances on a win and
   * restarts on a loss, the mode's best result is offered this scoreline, and
   * the lifetime counters take it. Written ONCE, the first frame the match is
   * over, and from the readout rather than from the button that follows, which
   * is what makes the record a fact about the match played rather than about
   * which action the player happened to press afterwards.
   *
   * THE ONE WRITE COVERS BOTH, deliberately. A ladder rung and a result are
   * two facts about the same finished match, and two writes would leave a
   * window in which the document held one of them.
   */
  function recordMatch(): void {
    if (recorded || match.readout().state.kind !== 'GAME_OVER') {
      return;
    }
    recorded = true;
    const scoring = match.readout().scoring;
    const stored = store.data();
    const ladder = setup.ladder;
    const advanced =
      ladder === undefined
        ? stored.progress
        : {
            ...stored.progress,
            ladderRung: ladderRungAfter(
              ladder.position,
              ladderStepFor(outcomeOf(scoring.player, scoring.opponent)),
            ),
          };
    store.save(
      recordResult(
        { ...stored, progress: advanced },
        setup.choice.kind,
        scoring.player,
        scoring.opponent,
      ),
    );
  }

  /** What the mode says about the match that has just finished. */
  function gameOverContext(): GameOverContext {
    const scoring = match.readout().scoring;
    const ladder = setup.ladder;
    const context: {
      opponentName: string;
      ladderStep?: ReturnType<typeof ladderStepFor>;
      ladderComplete?: boolean;
    } = { opponentName: setup.opponentName };
    if (ladder !== undefined) {
      const step = ladderStepFor(outcomeOf(scoring.player, scoring.opponent));
      context.ladderStep = step;
      context.ladderComplete = ladderComplete(ladder.position, step);
    }
    return context;
  }

  const chrome = mountChrome(host, {
    match,
    // SPEC section 17: the theme is a stored setting, so a change is written
    // as well as drawn. The value is read back off the attribute the chrome
    // has just written, which keeps the policy in the one module that owns it.
    onThemeChange: () => {
      const stored = store.data();
      store.save({ ...stored, settings: { ...stored.settings, theme: themeSetting() } });
      play.render();
    },
    initialTheme: store.data().settings.theme,
    // QUALITY-BAR section 4's size setting: the control raises the number, the
    // root applies it to the fit and writes it where the theme is written.
    // SPEC section 16 allows a settings write at exactly this moment, which is
    // an explicit change the player made, and at no other.
    initialSurfaceScale: surfaceScale,
    onSurfaceScaleChange: (percent: number) => {
      surfaceScale = percent;
      const stored = store.data();
      store.save({ ...stored, settings: { ...stored.settings, surfaceScale: percent } });
      play.setScale(percent);
    },
    // SPEC section 2.1's hint: shown until it is put away, and the dismissal
    // outlives the session the way SPEC section 19's does, beside it in the
    // same progress record and through the same seam.
    hintDismissed: progress.read().rotateHintDismissed,
    onHintDismissed: () => {
      progress.write({ ...progress.read(), rotateHintDismissed: true });
    },
    // SPEC section 17's Reset all data, after the panel's own confirmation.
    // The document goes, the session goes back to the new-player state, and
    // every readout follows from the store the way it always does: the menu
    // reads the rung when it opens, and the guide setting is put back here
    // because it is the one the root holds for the match in force.
    // THE MATCH IN PROGRESS LOSES ITS RIGHT TO RECORD ITSELF, and that is the
    // whole of "clears every persisted value". Settings is reached from the
    // pause overlay, so EVERY reset is taken with a match live and this root
    // still holding that match's mode: the whistle would otherwise write the
    // ladder rung it was playing, and its result and counters with it, back
    // over the document the player had just erased. Marking it recorded is
    // what stops that, and the next match begins recorded false as always.
    onResetData: () => {
      store.clear();
      recorded = true;
      guideEnabled = store.data().settings.guide;
      chrome.setGuide(guideEnabled);
      // The size and SPEC section 2.1's hint are NOT put back here, and that
      // is the same rule the theme already follows: the chrome owns its own
      // controls and puts each of them where a new player would have it, and
      // the size change it raises on the way through is what brings this
      // root's copy and the fit along with it. A second writer here would be
      // a second place for the two to disagree.
    },
    // Item G9's trap reaches the whole app column, and three of its elements
    // are this root's rather than the wiring's.
    background: play.background,
    modes: {
      initial: startingChoice,
      guideOn: guideEnabled,
      onStart: (choice, guide) => {
        startMode(choice, guide);
      },
      onPlayAgain: playAgain,
      onChangeMode: changeMode,
      onNextOpponent: nextOpponent,
      onRestartLadder: restartLadder,
      onHowToDismissed: () => {
        progress.write({ ...progress.read(), howToDismissed: true });
      },
      ladderRung: () => progress.read().ladderRung,
      gameOver: gameOverContext,
    },
  });

  // WCAG 2.2 SC 2.4.11's two halves, wired once the chrome exists: the bars
  // report their own heights into the scroll padding, and a focus move asks the
  // platform to honour it. Neither is a per-frame cost: the observer fires on a
  // box change and the listener on a focus.
  watchBars(chrome.hudBar, play.aimBar);
  followFocus(play.stage);

  /** The two sides as the mode in force names them, for every line of words. */
  function sideNames(): SideNames {
    return { opponent: setup.opponentName, player: setup.playerName };
  }

  /**
   * The accessible half of one frame: the title, the polite line and the
   * outcome, all derived from the readout the canvas was drawn from.
   *
   * THE AIM WINS THE POLITE CHANNEL WHERE THERE IS ONE, and `politeLine` states
   * why. The title is written on the edge alone, because a document title is
   * observable and a browser puts it in the tab, the window and the history.
   */
  function announce(delta: number): void {
    const reading = match.readout();
    const names = sideNames();
    const title = titleFor(reading, names);
    if (document.title !== title) {
      document.title = title;
    }
    regions.say(politeLine(reading, names, play.announcement()));
    regions.outcome(outcomeLine(reading, names));
    regions.pump(delta);
  }

  // SPEC section 19: How to Play is shown on first launch, and once dismissed
  // it is not shown again. The overlay opens over the menu, which is where a
  // first launch lands, and the menu is still there underneath it.
  if (!progress.read().howToDismissed) {
    chrome.showHowToPlay();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseNow();
    }
  });

  startFrameDriver((delta) => {
    match.update(delta);
    // The opponent answers its own seam with an ordinary launch intent. A
    // mode with no profile has nobody to answer it, which is the whole of
    // SPEC section 9's "no AI" and is why Hotseat needs no flag anywhere.
    const profile = setup.profile;
    if (profile !== undefined && opponent !== undefined) {
      respond(match, profile, opponent);
    }
    recordMatch();
    // The lock, once a frame, before anything reads the aim: the match may
    // have left the player's turn since the last pointer event, and an aim
    // that outlives its own turn is what item C8 forbids.
    play.refresh(delta);
    chrome.sync();
    play.render();
    // LAST, and after the chrome, because the aim line it reads is the one the
    // refresh above has just settled and the state is the one the chrome has
    // just derived every panel from.
    announce(delta);
  });
}

boot();
const host = document.getElementById('app');
if (host === null) {
  throw new Error('the composition root found no #app host to mount the game in');
}
mount(host);

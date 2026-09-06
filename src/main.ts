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
import { kickoffFacing } from './render/entities';
import type { Facing } from './render/entities';
import { attachAimInput } from './render/input';
import { createSurface, resizeSurface, watchDeviceRatio } from './render/surface';
import { drawFrame } from './render/pitch';
import type { FrameOptions, PitchCacheCell } from './render/pitch';
import { pitchFor } from './render/tokens';
import type { Theme } from './render/tokens';
import { createAimControls } from './ui/components/aim-controls';
import type { GameOverContext } from './ui/components/game-over-panel';
import { mountChrome } from './ui/layout';

export const GAME_ID = 'pocket-football';

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

export function boot(): void {
  document.documentElement.dataset['game'] = GAME_ID;
}

/** Everything the play surface has to ask the root, and nothing it decides. */
interface PlayContext {
  readonly match: Match;
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
    facing?: Facing;
    aim?: AimPreview;
    guide?: AimGuide;
    launcher?: Body;
    effects?: Effects;
  } = {};
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
): { render: () => void; refresh: (elapsed: number) => void } {
  const match = context.match;
  const frame = document.createElement('div');
  frame.className = 'pf-play-frame';
  frame.dataset['pf'] = 'play-frame';
  frame.setAttribute('tabindex', '0');
  frame.setAttribute('role', PLAY_SURFACE_ROLE);
  frame.setAttribute('aria-label', PLAY_SURFACE_LABEL);
  host.appendChild(frame);

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
    drawFrame(surface, cache, world, palette, frameOptionsFor(world, context, input.preview()));
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
   */
  const refresh = (elapsed: number): void => {
    input.refresh(elapsed);
    controls.sync(elapsed, input.preview(), input.allowed());
    context.effects()?.observe({
      world,
      scoring: match.readout().scoring,
      elapsed,
      reducedMotion: reducedMotionInForce(),
    });
  };

  refit();
  new ResizeObserver(refit).observe(host);
  watchDeviceRatio(window, refit);
  return { render, refresh };
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

  const play = mountPlaySurface(host, {
    match,
    inputState,
    aimWorld,
    guideShowing: () => guideShown(guideEnabled, firstEverMatch, turnsTaken),
    onLaunched: () => {
      turnsTaken += 1;
    },
    onPause: pauseNow,
    effects: () => effects,
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
    },
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
  });
}

boot();
const host = document.getElementById('app');
if (host === null) {
  throw new Error('the composition root found no #app host to mount the game in');
}
mount(host);

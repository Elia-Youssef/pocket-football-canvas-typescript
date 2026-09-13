import { createMatch } from '../../../src/core/match';
import type { ChromeOptions, ModeWiring } from '../../../src/ui/layout';

/**
 * The one place a test fills in the chrome wiring it does not care about.
 *
 * `ChromeOptions` has no optional members: every field the composition root
 * supplies is required, so the chrome a test mounts is the chrome the game
 * ships rather than one assembled out of whichever defaults happened to be
 * written into the wiring. That leaves a test with a dozen fields to name in
 * order to assert something about one of them, which is what this factory is
 * for: it names the defaults ONCE, and a test overrides the ones its subject is
 * about.
 *
 * THE DEFAULTS ARE THE NEW-PLAYER ONES, deliberately. `system`, 100 percent and
 * an undismissed hint are what `core/storage.ts` hands a player who has never
 * opened the game, so a mount with no overrides is the first-launch mount; a
 * test that wants a stored value says so, in the field, where a reader can see
 * it. The callbacks default to doing nothing, which is the only honest default
 * for a callback: a test that cares what one raises passes its own.
 *
 * A FIELD ADDED TO `ChromeOptions` IS ADDED ONCE, HERE, and every mount in the
 * suite gains it. That is the point of the factory and it is why it returns the
 * whole options object rather than a partial one to be spread into.
 */

/** SPEC section 9's default choice, which is what the menu opens on. */
export function modeWiring(overrides: Partial<ModeWiring> = {}): ModeWiring {
  return {
    initial: { kind: 'quick', duration: 60, difficulty: 'casual' },
    guideOn: true,
    onStart: () => undefined,
    onPlayAgain: () => undefined,
    onChangeMode: () => undefined,
    onNextOpponent: () => undefined,
    onRestartLadder: () => undefined,
    onHowToDismissed: () => undefined,
    ladderRung: () => 1,
    gameOver: () => ({ opponentName: 'Opponent' }),
    ...overrides,
  };
}

/**
 * A whole `ChromeOptions`, with the new-player defaults and a live match.
 *
 * The match is built here rather than defaulted to a shared one, because a
 * chrome reads its state from the match it is given and two mounts sharing one
 * match would share a state machine.
 */
export function chromeOptions(overrides: Partial<ChromeOptions> = {}): ChromeOptions {
  return {
    match: createMatch({ duration: 60 }),
    onThemeChange: () => undefined,
    initialTheme: 'system',
    onSurfaceScaleChange: () => undefined,
    initialSurfaceScale: 100,
    hintDismissed: false,
    onHintDismissed: () => undefined,
    onResetData: () => undefined,
    modes: modeWiring(),
    ...overrides,
  };
}

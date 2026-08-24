# @js-games/engine

**A placeholder. There is no shared engine in this repository yet, and this package is not the beginning of
one.**

## Why it exists at all

Acceptance item `M3` forbids any module under `core/` from importing "the shared engine renderer", and the
lint rule that enforces it matches the specifier `@js-games/engine/render`. A rule matching a specifier that
resolves to nothing is a rule nobody can tell apart from a typo, and the deliberately violating fixture the
item also requires would be importing a module that does not exist. So the specifier resolves: to
`src/render/index.ts`, which is a dead end that throws if anything calls it.

Two things make the specifier real rather than decorative: this package is an npm workspace, so
`@js-games/engine` is linked under `node_modules`, and `tsconfig.json` maps `@js-games/engine/*` at the type
level.

## Why it is not the engine

`docs/STACK.md` section 5 settles the extraction order: the shared package is **extracted from Blackjack
once Blackjack works, not designed up front**, because writing the API first would mean designing against
two games, one of which does not exist yet. That document's 2026-08-24 reorder, carried into
`docs/BUILD-PLAN.md`, brings Pocket Football's foundation parts forward ahead of the extraction: `PF-0` and
`PF-1` scaffold this project **standalone**, on its own copies of the toolchain and gates, and the `ENG`
parts rewire both games onto the shared package when they arrive.

So until an `ENG` part lands here, nothing in this project consumes a shared module. Adding anything to this
package before then would be the speculative API the extraction order exists to prevent.

## What arrives here later

The prediction, with evidence rather than guesswork, is in `docs/STACK.md` section 3: `loop`, `render`,
`input`, `layout`, `storage`, `audio`, `a11y`, `format`, `tokens` and `rng`. Two of them are named there as
things this game in particular will exercise first, and neither is built here now: the fixed-step
accumulator in `loop`, and the pointer-drag path in `layout` and `input`.

**Where `packages/engine` finally lives is an `ENG-1` decision.** `docs/STACK.md` section 2 settles the
order and deliberately does not settle the destination.

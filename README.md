# Pocket Football

A turn-based arcade football game for the browser. Top-down pitch, three circles: you, your opponent, and
the ball. Drag back from your circle to aim, release to launch, and hand-rolled elastic physics does the
rest. It is pool crossed with football, and a turn takes about five seconds.

Vanilla TypeScript, Canvas 2D for the play surface, real DOM for every button, readout, panel and label. No
game framework and no physics engine. No images, no audio files, no webfonts: every graphic is a drawn
primitive and every sound is synthesised at runtime. The whole thing ships as a static bundle and stores
everything in the browser.

**Nothing is playable yet.** `PF-0` was the scaffold: the toolchain, the gates and the `core/` boundary that
makes the rest of the build testable. `PF-1` added the design tokens, so `src/ui/` and `src/render/` hold
the two forms of the token layer and nothing else, and `src/main.ts` is a boot marker plus the one
stylesheet import. `PF-2` added the simulation: the three time layers, integration, per-second damping, the
stop threshold, the global speed cap, wall containment, the finiteness guard and the seeded stream. `PF-3`
added the collisions: elastic circle-against-circle response with positional separation and an approach
gate, the three pairs resolved in a fixed order four times per step, and wall reflection at the stated
restitution. `PF-4` added the goals: one predicate decides both whether the whole ball is inside an
opening and whether the side walls are transparent to it, so the ball passes through and the circles,
which fit the opening geometrically, never do; a goal needs the trailing edge past the line as well, so a
half-in ball does not score; and it holds the pitch for 1.2 s before the reset gives the next turn to the
side that conceded. It runs headlessly and nothing draws it yet, and it takes its time as a parameter, so
the frame driver is a later part. Aiming arrives at `PF-5`, and the turn flow around a goal at `PF-7`.

## Prerequisites

Nothing beyond these, and nothing to configure between cloning and building. No compiler toolchain, no
global CLI, no container, no service, no account, no API key and no `.env` file.

| Prerequisite | Version | Why |
|---|---|---|
| Node.js | 20.19.0 or later, per `engines` in `package.json` | Runs Vite, Vitest, ESLint and the check scripts |
| npm | bundled with Node | Installs from the committed lockfile |
| A browser | installed by Playwright, see below | The browser gate |

## Build and run

```bash
npm ci
npm run build
```

`npm ci` is the documented install command rather than `npm install`, because it fails outright if
`package.json` and `package-lock.json` disagree, and a deterministic build starts with a deterministic
dependency tree.

The browser gate needs its engines present. Once per machine:

```bash
npx playwright install chromium firefox webkit
```

Those two commands are the only ones that touch the network. Everything below works offline.

## Every script, and what it honestly does

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 4273, with module transforms and a client injected. Never what a gate measures |
| `npm run build` | Static bundle into `dist/`. Relative base, no sourcemap, no injected environment values |
| `npm run preview` | Serves the built `dist/` on port 4273, strict about the port |
| `npm run typecheck` | `tsc --noEmit` in strict mode against the project `tsconfig.json` |
| `npm run lint` | ESLint over the tree, including the `core/` boundary rules. Excludes the lint fixtures, which exist to be linted by a test |
| `npm run test` | The Vitest suite: the boundary rules against their fixtures, the build fingerprint, the repository record checks, the design tokens against the values the documents committed, and the simulation, which is frame independence, damping, the stop threshold, tunneling, the speed cap, finiteness, a seeded transcript, the collisions, and the goals: the openings a ball passes and the circles never do, and goal detection with its hold and reset |
| `npm run test:browser` | Builds, then drives the built bundle in Chromium, Firefox and WebKit |
| `npm run verify:build` | Builds twice under deliberately different conditions and compares every emitted byte. Writes `artifacts/reports/build.md` |
| `npm run verify:policy` | Checks the branch name, every commit in the history, and every tracked file against the repository record rules. Needs a git repository rooted at this project, and refuses by name to judge any other |
| `npm run verify:mutations` | Breaks each gate above in turn and requires every break to be caught. Slow, and not part of `verify` |
| `npm run verify` | Policy, typecheck, lint, unit, browser, deterministic build, in that order |

`verify:mutations` is deliberately outside `verify`. It edits and restores live source files, so nothing
else may run at the same time, and it is a phase gate rather than a per-commit one.

## The CI contract

Two jobs, both required, and their display names are exactly the two status check contexts in
`.github/rulesets/protect-main.json`:

| Check | Runs | Needs |
|---|---|---|
| **Repository policy** | `node scripts/check-repository-record.mjs` | Node builtins only, no install |
| **Pocket Football gates** | typecheck, lint, unit, browser, deterministic build | `npm ci` and the browser engines |

The policy job finishes in seconds and the gates job waits on it, so a problem in the record fails before
anything is installed rather than after a five minute install. Nothing reaches `main` except through a pull
request with both green: no direct pushes, no merging red, no administrator bypass. `bypass_actors` in the
ruleset is empty on purpose.

## Layout

```text
index.html                     entry document
src/
  core/                        the simulation. Zero DOM, zero canvas, zero renderer imports, zero
                               Math.random, and no clock: time arrives as a parameter.
                               Lint-enforced, not documented
    config.ts                  every geometry and tuning constant, one place
    vec2.ts                    vector maths that mutates what it is given, for a step that allocates
                               nothing
    bodies.ts                  the three bodies, the world, and kickoff placement
    rng.ts                     the seeded stream, one split per consumer
    collisions.ts              body against body: separation, the approach gate and the elastic
                               impulse, and the three pairs in their fixed order
    goals.ts                   the one predicate the goal openings and the goal test share, and the
                               GOAL state: one point, the celebration hold, the reset, the next turn
    physics.ts                 the three time layers, integration, damping, the stop threshold, the
                               speed cap, wall containment and reflection, and the finiteness guard
  render/                      the canvas play surface, and nothing else
    tokens.ts                  the play-surface palette and the numeric scales as data, because a
                               canvas context cannot take a var()
  ui/                          the DOM chrome: every button, readout, panel and label
    tokens.css                 every design token as a custom property, both themes and both
                               brightness variants. The only stylesheet, imported once by main.ts
  main.ts                      composition root, currently a boot marker and that import
  stylesheets.d.ts             says a stylesheet import resolves, so the type checker agrees with the
                               bundler. Narrow on purpose; see the note in it
packages/engine/               a placeholder, so the forbidden engine specifier resolves. See its README
tools/eslint-plugin-core-boundary/
                               the three rules behind the core boundary, and their README
tests/unit/                    Vitest, with the driver the simulation tests share in support/
tests/reference/               values copied from the documents that own them, for a test to read
tests/browser/                 Playwright, against the built bundle
tests/lint/fixtures/           a deliberately violating core module, its near-miss control, and the same
                               offences outside core. Excluded from tsc and from the shipping lint
scripts/                       the determinism check, the repository record check, the mutation harness
.github/                       CI, the ruleset for main, dependency updates, the pull request template
artifacts/reports/             measurement output, written by a gate and not committed
```

## The one rule worth reading before writing any code here

Nothing under `src/core/` may import `render/`, `ui/` or the shared engine renderer, name any DOM or canvas
type, or call `Math.random`. All randomness comes from a seeded stream with one split per consumer.

It is enforced by a lint rule at error severity, with a deliberately violating fixture proving the rule
rejects what it claims to, and a unit test asserting the shipping configuration is what rejects it. This is
what lets a whole match be played out headlessly, and it is the single property that makes the large
majority of the acceptance sheet automatable rather than merely observable.

`tools/eslint-plugin-core-boundary/README.md` says exactly what each rule catches and, just as importantly,
what it deliberately leaves alone.

## Where the rest of the truth lives

These documents sit outside this repository and are named rather than linked, so that a standalone clone has
no broken paths: `SPEC.md` for what the game is, `DESIGN.md` for how it is built, `ACCEPTANCE.md` and its
criteria CSV for what counts as done, `QUALITY-BAR.md` for the standards, `STACK.md` for the toolchain and
the shared-package contract, `BUILD-PLAN.md` for the order of the work, and `GITHUB.md` for how a change
reaches `main`.

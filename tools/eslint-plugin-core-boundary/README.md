# eslint-plugin-core-boundary

The enforcement half of acceptance item `M3`, which is Critical and traces `QB-1`:

> The core import boundary is lint-enforced and the lint fails the build: no module under core imports
> render, ui, the shared engine renderer, or any DOM or canvas type, and none calls Math.random. A
> deliberately violating fixture is rejected by the same rule.

Three rules, all at `error` in `eslint.config.js`, all applied to the whole tree. **They are not scoped by a
glob.** Each rule reads its own filename and returns an empty visitor outside a `core/` path, so a module
that moves into or out of `core/` changes what it is subject to without anybody editing a configuration.

`linterOptions.noInlineConfig` is `true` for `**/core/**`, so a violating line cannot switch off its own
detection with a disable comment. Without that, the whole item is worth one comment.

## The path scope

`isCorePath()` compares whole path **segments**, case-insensitively.

| Path | In scope | Why |
|---|---|---|
| `src/core/physics.ts` | yes | a `core` segment |
| `src/Core/physics.ts` | yes | case-insensitive, because a case-insensitive filesystem serves both |
| `tests/lint/fixtures/core/violations.ts` | yes | the fixture is subject to the shipping rules, not to a copy |
| `src/render-cache/core-notes.ts` | no | `core` is a substring, not a segment |
| `tools/eslint-plugin-core-boundary/index.js` | no | same |

## `no-forbidden-imports`

Every **syntax** by which one module can name another is covered, because a boundary is worth what its
weakest entry point is: `import`, `export ... from`, `export *`, dynamic `import()`, `require()`,
`import x = require(...)`, type-only imports, and the `import('...')` type position. What is not covered is
a module reached through another module, which is the second entry under "deliberately leaves alone" below.

### What it deliberately leaves alone

Two things, and both are stated here rather than discovered later.

**A computed specifier.** Only **statically known** specifiers are classified: a string literal, a template
literal with no expressions, and the literal type position. Guessing at a runtime string produces a rule
that is wrong in both directions.

**A transitive hop.** The rule is per file and reads one edge of the import graph, so a core module that
imports a non-core shim which itself imports `../render/pitch` is not reported: the offending edge is in the
shim, which is not a core path. Closing that would mean resolving the module graph inside a lint rule, which
is a different kind of tool and a much slower one. What stands against it instead is that the shim has to be
written on purpose and is visible in review, and that a boundary crossing which needs a deliberate
indirection to survive is no longer an accident. Worth revisiting if `core/` ever grows a barrel file.

Two matchers, kept apart, reporting different messages:

| Message | Fires on | Does not fire on |
|---|---|---|
| `engineRenderer` | `@js-games/engine/render` and anything beneath it | `@js-games/engine/render-utils` |
| `surfaceSegment` | a whole `render` or `ui` segment: `../render/pitch`, `./ui/hud`, `./ui.ts` | `../render-cache/store`, `../guidance/ui-copy`, `../rendering-order` |

The engine renderer is asked about **first**, and that ordering is load-bearing. The segment matcher would
catch `@js-games/engine/render` on its own, so if the two shared one message a broken engine matcher would
leave no trace. They do not share one, and the boundary test asserts the message id for that line.

## `no-dom`

By scope analysis, never by text. A name is reported when it is on the platform denylist **and** resolves to
no declaration in the file. The clean fixture pins the near misses a text scan gets wrong: a parameter named
`window`, a locally declared `interface HTMLPanelSpec`, an ordinary local named `document`.

The denylist is in `lib/platform-globals.js`: exact names plus whole families by prefix (`HTML*`, `SVG*`,
`Canvas*`, `Offscreen*`, `WebGL*`, `CSS*`, `DOM*`, `Audio*`, `Media*`, and the input event families). It
reaches past the document tree into timers, storage, network, events, observers and workers, because the
property the boundary buys is that a whole match simulates with no browser at all. Breadth is close to free
here: the rule only fires on a name that resolves to nothing, so a core module that declares or imports its
own `Node` or `Text` type is untouched.

Type positions are visited explicitly rather than left to the reference graph, because a type annotation is
where a DOM dependency reaches core most quietly: it compiles away and leaves no runtime trace to notice
later. A `/// <reference lib="dom" />` comment is reported too, since it would put the whole surface back in
scope.

**The explicit type visitor is redundancy, and the mutation harness says so.** The parser currently in use
resolves type references into the scope graph, so the reference sweep already reaches a type annotation and
deleting the visitor changes no verdict: the harness measured exactly that and the entry was replaced with
one that attacks the sweep instead. The visitor stays because the rule should not silently depend on a
parser behaviour that is not part of any contract, and the honest consequence is recorded here rather than
papered over with a mutation entry that cannot fail.

`globalThis` and `self` are on the denylist for their own sake: both are routes to every other name on it.

## `no-math-random`

`Math.random` is refused by every route, and every capture of the bare `Math` object is refused with it,
because once the object is held under another name nothing here can follow it.

| Message | Example |
|---|---|
| `mathRandom` | `Math.random()`, `Math['random']` |
| `mathDestructure` | `const { random } = Math`, `const { random: r } = Math`, `const { ...rest } = Math` |
| `mathAlias` | `const rng = Math`, `holder = Math` |
| `mathComputed` | `Math[key]`, where `key` is not statically known |
| `mathCapture` | `useMath(Math)`, and any other position that hands the object out |

What stays permitted is exactly what can be read statically and shown to be safe: a named member that is not
`random`, and a destructure whose keys are all known and none of them `random`. `Math.floor(x)` and
`const { abs, max } = Math` are ordinary and stay silent.

## Proof that any of this holds

- `tests/lint/fixtures/core/violations.ts`: one violation per line, each carrying an `@expect` marker naming
  the rule id and, where it matters, the message id.
- `tests/lint/fixtures/core/clean.ts`: the near misses, which must produce **zero** messages.
- `tests/lint/fixtures/outside/uses-dom.ts`: the same offences outside `core/`, which must also produce zero.
- `tests/unit/core-boundary.test.ts`: builds ESLint from the shipping `eslint.config.js` with no inline
  configuration, and asserts in both directions. Every marked line is reported with the expected rule, and
  nothing unmarked is reported at all.
- `scripts/mutation-check.mjs`: breaks each protected property in turn and requires every break to be
  detected. A gate that has quietly stopped failing is the defect class this project set exists to kill.

The fixtures are excluded from `tsc` by `tsconfig.json` and from the shipping lint run by the
`--ignore-pattern` on the `lint` script, so they are linted only by the test that exists to lint them. The
boundary test reads that ignore pattern out of `package.json` and asserts it names exactly the fixtures
directory, so removing it is a detected failure rather than a quiet widening.

# Contributing

The short version. The full set is in the project's `GITHUB.md`, cited by section number; this file says
only what a change has to look like to land here, and every rule below is enforced by
`npm run verify:policy` rather than trusted to review.

## One part, one branch, one pull request, squash merged

| Shape | Use |
|---|---|
| `main` | The only long-lived branch. Protected, always green, and the only branch anything is built from |
| `pf-<n>-<slug>` | One build-plan part |
| `eng-<n>-<slug>` | One shared-engine extraction step |
| `fix-<slug>` | A defect on `main`, naming the item it protects |
| `docs-<slug>` | Documents only |
| `ci-<slug>` | Workflow or gate changes only |
| `dependabot/<ecosystem>/<slug>` | Automated dependency updates, the only automated exception |

Branch names are lowercase and hyphenated, and carry no personal or tool prefix. Rebase onto `main` rather
than merging `main` into a branch: history on `main` is linear and enforced as such, and a merge commit
inside a branch survives a squash badly.

## Commits

```text
PF-0: scaffold the project and its CI gates

The boundary that makes the simulation testable has to exist before there is a
simulation to test, so the lint rule and its violating fixture ship with the
toolchain rather than after it.

Closes: A1, A2, A6, M3
```

| Rule | Checked by |
|---|---|
| Subject is `<area>: <lowercase imperative summary>` | `scripts/check-repository-record.mjs` |
| Area is `PF-n`, `ENG-n`, `fix`, `docs`, `ci` or `deps` | same |
| Subject is at most 72 characters, ASCII, and does not end in a full stop | same |
| The body begins after one blank line and says **why** | same, and review |
| Exactly one `Closes:` line, ids comma-space separated, or `None` | same |
| No trailer of any kind, and no identity naming a tool | same |

A dependency-update commit uses the configured `deps:` subject and is the only commit exempt from a
`Closes:` line, because its message is generated outside this repository.

Commit early and often on a branch. The squash at merge time is what lands on `main`, so a messy branch
history costs nothing.

## What may never appear in the record

Nothing pushed here names a product, vendor or model that writes code or prose on someone's behalf, and
nothing pushed attributes the work to one. That covers file contents, filenames, directory names, commit
messages, commit author and committer identities, branch names, pull request titles and pull request
bodies. These are client-facing products and the repository is part of what is delivered.

The list of names lives in `scripts/check-repository-record.mjs`, stored encoded so that the script does not
match itself, and it is deliberately not restated anywhere else. A genuine collision is reworded, or the
pattern is amended in a `ci-` pull request that says which product it names. Never a per-file exemption and
never a skipped run.

Local-only tooling configuration stays on the machine. Put those paths in `.git/info/exclude`, which is per
clone and never committed; naming them in `.gitignore` would itself put them in the record.

## Before you push

```bash
npm ci && npm run verify
```

The browser gate needs its engines, once per machine:

```bash
npx playwright install chromium firefox webkit
```

## The gate

Two required checks, and their names are exactly the two contexts in `.github/rulesets/protect-main.json`:

| Check | Runs |
|---|---|
| **Repository policy** | `node scripts/check-repository-record.mjs` over the branch, the whole history and every tracked file |
| **Pocket Football gates** | `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:browser`, `npm run verify:build` |

A required check that has not reported is treated as a failure, never as a pass. If a required check is
wrong, fix the check, in its own `ci-` pull request that goes through the same gate. Never merge past a
failure and never disable a check to land a part.

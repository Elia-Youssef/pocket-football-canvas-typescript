## Scope

<!-- Which build-plan part, or which of the three things allowed outside a part: a defect fix on main, a
     documents-only change, a workflow or gate change. One of them, not two. -->

## Reason

<!-- Why, not what. The diff already says what. -->

## Acceptance items

<!-- Exactly one Closes: line, and the record check reads it. List the item ids comma-space separated, or
     None for a documents or workflow change. Every id listed must pass by its declared method before this
     merges: T and CI-run A items green in CI, I items signed off against their checklist here. -->

Closes: None

## Verification

<!-- What was run and what it said. An item with no evidence is not done.

     - [ ] npm run verify green locally
     - [ ] For an Inspection item, the checklist verdict is recorded with date, reviewer, commit, OS and
           node version
     - [ ] For a phase-closing part, npm run verify:mutations reports every entry detected -->

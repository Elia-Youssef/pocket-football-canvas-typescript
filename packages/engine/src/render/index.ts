/**
 * A deliberate dead end.
 *
 * Item M3 forbids core from importing "the shared engine renderer", and the
 * lint rule that enforces it matches the specifier `@js-games/engine/render`.
 * A rule matching a specifier that resolves to nothing is a rule nobody can
 * distinguish from a typo, and the violating fixture would be importing a
 * module that does not exist. So the specifier resolves, here, to this.
 *
 * The engine itself is extracted from Blackjack at the ENG parts, per
 * STACK.md section 5 and the 2026-08-24 reorder recorded in BUILD-PLAN.md:
 * Pocket Football's foundation runs first and standalone, and nothing in this
 * project consumes a shared package until that extraction happens. Designing
 * the API here instead would be designing against a game that does not exist
 * yet, which is the one thing the extraction order exists to avoid.
 *
 * Nothing imports this. That is the point.
 *
 * ONE EXPORT, AND IT IS THE ONE THE FIXTURES NAME. The module stood on three
 * for a while, a string constant and an interface beside this function, and
 * nothing in `src/`, `tests/` or `scripts/` ever referred to either: a dead
 * end needs exactly enough surface for the specifier to resolve, and the lint
 * fixtures in `tests/lint/fixtures/` import `createSurface` alone.
 */

export function createSurface(): never {
  throw new Error(
    'The shared engine renderer has not been extracted yet: see STACK.md section 5.',
  );
}

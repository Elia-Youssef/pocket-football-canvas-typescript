# The design contract

**What this is.** A hand-copied subset of the two documents that own this project's design values, kept
inside the repository so that a test can read them. `tests/unit/tokens.test.ts` parses every table below and
fails if `src/ui/tokens.css` or `src/render/tokens.ts` disagrees with any of them.

**Where each half came from.**

| Half | Source | Owns |
|---|---|---|
| The numeric scales | `docs/QUALITY-BAR.md` section 15 | Type, line height, spacing, radius, border, focus ring, touch target, motion |
| The palette | `Pocket-Football/SPEC.md` section 18 | Every colour, both themes, both brightness variants, and every measured ratio |

**Nothing automated checks this file against those two documents.** They live outside this repository, so a
gate here cannot read them, and a copy that drifts would take the tokens with it silently. That is a
standing, disclosed risk and the reason the copy is deliberately small: it holds the values a test can act
on and none of the prose around them. A reviewer checks the copy by reading; the tests check everything
downstream of it.

**What was changed in copying, and nothing else was.** Markdown emphasis and the trailing `:1` on each
ratio are dropped, because they are formatting rather than value. Two rows that the source states as one
line with a slash, the markings pair and the aim-arrow pair, are written as one row each. The `Foreground`
and `Background` columns are added: the source names each pair in prose, and a test needs the two token
names to re-derive the ratio from the hexes. The chrome table's two ratio columns share one header in the
source and are named for their theme here, because a column is looked up by its header. Every hex, every
number and every threshold is character for character what the source states, with one scoping
transformation: the source binds two cells' thresholds to another carrier (the rail row's daylight cell
to the floodlit variant, the arrow's strong end to its outline). The Needs column here stays numeric so a
test can read it, and section 8 lists the two scoped cells by name.

**How a token resolves.** A play-surface token resolves by brightness variant, a chrome token by theme, and
the two are tied: the dark theme is the floodlit pitch and the light theme is daylight. So a measured pair
in the `Floodlit` column reads its chrome operands from the `Dark` column and its play-surface operands
from the `Floodlit` column, and the `Daylight` column reads from `Light` and `Daylight`.

## 1. Numeric scales

Values are written as the stylesheet declares them, so the comparison is a string comparison and not an
interpretation. `--target-clearance` and `--focus-ring-color` are aliases in the source too: section 15
states the clearance as 8 px "which is `--space-2`", and section 18 makes the accent the focus ring.

| Token | Value |
|---|---|
| `--type-xs` | `0.694rem` |
| `--type-sm` | `0.833rem` |
| `--type-base` | `1rem` |
| `--type-md` | `1.2rem` |
| `--type-lg` | `1.44rem` |
| `--type-xl` | `1.728rem` |
| `--type-2xl` | `2.074rem` |
| `--leading-body` | `1.5` |
| `--leading-tight` | `1.25` |
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `24px` |
| `--space-6` | `32px` |
| `--space-7` | `48px` |
| `--space-8` | `64px` |
| `--radius-sm` | `4px` |
| `--radius-md` | `8px` |
| `--radius-lg` | `14px` |
| `--radius-pill` | `999px` |
| `--border-hair` | `1px` |
| `--border-thin` | `2px` |
| `--border-thick` | `3px` |
| `--focus-ring-width` | `2px` |
| `--focus-ring-style` | `solid` |
| `--focus-ring-offset` | `2px` |
| `--focus-ring-color` | `var(--pf-accent)` |
| `--target-min` | `44px` |
| `--target-clearance` | `var(--space-2)` |
| `--dur-0` | `0ms` |
| `--dur-1` | `80ms` |
| `--dur-2` | `140ms` |
| `--dur-3` | `220ms` |
| `--dur-4` | `320ms` |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` |

Five of these are stated as prose in section 15 rather than as a row of one of its tables, and each is a
value the section states normatively and does not tokenise:

| Token | The sentence it comes from |
|---|---|
| `--leading-body` | "Line height is 1.5 for body" |
| `--leading-tight` | "and 1.25 at `--type-lg` and above" |
| `--target-min` | "Touch targets are 44 x 44 CSS px minimum" |
| `--target-clearance` | "with 8 px clearance (section 3), which is `--space-2`" |
| `--focus-ring-style` | The focus ring row reads "2px solid, 2px offset", which is three declarations |

## 2. Chrome palette

The ratio columns are the ones the source measured against that theme's `--pf-ground`. The ground has no
ratio against itself and the source writes a dash.

| Token | Dark | Ratio on dark ground | Light | Ratio on light ground |
|---|---|---|---|---|
| `--pf-ground` | `#0A1410` | - | `#EDF2EE` | - |
| `--pf-text` | `#EAF2EC` | 16.43 | `#16211B` | 14.62 |
| `--pf-text-muted` | `#9FB0A6` | 8.24 | `#4A5A50` | 6.46 |
| `--pf-accent` | `#F5C542` | 11.56 | `#7A5A06` | 5.63 |

## 3. Play surface palette

Ten tokens. Three of them differ between the two variants, which is what makes the pitch a brightness
variant of itself rather than a second palette; the other seven are one colour in both.

| Token | Floodlit | Daylight |
|---|---|---|
| `--pitch-stripe-a` | `#2A7336` | `#359045` |
| `--pitch-stripe-b` | `#2F7D3C` | `#3C9A4D` |
| `--pf-line` | `#F2F7F3` | `#F2F7F3` |
| `--pf-rail` | `#C8CFCB` | `#DDE3DF` |
| `--team-player` | `#5590CE` | `#5590CE` |
| `--team-opponent` | `#6E1712` | `#6E1712` |
| `--glyph-on-player` | `#0A1A2B` | `#0A1A2B` |
| `--glyph-on-opponent` | `#F2F7F3` | `#F2F7F3` |
| `--ball-body` | `#FAFAF8` | `#FAFAF8` |
| `--ball-panel` | `#1A1A1A` | `#1A1A1A` |

`--glyph-on-opponent` and `--pf-line` hold the same colour. The source states both independently, so both
are written out here and in the stylesheet rather than one aliasing the other: they are two decisions that
agree today, not one decision used twice.

## 4. The eleventh colour the play surface uses

The source's play-surface table has ten rows, and its last bullet gives the aim arrow an eleventh colour:
"The aim arrow ramps from `--pf-line` at the weak end to `--pf-accent` at the clamp". `--pf-accent` is a
chrome token, so it resolves by theme, and the renderer needs it as a value like every other colour it
draws. It is a cross-reference and not a new colour: the two hexes below are the two already in section 2.

| Token | Floodlit | Daylight |
|---|---|---|
| `--pf-accent` | `#F5C542` | `#7A5A06` |

## 5. Measured pairs

Every ratio the source measured on the play surface, with the two tokens each one is between. Section 8
lists the two cells whose stated threshold the source scopes to another carrier; both are re-derived like
every other cell and are asserted quiet there rather than against this table's threshold.

| Pair | Foreground | Background | Floodlit | Daylight | Needs |
|---|---|---|---|---|---|
| Markings on stripe A | `--pf-line` | `--pitch-stripe-a` | 5.38 | 3.71 | 3 |
| Markings on stripe B | `--pf-line` | `--pitch-stripe-b` | 4.70 | 3.27 | 3 |
| Entity ring on pitch | `--pf-line` | `--pitch-stripe-a` | 5.38 | 3.71 | 3 |
| Entity ring on player fill | `--pf-line` | `--team-player` | 3.09 | 3.09 | 3 |
| Entity ring on opponent fill | `--pf-line` | `--team-opponent` | 10.80 | 10.80 | 3 |
| Player fill against opponent fill | `--team-player` | `--team-opponent` | 3.49 | 3.49 | 3 |
| Glyph on player | `--glyph-on-player` | `--team-player` | 5.24 | 5.24 | 4.5 |
| Glyph on opponent | `--glyph-on-opponent` | `--team-opponent` | 10.80 | 10.80 | 4.5 |
| Ball on pitch | `--ball-body` | `--pitch-stripe-a` | 5.58 | 3.84 | 3 |
| Ball on player fill | `--ball-body` | `--team-player` | 3.21 | 3.21 | 3 |
| Rail on pitch | `--pf-rail` | `--pitch-stripe-a` | 3.67 | 3.09 | 3 |
| Rail on ground | `--pf-rail` | `--pf-ground` | 11.82 | 1.15 | 3 |
| Aim arrow weak end on pitch | `--pf-line` | `--pitch-stripe-a` | 5.38 | 3.71 | 3 |
| Aim arrow strong end on pitch | `--pf-accent` | `--pitch-stripe-a` | 3.59 | 1.59 | 3 |

## 6. Identity separation, in relative luminance

The source states these two to two decimal places and rests the whole identity argument on the gap between
them: hue collapses under protanopia, deuteranopia and tritanopia and luminance does not.

| Token | Relative luminance |
|---|---|
| `--team-player` | 0.26 |
| `--team-opponent` | 0.04 |

## 7. The retracted claim

The source retracts an earlier requirement that the two team fills clear 3:1 against the pitch as well as
against each other, states plainly that it is not achievable, and quotes what the fills actually measure
there. The pair below is therefore asserted to stay BELOW the threshold, not above it. A change that made
either one clear 3:1 would have dragged the two fills together and broken the guarantee that does hold,
which is the 3.49 in section 5.

| Pair | Foreground | Background | Measured | Stays below |
|---|---|---|---|---|
| Player fill on the floodlit pitch | `--team-player` | `--pitch-stripe-a` | 1.74 | 3 |
| Opponent fill on the floodlit pitch | `--team-opponent` | `--pitch-stripe-a` | 2.01 | 3 |

The same paragraph records that the reference image's two team colours measure 1.09 against each other.
That image is not a source of colour here and none of its values are copied.

## 8. Cells the threshold does not govern

Section 5 holds 28 cells. Twenty-six clear the threshold their row states. The two below are re-derived
the same way and are deliberately quiet: for each, the source scopes the 3:1 guarantee to a named carrier
instead. The test pins the measured value exactly, asserts it stays below 3 so the stronger claim cannot
be quietly reinstated by nudging a colour, and asserts the carrier clears.

Both entered this file at PF-1 as recorded defects in the source: the rail row's daylight cell quoted
8.59, a number the hexes never produced, and the arrow bullet promised both ends 3:1 on the pitch, which
no reading of the accent reaches in daylight. The specification owner corrected both on 2026-08-29
without changing any colour: the rail's daylight requirement was scoped to floodlit only, and the arrow's
contrast guarantee moved to its `--pf-line` outline, the same boundary rule every other object on the
pitch already follows.

| Pair | Variant | Measured | Stays below | Carried by |
|---|---|---|---|---|
| Rail on ground | Daylight | 1.15 | 3 | Rail on pitch, both variants |
| Aim arrow strong end on pitch | Daylight | 1.59 | 3 | The arrow's own `--pf-line` outline, both variants |

Nothing draws an arrow yet: it arrives with the aiming part, and `G2` and `E4` re-measure everything over
rendered pixels at `PF-19`, outline included.

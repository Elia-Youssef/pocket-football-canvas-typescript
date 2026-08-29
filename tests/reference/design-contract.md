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
number and every threshold is character for character what the source states.

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

Every ratio the source measured on the play surface, with the two tokens each one is between. A dash is a
cell the source leaves unmeasured, and no test invents a number for it. Section 8 accounts for all three
cells that are not compared here the ordinary way, the two dashes included.

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
| Rail on ground | `--pf-rail` | `--pf-ground` | 11.82 | 8.59 | 3 |
| Aim arrow weak end on pitch | `--pf-line` | `--pitch-stripe-a` | 5.38 | - | 3 |
| Aim arrow strong end on pitch | `--pf-accent` | `--pitch-stripe-a` | 3.59 | - | 3 |

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

## 8. The cells section 5 does not check the ordinary way

Section 5 holds 28 cells. **Twenty-five are compared against the hexes and clear the threshold their row
states. Three are not, and they are two separate defects in the source, in two different classes.** Both
are recorded here rather than quietly corrected, dropped or skipped: correcting either would mean editing
a source document, or a measured colour, to fit an implementation, and this part may do neither.

The two classes are not the same kind of problem and the tests below keep them apart:

| Class | What is wrong | Where |
|---|---|---|
| A quoted ratio that does not re-derive | The source states a number the two hexes do not produce | 8.1 |
| An unmeasured cell whose stated guarantee is not met | The source states a dash and a prose guarantee, and the colours miss it | 8.2 |

Neither is resolvable here and they are **one parked decision**, not two independent ones: both live in the
same section of the same document and any answer to either is a change only the specification's owner may
make.

### 8.1 A quoted ratio that does not re-derive

| Pair | Variant | Quoted | Re-derives to | Needs |
|---|---|---|---|---|
| Rail on ground | Daylight | 8.59 | 1.15 | 3 |

Both numbers are pinned by the test, so the disagreement cannot widen, cannot be resolved by editing a hex
without the test saying so, and cannot gain a second row unnoticed. This one cell is skipped by the loop
over section 5 and asserted here instead.

Two things about it are worth a reviewer's attention. The floodlit half of the same row re-derives exactly,
at 11.82, which is what confirms the pairing is read correctly: a light rail on the near-black dark ground
clears easily. The daylight half puts a near-white rail on a near-white ground, where no value near either
one can reach 3, so this is a question about the palette or about whether the pair belongs in the table at
all, and both answers are the user's to give. Nothing on the play surface depends on it yet: what carries
the rail's legibility is the row above, rail on pitch, which clears its threshold in both variants.

### 8.2 The unmeasured cells, and the guarantee one of them cannot meet

The source leaves both daylight cells of the aim-arrow rows as a dash, and states in prose that the arrow
"ramps from `--pf-line` at the weak end to `--pf-accent` at the clamp, so both ends clear 3:1 against the
pitch". On the daylight pitch the weak end does. **The strong end does not, under either reading of which
accent the arrow ramps to, and there is no third reading**: the accent is a chrome token with exactly two
values, and the arrow either takes the one in force for the theme or keeps the floodlit one.

| Pair | Variant | Reading | Foreground | Foreground read in | Background | Measured | Needs | Clears |
|---|---|---|---|---|---|---|---|---|
| Aim arrow weak end on pitch | Daylight | the outline, which does not flip | `--pf-line` | Daylight | `--pitch-stripe-a` | 3.71 | 3 | yes |
| Aim arrow strong end on pitch | Daylight | the accent flips with the theme | `--pf-accent` | Daylight | `--pitch-stripe-a` | 1.59 | 3 | no |
| Aim arrow strong end on pitch | Daylight | the arrow keeps the floodlit accent | `--pf-accent` | Floodlit | `--pitch-stripe-a` | 2.48 | 3 | no |

Every number here is derived by the test from the hexes, and each row's `Clears` verdict is asserted in
both directions, so a colour nudged until the strong end clears 3 fails just as loudly as one nudged until
the weak end stops clearing. The dash in section 5 for each of these two cells is asserted to still be a
dash: the loop's skip is this disclosure's doing and not an accident, and a number quietly written into
either cell fails.

**How this one differs from 8.1.** Nothing in the source is arithmetically wrong here; the numbers were
simply never taken, and the prose guarantee beside them turns out to be unreachable with the committed
colours, the same way the fill-on-pitch requirement in section 7 was. The choices are the specification
owner's: move the accent for the daylight variant, let the arrow keep the floodlit accent and accept
2.48, carry the arrow's contrast on its `--pf-line` outline the way every other object on the pitch does,
or withdraw the clause the way the fill-on-pitch one was withdrawn. **No colour was changed and no hex was
invented to close it.** Nothing draws an arrow yet: it arrives with the aiming part, and `G2` and `E4`
re-measure it over rendered pixels at `PF-19`.

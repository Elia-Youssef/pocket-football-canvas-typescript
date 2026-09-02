import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BREAKPOINTS,
  MEDIUM_MIN_WIDTH,
  STICKY_MIN_HEIGHT,
  WIDE_MIN_WIDTH,
  barsStick,
  breakpointFor,
} from '../../src/ui/breakpoints';
import type { Breakpoint } from '../../src/ui/breakpoints';

/**
 * Items F1 and F7, the half automation can reach without a browser: the four
 * breakpoints of QUALITY-BAR section 5 and the sticky-bar threshold, resolved
 * in code and held against the copy of that section's own table in
 * tests/reference/design-contract.md.
 *
 * WHY THE FIXTURE IS PARSED RATHER THAN QUOTED. A breakpoint written as a
 * media query carries its numbers where nothing can read them back, so a
 * threshold that drifted from the document would drift silently. Section 9 of
 * the contract holds the source's own table, this file parses it, and the
 * module's exported constants are compared against what was parsed. The row
 * counts are pinned for the reason every other parser in this suite pins
 * them: a table that has quietly stopped parsing reports agreement it never
 * checked, and every loop below would pass over nothing.
 *
 * THRESHOLDS ARE ALSO PINNED BY LITERAL. Comparing a constant against the
 * table it was copied from proves the copy is faithful; comparing it against
 * 1024 as well proves the pair did not move together. Both are here.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const CONTRACT = path.join(PROJECT_ROOT, 'tests', 'reference', 'design-contract.md');
const contractText = readFileSync(CONTRACT, 'utf8');

interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * The contract's tables under one heading, in order. Written out here rather
 * than shared with tokens.test.ts: that file's parser is part of what IT
 * pins, and a shared helper would mean one edit could blind both.
 */
function tablesUnder(heading: string): Table[] {
  const lines = contractText.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`the contract has no section headed ${JSON.stringify(heading)}`);
  }
  const found: Table[] = [];
  let headers: string[] | null = null;
  let rows: string[][] = [];
  const cells = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((text) => text.replace(/[`*]/g, '').trim());
  const separator = (row: readonly string[]): boolean =>
    row.length > 0 && row.every((text) => /^:?-{3,}:?$/.test(text));
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,6} /.test(line)) {
      break;
    }
    if (line.startsWith('|')) {
      const row = cells(line);
      if (headers === null) {
        headers = row;
      } else if (!separator(row)) {
        rows.push(row);
      }
      continue;
    }
    if (headers !== null) {
      found.push({ headers, rows });
      headers = null;
      rows = [];
    }
  }
  if (headers !== null) {
    found.push({ headers, rows });
  }
  return found;
}

const SECTION = tablesUnder('9. Responsive layout');
const NAMES = SECTION[0] ?? { headers: [], rows: [] };
const FIGURES = SECTION[1] ?? { headers: [], rows: [] };

function field(table: Table, row: readonly string[], header: string): string {
  const at = table.headers.indexOf(header);
  if (at === -1) {
    throw new Error(
      `no column headed ${JSON.stringify(header)}, the columns are ${table.headers.join(', ')}`,
    );
  }
  return row[at] ?? '';
}

/** The Range cell for one breakpoint name, as the source wrote it. */
function rangeOf(name: string): string {
  const row = NAMES.rows.find((entry) => field(NAMES, entry, 'Name') === name);
  if (row === undefined) {
    throw new Error(`the contract states no breakpoint named ${JSON.stringify(name)}`);
  }
  return field(NAMES, row, 'Range');
}

/** One figure's value, by the name the second table gives it. */
function figureOf(name: string): number {
  const row = FIGURES.rows.find((entry) => field(FIGURES, entry, 'Figure') === name);
  if (row === undefined) {
    throw new Error(`the contract states no figure named ${JSON.stringify(name)}`);
  }
  return Number(field(FIGURES, row, 'Value'));
}

/** The first whole number in a cell, which is how each range names its bound. */
function firstNumber(text: string): number {
  const found = /-?\d+/.exec(text);
  if (found === null) {
    throw new Error(`no number in ${JSON.stringify(text)}`);
  }
  return Number(found[0]);
}

function lastNumber(text: string): number {
  const all = [...text.matchAll(/-?\d+/g)];
  const found = all.at(-1);
  if (found === undefined) {
    throw new Error(`no number in ${JSON.stringify(text)}`);
  }
  return Number(found[0]);
}

/**
 * The resolution rule the source explicitly rejects, kept as a control: the
 * one that asks about orientation first. It agrees with the shipped rule
 * everywhere except the viewport QUALITY-BAR section 5 calls out by name.
 */
function orientationFirst(width: number, height: number): Breakpoint {
  if (height >= width) {
    return 'portrait';
  }
  if (width >= WIDE_MIN_WIDTH) {
    return 'wide';
  }
  return width >= MEDIUM_MIN_WIDTH ? 'medium' : 'compact';
}

describe('PF-14 the breakpoints, against QUALITY-BAR section 5', () => {
  describe('the contract this file reads', () => {
    it('parses both tables, at the size it depends on', () => {
      expect(SECTION).toHaveLength(2);
      expect(NAMES.rows).toHaveLength(4);
      expect(FIGURES.rows).toHaveLength(3);
      expect(NAMES.rows.map((row) => field(NAMES, row, 'Name'))).toEqual([
        'wide',
        'medium',
        'compact',
        'portrait',
      ]);
    });

    it('names the same four the module offers, in the same order', () => {
      expect(BREAKPOINTS).toEqual(NAMES.rows.map((row) => field(NAMES, row, 'Name')));
      expect(BREAKPOINTS).toHaveLength(4);
      expect(new Set(BREAKPOINTS).size).toBe(4);
    });

    it('carries the thresholds the module resolves by, and the same numbers', () => {
      // Parsed from the source's own Range cells, then pinned by literal as
      // well, so a constant and the table cannot drift together.
      expect(firstNumber(rangeOf('wide'))).toBe(WIDE_MIN_WIDTH);
      expect(firstNumber(rangeOf('medium'))).toBe(MEDIUM_MIN_WIDTH);
      expect(firstNumber(rangeOf('compact'))).toBe(MEDIUM_MIN_WIDTH);
      expect(firstNumber(rangeOf('portrait'))).toBe(MEDIUM_MIN_WIDTH);
      expect(WIDE_MIN_WIDTH).toBe(1024);
      expect(MEDIUM_MIN_WIDTH).toBe(768);
      // Medium's upper bound is the row below wide's floor, so the two ranges
      // meet with no width belonging to both and none belonging to neither.
      expect(lastNumber(rangeOf('medium'))).toBe(WIDE_MIN_WIDTH - 1);
      expect(lastNumber(rangeOf('medium'))).toBe(1023);
      // The orientation split belongs to the two rows below 768 and to no
      // other, which is the whole of "by width first".
      expect(rangeOf('wide')).not.toContain('portrait');
      expect(rangeOf('medium')).not.toContain('landscape');
      expect(rangeOf('compact')).toContain('landscape');
      expect(rangeOf('portrait')).toContain('portrait');
    });

    it('carries SC 1.4.10 s two figures and the sticky threshold', () => {
      expect(figureOf('Smallest supported width')).toBe(320);
      expect(figureOf('Smallest supported height')).toBe(256);
      expect(figureOf('Sticky bars unstick below')).toBe(400);
      expect(STICKY_MIN_HEIGHT).toBe(figureOf('Sticky bars unstick below'));
      expect(STICKY_MIN_HEIGHT).toBe(400);
      // The source's own words for each number, so a figure quietly re-pointed
      // at a different sentence fails here rather than passing quietly.
      const stated = (name: string): string => {
        const row = FIGURES.rows.find((entry) => field(FIGURES, entry, 'Figure') === name);
        return row === undefined ? '' : field(FIGURES, row, 'Stated as');
      };
      expect(stated('Smallest supported width')).toBe(
        'No two-dimensional scrolling at 320 x 256 CSS pixels',
      );
      expect(stated('Sticky bars unstick below')).toBe(
        'must collapse or unstick below a 400 px viewport height',
      );
    });
  });

  describe('resolution, by width first', () => {
    it('answers each row of the table on a viewport inside it', () => {
      expect(breakpointFor(1440, 900)).toBe('wide');
      expect(breakpointFor(1024, 768)).toBe('wide');
      expect(breakpointFor(900, 600)).toBe('medium');
      expect(breakpointFor(768, 500)).toBe('medium');
      expect(breakpointFor(700, 400)).toBe('compact');
      expect(breakpointFor(844, 390)).toBe('medium');
      expect(breakpointFor(667, 375)).toBe('compact');
      expect(breakpointFor(375, 667)).toBe('portrait');
      expect(breakpointFor(320, 256)).toBe('compact');
    });

    it('holds at one pixel either side of every boundary', () => {
      // The wide floor, in both orientations, because width decides it alone.
      expect(breakpointFor(1023, 800)).toBe('medium');
      expect(breakpointFor(1024, 800)).toBe('wide');
      // A tall viewport either side of the wide floor: neither is portrait,
      // because orientation does not reach this far up the table at all.
      expect(breakpointFor(1023, 2000)).toBe('medium');
      expect(breakpointFor(1024, 2000)).toBe('wide');
      // The medium floor, where the orientation split begins.
      expect(breakpointFor(767, 400)).toBe('compact');
      expect(breakpointFor(768, 400)).toBe('medium');
      expect(breakpointFor(767, 900)).toBe('portrait');
      expect(breakpointFor(768, 900)).toBe('medium');
      // Which is the width-first rule at its sharpest: one pixel of width
      // turns the same tall viewport from portrait into medium.
    });

    it('resolves a 1024 by 1366 tablet in portrait as wide, not portrait', () => {
      // QUALITY-BAR section 5 calls this viewport out by name: an earlier form
      // of its table qualified wide as landscape and left this device matching
      // no row at all.
      expect(breakpointFor(1024, 1366)).toBe('wide');
      // The control: the rule that asks about orientation first answers the
      // other way here, so this assertion is one a wrong implementation fails.
      expect(orientationFirst(1024, 1366)).toBe('portrait');
      expect(orientationFirst(1024, 1366)).not.toBe(breakpointFor(1024, 1366));
    });

    it('agrees with the rejected rule everywhere the width is not the question', () => {
      // The control is only useful if it is wrong in one place rather than
      // everywhere: below 768 the two rules are the same rule.
      for (const width of [320, 480, 640, 767]) {
        for (const height of [200, 320, 640, 900]) {
          expect(orientationFirst(width, height), `${String(width)}x${String(height)}`).toBe(
            breakpointFor(width, height),
          );
        }
      }
    });

    it('calls a square viewport portrait, the way the platform does', () => {
      // CSS resolves orientation: portrait when the height is greater than OR
      // EQUAL TO the width, and a device that reports square must not land on
      // a different arrangement from the one its own media query would choose.
      expect(breakpointFor(400, 400)).toBe('portrait');
      expect(breakpointFor(400, 401)).toBe('portrait');
      expect(breakpointFor(400, 399)).toBe('compact');
    });

    it('is exhaustive and mutually exclusive over every viewport it is asked', () => {
      const seen = new Map<Breakpoint, number>();
      for (let width = 200; width <= 2000; width += 7) {
        for (let height = 200; height <= 1600; height += 13) {
          const answer = breakpointFor(width, height);
          expect(BREAKPOINTS, `${String(width)}x${String(height)}`).toContain(answer);
          seen.set(answer, (seen.get(answer) ?? 0) + 1);
        }
      }
      // Every name is reached, so the sweep is not quietly answering one name
      // for everything, and the totals are what the width split predicts.
      expect([...seen.keys()].sort()).toEqual(['compact', 'medium', 'portrait', 'wide']);
      for (const name of BREAKPOINTS) {
        expect(seen.get(name) ?? 0, name).toBeGreaterThan(0);
      }
    });

    it('answers one of the four for a width that is not a number', () => {
      // A total answer for an impossible input rather than a fifth state.
      expect(BREAKPOINTS).toContain(breakpointFor(Number.NaN, 800));
      expect(BREAKPOINTS).toContain(breakpointFor(0, 0));
    });
  });

  describe('the sticky-bar threshold', () => {
    it('sticks at and above 400 and unsticks below it', () => {
      expect(barsStick(401)).toBe(true);
      expect(barsStick(400)).toBe(true);
      expect(barsStick(399)).toBe(false);
      expect(barsStick(256)).toBe(false);
      // QUALITY-BAR section 5 states the rule as a floor - bars must unstick
      // BELOW 400 - so 400 itself staying stuck is the document's answer and
      // not a rounding of it.
      expect(barsStick(STICKY_MIN_HEIGHT)).toBe(true);
      expect(barsStick(STICKY_MIN_HEIGHT - 1)).toBe(false);
    });

    it('is a question about height alone, and says so in its own shape', () => {
      // QUALITY-BAR section 5 makes the sticky rule a statement about height
      // and nothing else, and the signature is what says so: a width cannot
      // reach this answer because there is nowhere to hand one in. A loop over
      // widths would have been four copies of the same two assertions.
      expect(barsStick).toHaveLength(1);
      expect(barsStick(500)).toBe(true);
      expect(barsStick(300)).toBe(false);
    });
  });
});

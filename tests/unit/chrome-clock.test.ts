import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ceilingSeconds, formatClock, formatNumber } from '../../src/ui/components/clock';

/**
 * The clock face, SPEC section 12: `MM:SS`, ceiling-rounded, so it reads
 * `01:00` for the whole first second and `00:00` only at exactly zero.
 *
 * BOTH ENDS, EXPLICITLY. The match stores exact seconds, so every reading
 * between 59 and 60 is a different float with the same face; the assertions
 * below pin the ceiling at both ends of that interval and at the zero that
 * ends the match. Each bound is pinned against a literal, never against the
 * symbol that computes it.
 *
 * LOCALES ARE NOT COMPARED AS RAW STRINGS ACROSS LOCALES (QUALITY-BAR
 * section 11): the functional assertions pass an explicit locale list, and
 * the production locale list is pinned as source, by the construction
 * QUALITY-BAR states, rather than by whatever this host happens to resolve.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const CLOCK_SOURCE = path.join(PROJECT_ROOT, 'src', 'ui', 'components', 'clock.ts');

const EN: readonly string[] = ['en-US'];

describe('PF-13 the match clock face', () => {
  it('reads 01:00 for the whole first second, from 60 down to just above 59', () => {
    expect(formatClock(60, EN)).toBe('01:00');
    expect(formatClock(59.5, EN)).toBe('01:00');
    expect(formatClock(59.01, EN)).toBe('01:00');
    expect(formatClock(59.000001, EN)).toBe('01:00');
  });

  it('steps to 00:59 only when the remainder is gone, at exactly 59', () => {
    expect(formatClock(59, EN)).toBe('00:59');
    expect(formatClock(58.2, EN)).toBe('00:59');
  });

  it('reads 00:01 for every remainder above zero, and 00:00 only at exactly zero', () => {
    expect(formatClock(1, EN)).toBe('00:01');
    expect(formatClock(0.5, EN)).toBe('00:01');
    expect(formatClock(0.0001, EN)).toBe('00:01');
    expect(formatClock(0, EN)).toBe('00:00');
  });

  it('steps to 00:02 at exactly 2 and ceilings the second above it', () => {
    expect(formatClock(2, EN)).toBe('00:02');
    expect(formatClock(1.5, EN)).toBe('00:02');
    expect(formatClock(1.0001, EN)).toBe('00:02');
  });

  it('carries the minutes in the M slots', () => {
    expect(formatClock(90, EN)).toBe('01:30');
    expect(formatClock(125, EN)).toBe('02:05');
    expect(formatClock(600, EN)).toBe('10:00');
    expect(formatClock(3599.9, EN)).toBe('60:00');
  });

  it('ceils the exact seconds and keeps the non-positive half at zero', () => {
    expect(ceilingSeconds(60)).toBe(60);
    expect(ceilingSeconds(59.000001)).toBe(60);
    expect(ceilingSeconds(59)).toBe(59);
    expect(ceilingSeconds(0.0001)).toBe(1);
    expect(ceilingSeconds(0)).toBe(0);
    expect(ceilingSeconds(-1)).toBe(0);
  });

  it('formats the plain counts the other readouts show', () => {
    expect(formatNumber(0, EN)).toBe('0');
    expect(formatNumber(3, EN)).toBe('3');
    expect(formatNumber(12, EN)).toBe('12');
  });

  it('resolves the production locale list the way QUALITY-BAR section 11 states', () => {
    // Pinned as source, because a run on this host cannot see another host's
    // language list and must not pretend to. The list is explicit, the host
    // languages come first with their nullish guard, and the documented
    // fallback is appended last at every construction.
    const source = readFileSync(CLOCK_SOURCE, 'utf8');
    expect(source).toContain("const FALLBACK_LOCALE = 'en-US';");
    expect(source).toContain('return [...(navigator.languages ?? [])];');
    expect(source).toContain('[...locales, FALLBACK_LOCALE]');
    expect(source).toContain("typeof navigator === 'undefined'");
  });

  it('caches the two formatter shapes until the resolved locale list changes', () => {
    // The unique list forces a cache miss regardless of earlier assertions in
    // this file. Both public formatters then share the two constructed shapes:
    // plain counts and two clock digits.
    const original = Intl.NumberFormat;
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'NumberFormat');
    let constructions = 0;
    function CountingNumberFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ): Intl.NumberFormat {
      constructions += 1;
      return new original(locales, options);
    }
    Object.setPrototypeOf(CountingNumberFormat, original);
    Object.defineProperty(Intl, 'NumberFormat', {
      configurable: true,
      value: CountingNumberFormat,
    });
    try {
      formatNumber(3, ['fr-CA']);
      formatClock(60, ['fr-CA']);
      formatNumber(4, ['fr-CA']);
      expect(constructions).toBe(2);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(Intl, 'NumberFormat', descriptor);
      }
    }
  });

  it('rebuilds formatters when the host language list changes', () => {
    vi.stubGlobal('navigator', { languages: ['ar-EG'] });
    try {
      const arabic = formatNumber(7);
      vi.stubGlobal('navigator', { languages: ['en-US'] });
      expect(formatNumber(7)).toBe('7');
      expect(arabic).not.toBe('7');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

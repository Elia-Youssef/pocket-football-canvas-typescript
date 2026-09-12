import { describe, expect, it } from 'vitest';

import { browserDetectorArgs } from '../../scripts/mutation-check.mjs';

describe('the mutation harness browser detector', () => {
  it('caps failures only after a mutation and never in its baseline', () => {
    const baseline = browserDetectorArgs(true);
    const mutated = browserDetectorArgs(false);

    expect(baseline).not.toContain('--max-failures=1');
    expect(mutated).toContain('--max-failures=1');
    expect(baseline).not.toContain('--project=chromium');
    expect(mutated).toEqual(
      expect.arrayContaining([
        '--project=chromium',
        '--project=chromium-driven',
        '--no-deps',
        '--workers=4',
      ]),
    );
  });
});

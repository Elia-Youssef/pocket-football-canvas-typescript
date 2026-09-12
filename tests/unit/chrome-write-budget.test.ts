import { describe, expect, it } from 'vitest';

import { createMatch } from '../../src/core/match';
import { createAimControls } from '../../src/ui/components/aim-controls';
import { createHud } from '../../src/ui/components/hud';
import { installFakeDocument, writeCounts } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * Chrome synchronizes on every animation frame. A static readout must therefore
 * be a no-op, not a fresh text and attribute mutation for assistive technology
 * to observe. The changed controls prove the counters are measuring writes,
 * rather than merely returning zero for every sync.
 */
describe('B3 chrome write budget', () => {
  it('writes no HUD text or attributes for an unchanged second readout', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const readout = createMatch().readout();
      hud.update(readout);
      const before = writeCounts(hud.root as unknown as FakeElement);

      hud.update(readout);
      expect(writeCounts(hud.root as unknown as FakeElement)).toEqual(before);

      hud.update({
        ...readout,
        scoring: { ...readout.scoring, player: 1, goals: 1 },
      });
      const after = writeCounts(hud.root as unknown as FakeElement);
      expect(after.text).toBeGreaterThan(before.text);
    } finally {
      installed.restore();
    }
  });

  it('writes no aim attributes or text for an unchanged second frame', () => {
    const installed = installFakeDocument();
    try {
      const controls = createAimControls({
        onAim: () => undefined,
        onLaunch: () => undefined,
        onCancel: () => undefined,
      });
      controls.sync(0, null, false);
      const before = writeCounts(controls.root as unknown as FakeElement);

      controls.sync(0, null, false);
      expect(writeCounts(controls.root as unknown as FakeElement)).toEqual(before);

      controls.sync(
        0.5,
        { aim: { angleRad: 0, power01: 0.5 }, reach: 90, launchable: true },
        true,
      );
      const after = writeCounts(controls.root as unknown as FakeElement);
      expect(after.attributes).toBeGreaterThan(before.attributes);
      expect(after.text).toBeGreaterThan(before.text);
    } finally {
      installed.restore();
    }
  });
});

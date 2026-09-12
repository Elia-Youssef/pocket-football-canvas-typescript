import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, openGame } from './support/game';

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function labelEvidence(
  page: Page,
  selector: string,
): Promise<readonly { readonly marker: string | undefined; readonly label: string; readonly aria: string | null }[]> {
  return page.locator(selector).evaluateAll((controls) =>
    controls.map((element) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error('the visible-label check selected a non-input control');
      }
      return {
        marker: element.dataset['pf'],
        label: (element.labels?.[0]?.textContent ?? '').trim(),
        aria: element.getAttribute('aria-label'),
      };
    }),
  );
}

test.describe('B3 chrome controls', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('gives every native choice and range a visible label that supplies its name', async ({
    page,
  }) => {
    await openGame(page);

    const menuChoices = '[data-pf="panel-mode"] input';
    await expect(page.locator(menuChoices)).toHaveCount(14);
    for (const evidence of await labelEvidence(page, menuChoices)) {
      expect(evidence.marker).toBeTruthy();
      expect(evidence.label, evidence.marker).not.toBe('');
      expect(evidence.aria, evidence.marker).toBeNull();
    }

    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
    const aimRanges = '[data-pf="aim-controls"] input[type="range"]';
    await expect(page.locator(aimRanges)).toHaveCount(2);
    for (const evidence of await labelEvidence(page, aimRanges)) {
      expect(evidence.marker).toBeTruthy();
      expect(evidence.label, evidence.marker).not.toBe('');
      expect(evidence.aria, evidence.marker).toBeNull();
    }

    await at(page, 'pause').click();
    await at(page, 'pause-settings').click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    const settingChoices = '[data-pf="panel-settings"] input';
    await expect(page.locator(settingChoices)).toHaveCount(7);
    for (const evidence of await labelEvidence(page, settingChoices)) {
      expect(evidence.marker).toBeTruthy();
      expect(evidence.label, evidence.marker).not.toBe('');
      expect(evidence.aria, evidence.marker).toBeNull();
    }
  });

  test('marks a refused native choice with a painted shape as well as colour', async ({ page }) => {
    await openGame(page);

    const refused = at(page, 'target-3');
    const live = at(page, 'difficulty-casual');
    await expect(refused).toHaveAttribute('aria-disabled', 'true');
    await expect(live).toHaveAttribute('aria-disabled', 'false');

    const styles = await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-pf="target-3"]');
      const difficulty = document.querySelector<HTMLElement>('[data-pf="difficulty-casual"]');
      if (target === null || difficulty === null) {
        throw new Error('the mode controls are not mounted');
      }
      const targetLabel = target.nextElementSibling;
      const difficultyLabel = difficulty.nextElementSibling;
      return {
        refusedOutline: getComputedStyle(target).outlineStyle,
        liveOutline: getComputedStyle(difficulty).outlineStyle,
        refusedLabel: targetLabel === null ? '' : getComputedStyle(targetLabel).textDecorationLine,
        liveLabel:
          difficultyLabel === null ? '' : getComputedStyle(difficultyLabel).textDecorationLine,
      };
    });
    expect(styles.refusedOutline).toBe('dashed');
    expect(styles.liveOutline).not.toBe('dashed');
    expect(styles.refusedLabel).toContain('line-through');
    expect(styles.liveLabel).not.toContain('line-through');
  });

  test('marks every shipped chrome control and resolves native palette and font tokens', async ({ page }) => {
    await openGame(page);
    const missing = await page.locator('button, input').evaluateAll((controls) =>
      controls
        .filter(
          (control) =>
            control.getAttribute('type') !== 'hidden' && control.dataset['pf'] === undefined,
        )
        .map((control) => control.outerHTML),
    );
    expect(missing).toEqual([]);

    const choiceStyle = await at(page, 'mode-quick').evaluate((control) => {
      const style = getComputedStyle(control);
      return { accent: style.accentColor, font: style.fontFamily };
    });
    expect(choiceStyle.accent).not.toBe('auto');
    expect(choiceStyle.font).toContain('system-ui');
  });
});

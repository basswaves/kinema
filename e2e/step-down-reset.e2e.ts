/**
 * Settings → Advanced → Picture steps given up (A3-03, D6 as changed
 * 2026-11-13): what the player gave up on a graphics card is shown, and one
 * line forgets it — reached and pressed by keys alone, and saying plainly
 * what it did.
 */
import { expect, test } from '@playwright/test';
import { focusKey, focused, open, press } from './kb';

const MEMORY = JSON.stringify({ 'd3d11 · Test Card': { level: 2, percent: 4.2, clean: 1 } });

test('the steps given up are shown, and forgotten by keys', async ({ page }) => {
  await page.addInitScript((m) => localStorage.setItem('kinemaMockStepDown', m), MEMORY);
  await open(page, 'windows');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.settings-nav button', { hasText: 'Advanced' }).first().click();
  await expect.poll(() => focusKey(page)).toMatch(/^settings-nav:/);

  const section = page.locator('.settings-section', { hasText: 'Picture steps given up' });
  await expect(section).toContainText(
    'Given up on d3d11 · Test Card: HDR peak detection off (was on); chroma upscaling bilinear (was spline36).'
  );

  // By keys only: into the section, Down until the ring is on the line.
  await press(page, 'ArrowRight');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Forget the steps given up'; i++) {
    await press(page, 'ArrowDown');
  }
  expect(await focused(page)).toBe('Forget the steps given up');
  await press(page, 'Enter');

  await expect(section).toContainText(
    'Forgot what was given up on one graphics card. The next film plays with the full picture'
  );
  await expect(section).toContainText('Nothing is given up: every film gets the full picture.');
  const stored = await page.evaluate(() =>
    (window as unknown as { __kinemaMock: { settings: Map<string, string> } }).__kinemaMock.settings.get(
      'player_step_down'
    )
  );
  expect(stored).toBe('{}');

  // Pressed again: nothing left, and it says so.
  await press(page, 'Enter');
  await expect(section).toContainText('Nothing was remembered, so nothing changed.');
});

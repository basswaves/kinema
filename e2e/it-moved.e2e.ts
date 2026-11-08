/**
 * "It moved…" by keys alone (GitHub #14, review 2026-11 finding 5;
 * following.rs, MovedOffer.tsx). The mock's `kinemaMockAway=1` gives a TV
 * folder, `E:\TV`, that the scan could not reach; its files are at the picked
 * folder (`kinemaMockPick`), 58 of 60.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, open, press } from './kb';

/** Press `key` until the ring is on something starting with `text`. */
async function moveTo(page: Page, key: string, text: string, tries = 12): Promise<void> {
  for (let i = 0; i < tries && !(await focused(page))?.startsWith(text); i++) await press(page, key);
  expect(await focused(page)).toMatch(new RegExp(`^${text.replace(/[()\\.…]/g, '\\$&')}`));
}

/** Home → Settings, by keys: the ring on Add movies folder, in Library's Folders. */
async function settingsFolders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockAway', '1');
    localStorage.setItem('kinemaMockPick', 'F:\\TV');
  });
  await open(page, 'windows');
  await moveTo(page, 'ArrowUp', 'Settings', 4).catch(() => undefined);
  await moveTo(page, 'ArrowRight', 'Settings');
  await press(page, 'Enter');
  await expect(page.locator('.settings')).toBeVisible();
  // Down into the section list, on Library; Right into its folders.
  await moveTo(page, 'ArrowDown', 'Library', 4);
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
}

test('a folder not found: It moved…, 58 of 60 found, Move, and it is found again', async ({ page }) => {
  await settingsFolders(page);
  const row = page.locator('.settings-roots li', { hasText: 'E:\\TV' });
  await expect(row.locator('.root-missing')).toHaveText('Not found');

  await moveTo(page, 'ArrowUp', 'It moved…');
  await press(page, 'Enter');
  const offer = page.locator('.moved-offer');
  await expect(offer).toContainText('E:\\TV is now at F:\\TV? 58 of 60 files found there.');
  await expect.poll(() => focused(page)).toBe('Move');

  await press(page, 'Enter');
  await expect(offer).toHaveCount(0);
  await expect(page.getByText('Moved to F:\\TV: 60 files, with what you watched and decided.')).toBeVisible();
  await expect(page.locator('.settings-roots li', { hasText: 'F:\\TV' })).toBeVisible();
  await expect(page.locator('.root-missing')).toHaveCount(0);
});

test('a folder not found: Cancel leaves it as it was', async ({ page }) => {
  await settingsFolders(page);
  await moveTo(page, 'ArrowUp', 'It moved…');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Move');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Cancel');
  await press(page, 'Enter');
  await expect(page.locator('.moved-offer')).toHaveCount(0);
  await expect(page.locator('.root-missing')).toHaveText('Not found');
});

test('adding the place a folder not found moved to asks first: Move it, or add as new', async ({ page }) => {
  await settingsFolders(page);
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Add TV folder');
  await press(page, 'Enter');
  const offer = page.locator('.moved-offer');
  await expect(offer).toContainText('This looks like E:\\TV, moved here: 58 of 60 files found there. Move it, or add as new?');
  await expect.poll(() => focused(page)).toBe('Move it');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Add as new');
  await press(page, 'Enter');
  await expect(offer).toHaveCount(0);
  await expect(page.getByText('Added F:\\TV. Scan to pick up its files.')).toBeVisible();
  await expect(page.locator('.root-missing')).toHaveText('Not found');
});

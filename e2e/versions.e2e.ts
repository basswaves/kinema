/**
 * Versions: the mock's film here twice (kinemaMockVersions) — the 4K Dolby
 * Vision remux and a 1080p encode. Keyboard first, then the mouse.
 * Against `dev:mock`; see kb.ts and keyboard-*.e2e.ts for the conventions.
 */
import { expect, test, type Page } from '@playwright/test';

async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('.focused')?.textContent?.trim());
}

function playing(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __fakeMpv: { path: string } }).__fakeMpv.path);
}

async function open(page: Page, versions = true): Promise<void> {
  await page.addInitScript((on) => {
    localStorage.removeItem('kinemaMockSystem');
    if (on) localStorage.setItem('kinemaMockVersions', '1');
    else localStorage.removeItem('kinemaMockVersions');
  }, versions);
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

/** From Home to the film's page by keyboard; the ring on Play. */
async function filmPage(page: Page): Promise<void> {
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play');
}

/** Press `key` until the ring's text contains `text` (at most `max` presses). */
async function until(page: Page, key: string, text: string, max = 8): Promise<void> {
  for (let i = 0; i < max && !((await focused(page)) ?? '').includes(text); i++) await press(page, key);
  expect(await focused(page)).toContain(text);
}

test('Version by keyboard: the best fit first, another picked, Play uses it, remembered', async ({ page }) => {
  await open(page);
  await filmPage(page);
  // The mock screen is 4K and can show HDR: the remux fits it best.
  const version = page.getByRole('button', { name: /^Version:/ });
  await expect(version).toContainText('4K UHD · Dolby Vision');

  await until(page, 'ArrowRight', 'Version');
  await press(page, 'Enter');
  const dialog = page.getByRole('dialog', { name: 'Version' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^✓ 4K UHD/);
  await expect(dialog.getByRole('button')).toHaveCount(2);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toMatch(/^1080p/);
  await press(page, 'Enter');
  await expect(dialog).toBeHidden();
  // The ring is back on the button, which now names the 1080p copy.
  await expect.poll(() => focused(page)).toMatch(/^Version · 1080p/);

  await until(page, 'ArrowLeft', '▶ Play');
  await press(page, 'Enter');
  await expect.poll(() => playing(page)).toContain('1080p');

  // Back to the page: the choice is kept.
  await press(page, 'Escape');
  await page.waitForTimeout(400);
  if (await page.locator('.player').count()) await press(page, 'Escape');
  await expect(page.locator('.detail')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Version:/ })).toContainText('1080p');
});

test('Back closes the Version list and leaves the choice alone', async ({ page }) => {
  await open(page);
  await filmPage(page);
  await until(page, 'ArrowRight', 'Version');
  await press(page, 'Enter');
  await expect(page.getByRole('dialog', { name: 'Version' })).toBeVisible();
  await press(page, 'ArrowDown');
  await press(page, 'Escape');
  await expect(page.getByRole('dialog', { name: 'Version' })).toBeHidden();
  await expect(page.locator('.detail')).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^Version · 4K UHD/);
});

test('Version by mouse, and the list in Settings → Library', async ({ page }) => {
  await open(page);
  await filmPage(page);
  await page.getByRole('button', { name: /^Version:/ }).click();
  await page.getByRole('dialog', { name: 'Version' }).getByRole('button', { name: /^1080p/ }).click();
  await expect(page.getByRole('button', { name: /^Version:/ })).toContainText('1080p');
  await page.getByRole('button', { name: '▶ Play' }).click();
  await expect.poll(() => playing(page)).toContain('1080p');

  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Here more than once' })).toBeVisible();
  await page.getByRole('button', { name: 'Show the list' }).click();
  await expect(page.locator('.duplicates')).toContainText('Example Film (2017)');
  await expect(page.locator('.duplicates')).toContainText('2 versions');
  await expect(page.locator('.duplicates')).toContainText('1080p · 9.0 GB');
});

test('a film in one file has no Version button and Settings no list', async ({ page }) => {
  await open(page, false);
  await filmPage(page);
  await expect(page.getByRole('button', { name: /^Version:/ })).toHaveCount(0);
});

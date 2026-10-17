/**
 * Trakt's resume point, by keyboard alone: connect Trakt in Settings →
 * Accounts, see the "Continue where you stopped on another device" row, and
 * find the film's page offering to resume (trakt_resume.rs). The mock hands
 * Example Film a 40 % point once Trakt is connected.
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

const ROW = 'Continue where you stopped on another device';

/** Home → Settings → Accounts → Connect Trakt → Connected; the ring on the row. */
async function connectTrakt(page: Page): Promise<void> {
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 8 && (await focused(page)) !== 'Accounts'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('SIMKL');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 20 && (await focused(page)) !== 'Connect Trakt'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Connect Trakt');
  await press(page, 'Enter');
  await expect(page.getByText('Connected as example-trakt')).toBeVisible({ timeout: 20_000 });
}

function rowOf(page: Page) {
  return page.locator('.choice-row', { has: page.locator('.choice-label', { hasText: ROW }) });
}

/** Up from Disconnect until the ring is on a choice of the Trakt row. */
async function toRow(page: Page): Promise<void> {
  const onRow = () =>
    page.evaluate(
      (label) => !!document.querySelector('.focused')?.closest(`[aria-label="${label}"]`),
      ROW
    );
  // Connecting leaves the ring on Disconnect, just under the row: one Up.
  await expect.poll(() => focused(page)).toBe('Disconnect');
  await press(page, 'ArrowUp');
  expect(await onRow()).toBe(true);
}

/** Leave Settings and open Example Film's page from Home. */
async function openFilm(page: Page): Promise<void> {
  await press(page, 'ArrowLeft', 2);
  await press(page, 'ArrowUp', 6);
  for (let i = 0; i < 8 && (await focused(page)) !== 'Home'; i++) await press(page, 'ArrowLeft');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  expect(await focused(page)).toMatch(/^Example Film/);
  await press(page, 'Enter');
  await expect(page.locator('.detail')).toBeVisible();
}

test('Trakt connected: the film resumes at the share another device stopped at', async ({ page }) => {
  await connectTrakt(page);
  await toRow(page);
  const row = rowOf(page);
  await expect(row.locator('.choice')).toHaveText(['✓On', 'Off']);
  await expect(row.locator('.choice.chosen')).toHaveText('✓On');

  await openFilm(page);
  await expect(page.getByRole('button', { name: '▶ Resume at 40 %' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play from start' })).toBeVisible();
});

test('Trakt connected, resume switched Off: the film just plays', async ({ page }) => {
  await connectTrakt(page);
  await toRow(page);
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Off');
  await press(page, 'Enter');
  await expect(rowOf(page).locator('.choice.chosen')).toHaveText('✓Off');

  await openFilm(page);
  await expect(page.getByRole('button', { name: '▶ Play' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume/ })).toHaveCount(0);
});

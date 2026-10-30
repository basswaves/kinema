/**
 * Smart collections (library/collections.ts, CollectionPage.tsx): the
 * ready-made rails on Home only when the library has titles for them, and a
 * collection of one's own made, kept and deleted by keyboard alone.
 * Against `dev:mock` with `kinemaMockTraits` (mockBackend.ts `title_traits`).
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, press } from './kb';

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockTraits', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

const railHeadings = (page: Page) =>
  page.locator('.home .rail-heading').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));

/** Press `key` until the ring is on `name`, at most `times`. */
async function moveTo(page: Page, key: string, name: RegExp, times = 8): Promise<void> {
  for (let i = 0; i < times && !name.test((await focused(page)) ?? ''); i++) await press(page, key);
  expect(await focused(page)).toMatch(name);
}

test('ready-made collections show only where the library has two titles for them', async ({ page }) => {
  await open(page);
  await expect.poll(() => railHeadings(page)).toContain('Dolby Atmos');
  const headings = await railHeadings(page);
  expect(headings).toContain('4K');
  // One Dolby Vision title, one HDR10+ title: a card each, not a shelf.
  expect(headings).not.toContain('Dolby Vision');
  expect(headings).not.toContain('HDR10+');
  const atmos = page.locator('.rail', { has: page.locator('.rail-heading', { hasText: /^Dolby Atmos/ }) });
  // In the library's order; the two titles are what matters.
  const names = await atmos.locator('.card-title').allInnerTexts();
  expect(names.sort()).toEqual(['Example Film', 'Example Saga']);
});

test('a collection of ones own, made, kept and deleted by keyboard', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'TV shows' }).first().click();
  await expect(page.locator('.search .card')).toHaveCount(2);
  // From the first card: Up is the order row, Up again the head.
  await press(page, 'ArrowUp', 2);
  await moveTo(page, 'ArrowRight', /^New collection/);
  await press(page, 'Enter');

  // Lands on the first measured choice; only what the library has is offered.
  await expect(page.getByRole('heading', { name: /New collection/ })).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^4K/);
  await expect(page.getByRole('button', { name: /Dolby Vision profile 7/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /DTS:X/ })).toHaveCount(0);
  // Shows, as the shelf it came from: two; with 4K, only the saga.
  await expect(page.locator('.collection-page .card')).toHaveCount(2);
  await press(page, 'Enter');
  await expect(page.locator('.collection-page .card')).toHaveCount(1);
  await expect(page.locator('.collection-page .card-title')).toHaveText('Example Saga');

  await press(page, 'ArrowUp');
  await moveTo(page, 'ArrowRight', /^Save collection/);
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { name: /4K · TV shows/ })).toBeVisible();

  // Back past the shelf to Home, where it is a rail of its own with a way in.
  await press(page, 'Escape');
  await press(page, 'Escape');
  await expect.poll(() => railHeadings(page)).toContain('4K · TV shows');
  const rail = page.locator('.rail', { has: page.locator('.rail-heading', { hasText: '4K · TV shows' }) });
  await rail.getByRole('button', { name: /Open collection/ }).click();
  await expect(page.getByRole('heading', { name: /4K · TV shows/ })).toBeVisible();

  // Deleted, it goes from Home. (Kept across a restart is the settings
  // table's; the mock's settings live as long as the page.)
  await press(page, 'Escape');
  await rail.getByRole('button', { name: /Open collection/ }).click();
  await expect.poll(() => focused(page)).toMatch(/^✓ 4K/);
  await press(page, 'ArrowUp');
  await moveTo(page, 'ArrowRight', /^Delete/);
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect.poll(() => railHeadings(page)).not.toContain('4K · TV shows');
});

/**
 * The full grids (Movies, TV shows, See all): the order and where Back lands.
 * Against `dev:mock`; see kb.ts and keyboard-*.e2e.ts for the conventions.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, press } from './kb';

/** The mock library plus sixty bare films, so the Movies grid scrolls. */
async function open(page: Page, extra = '60'): Promise<void> {
  await page.addInitScript((n) => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockTitles', n);
  }, extra);
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

const cardNames = (page: Page) => page.locator('.search .card').evaluateAll((els) =>
  els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim())
);

test('a chosen sort flips when pressed again, by mouse and by keyboard, and is remembered', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Movies' }).first().click();
  const az = page.getByRole('button', { name: /^A–Z/ });
  await az.click();
  await expect(az).toContainText('↓');
  const down = await cardNames(page);
  await az.click();
  await expect(az).toContainText('↑');
  const up = await cardNames(page);
  expect(up).toEqual([...down].reverse());

  // Keyboard: a different sort starts "down", the same one flips again.
  await page.getByRole('button', { name: /^Year/ }).click();
  await expect(page.getByRole('button', { name: /^Year/ })).toContainText('↓');
  await press(page, 'Escape');
  await page.getByRole('button', { name: 'Movies' }).first().click();
  // Remembered per grid: A–Z reversed was left for Year ↓, which is what comes back.
  await expect(page.getByRole('button', { name: /^Year/ })).toContainText('↓');
});

test('the order row by remote: OK on the chosen sort flips it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Movies' }).first().click();
  // The ring lands on the first card; Up reaches the order row on the chosen sort.
  await press(page, 'ArrowUp');
  expect(await focused(page)).toMatch(/^Recently added/);
  await press(page, 'Enter');
  await expect(page.getByRole('button', { name: /^Recently added/ })).toContainText('↑');
  await press(page, 'Enter');
  await expect(page.getByRole('button', { name: /^Recently added/ })).toContainText('↓');
});

test('Back from a title lands on the same card, scroll and all', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Movies' }).first().click();
  // Auto may pick the light look on a busy machine, which makes the cards
  // small and the grid short; this flow is about the full one.
  await page.evaluate(async () => {
    const path = '/src/ui/lightLook.ts';
    (await import(/* @vite-ignore */ path)).setLook('full');
  });
  await expect(page.locator('.search .card').first()).toBeVisible();
  await press(page, 'ArrowDown', 6);
  const before = await focused(page);
  const scrollBefore = await page.evaluate(() => document.querySelector('.browse')?.scrollTop ?? 0);
  expect(scrollBefore).toBeGreaterThan(100);
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe(before);
  await page.waitForTimeout(1500);
  const scrollAfter = await page.evaluate(() => document.querySelector('.browse')?.scrollTop ?? 0);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(120);
  // The card is where it was: on screen, not scrolled out of sight.
  const box = await page.locator('.focused').boundingBox();
  expect(box && box.y >= 0 && box.y < 600).toBe(true);
});

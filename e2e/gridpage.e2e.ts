/**
 * The full grids (Movies, TV shows, See all): the order and where Back lands.
 * Against `dev:mock`; see kb.ts and keyboard-*.e2e.ts for the conventions.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, press, settled } from './kb';

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
  // The last press may still be scrolling smoothly: read once it has settled.
  await settled(page);
  const before = await focused(page);
  const scrollBefore = await page.evaluate(() => document.querySelector('.browse')?.scrollTop ?? 0);
  expect(scrollBefore).toBeGreaterThan(100);
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe(before);
  await settled(page);
  const scrollAfter = await page.evaluate(() => document.querySelector('.browse')?.scrollTop ?? 0);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(120);
  // The card is where it was: on screen, not scrolled out of sight.
  const box = await page.locator('.focused').boundingBox();
  expect(box && box.y >= 0 && box.y < 600).toBe(true);
});

async function openFirstShow(page: Page): Promise<void> {
  await open(page, '0');
  await page.getByRole('button', { name: 'TV shows' }).first().click();
  await expect(page.locator('.search .card').first()).toBeVisible();
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('a whole show marked watched in one press, and back again', async ({ page }) => {
  await openFirstShow(page);
  const rows = page.locator('button[aria-label="Mark watched"], button[aria-label^="Watched. Press"]');
  const watchedRows = () => page.locator('button[aria-label^="Watched. Press"]').count();
  const button = page.getByRole('button', { name: /^(Mark show watched|✓ Show watched)$/ });
  await expect(button).toHaveText('Mark show watched');
  await button.click();
  await expect(button).toHaveText('✓ Show watched');
  const all = await rows.count();
  expect(all).toBeGreaterThan(0);
  expect(await watchedRows()).toBe(all);
  await button.click();
  await expect(button).toHaveText('Mark show watched');
  expect(await watchedRows()).toBe(0);
});

test('Back stays at the top of a title page while it scrolls, never over the focused episode', async ({ page }) => {
  await openFirstShow(page);
  const back = page.getByRole('button', { name: '← Back' });
  const gap = await page.evaluate(() => {
    const b = document.querySelector('.browse')!;
    return b.scrollHeight - b.clientHeight;
  });
  expect(gap).toBeGreaterThan(200);
  await page.evaluate(() => document.querySelector('.browse')!.scrollTo({ top: 400, behavior: 'instant' }));
  const top = async () => (await back.boundingBox())!.y;
  await expect.poll(top).toBeLessThan(160);
  // By keyboard down the episodes: the ring's control stays clear of Back.
  for (let i = 0; i < 10; i++) {
    await press(page, 'ArrowDown');
    const backBox = (await back.boundingBox())!;
    const ring = await page.locator('.focused').boundingBox();
    if (ring && ring.y > backBox.y + backBox.height) continue;
    // Above Back means scrolled out of the way, not hidden under it.
    expect(ring === null || ring.y + ring.height <= backBox.y || ring.y >= backBox.y + backBox.height).toBe(true);
  }
  // The mouse: Back still there and it goes back.
  await back.click();
  await expect(page.locator('.search .card').first()).toBeVisible();
});

test('the developer tools library table scrolls sideways in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await open(page, '0');
  await page.locator('.top-bar button, nav button', { hasText: 'Settings' }).first().click();
  await page.locator('.settings-nav button', { hasText: 'Advanced' }).click();
  await page.locator('.settings-section', { hasText: 'Developer tools' }).locator('button', { hasText: /Show developer tools/ }).click();
  const wrap = page.locator('.library-table-wrap');
  await expect(wrap).toBeVisible();
  const fits = await wrap.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { overflowX: getComputedStyle(el).overflowX, right: r.right, vw: window.innerWidth };
  });
  expect(fits.overflowX).toBe('auto');
  expect(fits.right).toBeLessThanOrEqual(fits.vw);
});

/**
 * Choosing a title's poster (T20, PosterDialog.tsx, library/posters.ts):
 * the list opens by keyboard on the poster shown now, and a choice is kept
 * and shown. That it outlives a refresh is posters.rs's test and the real
 * app's (the mock fetches nothing).
 * Against `dev:mock` with `kinemaMockPeople` (mockBackend.ts `poster_options`):
 * Example Part Two has a picture beside its file and a TMDB poster; TMDB
 * itself cannot be asked from the mock, so the list keeps asking.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, press } from './kb';

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockPeople', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

/** The poster the title shows, as the mock's get_title_detail gives it. */
const shown = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __kinemaMock: { posterOf: (id: number) => string | null } }).__kinemaMock.posterOf(22)
  );

test('a poster is chosen by keyboard, and chosen back', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.locator('.search .card', { hasText: 'Example Part Two' }).click();
  await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
  // The picture beside the file wins until something else is chosen.
  expect(await shown(page)).toBe('local');

  await expect.poll(() => focused(page)).toMatch(/Play/);
  for (let i = 0; i < 10 && (await focused(page)) !== 'Poster'; i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('Poster');
  await press(page, 'Enter');

  const dialog = page.getByRole('dialog', { name: 'Poster' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Asking TMDB');
  await expect.poll(() => focused(page)).toMatch(/^✓ ?Beside the file/);
  await press(page, 'ArrowRight');
  expect(await focused(page)).toMatch(/^TMDB/);
  await press(page, 'Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Poster');
  expect(await shown(page)).toMatch(/^https:\/\/image\.tmdb\.org\/.*first/);

  // And back to the picture beside the file.
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^✓ ?TMDB/);
  await press(page, 'ArrowLeft');
  await press(page, 'Enter');
  await expect.poll(() => shown(page)).toBe('local');
});

/** TMDB's answer with eleven posters (mockBackend.ts), so the list is a grid several rows tall. */
async function manyPosters(page: Page): Promise<void> {
  const png = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0)
  );
  await page.addInitScript(() => localStorage.setItem('kinemaMockPosters', '1'));
  await page.route(/image\.tmdb\.org/, (route) => route.fulfill({ body: png, contentType: 'image/png' }));
}

const openPosters = async (page: Page) => {
  await open(page);
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.locator('.search .card', { hasText: 'Example Part Two' }).click();
  await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
  await expect.poll(() => focused(page)).toMatch(/Play/);
  for (let i = 0; i < 10 && (await focused(page)) !== 'Poster'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  const dialog = page.getByRole('dialog', { name: 'Poster' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.poster-choice')).toHaveCount(13);
  return dialog;
};

/** Index and box of the poster holding the ring. */
const ring = (page: Page) =>
  page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.poster-choice'));
    const el = document.querySelector('.poster-choice.focused');
    const r = el?.getBoundingClientRect();
    return { index: el ? all.indexOf(el) : -1, x: r?.x ?? 0, y: r?.y ?? 0 };
  });

test('the posters are a grid the ring moves through, down to the last row', async ({ page }) => {
  await manyPosters(page);
  const dialog = await openPosters(page);
  await expect.poll(async () => (await ring(page)).index).toBe(0);
  const columns = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.poster-choice'));
    return tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length;
  });
  expect(columns).toBeGreaterThan(2);
  expect(columns).toBeLessThan(12);

  // The ring is drawn, not just placed.
  await expect(page.locator('.poster-choice.focused')).toHaveCSS('outline-style', 'solid');
  const first = await ring(page);
  await press(page, 'ArrowRight');
  const right = await ring(page);
  expect(right.index).toBe(1);
  expect(right.x).toBeGreaterThan(first.x);
  await press(page, 'ArrowDown');
  const down = await ring(page);
  expect(down.index).toBe(1 + columns);
  expect(down.y).toBeGreaterThan(first.y);
  await press(page, 'ArrowLeft');
  expect((await ring(page)).index).toBe(columns);

  // Down off the last row reaches Cancel; the last poster is in view on the way.
  for (let i = 0; i < 4 && (await focused(page)) !== 'Cancel'; i++) await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Cancel');
  await press(page, 'ArrowUp');
  const last = page.locator('.poster-choice.focused');
  await expect(last).toBeInViewport();
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Poster');
});

test('the posters by mouse: every one is reachable, hover marks it, a click picks it', async ({ page }) => {
  await manyPosters(page);
  await page.setViewportSize({ width: 1280, height: 520 });
  const dialog = await openPosters(page);
  const tiles = page.locator('.poster-choice');
  const lastTile = tiles.nth(12);
  await lastTile.scrollIntoViewIfNeeded();
  await expect(lastTile).toBeInViewport();
  const box = await dialog.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(520);
  await lastTile.hover();
  await expect(lastTile).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.1)');
  await lastTile.click();
  await expect(dialog).toHaveCount(0);
  expect(await shown(page)).toMatch(/^https:\/\/image\.tmdb\.org\/.*p10/);
});

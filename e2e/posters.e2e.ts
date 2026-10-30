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

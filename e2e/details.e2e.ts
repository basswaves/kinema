/**
 * A title's page beyond the overview (details page round 1, TitleDetail.tsx,
 * aboutTitle.ts): "Ends at", the credits line, a show's state, the films of a
 * collection with Play for the series, and the file's details — reached by
 * keyboard, and absent for a title TMDB did not describe.
 * Against `dev:mock` with `kinemaMockPeople` (mockBackend.ts `ABOUT`).
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

/** A title's page from the Movies or TV shows shelf. */
async function openTitle(page: Page, shelf: 'Movies' | 'TV shows', name: string): Promise<void> {
  await page.getByRole('button', { name: shelf }).first().click();
  await page.locator('.search .card', { hasText: name }).click();
  await expect(page.locator('.detail h1')).toHaveText(name);
  await expect.poll(() => focused(page)).toMatch(/Play/);
}

/** Press `key` until the ring is on `name`, at most `times`. */
async function moveTo(page: Page, key: string, name: RegExp, times = 8): Promise<void> {
  for (let i = 0; i < times && !name.test((await focused(page)) ?? ''); i++) await press(page, key);
  expect(await focused(page)).toMatch(name);
}

test('a film says who made it, when it ends, and the rest of its collection', async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  await expect(page.locator('.detail-meta')).toContainText(/Ends at \d/);
  await expect(page.locator('.detail-crew')).toHaveText(['Directed by Dee Rector']);

  // Down from the buttons: the collection, oldest first, Play for the first
  // one not watched yet.
  await expect(page.locator('.detail-collection h2')).toHaveText('Part of Example Collection');
  await expect(page.locator('.detail-collection .card-title')).toHaveText([
    'Example Part One',
    'Example Part Two',
  ]);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toMatch(/^▶ Play the series from Example Part One/);
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.detail h1')).toHaveText('Example Part One');
  await expect(page.locator('.detail-crew')).toHaveText([
    'Directed by Dee Rector',
    'Written by Wren Writer and Ira Author',
  ]);

  // Back to the film it came from.
  await press(page, 'Escape');
  await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
});

test('the file details open by keyboard and can be read', async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  await moveTo(page, 'ArrowDown', /File details/);
  await press(page, 'Enter');
  const rows = page.locator('.file-info-row dt');
  await expect(rows.first()).toHaveText('File');
  await expect(page.locator('.file-info-list')).toContainText('Example.Part.Two.2014.1080p.mkv');
  await expect(page.locator('.file-info-list')).toHaveCSS('user-select', 'text');
});

test('a show says it has ended; a Wikidata film says nothing it does not know', async ({ page }) => {
  await open(page);
  await openTitle(page, 'TV shows', 'Example Show');
  await expect(page.locator('.detail-crew')).toHaveText(['Created by Ida Creator', 'Ended']);

  await press(page, 'Escape');
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.locator('.search .card', { hasText: 'Example Film' }).click();
  await expect(page.locator('.detail h1')).toHaveText('Example Film');
  await expect(page.locator('.detail-crew')).toHaveCount(0);
  await expect(page.locator('.detail-collection')).toHaveCount(0);
});

test('a cast member opens their page, with every title of the library they are in', async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  await moveTo(page, 'ArrowDown', /Pat Fixture/);
  await press(page, 'Enter');
  await expect(page.locator('.person-page h1')).toHaveText('Pat Fixture');
  // Newest first; the show as well as both films, by TMDB's id.
  await expect(page.locator('.person-page .card-title')).toHaveText([
    'Example Part Two',
    'Example Part One',
    'Example Show',
  ]);
  await expect.poll(() => focused(page)).toMatch(/Example Part Two/);
  await press(page, 'ArrowRight', 2);
  await press(page, 'Enter');
  await expect(page.locator('.detail h1')).toHaveText('Example Show');
  // Back, and Back again, to the film the actor was opened from.
  await press(page, 'Escape');
  await expect(page.locator('.person-page h1')).toHaveText('Pat Fixture');
  await press(page, 'Escape');
  await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
});

test('a cast member TMDB gave no id for is a name, not a way in', async ({ page }) => {
  await open(page);
  await openTitle(page, 'TV shows', 'Example Show');
  await expect(page.locator('.cast-member')).toHaveCount(2);
  await expect(page.locator('button.cast-member')).toHaveCount(1);
  await expect(page.locator('button.cast-member')).toContainText('Pat Fixture');
});

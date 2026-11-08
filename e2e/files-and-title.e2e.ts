/**
 * Keyboard flows for GitHub #14: Files and title on a show's page, and
 * Needs attention's `Link as…` (FilesAndTitle.tsx, PlaceChooser.tsx). Keys
 * only, in each engine `playwright.config.ts` lists; the mouse is never
 * touched (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { press, focused, open } from './kb';

/** Press `key` until the ring is on a control whose text matches. */
async function until(page: Page, key: string, want: RegExp, most = 12): Promise<void> {
  for (let i = 0; i < most && !want.test((await focused(page)) ?? ''); i++) await press(page, key);
  await expect.poll(() => focused(page)).toMatch(want);
}

async function openSaga(page: Page): Promise<void> {
  await open(page, 'windows');
  await until(page, 'ArrowUp', /^(Home|Settings)/, 8);
  await until(page, 'ArrowRight', /^TV shows$/, 4);
  await press(page, 'Enter');
  await until(page, 'ArrowDown', /Example (Show|Saga)/, 4);
  await until(page, 'ArrowRight', /Example Saga/, 6);
  await press(page, 'Enter');
  await expect(page.locator('h1, .detail-title').filter({ hasText: 'Example Saga' }).first()).toBeVisible();
}

test('Files and title: a season folder moves to Specials, then is unlinked alone, by keys', async ({ page }) => {
  await openSaga(page);
  // The last button of the row, renamed from "Wrong title?".
  await until(page, 'ArrowDown', /^(▶ |Files and title)/, 4);
  await until(page, 'ArrowRight', /^Files and title$/, 12);
  await press(page, 'Enter');
  const dialog = page.locator('[role="dialog"][aria-label="Files and title"]');
  await expect(dialog).toContainText('4 files are linked to “Example Saga”');
  // One row per folder and season; it opens on the first.
  await expect(dialog.locator('.files-row-head')).toHaveCount(2);
  await expect.poll(() => focused(page)).toMatch(/^Season 1/);

  // Season 2's folder: Move to another season… → Specials → Move 2 files.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toMatch(/^Season 2 2 files · Season 2/);
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Move to another season…');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('As the names say: Season 2');
  await until(page, 'ArrowRight', /^Specials$/, 3);
  await press(page, 'Enter');
  await expect(dialog.locator('.place-row').first()).toContainText('→Specials 1');
  await until(page, 'ArrowDown', /^Move 2 files$/, 8);
  await press(page, 'Enter');
  await expect(dialog).toContainText('Moved 2 files to Specials. File names are unchanged.');
  await expect.poll(() => focused(page)).toMatch(/^Season 2.*Specials \(placed by hand\)/);

  // Closed: the ring is back on the button, and the page has a Specials season.
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Files and title');
  await expect(page.locator('button', { hasText: /^Specials/ }).first()).toBeVisible();

  // Again: the placed row offers the names back; unlink takes it alone.
  await press(page, 'Enter');
  await until(page, 'ArrowDown', /Specials \(placed by hand\)/, 3);
  await press(page, 'Enter');
  await expect(dialog.getByText('Back to what the names say')).toBeVisible();
  await until(page, 'ArrowRight', /^Unlink, decide later$/, 4);
  await press(page, 'Enter');
  await expect(dialog).toContainText('the rest of “Example Saga” is as it was');
  await expect(dialog.locator('.files-row-head')).toHaveCount(1);
  // Back closes it.
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
});

test('Files and title: make a folder its own title, by keys', async ({ page }) => {
  await openSaga(page);
  await until(page, 'ArrowDown', /^(▶ |Files and title)/, 4);
  await until(page, 'ArrowRight', /^Files and title$/, 12);
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Season 1/);
  await press(page, 'Enter');
  await until(page, 'ArrowRight', /^Make it its own title…$/, 3);
  await press(page, 'Enter');
  // The name box, filled in from the files.
  await expect.poll(() => page.evaluate(() => document.querySelector('.focused')?.getAttribute('placeholder'))).toBe('Name');
  await expect(page.locator('.fixmatch-local .fixmatch-input').first()).toHaveValue('Example Saga');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Saga Prequel');
  await press(page, 'Enter');
  // Its own page.
  await expect(page.locator('h1, .detail-title').filter({ hasText: 'Saga Prequel' }).first()).toBeVisible();
});

test('Needs attention: Link as… puts a show’s files on Specials, and a stacking link asks first', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockReview', 'items');
    localStorage.setItem('kinemaMockTmdb', '1');
    localStorage.setItem('kinemaMockReviewStack', '1');
  });
  await open(page, 'windows');
  await until(page, 'ArrowDown', /^Review$/, 4);
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);
  await until(page, 'ArrowDown', /Sample Series/, 3);
  await press(page, 'Enter');
  const placeholder = () =>
    page.evaluate(() => document.querySelector('.focused')?.getAttribute('placeholder'));
  for (let i = 0; i < 4 && (await placeholder()) !== 'Search for the right title…'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.getByText('1 result, searched as a TV series')).toBeVisible();
  await until(page, 'ArrowDown', /^Link 2 files$/, 6);

  // A plain link would put S02E01-02 on top of the show's own: it asks.
  await press(page, 'Enter');
  const dialog = page.locator('[role="dialog"][aria-label="Where do these go?"]');
  await expect(dialog).toContainText('Season 2 already has these 2 episodes.');
  await expect.poll(() => focused(page)).toBe('Choose where they go');
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);

  // Link as…: beside Link, a row of its own.
  await expect.poll(() => focused(page)).toBe('Link 2 files');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Link as…');
  await press(page, 'Enter');
  await expect(dialog).toContainText('Example Saga: where do these 2 files go?');
  await expect.poll(() => focused(page)).toBe('As the names say: Season 2');
  await expect(dialog).toContainText('already here: this becomes a second copy');
  await until(page, 'ArrowRight', /^Specials$/, 4);
  await press(page, 'Enter');
  await expect(dialog.locator('.place-row').first()).toContainText('Specials 1 · Behind the scenes');
  await expect(dialog).not.toContainText('second copy');

  // A row's own episode menu, opened by its row.
  await until(page, 'ArrowDown', /^Sample Series S02E02/, 6);
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Specials \d/);
  // Back from the picker goes to the list, not out of the dialog.
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(1);
  await expect.poll(() => focused(page)).toMatch(/^Sample Series S02E02/);

  await until(page, 'ArrowDown', /^Link 2 files$/, 4);
  await press(page, 'Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Linked 2 files to “Example Saga”, Specials. File names are unchanged.')).toBeVisible();
  const linked = await page.evaluate(
    () => (window as unknown as { __kinemaLastMatch: { placements: { season: number; episode: number }[] } }).__kinemaLastMatch
  );
  expect(linked.placements.map((p) => [p.season, p.episode])).toEqual([
    [0, 1],
    [0, 2],
  ]);
});

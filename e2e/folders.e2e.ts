/**
 * Library → Folders by keyboard alone (FoldersPage.tsx): a drive, a folder,
 * a video played as a video of its own and Back to it; a library episode
 * played as that episode; "Add this folder to the library" as Videos; a typed
 * network address kept for next time. The mock's drives are in
 * mockBackend.ts `mockDrives` and `folder_places`.
 */
import { expect, test, type Page } from '@playwright/test';

async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(200);
  }
}

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('.focused')?.textContent?.trim());
}

/** Down (or Up) until the ring is on something starting with `text`. */
async function moveTo(page: Page, key: 'ArrowDown' | 'ArrowUp' | 'ArrowRight', text: string) {
  for (let i = 0; i < 12 && !(await focused(page))?.startsWith(text); i++) await press(page, key);
  expect(await focused(page)).toMatch(new RegExp(`^${text.replace(/[()\\]/g, '\\$&')}`));
}

/** Home → Library → Folders: the ring on the first place. */
async function openFolders(page: Page): Promise<void> {
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  await moveTo(page, 'ArrowRight', 'Library');
  await press(page, 'Enter');
  await expect(page.locator('.library-page')).toBeVisible();
  await moveTo(page, 'ArrowRight', 'Folders');
  await press(page, 'Enter');
  await expect(page.locator('.folders-page')).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^Videos/);
}

/** Back out of the player: the first Back may only take the controls down. */
async function backOut(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      if (await page.locator('.folders-page').isVisible()) return true;
      await press(page, 'Escape');
      return page.locator('.folders-page').isVisible();
    })
    .toBe(true);
}

test('a video in a folder plays, and Back returns to it in its folder', async ({ page }) => {
  await openFolders(page);
  await moveTo(page, 'ArrowDown', 'Media (D:)');
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('Media (D:)');
  await expect.poll(() => focused(page)).toMatch(/^Concerts/);
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('Media (D:) › Concerts');
  await expect(page.getByText('2 videos here')).toBeVisible();
  await moveTo(page, 'ArrowDown', 'Live 2021.mkv');
  await press(page, 'Enter');

  await expect(page.locator('.player')).toBeAttached();
  await expect(page.locator('.player-label')).toContainText('Live 2021');
  await backOut(page);
  await expect(page.locator('.folder-where')).toHaveText('Media (D:) › Concerts');
  await expect.poll(() => focused(page)).toMatch(/^Live 2021\.mkv/);

  // Back climbs a level at a time, the ring on what it came out of, then
  // leaves for the Library page.
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toMatch(/^Concerts/);
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toMatch(/^Media \(D:\)/);
  await press(page, 'Escape');
  await expect(page.locator('.library-page')).toBeVisible();
});

test('a file a library folder holds plays as that episode', async ({ page }) => {
  await openFolders(page);
  await moveTo(page, 'ArrowDown', 'fixture');
  await press(page, 'Enter');
  await expect(page.getByText('In the library: fixture (TV shows)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add this folder to the library' })).toHaveCount(0);
  await press(page, 'Enter');
  await press(page, 'Enter');
  await moveTo(page, 'ArrowDown', 'Example.Show.S01E02.mkv');
  await press(page, 'Enter');
  await expect(page.locator('.player-label')).toContainText('S01E02');
});

test('a folder is added to the library as Videos, with a name', async ({ page }) => {
  await openFolders(page);
  await moveTo(page, 'ArrowDown', 'Media (D:)');
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('Media (D:) › Concerts');
  await moveTo(page, 'ArrowUp', 'Add this folder to the library');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Movies');
  await moveTo(page, 'ArrowRight', 'Videos');
  await press(page, 'Enter');
  const name = page.locator('.folders-add input');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Concerts');
  await name.fill('Live shows');
  await press(page, 'Enter');
  await expect(page.getByText('In the library: Live shows (Videos)')).toBeVisible();
  await expect(page.getByText('Added Live shows to the library and scanned it.')).toBeVisible();

  // Its tile is on the Library page.
  await press(page, 'Escape', 3);
  await expect(page.locator('.library-page')).toBeVisible();
  await expect(page.locator('.library-tile', { hasText: 'Live shows' })).toBeVisible();
});

test('a typed network address opens, and is offered again', async ({ page }) => {
  await openFolders(page);
  // Down the places to the address box.
  const onBox = () => page.evaluate(() => !!document.querySelector('.folders-page input.focused'));
  for (let i = 0; i < 12 && !(await onBox()); i++) await press(page, 'ArrowDown');
  expect(await onBox()).toBe(true);
  await press(page, 'Enter');
  await page.keyboard.type('//nas/films');
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('\\\\nas\\films');
  await expect.poll(() => focused(page)).toMatch(/^A film \(2001\)/);
  await press(page, 'Escape');
  await expect(page.getByText('Opened before')).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^\\\\nas\\films/);
});

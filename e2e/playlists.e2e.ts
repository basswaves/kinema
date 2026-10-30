/**
 * Playlists by keyboard alone (LOCAL-MEDIA.md phase 5): Library → Playlists →
 * a playlist plays in its own order through Up next and carries on where it
 * was left; + Playlist on a film's page makes a playlist by name, and an
 * episode's own "+" adds just that episode; the player's
 * Audio & subtitles adds what is playing; Up and Remove on the playlist page.
 * `kinemaMockPlaylists=1` starts the mock with "Evening": S01E02, the film, a
 * video, S01E01 (mockBackend.ts).
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

async function moveTo(page: Page, key: 'ArrowDown' | 'ArrowUp' | 'ArrowRight', text: string) {
  for (let i = 0; i < 25 && !(await focused(page))?.startsWith(text); i++) await press(page, key);
  expect(await focused(page)).toMatch(new RegExp(`^${text.replace(/[()\\+?.]/g, '\\$&')}`));
}

interface FakeMpv {
  path: string | null;
  position: number;
}

const mpvPath = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.path);

async function playheadTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.position = s;
  }, seconds);
}

/** As player.e2e.ts: the day picks Home's hero (hero.ts). */
const DAYS = { series: '2026-10-01T12:00:00', film: '2026-10-02T12:00:00' } as const;

async function home(page: Page, day: keyof typeof DAYS, seeded: boolean): Promise<void> {
  await page.clock.setFixedTime(new Date(DAYS[day]));
  await page.addInitScript((s) => {
    localStorage.removeItem('kinemaMockSystem');
    if (s) localStorage.setItem('kinemaMockPlaylists', '1');
    else localStorage.removeItem('kinemaMockPlaylists');
  }, seeded);
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  // The clock runs again, or the spatial library's throttle takes every press
  // after the first for a repeat (player.e2e.ts).
  await page.clock.setSystemTime(new Date(DAYS[day]));
}

/** Home → Library → Playlists → Evening: the ring on its Play. */
async function openEvening(page: Page): Promise<void> {
  await press(page, 'ArrowUp', 2);
  await moveTo(page, 'ArrowRight', 'Library');
  await press(page, 'Enter');
  await expect(page.locator('.library-page')).toBeVisible();
  await moveTo(page, 'ArrowRight', 'Playlists');
  await press(page, 'Enter');
  await expect(page.locator('.playlists-page')).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/Evening/);
  await press(page, 'Enter');
  await expect(page.locator('.playlist-page')).toBeVisible();
  await expect(page.locator('.playlist-row')).toHaveCount(4);
  await expect.poll(() => focused(page)).toBe('▶ Play');
}

async function backTo(page: Page, selector: string): Promise<void> {
  await expect
    .poll(async () => {
      if (await page.locator(selector).isVisible()) return true;
      await press(page, 'Escape');
      return page.locator(selector).isVisible();
    })
    .toBe(true);
}

test('a playlist plays in its own order through Up next, and carries on there', async ({ page }) => {
  await home(page, 'series', true);
  // Home has the rail as soon as a playlist exists.
  await expect(page.locator('.rail-heading', { hasText: 'Playlists' })).toBeVisible();
  await openEvening(page);
  await press(page, 'Enter');
  await expect.poll(() => mpvPath(page)).toContain('S01E02');

  // The end of the episode: Up next is the playlist's next item, the film,
  // not the show's next episode.
  await playheadTo(page, 1499.9);
  const card = page.locator('.up-next');
  await expect(card).toContainText('Example Film');
  await expect.poll(() => mpvPath(page), { timeout: 20_000 }).toContain('Example.Film');

  // Back on the playlist: Play carries on at the film.
  await backTo(page, '.playlist-page');
  await expect(page.getByRole('button', { name: /Carry on: Example Film/ })).toBeVisible();
});

test('shuffle and repeat on the playlist page, by remote, kept for the playlist', async ({ page }) => {
  await home(page, 'series', true);
  await openEvening(page);
  await moveTo(page, 'ArrowRight', 'Shuffle: Off');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Shuffle: On');
  await moveTo(page, 'ArrowRight', 'Repeat: Off');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Repeat: On');

  // Play takes the shuffled round's first (the mock's round is the playlist
  // backwards), not the playlist's own first item.
  for (let i = 0; i < 4 && (await focused(page)) !== '▶ Play'; i++) await press(page, 'ArrowLeft');
  await expect.poll(() => focused(page)).toBe('▶ Play');
  await press(page, 'Enter');
  await expect.poll(() => mpvPath(page)).toContain('S01E01');

  // Kept: back on the page, both are still on.
  await backTo(page, '.playlist-page');
  await expect(page.getByRole('button', { name: 'Shuffle: On' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repeat: On' })).toBeVisible();
});

test("+ Playlist on a film's page makes a playlist by name", async ({ page }) => {
  await home(page, 'film', false);
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.detail-actions')).toBeVisible();
  await moveTo(page, 'ArrowRight', '+ Playlist');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-dialog')).toBeVisible();
  await expect.poll(() => focused(page)).toBe('+ New playlist');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-dialog input')).toBeFocused();
  await page.keyboard.type('Road');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-dialog')).toHaveCount(0);
  await expect(page.locator('.detail-note')).toHaveText('Added 1 item to Road');
  // The ring is back on the button that opened the dialog.
  await expect.poll(() => focused(page)).toBe('+ Playlist');
});

test("one episode by the + on its row; the top button is the season's", async ({ page }) => {
  await home(page, 'series', false);
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.detail-actions')).toBeVisible();
  // The page's own button names what it adds.
  await moveTo(page, 'ArrowRight', '+ Playlist (season 1)');

  // Episode 1 → its tick → its "+".
  await moveTo(page, 'ArrowDown', '1Episode 1');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toMatch(/^✓/);
  await press(page, 'ArrowRight');
  await expect(page.locator('.episode-add.focused')).toHaveAttribute('aria-label', 'Add to a playlist');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-dialog h2')).toHaveText('Add season 1, episode 1 to a playlist');
  await expect.poll(() => focused(page)).toBe('+ New playlist');
  await press(page, 'Enter');
  await page.keyboard.type('Pilots');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-dialog')).toHaveCount(0);
  await expect(page.locator('.detail-note')).toHaveText('Added 1 item to Pilots');
  // The ring is back on the "+" it came from.
  await expect(page.locator('.episode-add.focused')).toHaveCount(1);
});

test("the player's Audio & subtitles adds what is playing", async ({ page }) => {
  await home(page, 'series', true);
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeAttached();
  await expect.poll(() => mpvPath(page)).toContain('S01E01');

  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Audio & subtitles'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.track-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.track-panel .focused'))).toBe(true);
  await moveTo(page, 'ArrowDown', 'Add to a playlist');
  await press(page, 'Enter');
  // The newest playlist first: Evening, which already holds S01E01.
  await expect.poll(() => focused(page)).toMatch(/^Evening/);
  await press(page, 'Enter');
  await expect(page.locator('.track-panel')).toContainText('Already in Evening');
  await expect.poll(() => focused(page)).toBe('Add to a playlist ›');

  // A new one is named for itself: nothing can be typed in the player.
  await press(page, 'Enter');
  await moveTo(page, 'ArrowDown', '+ New playlist');
  await press(page, 'Enter');
  await expect(page.locator('.track-panel')).toContainText('Added 1 item to Playlist 2');
});

test('Up and Remove on the playlist page, the ring staying on the row', async ({ page }) => {
  await home(page, 'series', true);
  await openEvening(page);
  const names = page.locator('.playlist-row-name');
  await expect(names.first()).toHaveText('Example Show · S01E02');

  await moveTo(page, 'ArrowDown', '▶Example Film');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('↑');
  await press(page, 'Enter');
  await expect(names.first()).toHaveText('Example Film');

  await moveTo(page, 'ArrowRight', 'Remove');
  await press(page, 'Enter');
  await expect(page.locator('.playlist-row')).toHaveCount(3);
  await expect(names.first()).toHaveText('Example Show · S01E02');
  await expect.poll(() => focused(page)).toBe('Remove');
});

/**
 * The player by mouse: everything a desk with a mouse does while watching —
 * moving to bring the controls up, clicking the film to pause, double
 * clicking for full screen, the buttons, dragging the seek bar, the wheel on
 * the volume, and Back.
 *
 * Kept apart from player.e2e.ts on purpose: there the mouse is never touched,
 * because one stray hover repairs focus and hides a remote's failure
 * (CONTRIBUTING, "Two failure modes"). Here it is the point.
 *
 * Against `dev:mock`'s fake mpv, so this is the page's side on Windows'
 * terms. On Linux the same page gets the mouse from mpv's own window
 * (pageMouse.ts); `scripts/headless-selftest.sh` checks that path with mpv's
 * own mouse commands in a windowless Sway (CONTRIBUTING).
 */
import { expect, test, type Page } from '@playwright/test';

interface FakeMpv {
  paused: boolean;
  position: number;
  duration: number | null;
  volume: number;
}

function mpv(page: Page): Promise<FakeMpv> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    return { paused: f.paused, position: f.position, duration: f.duration, volume: f.volume };
  });
}

function fullscreen(page: Page): Promise<boolean> {
  return page.evaluate(async (module) => {
    const engine = await import(/* @vite-ignore */ module);
    return (engine.isPictureFullscreen as () => Promise<boolean>)();
  }, '/src/player/engine.ts');
}

/** Open Home and start the hero's film with the keyboard, as player.e2e.ts does. */
async function play(page: Page): Promise<void> {
  // A day whose hero is a film (player.e2e.ts, DAYS).
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00'));
  await page.addInitScript(() => localStorage.removeItem('kinemaMockSystem'));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => document.querySelector('.focused')?.textContent ?? '')).toContain('Play');
  await page.keyboard.press('Enter');
  await expect(page.locator('.player')).toBeAttached();
  await page.clock.setSystemTime(new Date('2026-10-02T12:00:00'));
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(0.5);
}

/** A point on the film, clear of every control. */
async function onTheFilm(page: Page): Promise<{ x: number; y: number }> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  return { x: size.width / 2, y: size.height * 0.4 };
}

test('the player by mouse: controls, pause, full screen, seek bar, volume and Back', async ({ page }) => {
  await play(page);
  const film = await onTheFilm(page);

  // Left alone, the controls step aside; moving the mouse brings them back.
  await expect(page.locator('.player.osd-hidden')).toBeAttached({ timeout: 10_000 });
  await page.mouse.move(film.x, film.y);
  await expect(page.locator('.player.osd-hidden')).toHaveCount(0);

  // A click on the film pauses, and another plays.
  await page.mouse.click(film.x, film.y);
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);
  await page.mouse.click(film.x, film.y);
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);

  // A double click on the film switches full screen, and back. Going full
  // screen pauses while the screen is matched to the film, which waits for
  // the picture's details: given here, as a real mpv has them.
  await page.evaluate(() => {
    const f = window as unknown as { __fakeMpv: { extra: Record<string, unknown> } };
    Object.assign(f.__fakeMpv.extra, {
      'video-params/gamma': 'bt.1886',
      'video-params/w': 3840,
      'video-params/h': 2160,
      'container-fps': 23.976,
    });
  });
  const before = await fullscreen(page);
  await page.mouse.dblclick(film.x, film.y);
  await expect.poll(() => fullscreen(page)).toBe(!before);
  await page.mouse.dblclick(film.x, film.y);
  await expect.poll(() => fullscreen(page)).toBe(before);
  // Its two clicks paused and played again: still playing.
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);

  // The Pause button, by its name.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);

  // Dragging the seek bar to three quarters seeks there when it is let go.
  const bar = await page.locator('.player-seek').boundingBox();
  if (!bar) throw new Error('no seek bar');
  const y = bar.y + bar.height / 2;
  await page.mouse.move(bar.x + 4, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(bar.x + 4 + ((bar.width * 0.75 - 4) * i) / 10, y);
  await page.mouse.up();
  const { duration } = await mpv(page);
  if (!duration) throw new Error('no duration');
  await expect.poll(async () => (await mpv(page)).position / duration).toBeGreaterThan(0.7);
  expect((await mpv(page)).position / duration).toBeLessThan(0.8);

  // The wheel over the volume turns it down, and up again.
  const volume = page.locator('.volume-control');
  await volume.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await mpv(page)).volume).toBeLessThan(100);
  const lower = (await mpv(page)).volume;
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await mpv(page)).volume).toBeGreaterThan(lower);

  // Back leaves the player.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page.locator('.player')).toHaveCount(0);
});

test('Android: Kinema’s own folder browser by mouse', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  const browser = page.locator('.folder-browser');
  const where = page.locator('.folder-where');

  await page.getByRole('button', { name: 'Add TV folder' }).click();
  await expect(browser.locator('h2')).toHaveText('Choose your TV folder');
  await browser.getByRole('button', { name: /USB drive/ }).first().click();
  await browser.getByRole('button', { name: 'TV', exact: true }).click();
  await browser.getByRole('button', { name: 'Example Show' }).click();
  await expect(where).toHaveText('USB drive › TV › Example Show');
  // Up a folder is the mouse's Back.
  await browser.getByRole('button', { name: 'Up a folder' }).click();
  await expect(where).toHaveText('USB drive › TV');
  await browser.getByRole('button', { name: 'Use this folder' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.root-path')).toHaveText('/storage/1A2B-3C4D/TV');

  // Cancel, and a click beside the panel, both close without choosing.
  await page.getByRole('button', { name: 'Add movies folder' }).click();
  await browser.getByRole('button', { name: 'Cancel' }).click();
  await expect(browser).toHaveCount(0);
  await page.getByRole('button', { name: 'Add movies folder' }).click();
  await page.mouse.click(5, 5);
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
});

test('Android: a network drive by mouse, signed in to with clicks and typing', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  const browser = page.locator('.folder-browser');
  const where = page.locator('.folder-where');

  await page.getByRole('button', { name: 'Add movies folder' }).click();
  await browser.getByRole('button', { name: /Network drives/ }).click();
  await expect(where).toHaveText('Network drives');
  // Back, for a mouse, as Up a folder is among folders.
  await browser.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(browser.getByRole('button', { name: /Network drives/ })).toBeVisible();
  await browser.getByRole('button', { name: /Network drives/ }).click();
  await browser.getByRole('button', { name: /Living room NAS/ }).click();
  await browser.locator('input').first().click();
  await page.keyboard.type('films');
  await browser.locator('input[type=password]').click();
  await page.keyboard.type('secret');
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.getByRole('button', { name: 'tv', exact: true }).click();
  await expect(where).toHaveText('tv on Living room NAS');
  await browser.getByRole('button', { name: 'Example Show' }).click();
  await browser.getByRole('button', { name: 'Use this folder' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.root-path')).toHaveText('smb://nas/tv/Example Show');
});

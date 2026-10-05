/**
 * The player on Android, where Media3 plays instead of mpv: the same page and
 * the same keys, through engine.ts's Media3 branches, against the mock's fake
 * Media3 (`src/dev/fakeMedia3.ts`, `kinemaMockSystem=android`). On Android
 * there is no mpv to ask, and the mock refuses every call to it as the device
 * does, so anything that still asks mpv shows up here as a warning.
 *
 * Keyboard only, as player.e2e.ts.
 */
import { expect, test, type Page } from '@playwright/test';

/** Presses far enough apart that the app sees two (docs/GOTCHAS.md). */
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

/** The control the focus ring is on: its spoken name, else its text. */
function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    return el?.getAttribute('aria-label') ?? el?.textContent?.trim();
  });
}

interface FakeMedia3 {
  path: string | null;
  position: number;
  wantPlaying: boolean;
  commands: { name: string; args: Record<string, unknown> }[];
}

function media3(page: Page): Promise<FakeMedia3> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMedia3: FakeMedia3 }).__fakeMedia3;
    return { path: f.path, position: f.position, wantPlaying: f.wantPlaying, commands: [...f.commands] };
  });
}

/** The names of the commands Media3 was sent, in order. */
async function sent(page: Page): Promise<string[]> {
  return (await media3(page)).commands.map((c) => c.name);
}

/** Every warning and error the page logged that mentions mpv. */
function mpvComplaints(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'warning' && message.type() !== 'error') return;
    if (/libmpv|mpv/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

/** Open Home as an Android box on the day whose hero is the film, and play it. */
async function playFilm(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00'));
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeAttached();
  await page.clock.setSystemTime(new Date('2026-10-02T12:00:00'));
  await expect.poll(async () => (await media3(page)).position).toBeGreaterThan(0.5);
}

test('Android: a film plays through Media3 — the screen matched, seeking, pausing, Back', async ({
  page,
}) => {
  const complaints = mpvComplaints(page);
  await playFilm(page);

  // Opened by Media3, with the screen matched to the film first (on by
  // default on Android): paused, the mode asked for, then played.
  const opened = (await media3(page)).commands.find((c) => c.name === 'open');
  expect(opened?.args.path).toContain('Example Film');
  const modes = (await media3(page)).commands.filter((c) => c.name === 'set_mode');
  expect(modes.map((c) => c.args.rate)).toEqual([23.976]);
  expect((await media3(page)).wantPlaying).toBe(true);

  // Right and Left seek.
  let before = (await media3(page)).position;
  await press(page, 'ArrowRight');
  await expect.poll(async () => (await media3(page)).position).toBeGreaterThan(before + 9);
  before = (await media3(page)).position;
  await press(page, 'ArrowLeft');
  await expect.poll(async () => (await media3(page)).position).toBeLessThan(before - 5);
  expect(await sent(page)).toContain('seek');

  // Space pauses and puts the ring on Play; OK plays again.
  await press(page, 'Space');
  await expect.poll(async () => (await media3(page)).wantPlaying).toBe(false);
  await expect.poll(() => focused(page)).toBe('Play');
  await press(page, 'Enter');
  await expect.poll(async () => (await media3(page)).wantPlaying).toBe(true);
  await press(page, 'Escape');

  // Back leaves the player: Media3 stops and the screen gets its mode back.
  await press(page, 'Escape');
  await expect(page.locator('.player')).toHaveCount(0);
  await expect.poll(async () => (await media3(page)).path).toBeNull();
  expect(await sent(page)).toContain('restore_mode');

  // Nothing on the way asked mpv, which Android does not have.
  expect(complaints).toEqual([]);
});

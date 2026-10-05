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
  volume: number;
  muted: boolean;
  untouched: boolean;
  commands: { name: string; args: Record<string, unknown> }[];
}

function media3(page: Page): Promise<FakeMedia3> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMedia3: FakeMedia3 }).__fakeMedia3;
    return { ...f, commands: [...f.commands] };
  });
}

/** One of the app's own modules, called as the app would. */
function call<T>(page: Page, module: string, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([m, n, a]) => {
      const mod = await import(/* @vite-ignore */ m as string);
      return mod[n as string](...(a as unknown[])) as T;
    },
    [module, name, args] as const
  );
}

/** The names of the commands Media3 was sent, in order. */
async function sent(page: Page): Promise<string[]> {
  return (await media3(page)).commands.map((c) => c.name);
}

/**
 * Every error the page logged, and every warning that mentions mpv — which
 * Android does not have, so anything still asking it shows up here.
 */
function mpvComplaints(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || (message.type() === 'warning' && /mpv/i.test(message.text()))) {
      seen.push(message.text());
    }
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

  // Playing with sound: nothing claims otherwise once the desktop's own check
  // for a sound output would have run (Media3 falls back by itself).
  await page.waitForTimeout(2500);
  expect(complaints).toEqual([]);

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

test('Android: the volume is Media3’s, remembered, and the receiver’s when the sound goes untouched', async ({
  page,
}) => {
  const complaints = mpvComplaints(page);
  await playFilm(page);

  // The remembered level is put on as the player opens.
  await expect.poll(async () => (await sent(page)).includes('set_volume')).toBe(true);

  await press(page, '-');
  await expect.poll(async () => (await media3(page)).volume).toBe(95);
  await press(page, '0');
  await expect.poll(async () => (await media3(page)).volume).toBe(100);
  await press(page, 'm');
  await expect.poll(async () => (await media3(page)).muted).toBe(true);
  await press(page, 'm');
  await expect.poll(async () => (await media3(page)).muted).toBe(false);
  await press(page, '-', 2);
  await expect.poll(async () => (await media3(page)).volume).toBe(90);
  await expect.poll(() => call(page, '/src/metadata/api.ts', 'getSetting', 'volume')).toBe('90');

  // The box passes the sound to the receiver untouched: the keys leave the
  // level alone and the control says the receiver has the volume.
  await page.evaluate(() => {
    (window as unknown as { __fakeMedia3: FakeMedia3 }).__fakeMedia3.untouched = true;
  });
  await press(page, '-');
  await expect(page.locator('.volume-control.receiver')).toBeAttached();
  expect((await media3(page)).volume).toBe(90);

  expect(complaints).toEqual([]);
});

test('Android: the track panel lists Media3’s tracks, chooses by remote, and the choice comes back', async ({
  page,
}) => {
  const complaints = mpvComplaints(page);
  await playFilm(page);

  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Audio & subtitles'; i++) {
    await press(page, 'ArrowRight');
  }
  await expect.poll(() => focused(page)).toBe('Audio & subtitles');
  await press(page, 'Enter');
  const panel = page.locator('.track-panel');
  await expect(panel).toBeVisible();

  // Media3's tracks, read the same way as mpv's.
  await expect(panel.locator('.track-option', { hasText: 'English · 5.1 · Dolby Digital Plus Atmos' })).toBeVisible();
  await expect(panel.locator('.track-option', { hasText: 'Commentary with the director' })).toBeVisible();

  const target = panel.locator('.track-option', { hasText: 'Norwegian' }).first();
  for (let i = 0; i < 10 && !(await target.evaluate((el) => el.classList.contains('focused'))); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect(target).toHaveClass(/active/);
  const chosen = (await media3(page)).commands.filter((c) => c.name === 'select_track').map((c) => c.args);
  expect(chosen).toContainEqual({ kind: 'sub', id: 2 });
  expect((await media3(page)).commands.at(-1)).toEqual({ name: 'show_subtitles', args: { visible: true } });

  // Out, and the film again: the remembered choice is put on by itself once
  // Media3 knows the file's tracks.
  await press(page, 'Escape');
  await press(page, 'Escape');
  await press(page, 'Escape');
  await expect(page.locator('.player')).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __fakeMedia3: FakeMedia3 }).__fakeMedia3.commands.length = 0;
  });
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeAttached();
  await expect
    .poll(async () => (await media3(page)).commands.filter((c) => c.name === 'select_track').map((c) => c.args))
    .toContainEqual({ kind: 'sub', id: 2 });

  expect(complaints).toEqual([]);
});

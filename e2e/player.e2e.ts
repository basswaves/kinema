/**
 * The player, by keyboard alone: every way of watching that a sofa uses —
 * the controls and their focus ring, seeking, pausing, the skip prompts, Up
 * next, the episodes either side, the track panel, the volume, the stats
 * panel, resuming, and the notice when the sound will not open.
 *
 * Written as the safety net for splitting Player.tsx into its parts: each
 * flow passed against the player as one file before any of it moved. Nothing
 * here touches the mouse (CONTRIBUTING, "Two failure modes").
 */
import { expect, test, type Page } from '@playwright/test';

/** Presses far enough apart that the app sees two (docs/GOTCHAS.md). */
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

/**
 * A key a remote's transport row sends, which a desktop keyboard has no
 * button for: dispatched on the page the way mpv's own window passes one on
 * (engine.ts, the `key` event).
 */
async function remoteKey(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  }, key);
  await page.waitForTimeout(150);
}

/** The control the focus ring is on: its spoken name, else its text. */
function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    return el?.getAttribute('aria-label') ?? el?.textContent?.trim();
  });
}

interface FakeMpv {
  path: string | null;
  paused: boolean;
  position: number;
  volume: number;
  mute: boolean;
  currentAo: string | null;
  commands: { name: string; args: unknown[] }[];
}

function mpv(page: Page): Promise<Omit<FakeMpv, 'commands'>> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    return {
      path: f.path,
      paused: f.paused,
      position: f.position,
      volume: f.volume,
      mute: f.mute,
      currentAo: f.currentAo,
    };
  });
}

/** Move the fake film's clock, as time passing would. */
async function playheadTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.position = s;
  }, seconds);
}

/** Every `set` mpv was sent, as `name=value`. */
function sets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.commands
      .filter((c) => c.name === 'set')
      .map((c) => c.args.join('='))
  );
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

/**
 * Home's hero is a different title each calendar day (hero.ts), so the day
 * picks what its Play button starts: the series' first episode, the film, or
 * the saga's first episode (a recap, then the intro).
 */
const DAYS = {
  series: '2026-10-01T12:00:00',
  film: '2026-10-02T12:00:00',
  saga: '2026-10-03T12:00:00',
} as const;

/** Open Home on the given day and press the hero's Play. */
async function play(
  page: Page,
  what: keyof typeof DAYS,
  before?: (page: Page) => Promise<void>
): Promise<void> {
  await page.clock.setFixedTime(new Date(DAYS[what]));
  await page.addInitScript(() => localStorage.removeItem('kinemaMockSystem'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  if (before) await before(page);
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeAttached();
  // Then let the clock run again from that day: with time standing still,
  // the spatial library's throttle (Browse.tsx) takes every press after the
  // first for a repeat, and the ring on the controls would never move.
  await page.clock.setSystemTime(new Date(DAYS[what]));
  // Playing: the file is open and its clock is running.
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(0.5);
}

/** Wait for the controls to step out of the way by themselves. */
async function controlsHidden(page: Page): Promise<void> {
  await expect(page.locator('.player.osd-hidden')).toBeAttached({ timeout: 10_000 });
}

const osdFocused = (page: Page) => page.locator('.player.osd-focused');

/**
 * A person reads a prompt before answering it. Pressed in the instant it
 * appears, OK can reach the key handler from the moment before, which did
 * not know about the prompt yet and pauses instead (one run in two, in
 * WebKit) — the same as the Up next card in keyboard.e2e.ts.
 */
const readIt = (page: Page) => page.waitForTimeout(500);

test('the controls by remote: the ring, the seek bar, Back, and handing the arrows back', async ({
  page,
}) => {
  await play(page, 'series');

  // Down brings the controls up with the ring on Pause.
  await press(page, 'ArrowDown');
  await expect(osdFocused(page)).toBeAttached();
  await expect.poll(() => focused(page)).toBe('Pause');

  // Forward 10 seconds, by the button.
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Forward 10 seconds');
  let before = (await mpv(page)).position;
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(before + 9);

  // Up to the seek bar: Left steers a seek, sent when the key is let go.
  await press(page, 'ArrowLeft');
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Position');
  before = (await mpv(page)).position;
  await press(page, 'ArrowLeft');
  await expect.poll(async () => (await mpv(page)).position).toBeLessThan(before - 5);
  // The ring stayed on the bar: one handler per press.
  expect(await focused(page)).toBe('Position');

  // Down from the bar lands on Play/Pause, under its middle.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Pause');

  // Back hands the arrows back to seeking.
  await press(page, 'Escape');
  await expect(osdFocused(page)).toHaveCount(0);
  await expect(page.locator('.player')).toBeAttached();
  before = (await mpv(page)).position;
  await press(page, 'ArrowRight');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(before + 5);

  // Left alone on the controls, they hand the arrows back by themselves.
  await press(page, 'ArrowUp');
  await expect(osdFocused(page)).toBeAttached();
  await expect(osdFocused(page)).toHaveCount(0, { timeout: 10_000 });
});

test('watching keys: seeking, pausing, volume, stats and the transport row', async ({ page }) => {
  await play(page, 'series');

  // Right and Left seek ten seconds while the controls do not have the ring.
  let before = (await mpv(page)).position;
  await press(page, 'ArrowRight');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(before + 9);
  before = (await mpv(page)).position;
  await press(page, 'ArrowLeft');
  await expect.poll(async () => (await mpv(page)).position).toBeLessThan(before - 5);

  // Space pauses and puts the ring on Play, so OK plays again.
  await press(page, 'Space');
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);
  await expect(osdFocused(page)).toBeAttached();
  await expect.poll(() => focused(page)).toBe('Play');
  // Paused, the controls stay up.
  await page.waitForTimeout(4000);
  await expect(page.locator('.player.osd-hidden')).toHaveCount(0);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);
  await press(page, 'Escape');
  await expect(osdFocused(page)).toHaveCount(0);

  // Volume, on mpv's keys.
  await press(page, '-');
  await expect.poll(async () => (await mpv(page)).volume).toBe(95);
  await press(page, '0');
  await expect.poll(async () => (await mpv(page)).volume).toBe(100);
  await press(page, 'm');
  await expect.poll(async () => (await mpv(page)).mute).toBe(true);
  await expect(page.locator('.volume-control')).toBeAttached();
  await press(page, 'm');
  await expect.poll(async () => (await mpv(page)).mute).toBe(false);
  // Remembered for the next film.
  await expect.poll(() => call(page, '/src/metadata/api.ts', 'getSetting', 'volume')).toBe('100');

  // `i` opens and closes the stats panel; Back closes it too, and only it.
  await press(page, 'i');
  await expect(page.locator('.stats-panel')).toBeVisible();
  await press(page, 'i');
  await expect(page.locator('.stats-panel')).toHaveCount(0);
  await press(page, 'i');
  await expect(page.locator('.stats-panel')).toBeVisible();
  await press(page, 'Escape');
  await expect(page.locator('.stats-panel')).toHaveCount(0);
  await expect(page.locator('.player')).toBeAttached();

  // The transport row of a remote.
  before = (await mpv(page)).position;
  await remoteKey(page, 'MediaFastForward');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(before + 25);
  before = (await mpv(page)).position;
  await remoteKey(page, 'MediaRewind');
  await expect.poll(async () => (await mpv(page)).position).toBeLessThan(before - 25);
  await remoteKey(page, 'MediaPause');
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);
  await expect.poll(() => focused(page)).toBe('Play');
  await remoteKey(page, 'MediaPlay');
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);
  await remoteKey(page, 'MediaPlayPause');
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);
  await remoteKey(page, 'MediaPlayPause');
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);

  // Stop leaves the player, back to where it was opened from.
  await remoteKey(page, 'MediaStop');
  await expect(page.locator('.player')).toHaveCount(0);
  await expect.poll(() => focused(page)).toContain('Play');
});

test('Skip intro, then the episodes either side, and resuming with Start over', async ({ page }) => {
  await play(page, 'series');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E01');

  // The intro is offered from the start; OK with the controls hidden takes it.
  await expect(page.locator('.skip-button')).toHaveText('Skip intro');
  await controlsHidden(page);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(45.6);
  await expect(page.locator('.skip-button')).toHaveCount(0);

  // The first episode has a next and no previous, and the buttons say so.
  await expect(page.getByRole('button', { name: /^Next episode/ })).toBeAttached();
  await expect(page.getByRole('button', { name: /^Previous episode/ })).toHaveCount(0);

  // Somewhere worth resuming, then on to the next episode with `n`.
  await playheadTo(page, 600);
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(600);
  await press(page, 'n');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E02');
  await expect(page.locator('.player-label')).toContainText('S01E02');
  await expect(page.getByRole('button', { name: /^Previous episode/ })).toBeAttached();
  // A cold open: the intro is offered through it, from 0:00.
  await expect(page.locator('.skip-button')).toHaveText('Skip intro');

  // Back with `p`: the first episode opens where it was left.
  await press(page, 'p');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E01');
  await expect(page.locator('.resume-toast')).toContainText('Resumed from 10:0');
  expect((await mpv(page)).position).toBeGreaterThanOrEqual(600);
  // While the notice shows, OK means "from the beginning".
  await readIt(page);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeLessThan(10);
  await expect(page.locator('.resume-toast')).toHaveCount(0);

  // The remote's episode keys do the same as `n` and `p`.
  await remoteKey(page, 'MediaTrackNext');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E02');
  await remoteKey(page, 'MediaTrackPrevious');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E01');
});

test('the credits: Up next is offered, Keep watching declines it, the end counts down', async ({
  page,
}) => {
  await play(page, 'series');
  await controlsHidden(page);

  // Into the measured credits: the card offers, with no countdown.
  await playheadTo(page, 1431);
  const card = page.locator('.up-next');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Play next');
  await expect(card).toContainText('Keep watching');
  // The small credits prompt stays away while the card is up.
  await expect(page.locator('.skip-button')).toHaveCount(0);

  // Keep watching, by remote: Up brings the ring, which goes up to the card.
  await press(page, 'ArrowUp');
  await expect(osdFocused(page)).toBeAttached();
  for (let i = 0; i < 4 && (await focused(page)) !== 'Keep watching'; i++) {
    await press(page, (await focused(page))?.includes('Play next') ? 'ArrowRight' : 'ArrowUp');
  }
  await expect.poll(() => focused(page)).toBe('Keep watching');
  await press(page, 'Enter');
  await expect(card).toHaveCount(0);
  // Declined for the rest of this file: no credits prompt in its place.
  await page.waitForTimeout(1500);
  await expect(page.locator('.skip-button')).toHaveCount(0);
  await expect(card).toHaveCount(0);
  // And the ring is still somewhere, not on the button that went.
  await expect.poll(() => focused(page)).toBeTruthy();
  await press(page, 'Escape');
  await expect(osdFocused(page)).toHaveCount(0);

  // The real end: the card comes back counting down, and rolls on by itself.
  await playheadTo(page, 1499.9);
  await expect(card).toContainText('Play now');
  await expect(card).toContainText('Back to library');
  await expect.poll(async () => (await mpv(page)).path, { timeout: 20_000 }).toContain('S01E02');
  await expect(card).toHaveCount(0);
  // The first episode counts as watched.
  await expect
    .poll(() => call<{ completed: boolean }>(page, '/src/player/api.ts', 'getProgress', 101))
    .toMatchObject({ completed: true });
});

test('the film: the scene after the credits is offered, and the end goes back to the library', async ({
  page,
}) => {
  await play(page, 'film');
  await expect.poll(async () => (await mpv(page)).path).toContain('Example.Film');
  // A film has no episodes either side.
  await expect(page.getByRole('button', { name: /episode/ })).toHaveCount(0);
  await controlsHidden(page);

  // Credits with a scene after them: the skip goes to the scene, not the end.
  await playheadTo(page, 5610);
  await expect(page.locator('.skip-button')).toHaveText('Skip to the scene after the credits');
  await expect(page.locator('.up-next')).toHaveCount(0);
  await readIt(page);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(5880);
  await expect(page.locator('.player')).toBeAttached();

  // The end of a film with nothing after it is the way back.
  await playheadTo(page, 5999.9);
  await expect(page.locator('.player')).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => focused(page)).toBeTruthy();
});

test('a recap and then an intro: two prompts, one after the other', async ({ page }) => {
  await play(page, 'saga');
  await expect.poll(async () => (await mpv(page)).path).toContain('Example.Saga.S01E01');
  await expect(page.locator('.skip-button')).toHaveText('Skip recap');
  await controlsHidden(page);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(40);
  await expect(page.locator('.skip-button')).toHaveText('Skip intro');
  await readIt(page);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(70);
  await expect(page.locator('.skip-button')).toHaveCount(0);
});

test('automatic skipping takes the intro once, by itself', async ({ page }) => {
  await play(page, 'series', (p) => call(p, '/src/metadata/api.ts', 'setSetting', 'skip_mode', 'auto'));
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(45.6);
  // No button for what was done without asking.
  await expect(page.locator('.skip-button')).toHaveCount(0);
  // Once only: back into the intro, and it plays.
  await playheadTo(page, 20);
  await page.waitForTimeout(2000);
  const position = (await mpv(page)).position;
  expect(position).toBeGreaterThan(20);
  expect(position).toBeLessThan(45);
});

test('the track panel by remote: choose, find online, and Back to its button', async ({ page }) => {
  await play(page, 'series');

  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Audio & subtitles'; i++) {
    await press(page, 'ArrowRight');
  }
  await expect.poll(() => focused(page)).toBe('Audio & subtitles');
  await press(page, 'Enter');
  const panel = page.locator('.track-panel');
  await expect(panel).toBeVisible();
  // The ring follows the panel when it opens.
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.track-panel .focused'))).toBe(true);

  // A Norwegian subtitle track, chosen by remote, is put on and remembered.
  const target = panel.locator('.track-option', { hasText: 'Norwegian' }).first();
  await expect(target).toBeVisible();
  for (let i = 0; i < 10 && !(await target.evaluate((el) => el.classList.contains('focused'))); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => sets(page)).toContain('sid=2');
  await expect(target).toHaveClass(/active/);
  await expect
    .poll(() => call<{ sub_lang: string | null }>(page, '/src/player/api.ts', 'getTitlePrefs', 1))
    .toMatchObject({ sub_lang: 'nor', sub_enabled: true });

  // Find subtitles online: the best is put on, and the rest offered.
  const find = panel.locator('.track-online');
  await expect(find).toBeVisible();
  for (let i = 0; i < 12 && !(await find.evaluate((el) => el.classList.contains('focused'))); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect(panel.locator('.track-note', { hasText: 'Showing' })).toContainText(
    'subtitles timed for this file'
  );
  await expect.poll(() =>
    page.evaluate(() =>
      (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.commands.some((c) => c.name === 'sub-add')
    )
  ).toBe(true);

  // Back closes the panel with the ring on the button that opened it.
  await press(page, 'Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Audio & subtitles');
  await press(page, 'Escape');
  await expect(osdFocused(page)).toHaveCount(0);
  await expect(page.locator('.player')).toBeAttached();
});

test('sound that will not open falls back, and says so', async ({ page }) => {
  await play(page, 'series', (p) =>
    p.evaluate(() => {
      (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.currentAo = null;
    })
  );
  // Every fallback refused too: no sound, and what to do about it.
  await expect(page.locator('.player-notice')).toContainText('No sound', { timeout: 10_000 });
  // It floats under the top bar: Back and the title stay at the top (in the
  // player's column it pushed them down to the middle of the screen).
  expect(
    await page.locator('.player-top').evaluate((el) => el.getBoundingClientRect().top)
  ).toBeLessThan(2);

  // Next time a fallback works: it plays, through the system, and says so.
  await press(page, 'n');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E02');
  await page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    // The first fallback reopens the output, and then it works.
    const original = f.commands.length;
    const timer = window.setInterval(() => {
      if (f.commands.slice(original).some((c) => c.name === 'set' && c.args[0] === 'aid')) {
        f.currentAo = 'wasapi';
        window.clearInterval(timer);
      }
    }, 20);
  });
  await expect(page.locator('.player-notice')).toContainText('going through Windows instead', {
    timeout: 10_000,
  });
});

test('Back steps out of full screen before it leaves the player', async ({ page }) => {
  await play(page, 'series');
  const fullscreen = () => call<boolean>(page, '/src/player/engine.ts', 'isPictureFullscreen');
  if (await fullscreen()) {
    await press(page, 'f');
    await expect.poll(fullscreen).toBe(false);
  }
  await press(page, 'f');
  await expect.poll(fullscreen).toBe(true);
  await press(page, 'Escape');
  await expect.poll(fullscreen).toBe(false);
  await expect(page.locator('.player')).toBeAttached();
  await press(page, 'Escape');
  await expect(page.locator('.player')).toHaveCount(0);
  await expect.poll(() => focused(page)).toContain('Play');
});

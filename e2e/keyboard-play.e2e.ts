/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): Playing: episodes, a Videos folder, files that cannot be opened.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test } from '@playwright/test';
import { press, focused, type FakeMpv, mpv, onFixtureDay, open } from './kb';

test('an episode plays, pauses and rolls on to the next', async ({ page }) => {
  await onFixtureDay(page);
  await open(page, 'windows');
  await press(page, 'Enter');

  await expect.poll(async () => (await mpv(page)).path).toContain('S01E01');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(1);

  await press(page, 'Space');
  await expect.poll(async () => (await mpv(page)).paused).toBe(true);
  await press(page, 'Space');
  await expect.poll(async () => (await mpv(page)).paused).toBe(false);
  // Leave the controls to hide, as on a sofa: while they are up OK belongs to
  // the control the ring is on, not to a prompt.
  await expect(page.locator('.player.osd-hidden')).toBeAttached({ timeout: 10_000 });

  // To the very end — past the credits offer, which a few seconds earlier
  // would ask first — and the next episode is offered. With the controls
  // hidden OK takes whatever prompt is showing, no ring needed (usePlayerKeys.ts).
  await page.evaluate(() => {
    (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv.position = 2999.9;
  });
  await expect(page.getByRole('button', { name: /Play now/ })).toBeVisible({ timeout: 15_000 });
  // A person reads the card first. Pressed in the same instant it appears,
  // OK can land before the player has started listening for the card (one
  // run in 24 did, in WebKit).
  await page.waitForTimeout(500);
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E02');
});

test('a Videos folder: Library, Play all through a sub-folder, then on to the next', async ({
  page,
}) => {
  await open(page, 'windows');
  // Up to the top bar, along to Library: one press at a time, as a remote.
  await press(page, 'ArrowUp');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Library'; i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('Library');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Home videos');
  await press(page, 'Enter');
  // The folder's own files first, then the sub-folder's group under them.
  await expect.poll(() => focused(page)).toContain('Birthday 2024-05-02');
  await press(page, 'ArrowDown');
  expect(await focused(page)).toContain('Play all');
  await press(page, 'Enter');

  await expect.poll(async () => (await mpv(page)).path).toContain('Summer trip/clip 1.mp4');
  // The next step is the folder's next file, in file-manager order.
  await expect(page.locator('button[title^="Next: clip 2 "]')).toBeAttached();
  await press(page, 'n');
  await expect.poll(async () => (await mpv(page)).path).toContain('clip 2.mp4');
  await expect(page.locator('button[title^="Next: clip 10 "]')).toBeAttached();
});

test('a Videos folder with no sub-folder: + Playlist by keyboard, the focused video named at the foot', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockRootVideos', '1'));
  await open(page, 'windows');
  await press(page, 'ArrowUp');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Library'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Home videos');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Birthday 2024-05-02');
  await expect(page.locator('.video-facts-name')).toHaveText(/Birthday/);
  await press(page, 'ArrowUp');
  expect(await focused(page)).toContain('Play all');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('+ Playlist');
  await press(page, 'ArrowDown');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('Garden');
  await expect(page.locator('.video-facts-name')).toHaveText('Garden');
});

test('Linux: straight to the receiver takes its card for the film and gives it back', async ({
  page,
}) => {
  await onFixtureDay(page);
  await open(page, 'linux');
  await page.evaluate(async () => {
    const path = '/src/metadata/api.ts';
    const api = await import(/* @vite-ignore */ path);
    await api.setSetting('audio_direct', 'on');
  });
  await press(page, 'Enter');
  await expect.poll(async () => (await mpv(page)).path).toContain('S01E01');

  // The receiver the Linux check found, by its ALSA name — not the sound
  // server — with what it takes passed through.
  const device = 'alsa/hdmi:CARD=Mock,DEV=0';
  const sets = () =>
    page.evaluate(() =>
      (window as unknown as { __fakeMpv: { commands: { name: string; args: unknown[] }[] } })
        .__fakeMpv.commands.filter((c) => c.name === 'set')
        .map((c) => c.args.join('='))
    );
  await expect.poll(sets).toContain(`audio-device=${device}`);
  expect(await sets()).toContain('audio-spdif=ac3,eac3,dts,dts-hd,truehd');
  const reserved = () =>
    page.evaluate(() => (window as unknown as { __reserved?: unknown[] }).__reserved ?? []);
  // Asked for before the file opened…
  expect(await reserved()).toContain(device);

  // …and given back when the player is left. Back steps out one layer at a
  // time (a prompt, full screen, the player), so it is pressed until out.
  for (let i = 0; i < 5 && (await page.locator('.player').count()) > 0; i++) {
    await press(page, 'Escape');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.player')).toHaveCount(0);
  await expect.poll(reserved).toContain('released');
});

test('a file that cannot be opened says so, and Back still works', async ({ page }) => {
  await open(page, 'windows');
  await page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: { failNextLoad: string | null } }).__fakeMpv;
    f.failNextLoad = 'no such file or directory';
  });
  await press(page, 'Enter');
  await expect(page.getByText('Could not play this file: no such file or directory')).toBeVisible();
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toContain('Play');
});

for (const [label, errors, notice] of [
  [
    'a folder that is away is named, with what that means',
    ['A film: TMDB /search/movie failed: HTTP 401', 'root unavailable, skipped: \\\\nas\\Films'],
    'Could not reach \\\\nas\\Films · and 1 more. Anything in that folder can’t be played until it is back.',
  ],
  // Matching went wrong, not a folder: nothing about one being away.
  [
    'any other problem says only what happened',
    ['A film: TMDB /search/movie failed: HTTP 401'],
    'A film: TMDB /search/movie failed: HTTP 401',
  ],
] as const) {
  test(`the startup scan's notice: ${label}`, async ({ page }) => {
    await page.addInitScript((e) => localStorage.setItem('kinemaMockScanErrors', e), JSON.stringify(errors));
    await open(page, 'windows');
    await expect(page.locator('.home-notice-scan .home-notice-text')).toHaveText(notice);
    // Only a notice: focus stays where it was, and Play still plays.
    expect(await focused(page)).toContain('Play');
    await press(page, 'Enter');
    await expect.poll(async () => (await mpv(page)).path).not.toBeNull();
  });

  // The line pushes Home down; an empty Continue Watching, still registered
  // with nothing on screen, then caught Up from Play and the ring vanished.
  test(`the startup scan's notice leaves the top bar one Up away: ${label}`, async ({ page }) => {
    await page.addInitScript((e) => localStorage.setItem('kinemaMockScanErrors', e), JSON.stringify(errors));
    await open(page, 'windows');
    await expect(page.locator('.home-notice-scan')).toBeVisible();
    await press(page, 'ArrowUp');
    await expect.poll(() => focused(page)).toBe('Home');
  });

  // A remote puts it away: Down to its OK (owner, 2026-10-11), and the ring
  // goes back to Play.
  test(`the startup scan's notice goes with OK, by remote: ${label}`, async ({ page }) => {
    await page.addInitScript((e) => localStorage.setItem('kinemaMockScanErrors', e), JSON.stringify(errors));
    await open(page, 'windows');
    await press(page, 'ArrowDown');
    await expect.poll(() => focused(page)).toBe('OK');
    await press(page, 'Enter');
    await expect(page.locator('.home-notice-scan')).toHaveCount(0);
    await expect.poll(() => focused(page)).toContain('Play');
  });
}

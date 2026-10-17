/**
 * Videos opened from outside the app (opened.rs, LOCAL-MEDIA.md phase 1): a
 * file Kinema was started for, one a second Kinema passes on while this one
 * runs, and files dropped on the window. Keyboard only, as everywhere.
 */
import { expect, test, type Page } from '@playwright/test';

/** Presses far enough apart that the app sees two (docs/GOTCHAS.md). */
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

interface Mock {
  openVideo: (path: string) => void;
  dropFiles: (paths: string[]) => void;
  looseProgress: Map<string, { position: number }>;
}

function mpv(page: Page): Promise<{ path: string | null; position: number }> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: { path: string | null; position: number } })
      .__fakeMpv;
    return { path: f.path, position: f.position };
  });
}

async function playheadTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __fakeMpv: { position: number } }).__fakeMpv.position = s;
  }, seconds);
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThanOrEqual(seconds);
  // The player hears of the new position on the fake mpv's next tick.
  await page.waitForTimeout(700);
}

const powerActions = (page: Page) =>
  page.evaluate(() => (window as unknown as { __powerActions?: string[] }).__powerActions ?? []);

const HOLIDAY = 'D:\\Videos\\Holiday 2019.mkv';
const EPISODE = 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E02.mkv';

/** Back out of the player: the first Back may only take the controls down. */
async function backOut(page: Page, done: () => Promise<boolean>): Promise<void> {
  await expect
    .poll(async () => {
      if (await done()) return true;
      await press(page, 'Escape');
      return done();
    })
    .toBe(true);
}

test('started for a video: the player first, and Kinema closes when Back is pressed', async ({
  page,
}) => {
  await page.addInitScript((path) => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockOpen', path);
  }, HOLIDAY);
  await page.goto('/');

  await expect(page.locator('.player')).toBeAttached();
  // Home was never drawn beneath it first.
  await expect(page.locator('.home')).toHaveCount(0);
  await expect.poll(async () => (await mpv(page)).path).toBe(HOLIDAY);
  await expect(page.locator('.player-label')).toContainText('Holiday 2019');
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(0.5);
  await playheadTo(page, 600);

  await backOut(page, async () => (await powerActions(page)).includes('close'));
  // Black while it closes, never Home; and where it was left is kept.
  await expect(page.locator('.home')).toHaveCount(0);
  const kept = await page.evaluate(
    (path) =>
      (window as unknown as { __kinemaMock: Mock }).__kinemaMock.looseProgress.get(path)?.position ??
      0,
    HOLIDAY
  );
  expect(kept).toBeGreaterThanOrEqual(600);
});

test('already running: a passed-on video plays over Home, resumes, and a dropped one takes its place', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.removeItem('kinemaMockOpen');
  });
  await page.goto('/');
  await expect(page.locator('.home')).toBeAttached();

  // A second Kinema, started for a video outside the library, passes it on.
  await page.evaluate(
    (path) => (window as unknown as { __kinemaMock: Mock }).__kinemaMock.openVideo(path),
    HOLIDAY
  );
  await expect(page.locator('.player')).toBeAttached();
  await expect.poll(async () => (await mpv(page)).path).toBe(HOLIDAY);
  await expect(page.locator('.player-label')).toContainText('Holiday 2019');
  await playheadTo(page, 600);

  // Back goes back to Home, as it was: Kinema was not started for this one.
  await backOut(page, async () => (await page.locator('.home').count()) > 0);
  expect(await powerActions(page)).not.toContain('close');

  // The same video again resumes where it was left.
  await page.evaluate(
    (path) => (window as unknown as { __kinemaMock: Mock }).__kinemaMock.openVideo(path),
    HOLIDAY
  );
  await expect(page.locator('.resume-toast')).toContainText('Resumed from 10:0');
  expect((await mpv(page)).position).toBeGreaterThanOrEqual(600);

  // Dropped on the window: what is not a video is passed over, and a library
  // episode plays as itself, in place of the one playing.
  await page.evaluate(
    (paths) => (window as unknown as { __kinemaMock: Mock }).__kinemaMock.dropFiles(paths),
    ['D:\\notes.txt', EPISODE]
  );
  await expect.poll(async () => (await mpv(page)).path).toBe(EPISODE);
  await expect(page.locator('.player-label')).toContainText('S01E02');
  await expect(page.getByRole('button', { name: /^Previous episode/ })).toBeAttached();

  // It took the other's place: one Back is Home.
  await backOut(page, async () => (await page.locator('.home').count()) > 0);
});

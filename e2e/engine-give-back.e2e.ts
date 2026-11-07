/**
 * mpv's memory after a film (engine.ts, `giveBackEngineSoon`): mpv ends a while
 * after the player closes, comes back for the next film, and is never ended
 * under one. Whether the real mpv does this well is checked on the real app.
 */
import { expect, test, type Page } from '@playwright/test';
import { pause } from './kb';

const FILM = 'D:\\Videos\\Holiday 2019.mkv';

interface Fake {
  path: string | null;
  position: number;
  paused: boolean;
  initialised: boolean;
  destroyed: number;
}
const mpv = (page: Page): Promise<Fake> =>
  page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: Fake }).__fakeMpv;
    return { ...f };
  });

async function play(page: Page): Promise<void> {
  await page.evaluate(
    (path) =>
      (window as unknown as { __kinemaMock: { openVideo: (p: string) => void } }).__kinemaMock.openVideo(path),
    FILM
  );
  await expect.poll(async () => (await mpv(page)).path).toBe(FILM);
  await expect.poll(async () => (await mpv(page)).position).toBeGreaterThan(0.2);
}

async function leave(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      if ((await page.locator('.player').count()) === 0) return true;
      await page.keyboard.press('Escape');
      await pause(page, 200, 'input pacing');
      return (await page.locator('.player').count()) === 0;
    })
    .toBe(true);
}

test('mpv ends a while after leaving, returns for the next film, and not while one plays', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.removeItem('kinemaMockOpen');
  });
  await page.goto('/');
  await expect(page.locator('.home')).toBeAttached();

  await play(page);
  await leave(page);
  expect((await mpv(page)).destroyed).toBe(0);

  // Back again within the wait: nothing was ended, nothing is, film or no film.
  await page.clock.fastForward(10_000);
  await play(page);
  await page.clock.fastForward(60_000);
  expect(await mpv(page)).toMatchObject({ destroyed: 0, path: FILM });

  // Left, while paused, and the wait is over.
  await page.evaluate(() => {
    (window as unknown as { __fakeMpv: Fake }).__fakeMpv.paused = true;
  });
  await leave(page);
  await page.clock.fastForward(31_000);
  await expect.poll(async () => (await mpv(page)).destroyed).toBe(1);
  expect((await mpv(page)).initialised).toBe(false);

  // The next film starts it again and plays.
  await play(page);
  expect(await mpv(page)).toMatchObject({ initialised: true, destroyed: 1, path: FILM });
});

/**
 * A YouTube trailer in Kinema (TrailerOverlay.tsx, trailer.ts): YouTube's
 * embed in the overlay, driven by keys alone — OK pauses, the arrows seek,
 * Down reaches the buttons, Back closes and the ring goes home — and any error
 * YouTube reports sends the trailer to the browser instead.
 * YouTube itself is stubbed: a page at the embed's address that answers the
 * IFrame API's messages as YouTube's player does and keeps what it was told.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { focused, press } from './kb';

const KEY = 'M7lc1UVf-VE';
const WATCH = `https://www.youtube.com/watch?v=${KEY}`;

/** YouTube's player, as far as the overlay can tell: ready and playing at 30 s, or an error. */
function stub(error: number | null): string {
  return `<!doctype html><body style="background:#123"><script>
window.told = [];
let started = false;
const post = (m) => parent.postMessage(JSON.stringify({ ...m, channel: 'widget', id: 1 }), '*');
addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.event === 'listening' && !started) {
    started = true;
    ${
      error === null
        ? `post({ event: 'onReady', info: null });
    post({ event: 'infoDelivery', info: { playerState: 1, currentTime: 30 } });`
        : `post({ event: 'onError', info: ${error} });`
    }
  } else if (m.event === 'command' && m.func !== 'addEventListener') {
    window.told.push(m.func + (m.args.length ? ' ' + m.args[0] : ''));
    if (m.func === 'pauseVideo') post({ event: 'onStateChange', info: 2 });
    if (m.func === 'playVideo') post({ event: 'onStateChange', info: 1 });
  }
});
</script></body>`;
}

async function open(page: Page, error: number | null): Promise<void> {
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: stub(error) })
  );
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockTrailer', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.locator('.search .card', { hasText: 'Example Film' }).click();
  await expect(page.locator('.detail h1')).toHaveText('Example Film');
  await expect.poll(() => focused(page)).toMatch(/Play/);
  for (let i = 0; i < 8 && (await focused(page)) !== '▶ Trailer'; i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('▶ Trailer');
  await press(page, 'Enter');
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __kinemaMock: { openedLinks: string[] } }).__kinemaMock.openedLinks);

function player(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  if (!frame) throw new Error('no embed frame');
  return frame;
}

const told = (page: Page) => player(page).evaluate(() => (window as unknown as { told: string[] }).told);

test('a trailer plays in the overlay, answers the remote, and Back closes it', async ({ page }) => {
  await open(page, null);
  const frame = page.locator('.trailer iframe');
  await expect(frame).toHaveAttribute('src', new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${KEY}\\?enablejsapi=1`));
  await expect(frame).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('.trailer-screen')).toHaveClass(/focused/);

  // OK pauses and plays; the arrows seek ten seconds from where it is.
  await expect.poll(() => told(page).catch(() => [])).toEqual([]);
  await press(page, 'Enter');
  await expect(page.locator('.trailer-keys')).toContainText('Paused');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
  await press(page, 'ArrowLeft');
  await press(page, 'ArrowLeft');
  await expect.poll(() => told(page)).toEqual(['pauseVideo', 'playVideo', 'seekTo 40', 'seekTo 30', 'seekTo 20']);
  await expect(page.locator('.trailer-keys')).not.toContainText('Paused');

  // Down to the buttons, Up back to the picture: the ring never enters YouTube's page.
  await press(page, 'ArrowDown');
  expect(await focused(page)).toMatch(/Open on YouTube|Close/);
  await press(page, 'ArrowUp');
  await expect(page.locator('.trailer-screen')).toHaveClass(/focused/);

  // Back closes; the ring is back on the button that opened it, nothing went to the browser.
  await press(page, 'Escape');
  await expect(page.locator('.trailer')).toHaveCount(0);
  await expect(page.locator('.detail h1')).toHaveText('Example Film');
  expect(await focused(page)).toBe('▶ Trailer');
  expect(await opened(page)).toEqual([]);
});

test('a click in YouTube’s player does not keep the keyboard', async ({ page }) => {
  await open(page, null);
  await expect(page.locator('.trailer-screen')).toHaveClass(/focused/);
  await page.locator('.trailer iframe').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
  await press(page, 'Escape');
  await expect(page.locator('.trailer')).toHaveCount(0);
});

test('the mouse has the same: Close, and Open on YouTube', async ({ page }) => {
  await open(page, null);
  await page.locator('.trailer button', { hasText: 'Open on YouTube' }).click();
  await expect.poll(() => opened(page)).toEqual([WATCH]);
  await page.locator('.trailer button', { hasText: 'Close' }).click();
  await expect(page.locator('.trailer')).toHaveCount(0);
});

for (const code of [150, 153]) {
  test(`YouTube's error ${code} sends the trailer to the browser`, async ({ page }) => {
    await open(page, code);
    await expect(page.locator('.trailer')).toHaveCount(0);
    await expect.poll(() => opened(page)).toEqual([WATCH]);
    await expect(page.locator('.detail h1')).toHaveText('Example Film');
  });
}

/**
 * A film this system cannot decode (review A3-01, A3-02, A3-05): the player
 * says so in plain words, instead of a black picture or the sound route's
 * fallback notices, and does not hold the film paused for a picture that
 * cannot come. The fake mpv stands in for a system's own "free" codec
 * libraries through its `extra` answers: a `decoder-list` without the
 * patented formats, and the film's track dropped, as mpv drops it.
 * Keyboard only.
 */
import { expect, test, type Page } from '@playwright/test';
import { pause } from './kb';

interface FakeMpv {
  position: number;
  paused: boolean;
  currentAo: string | null;
  extra: Record<string, unknown>;
}

/** mpv's decoder-list as it prints it, for a build with only these. */
const FREE_BUILD = JSON.stringify(
  ['h264', 'vp9', 'av1', 'aac', 'ac3', 'opus', 'flac'].map((codec) => ({
    codec,
    driver: codec,
    description: codec,
  }))
);

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    return el?.getAttribute('aria-label') ?? el?.textContent?.trim();
  });
}

function fake(page: Page): Promise<FakeMpv> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    return { position: f.position, paused: f.paused, currentAo: f.currentAo, extra: f.extra };
  });
}

/**
 * Play the fixture series' first episode from Home's hero (its day: hero.ts),
 * as `system`, with the fake mpv set up by `setup` first.
 */
async function play(
  page: Page,
  system: 'windows' | 'linux',
  setup: { extra: Record<string, unknown>; currentAo?: null }
): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00'));
  await page.addInitScript((s) => {
    if (s === 'linux') localStorage.setItem('kinemaMockSystem', 'linux');
    else localStorage.removeItem('kinemaMockSystem');
  }, system);
  await page.goto('/');
  await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
  await page.evaluate((s) => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    f.extra = s.extra;
    if (s.currentAo === null) f.currentAo = null;
  }, setup);
  await page.keyboard.press('Enter');
  await expect(page.locator('.player')).toBeAttached();
  await page.clock.setSystemTime(new Date('2026-10-01T12:00:00'));
}

test('no decoder for the picture: said, with where to get one, and the film starts at once', async ({
  page,
}) => {
  await play(page, 'linux', { extra: { 'decoder-list': FREE_BUILD, 'track-list/0/selected': false } });
  const notice = page.locator('.player-notice');
  await expect(notice).toContainText('This system cannot decode HEVC video, so there is no picture.', {
    timeout: 10_000,
  });
  await expect(notice).toContainText('RPM Fusion');
  // Not held paused waiting for a first frame that cannot come (A3-05's wait
  // was 15 s): the clock runs well before that.
  await expect.poll(async () => (await fake(page)).position, { timeout: 8_000 }).toBeGreaterThan(0.5);
  // The screen stays black, so the notice stays past the sound notices' 12 s.
  await pause(page, 13_000, 'past AUDIO_NOTICE_MS, the time a sound notice shows');
  await expect(notice).toContainText('cannot decode HEVC video');
});

test('no decoder for the sound: said, not taken for an output that refused it', async ({
  page,
}) => {
  // The first sound track is TrueHD, which this build lacks; mpv then has no
  // sound output open, which is what the fallbacks look for.
  await play(page, 'windows', { extra: { 'decoder-list': FREE_BUILD }, currentAo: null });
  const notice = page.locator('.player-notice');
  await expect(notice).toContainText('This system cannot decode TrueHD sound', { timeout: 10_000 });
  // The file's AC-3 commentary is one it can play.
  await expect(notice).toContainText('Another sound track is in Audio & subtitles.');
  // Windows' libraries are Kinema's own: no pointer to a Linux build.
  await expect(notice).not.toContainText('RPM Fusion');
  await pause(page, 3_000, 'past the sound check and where a fallback would have run');
  await expect(notice).not.toContainText('going through Windows instead');
  await expect(notice).not.toContainText('playing in stereo');
  await expect(notice).toContainText('cannot decode TrueHD sound');
});

/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): ffmpeg and Skiptro: installing, finding, and what each system offers.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { press, focused, open, firstRunToSetupPage } from './kb';

/** Home's ffmpeg notice, its button under the ring, by Down from Play. */
async function toFfmpegNotice(page: Page, button: string): Promise<void> {
  for (let i = 0; i < 6 && (await focused(page)) !== button; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe(button);
  await expect(page.locator('.home-notice').last()).toContainText('need ffmpeg');
}

test('Windows: Home installs ffmpeg with one press, and the notice goes', async ({ page }) => {
  await open(page, 'windows');
  await toFfmpegNotice(page, 'Install ffmpeg');
  // What will happen is said before the press.
  const notice = page.locator('.home-notice').last();
  await expect(notice).toContainText('winget');
  await expect(notice).toContainText('about 110 MB');
  await expect(notice).toContainText('stays installed if Kinema is ever removed');

  // Each step of the mock's install shows for 400 ms: watched every frame
  // from before the press, so a step is never missed between two looks.
  const sawDownloading = page.waitForFunction(
    () => Array.from(document.querySelectorAll('.home-notice')).some((n) => n.textContent?.includes('Downloading ffmpeg')),
    undefined,
    { polling: 'raf' }
  );
  await press(page, 'Enter');
  // While it runs the button stays under the ring, and says so.
  await expect.poll(() => focused(page)).toBe('Installing…');
  await sawDownloading;
  // Done: the notice is gone, and the ring went somewhere, not nowhere.
  await expect(page.locator('body')).not.toContainText('need ffmpeg', { timeout: 10_000 });
  await expect.poll(() => focused(page)).toBeTruthy();
});

test('Windows without winget: the button becomes the download page, and says why', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockWinget', 'missing'));
  await open(page, 'windows');
  await toFfmpegNotice(page, 'Install ffmpeg');
  await press(page, 'Enter');
  await expect(page.locator('.home-notice').last()).toContainText('winget) is not on this computer');
  // The same place under the ring, now the way it was always added.
  await expect.poll(() => focused(page)).toBe('Open the ffmpeg download page ↗');
});

test('Windows: a failed install says why, with Try again and the download page', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockWinget', 'fail'));
  await open(page, 'windows');
  await toFfmpegNotice(page, 'Install ffmpeg');
  await press(page, 'Enter');
  const notice = page.locator('.home-notice').last();
  await expect(notice).toContainText('The download failed', { timeout: 10_000 });
  await expect(notice.locator('.ffmpeg-install-tail')).toContainText('Installer failed');
  await expect.poll(() => focused(page)).toBe('Try again');
  // The download page is reachable by remote from Try again: beside it, in
  // the notice's text, so Left (the notice is a row; round 7).
  for (let i = 0; i < 3 && (await focused(page)) !== 'Open the ffmpeg download page ↗'; i++) {
    await press(page, 'ArrowLeft');
  }
  await expect.poll(() => focused(page)).toBe('Open the ffmpeg download page ↗');
});

test('Windows: Settings installs ffmpeg, and its status turns green', async ({ page }) => {
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Library');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Skipping intros'; i++) {
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Skipping intros');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Skipping intros');
  if (await page.evaluate(() => Boolean(document.querySelector('.settings-nav .focused')))) {
    await press(page, 'ArrowRight');
  }
  // The section says what it found before the ring goes down it: the button
  // is the install one only once ffmpeg has been looked for.
  const section = page.locator('.settings-content');
  await expect(section).toContainText('Could not find ffmpeg');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Install ffmpeg'; i++) {
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Install ffmpeg');
  await expect(section).toContainText('Could not find ffmpeg');
  await expect(section).toContainText('about 110 MB');

  await press(page, 'Enter');
  await expect(section.locator('.settings-ok').first()).toContainText('Found ffmpeg at', {
    timeout: 10_000,
  });
  await expect(section).toContainText('ffmpeg is installed');
  // Nothing left to install: the button is the download page again, and the
  // ring is still in the section.
  await expect(section).not.toContainText('Install ffmpeg');
  await expect.poll(() => focused(page)).toBeTruthy();
});

test('first run, Details and ratings: ffmpeg installs from the setup page by remote', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockEmpty', '1');
    // Watch history and subtitles with nothing to press, so their way on is under the ring.
    localStorage.setItem('kinemaMockNoAccountApps', '1');
  });
  await firstRunToSetupPage(page, 'windows', 'Details and ratings');
  await expect.poll(() => focused(page)).toBe('Install ffmpeg');
  await expect(page.locator('.setup-page')).toContainText('about 110 MB');
  await press(page, 'Enter');
  await expect(page.locator('.setup-page .settings-ok').first()).toContainText('Found ffmpeg at', {
    timeout: 10_000,
  });
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is installed');
  // The button went with the question it answered; the ring moved on to the
  // next control on the page (the path field), not nowhere.
  await expect
    .poll(() => page.evaluate(() => Boolean(document.querySelector('.setup-page .focused'))))
    .toBe(true);
});

test("an ffmpeg without HEVC or E-AC-3 (Fedora's own) is found, and what it costs is said", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockFfmpegFound', '1');
    localStorage.setItem('kinemaMockFfmpegLacks', 'hevc,eac3');
  });
  await open(page, 'linux');
  // Found, so Home has nothing to say about it.
  await expect(page.locator('body')).not.toContainText('need ffmpeg');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Skipping intros'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const section = page.locator('.settings-content');
  await expect(section).toContainText('Found ffmpeg at');
  await expect(section).toContainText('cannot decode HEVC video or E-AC-3 sound');
  await expect(section).toContainText('the picture shape is not measured');
});

test('Linux: Home still sends ffmpeg to Settings; nothing offers to install it', async ({
  page,
}) => {
  await open(page, 'linux');
  await toFfmpegNotice(page, 'How to add it');
  await expect(page.locator('body')).not.toContainText('Install ffmpeg');
  await expect(page.locator('body')).not.toContainText('winget');
});

test('Android: nothing offers ffmpeg or Skiptro, which an Android app cannot run', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  // The mock has no ffmpeg; on a desktop Home would say so.
  await expect(page.locator('body')).not.toContainText('need ffmpeg');

  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Skipping intros'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const section = page.locator('.settings-content');
  await expect(section.locator('h2')).toHaveText(['Skipping intros', 'How Kinema finds them']);
  await expect(section).toContainText('cannot listen to the episodes itself');
  await expect(section.locator('h3')).toHaveText(['Times shared by other viewers']);
  await expect(section.locator('.choice-label')).toContainText(['Look up TheIntroDB', 'Look up IntroDB']);
  await expect(section).not.toContainText('ffmpeg');
  await expect(section).not.toContainText('Skiptro');
});

/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): Settings → Playback, the first run and its setup pages.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test } from '@playwright/test';
import { press, focused, open, firstRunToSetupPage } from './kb';

test('Settings → Playback: Look is Auto, Full or Light, by remote, and Light drops the blur', async ({
  page,
}) => {
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Playback'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Playback');

  const row = page.locator('.choice-row', { has: page.locator('.choice-label', { hasText: /^Look$/ }) });
  await expect(row.locator('.choice')).toHaveText(['✓Auto', 'Full', 'Light']);
  // Reach the row with Down, as a remote would.
  const onLook = () =>
    page.evaluate(() => !!document.querySelector('.focused')?.closest('[aria-label="Look"]'));
  await press(page, 'ArrowRight');
  for (let i = 0; i < 12 && !(await onLook()); i++) await press(page, 'ArrowDown');
  expect(await onLook()).toBe(true);

  // Auto says what it chose; either way the page carries one of the two looks.
  await expect(row.locator('.choice-hint')).toContainText(/^Auto (chose (Full|Light): |is still looking)/);
  const look = () => page.evaluate(() => document.documentElement.dataset.look);
  await expect.poll(look).toMatch(/^(full|light)$/);
  const blur = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.top-nav')!).backdropFilter);

  // Move to Light: the chosen one is marked, the page is light, the blur is gone.
  const toward = async (label: string, key: string) => {
    for (let i = 0; i < 3 && (await focused(page)) !== label && (await focused(page)) !== `✓${label}`; i++) {
      await press(page, key);
    }
  };
  await toward('Light', 'ArrowRight');
  await press(page, 'Enter');
  await expect(row.locator('.choice.chosen')).toHaveText('✓Light');
  await expect.poll(look).toBe('light');
  await expect.poll(blur).toBe('none');
  await expect(row.locator('.choice-hint')).toHaveCount(0);
  // The ring is still on the control: focus stays clearly visible.
  await expect.poll(() => focused(page)).toBe('✓Light');

  await toward('Full', 'ArrowLeft');
  await press(page, 'Enter');
  await expect(row.locator('.choice.chosen')).toHaveText('✓Full');
  await expect.poll(look).toBe('full');
  await expect.poll(blur).not.toBe('none');

  await toward('Auto', 'ArrowLeft');
  await press(page, 'Enter');
  await expect(row.locator('.choice.chosen')).toHaveText('✓Auto');
  await expect(row.locator('.choice-hint')).toContainText('Auto');
});

test('first run: where to watch, a folder, then the setup pages, all by remote', async ({ page }) => {
  // A short window, so the welcome page is scrolled when Scan opens the
  // pages: the first page's focus landed a row down from stale positions
  // that way (CI's Linux WebKit at full height; here, anywhere under ~560).
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockEmpty', '1'));
  await page.goto('/');
  const setting = (key: string) =>
    page.evaluate(async (k) => {
      const path = '/src/metadata/api.ts';
      const api = await import(/* @vite-ignore */ path);
      return api.getSetting(k) as Promise<string | null>;
    }, key);

  // Asked first, and nothing chosen for the person.
  await expect.poll(() => focused(page)).toBe('A TV, from the sofa');
  await press(page, 'Enter');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.tv)).toBe('on');

  // A folder (the mock's picker answers at once), then Scan.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
  for (let i = 0; i < 5 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Scan my library');
  await press(page, 'Enter');

  // The setup pages, at once, landing on the first question.
  await expect(page.locator('.setup-pages h1')).toHaveText('Picture and sound');
  await expect.poll(() => focused(page)).toBe('Every receiver');
  expect(await setting('audio_direct')).toBeNull();
  expect(await setting('setup_pages')).toBe('open');

  // An answer is saved as it is given, and only that one.
  await press(page, 'Enter');
  await expect.poll(() => setting('audio_direct')).toBe('on');
  expect(await setting('display_switch_refresh')).toBeNull();

  // The scan finishes behind the page, and the page stays.
  await expect(page.locator('.setup-progress')).toContainText('Your library is ready.');
  await expect(page.locator('.setup-pages h1')).toHaveText('Picture and sound');

  // The way on is one press up, and says Next once something is chosen.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await expect(page.locator('.setup-progress')).toContainText('1 of 5');
  await press(page, 'Enter');

  // Intros and credits: the current answers shown, the ring on the first.
  await expect(page.locator('.setup-pages h1')).toHaveText('Skipping intros');
  await expect.poll(() => focused(page)).toBe('✓Show a Skip button');
  // Skiptro is not on this PC: one line, nothing to press.
  await expect(page.locator('.setup-page')).toContainText('Already use Skiptro');
  // One answer covers both services.
  await press(page, 'ArrowDown');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Off');
  await press(page, 'Enter');
  await expect.poll(() => setting('introdb_enabled')).toBe('off');
  await expect.poll(() => setting('introdb_app_enabled')).toBe('off');
  expect(await setting('skip_mode')).toBeNull();

  // Back returns to the page before, as it was left.
  await press(page, 'Escape');
  await expect(page.locator('.setup-pages h1')).toHaveText('Picture and sound');
  await expect.poll(() => focused(page)).toBe('✓Every receiver');
  await press(page, 'ArrowUp');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Skipping intros');

  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'Enter');

  // Watch history: Settings' own cards, the ring on the first Connect.
  await expect(page.locator('.setup-pages h1')).toHaveText('Keep track of what you watch');
  await expect(page.locator('.setup-page h2')).toHaveCount(2);
  await expect.poll(() => focused(page)).toBe('Connect SIMKL');
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'Enter');

  // Subtitles online: OpenSubtitles' card.
  await expect(page.locator('.setup-pages h1')).toHaveText('Subtitles online');
  await expect(page.locator('.setup-page h2')).toHaveText(['OpenSubtitles']);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Next'; i++) await press(page, 'ArrowUp');
  await press(page, 'Enter');

  // Details and ratings: the mock has no ffmpeg, so the way to install it and where it is.
  await expect(page.locator('.setup-pages h1')).toHaveText('Details and ratings');
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await expect.poll(() => focused(page)).toBe('Install ffmpeg');
  await press(page, 'ArrowDown');
  await page.keyboard.type('/opt/ffmpeg/bin/ffmpeg');
  await expect.poll(() => setting('ffmpeg_path')).toBe('/opt/ffmpeg/bin/ffmpeg');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Get a free key ↗'; i++) await press(page, 'ArrowDown');
  await press(page, 'ArrowDown');
  await page.keyboard.type('abc123');
  await expect.poll(() => setting('omdb_api_key')).toBe('abc123');
  await expect(page.locator('.setup-page')).toContainText('Saved.');

  // On the last page the way on finishes, to the library.
  for (let i = 0; i < 6 && (await focused(page)) !== 'Finish'; i++) await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Finish');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');
  await expect.poll(() => setting('setup_pages')).toBe('done');
  expect(await setting('display_switch_refresh')).toBeNull();

  // Settings → Library → Run setup again brings the pages back.
  await press(page, 'ArrowUp', 2);
  await expect.poll(() => focused(page)).toBe('Home');
  await press(page, 'ArrowRight', 5);
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Library');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 30 && (await focused(page)) !== 'Run setup again'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Run setup again');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Picture and sound');
  // An answer given before is shown as given (the tick).
  await expect.poll(() => focused(page)).toBe('✓Every receiver');
  await expect.poll(() => setting('setup_pages')).toBe('open');

  // Next, never Skip — nothing chosen this time — then Finish later:
  // straight back to the library.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Finish later');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');
  await expect.poll(() => setting('setup_pages')).toBe('done');
});

test('Android: a folder on a USB drive, chosen in Kinema’s own browser', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  const storage = () =>
    page.evaluate(
      () => (window as unknown as { __kinemaMock: { storage: { read: string; asked: number } } })
        .__kinemaMock.storage
    );
  await expect(page.locator('.first-run')).toContainText(
    'on a NAS or a computer on your network, a USB drive, or this device’s own storage'
  );

  // Add movies folder: Android is asked once, then the drives.
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  await expect(page.locator('.folder-browser h2')).toHaveText('Choose your movies folder');
  await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
  expect(await storage()).toEqual(expect.objectContaining({ read: 'granted', asked: 1 }));
  // The subtitles' permission is offered, not required; once given, the
  // offer goes and the ring is back on the drives.
  await expect(page.locator('.folder-browser')).toContainText('All files access');
  // Past the drives and Network drives.
  await press(page, 'ArrowDown', 3);
  await expect.poll(() => focused(page)).toBe('Allow all files');
  await press(page, 'Enter');
  await expect(page.locator('.folder-browser')).not.toContainText('All files access');
  await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');

  // Into the drive, then Films; the ring lands on the first folder each time.
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('USB drive');
  await expect.poll(() => focused(page)).toBe('Films');
  await press(page, 'Enter');
  await expect(page.locator('.folder-where')).toHaveText('USB drive › Films');
  await expect.poll(() => focused(page)).toBe('A film (2001)');

  // Back goes up a level, onto the folder come out of.
  await press(page, 'Escape');
  await expect(page.locator('.folder-where')).toHaveText('USB drive');
  await expect.poll(() => focused(page)).toBe('Films');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('A film (2001)');

  // Use this folder is one press up; the browser closes and the root is added.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Use this folder');
  await press(page, 'Enter');
  await expect(page.locator('.folder-browser')).toHaveCount(0);
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
  await expect(page.locator('.root-path')).toHaveText('/storage/1A2B-3C4D/Films');
  await expect.poll(() => focused(page)).toBe('Add movies folder');

  // Opened again and left with Back from the drives: nothing chosen.
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
  await press(page, 'Escape');
  await expect(page.locator('.folder-browser')).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  expect((await storage()).asked).toBe(1);
});

test('Android: Picture & sound is one switch, on, and says what the system does', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Picture & sound'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const section = page.locator('.settings-section');
  await expect(section.locator('h2')).toHaveText(['Picture & sound']);
  // On before anyone chose: nothing stored, the tick on On.
  await expect(section.locator('.focused, button', { hasText: '✓' })).toHaveText(['✓On']);
  await expect(section).toContainText('HDR10 and HLG');
  // What the system reports, and what the player did with the last film.
  await expect(section).toContainText('Android reports that the TV or receiver takes');
  await expect(section).toContainText(
    'Last film: its DTS-HD 5.1 sound was turned into ordinary sound on this device.'
  );
  // Nothing of the desktop's per-device settings.
  await expect(section).not.toContainText('Every screen that can');

  // Off, by remote, is stored.
  await press(page, 'ArrowRight');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Off'; i++) await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Off');
  await press(page, 'Enter');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/metadata/api.ts';
        const api = await import(/* @vite-ignore */ path);
        return api.getSetting('display_match') as Promise<string | null>;
      })
    )
    .toBe('off');
});

test('Android: refused, the folder browser says where to allow it', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockStorageRefused', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  await expect(page.locator('.folder-browser')).toContainText('Apps → Kinema → Permissions');
  await expect.poll(() => focused(page)).toBe('Ask again');
  await press(page, 'Escape');
  await expect(page.locator('.folder-browser')).toHaveCount(0);
});

test('Android: always the TV layout, never asked', async ({ page }) => {
  // A TV's screen as Android's WebView gives it to the page: a 1080p TV at
  // twice the density, as on the emulated TV and on a real box.
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  const tv = () => page.evaluate(() => document.documentElement.dataset.tv);

  // No seat question: the folder is the first step, in the TV layout.
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await expect(page.locator('.first-run h2').first()).toContainText('1 Where are your movies');
  await expect(page.locator('.first-run')).not.toContainText('Where will you watch?');
  expect(await tv()).toBe('on');
  // Where the first run starts, so wholly on screen (it sat half off a TV).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = document.querySelector('.focused')?.getBoundingClientRect();
        return box ? box.bottom <= window.innerHeight && box.top >= 0 : false;
      })
    )
    .toBe(true);
  // F11 and Ctrl+Shift+T switch a desktop's layout; here there is no desk.
  await press(page, 'F11');
  await press(page, 'Control+Shift+T');
  expect(await tv()).toBe('on');

  // Nothing to ask about picture and sound: the pages start at intros.
  // (A folder first: the USB drive itself, in Kinema's own browser.)
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
  await press(page, 'Enter');
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Use this folder');
  await press(page, 'Enter');
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
  for (let i = 0; i < 5 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Skipping intros');
  await expect(page.locator('.setup-progress')).toContainText('1 of 4');
  await press(page, 'ArrowUp');
  // Nothing chosen, and the way on still says Next: it accepts what is shown.
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Finish later');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');

  // Settings → Playback has no desk-or-TV row, and the key list no F11.
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Playback'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Playback');
  await expect(page.locator('.settings-section')).not.toContainText('Where Kinema is used');
  await press(page, '?');
  await expect(page.locator('.shortcuts')).toBeVisible();
  await expect(page.locator('.shortcuts')).not.toContainText('F11');
  await expect(page.locator('.shortcuts')).not.toContainText('Fullscreen');
  // The remote's names for the keys, the keyboard's in one group under them.
  await expect(page.locator('.shortcuts h3')).toHaveText([
    'Getting around',
    'While something is playing',
    'With a keyboard',
  ]);
  await expect(page.locator('.shortcuts')).toContainText('OKChoose the highlighted thing');
  await expect(page.locator('.shortcuts')).toContainText('BackGo back');
  expect(await tv()).toBe('on');
});

for (const system of ['android', 'windows'] as const) {
  test(`${system}: a setup page with nothing to press keeps the ring on Next`, async ({ page }) => {
    // A build without SIMKL's or Trakt's app and without an OpenSubtitles key
    // — every build but a release — has nothing to press on Keep track of
    // what you watch, nor on Subtitles online. The
    // ring went nowhere a moment after arriving, for good (found on a box).
    await page.setViewportSize({ width: 960, height: 540 });
    await page.addInitScript((s) => {
      if (s === 'android') localStorage.setItem('kinemaMockSystem', 'android');
      localStorage.setItem('kinemaMockEmpty', '1');
      localStorage.setItem('kinemaMockNoAccountApps', '1');
    }, system);
    await firstRunToSetupPage(page, system, 'Keep track of what you watch');
    await expect(page.locator('.setup-page')).toContainText('built without a SIMKL app');

    // Long after the page's wait for a question has run out, the ring is on
    // the way on.
    await page.waitForTimeout(4000);
    expect(await focused(page)).toBe('Next');

    // Down reads the page to its end, and Up comes back to Next.
    const atBottom = () =>
      page.evaluate(() => {
        const el = document.querySelector('.setup-later');
        return el ? el.getBoundingClientRect().bottom <= window.innerHeight : false;
      });
    for (let i = 0; i < 10 && !(await atBottom()); i++) {
      await press(page, 'ArrowDown');
      await page.waitForTimeout(400);
    }
    expect(await atBottom()).toBe(true);
    expect(await focused(page)).toBe('Next');
    const inView = () =>
      page.evaluate(() => {
        const r = document.querySelector('.focused')?.getBoundingClientRect();
        return r ? r.top >= 0 && r.bottom <= window.innerHeight : false;
      });
    for (let i = 0; i < 10 && !(await inView()); i++) {
      await press(page, 'ArrowUp');
      await page.waitForTimeout(400);
    }
    expect(await inView()).toBe(true);
    expect(await focused(page)).toBe('Next');
    await press(page, 'Enter');
    await expect(page.locator('.setup-pages h1')).toHaveText('Subtitles online');
  });
}

test('a setup page whose question comes late still starts on it, unless the remote was used', async ({
  page,
}) => {
  // Details and ratings asks whether ffmpeg is there before it shows anything; on a busy
  // computer that took longer than the page waits (seen once under load).
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockSlowFfmpeg', '1');
  });
  await firstRunToSetupPage(page, 'windows', 'Details and ratings');
  // Meanwhile the ring is on the way on (the last page's: Finish), never
  // nowhere…
  await expect.poll(() => focused(page)).toBe('Finish');
  // …and goes to the first question when it arrives.
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await expect.poll(() => focused(page)).toBe('Install ffmpeg');

  // Back, and on again: this time a key is pressed before the question comes,
  // and the ring stays where the person has it.
  await press(page, 'Escape');
  await expect(page.locator('.setup-pages h1')).toHaveText('Subtitles online');
  await press(page, 'ArrowUp');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Next'; i++) await press(page, 'ArrowUp');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Details and ratings');
  await expect.poll(() => focused(page), { timeout: 2500 }).toBe('Finish');
  await press(page, 'ArrowDown');
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await page.waitForTimeout(500);
  expect(await focused(page)).toBe('Finish');
});

test('first run: a folder whose files all go unnamed ends on what was found, never Welcome again', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockNoMatch', '1');
    localStorage.setItem('kinemaMockReview', 'items');
  });
  await firstRunToSetupPage(page, 'windows', 'Picture and sound');
  // Through every page to Finish, by remote.
  for (let i = 0; i < 8 && (await page.locator('.setup-pages').count()) > 0; i++) {
    for (let j = 0; j < 4 && !/^(Next|Finish)$/.test((await focused(page)) ?? ''); j++) {
      await press(page, 'ArrowUp');
    }
    await press(page, 'Enter');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.setup-pages')).toHaveCount(0);

  // Not the Welcome page and its setup again (INBOX #10): what was found.
  await expect(page.locator('.nothing-named h1')).toContainText('could not name them');
  await expect(page.locator('.first-run h1', { hasText: 'Welcome' })).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Review them');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Add another folder');

  // Review them opens the queue, on its own button.
  await press(page, 'ArrowLeft');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Folders');
  await expect.poll(() => focused(page)).toMatch(/review/i);
});

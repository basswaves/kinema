/**
 * The watching path and the capability-driven screens, by keyboard alone, in
 * each engine `playwright.config.ts` lists. Nothing here touches the mouse:
 * one stray hover repairs focus and hides the failure (CONTRIBUTING, "Two
 * failure modes").
 */
import { expect, test, type Page } from '@playwright/test';

/** Presses far enough apart that the app sees two (docs/GOTCHAS.md). */
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

/** The text of the control the focus ring is on. */
function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('.focused')?.textContent?.trim());
}

interface FakeMpv {
  path: string | null;
  paused: boolean;
  position: number;
}

function mpv(page: Page): Promise<FakeMpv> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    return { path: f.path, paused: f.paused, position: f.position };
  });
}

/** Switch TV mode on through the app's own module, as Settings would. */
async function tvMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = '/src/ui/tv.ts';
    const tv = await import(/* @vite-ignore */ path);
    await tv.setTvMode(true);
  });
}

/**
 * Home's hero is a different title each calendar day (hero.ts); the flows
 * that press its Play need it to be the fixture show, so they run on a
 * fixed day. Only those: with the date fixed, key presses all carry the
 * same time, and the navigation the other flows rely on takes them for
 * repeats.
 */
async function onFixtureDay(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00'));
}

/** Open the mock as a given system (`kinemaMockSystem`), Home focused. */
async function open(page: Page, system: 'windows' | 'linux'): Promise<void> {
  await page.addInitScript((s) => {
    if (s === 'linux') localStorage.setItem('kinemaMockSystem', 'linux');
    else localStorage.removeItem('kinemaMockSystem');
  }, system);
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

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
    await expect(page.locator('.browse-notice')).toHaveText(notice);
    // Only a notice: focus stays where it was, and Play still plays.
    expect(await focused(page)).toContain('Play');
    await press(page, 'Enter');
    await expect.poll(async () => (await mpv(page)).path).not.toBeNull();
  });
}

for (const [label, system, noPower, choices] of [
  ['windows', 'windows', false, ['Close Kinema', 'Put the PC to sleep', 'Shut down the PC', 'Cancel']],
  ['linux', 'linux', false, ['Close Kinema', 'Put the PC to sleep', 'Shut down the PC', 'Cancel']],
  // A system whose logind will not let Kinema, or has none (power.rs).
  ['linux without logind', 'linux', true, ['Close Kinema', 'Cancel']],
] as const) {
  test(`Leave offers what ${label} can do`, async ({ page }) => {
    if (noPower) await page.addInitScript(() => localStorage.setItem('kinemaMockNoPower', '1'));
    await open(page, system);
    await tvMode(page);
    await press(page, 'Escape');
    await expect(page.locator('.leave-choice')).toHaveText([...choices]);
    await expect.poll(() => focused(page)).toBe('Close Kinema');
    await press(page, 'ArrowDown', choices.length - 1);
    await expect.poll(() => focused(page)).toBe('Cancel');
  });
}

for (const [system, sections] of [
  ['windows', ['Screen', 'Sound', 'Your equipment']],
  // Linux: sound, what it cannot do yet, then the equipment it can see.
  ['linux', ['Sound', 'Picture & sound', 'Your equipment']],
] as const) {
  test(`Picture & sound shows what ${system} can do`, async ({ page }) => {
    await open(page, system);
    await press(page, 'ArrowUp', 2);
    await expect.poll(() => focused(page)).toBe('Home');
    await press(page, 'ArrowRight', 4);
    await expect.poll(() => focused(page)).toBe('Settings');
    await press(page, 'Enter');
    await press(page, 'ArrowDown');
    await expect.poll(() => focused(page)).toBe('Library');
    // A column down the left at this width (a row of tabs when narrower).
    await press(page, 'ArrowDown', 2);
    await expect.poll(() => focused(page)).toBe('Picture & sound');
    await press(page, 'Enter');
    await expect(page.locator('.settings-section h2')).toHaveText([...sections]);
    // Nothing about Windows' mixer where there is none.
    const equipment = page
      .locator('.settings-section')
      .filter({ has: page.locator('h2', { hasText: 'Your equipment' }) });
    await expect(equipment).toContainText(system === 'linux' ? 'What Linux reports' : 'What Windows reports');
    if (system === 'linux') await expect(equipment).not.toContainText('Windows');
  });
}

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
  for (let i = 0; i < 4 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
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
  await expect(page.locator('.setup-progress')).toContainText('1 of 4');
  await press(page, 'Enter');

  // Intros and credits: the current answers shown, the ring on the first.
  await expect(page.locator('.setup-pages h1')).toHaveText('Intros and credits');
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
  await expect(page.locator('.setup-pages h1')).toHaveText('Intros and credits');

  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'Enter');

  // Accounts: Settings' own sections, the ring on the first Connect.
  await expect(page.locator('.setup-pages h1')).toHaveText('Accounts');
  await expect(page.locator('.setup-page h2')).toHaveCount(3);
  await expect.poll(() => focused(page)).toBe('Connect SIMKL');
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'Enter');

  // Extras: the mock has no ffmpeg, so where to get it and where it is.
  await expect(page.locator('.setup-pages h1')).toHaveText('Extras');
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await expect.poll(() => focused(page)).toBe('Open the ffmpeg download page ↗');
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
  await press(page, 'ArrowRight', 4);
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
  await press(page, 'ArrowRight', 4);
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
  for (let i = 0; i < 4 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Intros and credits');
  await expect(page.locator('.setup-progress')).toContainText('1 of 3');
  await press(page, 'ArrowUp');
  // Nothing chosen, and the way on still says Next: it accepts what is shown.
  await expect.poll(() => focused(page)).toBe('Next');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Finish later');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');

  // Settings → Playback has no desk-or-TV row, and the key list no F11.
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 4);
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

/**
 * Through the first run by remote, with one folder, to the setup page titled
 * `title` — passing the pages before it with their way on. Switches for the
 * mock go in an init script first.
 */
async function firstRunToSetupPage(
  page: Page,
  system: 'android' | 'windows',
  title: string
): Promise<void> {
  await page.goto('/');
  if (system === 'windows') {
    await expect.poll(() => focused(page)).toBe('A TV, from the sofa');
    await press(page, 'Enter');
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  if (system === 'android') {
    await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
    await press(page, 'Enter');
    await press(page, 'ArrowUp');
    await expect.poll(() => focused(page)).toBe('Use this folder');
    await press(page, 'Enter');
  }
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
  for (let i = 0; i < 4 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  for (let i = 0; i < 4 && (await page.locator('.setup-pages h1').textContent()) !== title; i++) {
    await expect.poll(() => focused(page)).not.toBeUndefined();
    for (let j = 0; j < 4 && (await focused(page)) !== 'Next'; j++) {
      await press(page, 'ArrowUp');
    }
    await press(page, 'Enter');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.setup-pages h1')).toHaveText(title);
}

for (const system of ['android', 'windows'] as const) {
  test(`${system}: a setup page with nothing to press keeps the ring on Next`, async ({ page }) => {
    // A build without SIMKL's or Trakt's app and without an OpenSubtitles key
    // — every build but a release — has nothing to press on Accounts. The
    // ring went nowhere a moment after arriving, for good (found on a box).
    await page.setViewportSize({ width: 960, height: 540 });
    await page.addInitScript((s) => {
      if (s === 'android') localStorage.setItem('kinemaMockSystem', 'android');
      localStorage.setItem('kinemaMockEmpty', '1');
      localStorage.setItem('kinemaMockNoAccountApps', '1');
    }, system);
    await firstRunToSetupPage(page, system, 'Accounts');
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
    await expect(page.locator('.setup-pages h1')).toHaveText('Extras');
  });
}

test('a setup page whose question comes late still starts on it, unless the remote was used', async ({
  page,
}) => {
  // Extras asks whether ffmpeg is there before it shows anything; on a busy
  // computer that took longer than the page waits (seen once under load).
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockSlowFfmpeg', '1');
  });
  await firstRunToSetupPage(page, 'windows', 'Extras');
  // Meanwhile the ring is on the way on (the last page's: Finish), never
  // nowhere…
  await expect.poll(() => focused(page)).toBe('Finish');
  // …and goes to the first question when it arrives.
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await expect.poll(() => focused(page)).toBe('Open the ffmpeg download page ↗');

  // Back, and on again: this time a key is pressed before the question comes,
  // and the ring stays where the person has it.
  await press(page, 'Escape');
  await expect(page.locator('.setup-pages h1')).toHaveText('Accounts');
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Next'; i++) await press(page, 'ArrowUp');
  await press(page, 'Enter');
  await expect(page.locator('.setup-pages h1')).toHaveText('Extras');
  await expect.poll(() => focused(page), { timeout: 2500 }).toBe('Finish');
  await press(page, 'ArrowDown');
  await expect(page.locator('.setup-page')).toContainText('ffmpeg is not installed');
  await page.waitForTimeout(500);
  expect(await focused(page)).toBe('Finish');
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
  await press(page, 'ArrowRight', 4);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 6 && (await focused(page)) !== 'Intro & credits'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const section = page.locator('.settings-section');
  await expect(section.locator('h2')).toHaveText(['Intro and credits']);
  await expect(section).toContainText('cannot listen to the episodes itself');
  await expect(section.locator('h3')).toHaveText(['TheIntroDB', 'IntroDB']);
  await expect(section).not.toContainText('ffmpeg');
  await expect(section).not.toContainText('Skiptro');
});

test('the equipment notice: Choose when never asked, Use it too for only these', async ({ page }) => {
  await open(page, 'windows');
  const api = (name: string, ...args: string[]) =>
    page.evaluate(
      async ([n, a]) => {
        const path = '/src/metadata/api.ts';
        const mod = await import(/* @vite-ignore */ path);
        return mod[n as string](...(a as string[])) as Promise<string | null>;
      },
      [name, args] as const
    );
  const toNotice = async (button: string) => {
    for (let i = 0; i < 4 && (await focused(page)) !== button; i++) await press(page, 'ArrowDown');
    await expect.poll(() => focused(page)).toBe(button);
  };

  // Never answered: the notice sends the question to Settings.
  await toNotice('Choose');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Screen');

  // Answered "only these" with the monitor alone, the rest off: only the TV
  // is mentioned, and Use it too adds it.
  await api('setSetting', 'display_switch_refresh', 'these');
  await api('setSetting', 'display_switch_refresh_devices', JSON.stringify(['mock-monitor']));
  await api('setSetting', 'display_switch_hdr', 'off');
  await api('setSetting', 'audio_direct', 'off');
  // Back lands on the button it left from, now asking the new question.
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe('Use it too');
  await expect(page.locator('.home-notice').first()).toContainText('Something connected can do more');
  await expect(page.locator('.home-notice li')).toHaveCount(1);
  await press(page, 'Enter');
  await expect
    .poll(() => api('getSetting', 'display_switch_refresh_devices'))
    .toBe(JSON.stringify(['mock-monitor', 'mock-tv']));
  await expect(page.locator('.home-notice li')).toHaveCount(0);
  // The button went with the notice; the ring goes somewhere, not nowhere.
  await expect.poll(() => focused(page)).toBeTruthy();
});

test('Settings: Up and Down stay in the open section, Left goes to the list', async ({ page }) => {
  // A TV's size, where Library is longer than the screen: Up from its last
  // item went to the section list beside it, not the item above.
  await page.setViewportSize({ width: 960, height: 540 });
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 4);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Library');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 30 && (await focused(page)) !== 'Run setup again'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Run setup again');

  const place = () =>
    page.evaluate(() => {
      const el = document.querySelector('.focused');
      if (!el) return 'none';
      if (el.closest('.settings-nav')) return 'list';
      return el.closest('.settings-content') ? 'section' : 'top bar';
    });
  const seen: string[] = [];
  for (let i = 0; i < 30 && (await place()) === 'section'; i++) {
    seen.push((await focused(page)) ?? '');
    await press(page, 'ArrowUp');
  }
  // Up through every item to the first, then on to the bar at the top.
  expect(await place()).toBe('top bar');
  expect(seen).toContain('Add movies folder');

  // Left goes to the list, onto the open section (after the buttons to the
  // left in the same row); Right comes back to where one was.
  for (let i = 0; i < 6 && (await focused(page)) !== 'Run setup again'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Run setup again');
  let left = '';
  for (let i = 0; i < 4 && (await place()) === 'section'; i++) {
    left = (await focused(page)) ?? '';
    await press(page, 'ArrowLeft');
  }
  await expect.poll(() => focused(page)).toBe('Library');
  await press(page, 'ArrowRight');
  expect(await place()).toBe('section');
  expect(await focused(page)).toBe(left);
});

test('Down with nothing further down reads on, and Up reads back', async ({ page }) => {
  // A film's page ends in its picture and sound badges under Play, never
  // focusable; in a short window they are more than fits beneath it.
  await open(page, 'windows');
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play');
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.waitForTimeout(400);
  const lastRow = page.locator('.media-badges .badge-row').last();
  const rowShown = () =>
    lastRow.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight);
  expect(await rowShown()).toBe(false);

  for (let i = 0; i < 6 && !(await rowShown()); i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(400);
  }
  expect(await rowShown()).toBe(true);
  expect(await focused(page)).toBe('▶ Play');

  // Back up: Play comes back into view before focus moves anywhere.
  const inView = () =>
    page.evaluate(() => {
      const r = document.querySelector('.focused')?.getBoundingClientRect();
      return r ? r.top >= 0 && r.bottom <= window.innerHeight : false;
    });
  for (let i = 0; i < 6 && !(await inView()); i++) {
    await press(page, 'ArrowUp');
    await page.waitForTimeout(400);
  }
  expect(await inView()).toBe(true);
  expect(await focused(page)).toBe('▶ Play');
});

test('reading on and back never leaves the ring half under the top bar', async ({ page }) => {
  // Picture & sound ends in text below its last button. Reading on, then
  // back, left that button half under the see-through bar at the page's end.
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 4);
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Picture & sound'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 20 && (await focused(page)) !== 'Check again'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Check again');

  const halfHidden = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.top-nav')!.getBoundingClientRect();
      const el = document.querySelector('.focused')!;
      const r = el.getBoundingClientRect();
      return !el.closest('.top-nav') && r.top < bar.bottom - 1 && r.bottom > 0;
    });
  const atEnd = () =>
    page.evaluate(() => {
      const el = document.querySelector('.browse')!;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    });
  for (let i = 0; i < 6 && !(await atEnd()); i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(500);
    expect(await halfHidden()).toBe(false);
  }
  await press(page, 'ArrowDown');
  await page.waitForTimeout(500);
  expect(await halfHidden()).toBe(false);
  expect(await focused(page)).toBe('Check again');
  // Back up the section to its first item: each one clear of the bar.
  for (let i = 0; i < 5; i++) {
    await press(page, 'ArrowUp');
    await page.waitForTimeout(500);
    expect(await halfHidden()).toBe(false);
  }
});

test('Android: the system keyboard opens on OK, never on arriving at a field', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Search'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  const box = page.locator('.search-input');
  await expect(box).toBeFocused();
  // Typing focus, with the system's keyboard held back...
  await expect(box).toHaveAttribute('inputmode', 'none');
  // ...while a plugged-in keyboard types as ever.
  await page.keyboard.type('exa');
  await expect(box).toHaveValue('exa');
  // OK (Shift+Enter, as MainActivity sends it) asks for the system's
  // keyboard, and the box keeps typing focus.
  await press(page, 'Shift+Enter');
  await expect(box).toHaveAttribute('inputmode', 'text');
  await expect(box).toBeFocused();
  // Moving on lets go, and the next arrival holds the keyboard back again.
  await press(page, 'ArrowDown');
  await expect(box).not.toBeFocused();
  await press(page, 'ArrowUp');
  await expect(box).toHaveAttribute('inputmode', 'none');
});

async function androidSettings(page: Page, section: string): Promise<void> {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Settings'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 8 && (await focused(page)) !== section; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
}

test('Android: a web page nothing can open is shown as its address and a QR code', async ({
  page,
}) => {
  await androidSettings(page, 'Library');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Get a free TMDB key ↗'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const card = page.locator('.link-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('https://www.themoviedb.org');
  await expect(card.locator('img.simkl-qr')).toBeVisible();
  await expect.poll(() => focused(page)).toBe('Close');
  // Back puts it away, and the ring back on the button.
  await press(page, 'Escape');
  await expect(card).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Get a free TMDB key ↗');
  await expect(page.locator('.settings-section h2').first()).toBeVisible();
});

test('Android: the log is shared, and no folder is offered to open', async ({ page }) => {
  await androidSettings(page, 'Advanced');
  const advanced = page.locator('.settings-content, .settings-layout').last();
  await expect(advanced).toContainText('Share the log');
  await expect(advanced).not.toContainText('Open log folder');
  await expect(advanced).not.toContainText('Open the folder of copies');
  await expect(advanced).not.toContainText('mpv.log');
  // Beside "Show developer tools", in the same row.
  for (let i = 0; i < 20 && (await focused(page)) !== 'Show developer tools'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Share the log');
  await press(page, 'Enter');
  await expect(page.locator('.settings-error, .settings-warn')).toHaveCount(0);
});

test('Android: a kept network sign-in is listed, and forgotten by remote', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockShareLogin', '1'));
  await androidSettings(page, 'Library');
  const section = page.locator('.settings-section', { hasText: 'Saved network logins' });
  await expect(section).toContainText('nas');
  await expect(section).toContainText('films');
  // Down from the folders' buttons, as a remote gets there.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Forget');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Forget it');
  await press(page, 'Enter');
  // Nothing kept, nothing to list.
  await expect(section).toHaveCount(0);
  await expect(page.locator('.settings-section h2').first()).toHaveText('Folders');
});

test('a computer opens shares itself, so it lists no network sign-ins', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockShareLogin', '1'));
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Settings'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Folders');
  await expect(page.locator('.settings-section', { hasText: 'Saved network logins' })).toHaveCount(0);
});

test('Android: a folder on a network drive, signed in to and chosen by remote', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  const browser = page.locator('.folder-browser');
  await expect(browser.locator('.folder-where')).toContainText('or a network drive');

  // Network drives, after the drives.
  await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
  for (let i = 0; i < 4 && !(await focused(page))?.startsWith('Network drives'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives');
  // The NAS that announced itself, and a way to type one that did not.
  await expect.poll(() => focused(page)).toBe('Living room NASnas');
  await expect(browser).toContainText('Type an address');

  // No sign-in yet: the NAS asks for one. A wrong password is said so.
  await press(page, 'Enter');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives › Living room NAS');
  const name = browser.locator('input').first();
  const password = browser.locator('input[type=password]');
  await expect(name).toBeFocused();
  await page.keyboard.type('films');
  await press(page, 'ArrowDown');
  await expect(password).toBeFocused();
  await page.keyboard.type('wrong');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Connect');
  await press(page, 'Enter');
  await expect(browser.locator('.leave-error')).toHaveText('nas did not accept that user name and password.');
  await press(page, 'ArrowUp');
  await expect(password).toBeFocused();
  await password.fill('secret');
  await press(page, 'ArrowDown');
  await press(page, 'Enter');

  // Its shares, then a share's folders, as a drive's.
  await expect.poll(() => focused(page)).toBe('films');
  await expect(browser).toContainText('tv');
  await press(page, 'Enter');
  await expect(browser.locator('.folder-where')).toHaveText('films on Living room NAS');
  await expect.poll(() => focused(page)).toBe('A film (2001)');

  // Back from the share's top: the shares; again: the servers, now signed in.
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe('films');
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe('Living room NASSigned in');
  // Signed in, it opens straight to the shares.
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('films');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('A film (2001)');

  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Use this folder');
  await press(page, 'Enter');
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.root-path')).toHaveText('smb://nas/films');

  // Opened again: Back from the servers lands on Network drives.
  await press(page, 'Enter');
  for (let i = 0; i < 4 && !(await focused(page))?.startsWith('Network drives'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Living room NASSigned in');
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toBe('Network drivesA NAS, or a folder shared by a computer');
});

test('Android: a NAS that does not announce itself, typed, and its share named', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockShareLogin', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  const browser = page.locator('.folder-browser');
  for (let i = 0; i < 4 && !(await focused(page))?.startsWith('Network drives'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Type an addressA computer or a NAS not listed'; i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  const field = browser.locator('input');
  await expect(field).toBeFocused();
  // A mistyped address is caught before any user name is asked for. The
  // keyboard's Enter goes to Next; Next checks.
  await page.keyboard.type('nsa');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Next');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives');
  await press(page, 'Enter');
  await expect(browser.locator('.leave-error')).toContainText('Nothing answers as a network drive at nsa');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives');
  // The form people copy an address in is forgiven.
  await field.fill('\\\\nas\\films');
  await press(page, 'ArrowUp');
  await expect(field).toBeFocused();
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives › nas');
  await expect(browser.locator('input').first()).toBeFocused();
});

test('Android: OK opens the keyboard, its Enter moves on, and Connect waits to be pressed', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  for (let i = 0; i < 4 && !(await focused(page))?.startsWith('Network drives'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Living room NASnas');
  await press(page, 'Enter');
  const browser = page.locator('.folder-browser');
  const name = browser.locator('input').first();
  const password = browser.locator('.folder-password input');
  // The form at the top, clear of the system's keyboard.
  await expect(page.locator('.leave-backdrop')).toHaveClass(/typing/);
  // Arriving holds the keyboard back; the remote's OK opens it, and only that.
  await expect(name).toHaveAttribute('inputmode', 'none');
  await press(page, 'Shift+Enter');
  await expect(name).toHaveAttribute('inputmode', 'text');
  await expect(name).toBeFocused();
  await page.keyboard.type('Films');
  // Typed as typed: nothing capitalised or corrected by the system.
  await expect(name).toHaveAttribute('autocapitalize', 'none');
  // The keyboard's Enter moves on, and the keyboard goes with it...
  await press(page, 'Enter');
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute('inputmode', 'text');
  // ...where OK still only opens it, never connects.
  await press(page, 'Shift+Enter');
  await expect(password).toBeFocused();
  await page.keyboard.type('secret');
  // The cursor arrows move through the text, not off the field...
  await press(page, 'ArrowLeft', 2);
  await expect(password).toBeFocused();
  await expect.poll(() => password.evaluate((i: HTMLInputElement) => i.selectionStart)).toBe(4);
  // ...and at its end Right reaches Show, which shows what was typed.
  await press(page, 'End');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Show');
  await expect(password).toHaveAttribute('type', 'password');
  await press(page, 'Enter');
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('secret');
  await expect.poll(() => focused(page)).toBe('Hide');
  await press(page, 'ArrowLeft');
  await expect(password).toBeFocused();
  // From the password the keyboard's Enter goes to Connect, and stops there.
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Connect');
  await expect(browser).not.toContainText('films');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('films');
});

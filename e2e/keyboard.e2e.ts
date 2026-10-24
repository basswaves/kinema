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

/**
 * Whether the focused control is wholly on screen, below the top bar. Its own
 * box, without the zoom a focused control grows by (a few pixels past the
 * edge is the zoom, not the control).
 */
function focusedOnScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ring = document.querySelector<HTMLElement>('.focused');
    if (!ring) return false;
    const bar = document.querySelector('.top-nav')?.getBoundingClientRect().bottom ?? 0;
    const r = ring.getBoundingClientRect();
    const middle = (r.top + r.bottom) / 2;
    const top = middle - ring.offsetHeight / 2;
    const bottom = middle + ring.offsetHeight / 2;
    return top >= bar - 1 && bottom <= window.innerHeight + 1;
  });
}

// TV-FEEL N9 and N8, at a TV's layout: Home's notice opens Settings with the
// Review button in sight, and an item opened by remote brings what opened
// into sight with it.
test('needs attention by remote: the Review button and an opened item are on screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockReview', 'items'));
  await open(page, 'windows');
  await tvMode(page);
  for (let i = 0; i < 4 && (await focused(page)) !== 'Review'; i++) await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Review');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);
  await expect.poll(() => focusedOnScreen(page)).toBe(true);

  // The queue is open already: Home's notice asked for it.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await press(page, 'Enter');
  const box = page.locator('.fixmatch-row.open .fixmatch-input').first();
  await expect(box).toBeVisible();
  await expect
    .poll(() =>
      box.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      })
    )
    .toBe(true);
});

// LOCAL-MEDIA.md phase 3: what no database lists is kept under its own name,
// renamed on its own page, and sent back to be matched after all — the whole
// way by remote.
test('add without a match, rename it, and send it back to find a match', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockReview', 'items'));
  await open(page, 'windows');
  const placeholder = () =>
    page.evaluate(() => document.querySelector('.focused')?.getAttribute('placeholder'));
  for (let i = 0; i < 4 && (await focused(page)) !== 'Review'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);

  // The series' row, opened; under its search, the name it came with.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Sample Series');
  await press(page, 'Enter');
  for (let i = 0; i < 4 && (await placeholder()) !== 'Name'; i++) await press(page, 'ArrowDown');
  expect(await placeholder()).toBe('Name');
  await expect(page.locator('.fixmatch-local .fixmatch-input').first()).toHaveValue('Sample Series');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Our Holiday');
  await press(page, 'Enter');
  await expect(page.getByText('Added “Our Holiday” to TV shows without a match.')).toBeVisible();
  // Gone from the queue, and the ring on what is left rather than lost.
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await expect(page.locator('.fixmatch-title', { hasText: 'Sample Series' })).toHaveCount(0);

  // In TV shows, newest first.
  for (let i = 0; i < 8 && !(await focused(page))?.startsWith('Settings'); i++) {
    await press(page, 'ArrowUp');
  }
  await press(page, 'ArrowLeft', 3);
  await expect.poll(() => focused(page)).toBe('TV shows');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Our Holiday');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play S02E03');

  // Renamed in place (past My list, which sits beside Play).
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('+ My list');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Rename');
  await press(page, 'Enter');
  await expect.poll(placeholder).toBe('Name');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Summer by the Sea');
  await press(page, 'Enter');
  await expect(page.locator('.detail h1')).toHaveText('Summer by the Sea');
  await expect.poll(() => focused(page)).toBe('Rename');

  // Find a match: back in the queue, which opens on its Review button.
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Find a match');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);
  await expect(page.locator('.fixmatch-title', { hasText: 'Sample Series' })).toHaveCount(1);
});

// Matched by hand afterwards (or with a TMDB key added since), nothing waits
// any more, and Home stops saying that films do (owner, 2026-10-09).
test("the startup scan's notice: Wikipedia's line goes once nothing waits", async ({ page }) => {
  const busy = 'A film: Wikimedia is busy: Wikidata query: HTTP 503';
  await page.addInitScript((e) => {
    localStorage.setItem('kinemaMockScanErrors', e);
    if (!sessionStorage.getItem('reviewSet')) {
      localStorage.setItem('kinemaMockReview', '2');
      sessionStorage.setItem('reviewSet', '1');
    }
  }, JSON.stringify([busy]));
  await open(page, 'windows');
  const notice = page.locator('.home-notice-scan .home-notice-text');
  await expect(notice).toHaveText(
    'Wikipedia was busy, so some films wait to be matched until the next scan'
  );

  // Both matched in Settings; back on Home, the line is gone.
  await page.evaluate(() => localStorage.setItem('kinemaMockReview', '0'));
  // One Up: an empty Continue Watching once caught it, with this line
  // pushing Home down, and the ring vanished.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Home');
  await press(page, 'ArrowRight', 5);
  // With its badge: still 2 to review when Home was read.
  await expect.poll(() => focused(page)).toBe('Settings2');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section').first()).toBeVisible();
  // Settings read the queue again, and the badge above it follows at once —
  // it used to keep its 2 until another tab was opened.
  await expect(page.locator('.top-nav .nav-badge')).toHaveCount(0);
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toContain('Play');
  await expect(notice).toHaveCount(0);
});

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
    await press(page, 'ArrowRight', 5);
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
  for (let i = 0; i < 5 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  for (let i = 0; i < 6 && (await page.locator('.setup-pages h1').textContent()) !== title; i++) {
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

  await press(page, 'Enter');
  // While it runs the button stays under the ring, and says so.
  await expect.poll(() => focused(page)).toBe('Installing…');
  await expect(notice).toContainText('Downloading ffmpeg');
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
  // The download page is reachable by remote from Try again.
  for (let i = 0; i < 3 && (await focused(page)) !== 'Open the ffmpeg download page ↗'; i++) {
    await press(page, 'ArrowDown');
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
  for (let i = 0; i < 12 && (await focused(page)) !== 'Install ffmpeg'; i++) {
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Install ffmpeg');
  const section = page.locator('.settings-content');
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
  await press(page, 'ArrowRight', 5);
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
  // left in the same row); Right comes back to where one was. Down visits
  // every row on the way, never skipping one (NAV-MAP 2026-10-11).
  for (let i = 0; i < 12 && (await focused(page)) !== 'Run setup again'; i++) await press(page, 'ArrowDown');
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

// Play only appears once the next episode is known, which on a slow box came
// after the episode list — and the page had already landed on an episode.
test("a series' page lands on Play even when the next episode is slow to find", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockSlowNextUp', '600'));
  await open(page, 'windows');
  // The fixture series from the first rail: the hero is a different title
  // each day (hero.ts), and on some days a film.
  const card = async () => (await focused(page)) ?? '';
  for (let i = 0; i < 8 && !(await card()).startsWith('Example'); i++) await press(page, 'ArrowDown');
  for (const way of ['ArrowLeft', 'ArrowRight']) {
    for (let i = 0; i < 4 && !(await card()).startsWith('Example Show'); i++) await press(page, way);
  }
  expect(await card()).toMatch(/^Example Show/);
  await press(page, 'Enter');
  await expect(page.locator('.detail')).toBeVisible();
  await expect.poll(() => focused(page)).toMatch(/^▶ (Play|Resume) S\d\dE\d\d/);
  await page.waitForTimeout(800);
  await expect.poll(() => focused(page)).toMatch(/^▶ (Play|Resume) S\d\dE\d\d/);
});

// White lettering on a solid plate went one white block; it is cut out now.
test('a studio logo with lettering on a plate keeps its lettering', async ({ page }) => {
  await open(page, 'windows');
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect(page.locator('.media-badge-logo.cut-out')).toHaveAttribute('alt', 'Mock Bros.');
  // A coloured word on nothing stays plain white.
  await expect(page.getByAltText('Example Pictures')).not.toHaveClass(/cut-out/);
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
  await press(page, 'ArrowRight', 5);
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

test("a rail's title stays clear of the top bar, going down and coming back up", async ({
  page,
}) => {
  // The page used to stop with the card just clear of the bar and the rail's
  // title hidden underneath it (TV-FEEL.md, N3).
  await open(page, 'windows');
  const headingClear = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.top-nav')!.getBoundingClientRect();
      const card = document.querySelector('.focused')!;
      const heading = card.closest('.rail')?.querySelector('.rail-heading');
      if (!heading) return null;
      return heading.getBoundingClientRect().top >= bar.bottom - 1;
    });
  const seen: (boolean | null)[] = [];
  // Down to the last rail, then back up: coming up into a rail is where its
  // title was left under the bar.
  for (let i = 0; i < 6; i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(500);
    seen.push(await headingClear());
  }
  const goingUp: (boolean | null)[] = [];
  for (let i = 0; i < 2; i++) {
    await press(page, 'ArrowUp');
    await page.waitForTimeout(500);
    goingUp.push(await headingClear());
  }
  // Every stop on a rail had its title in view (null: not on a rail), and
  // both presses up landed on one.
  expect(goingUp).not.toContain(null);
  expect([...seen, ...goingUp]).not.toContain(false);
});

/** Down through the open Settings section until a text box has the caret. */
async function downToTextBox(page: Page): Promise<void> {
  const typing = () => page.evaluate(() => document.activeElement?.tagName === 'INPUT');
  for (let i = 0; i < 30 && !(await typing()); i++) await press(page, 'ArrowDown');
  expect(await typing()).toBe(true);
}

/** Whether the box with the caret is below the top bar and in the upper part. */
function typingSpotOk(page: Page): Promise<{ ok: boolean; why: string }> {
  return page.evaluate(() => {
    const bar = document.querySelector('.top-nav')!.getBoundingClientRect();
    const box = document.activeElement!.getBoundingClientRect();
    const height = window.visualViewport?.height ?? window.innerHeight;
    const ok = box.top >= bar.bottom - 1 && box.bottom <= height * 0.45 + 1;
    return { ok, why: `box ${box.top}-${box.bottom}, bar ${bar.bottom}, visible ${height}` };
  });
}

test('Android: OK on a text box puts it in the upper screen, clear of the keyboard', async ({
  page,
}) => {
  // TV-FEEL.md, N10: the system's keyboard covered the box being typed in.
  await androidSettings(page, 'Language & subtitles');
  await downToTextBox(page);
  await press(page, 'Shift+Enter');
  await page.waitForTimeout(200);
  const spot = await typingSpotOk(page);
  expect(spot.ok, spot.why).toBe(true);
  // Moving on gives back any room added under the page.
  await press(page, 'ArrowDown');
  await expect(page.locator('.browse')).not.toHaveAttribute('style', /padding-bottom/);
});

test('the visible area shrinking while typing moves the box up out of the way', async ({
  page,
}) => {
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Settings'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 8 && (await focused(page)) !== 'Skipping intros'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
  await downToTextBox(page);
  // A keyboard on screen takes the lower half, as Windows' touch keyboard
  // does to a window.
  await page.setViewportSize({ width: 1280, height: 360 });
  await page.waitForTimeout(300);
  const spot = await typingSpotOk(page);
  expect(spot.ok, spot.why).toBe(true);
});

test('on a slow computer every quick Up still moves the ring', async ({ page }) => {
  // A slow computer's smooth scroll arrives late. A control just moved to was
  // then still above the screen at the next press, and Up spent that press
  // scrolling back as if reading on had left it there (CI's Linux WebKit).
  await page.addInitScript(() => {
    for (const name of ['scrollIntoView', 'scrollBy', 'scrollTo'] as const) {
      const own = Element.prototype[name] as (this: Element, ...args: unknown[]) => void;
      Element.prototype[name] = function (this: Element, ...args: unknown[]) {
        const options = args[0] as { behavior?: string } | undefined;
        if (typeof options !== 'object' || options?.behavior !== 'smooth') return own.apply(this, args);
        window.setTimeout(() => own.call(this, { ...options, behavior: 'auto' }), 400);
      } as never;
    }
  });
  await open(page, 'windows');
  await page.setViewportSize({ width: 1280, height: 300 });
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Picture & sound'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 20 && (await focused(page)) !== 'Check again'; i++) await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Check again');
  await page.waitForTimeout(600);

  // Several controls here say "Off", so each is told apart by a mark of its own.
  const ring = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.focused');
      if (!el) return 'nothing';
      el.dataset.seen ??= String(document.querySelectorAll('[data-seen]').length);
      return `${el.dataset.seen} ${el.textContent?.trim()}`;
    });
  const seen = [await ring()];
  for (let i = 0; i < 5; i++) {
    await press(page, 'ArrowUp');
    seen.push(await ring());
  }
  expect(new Set(seen).size, seen.join(' / ')).toBe(seen.length);
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

test('Settings → Privacy lists what leaves the computer, and goes to the switch that stops it', async ({
  page,
}) => {
  await open(page, 'windows');
  await press(page, 'ArrowUp', 2);
  await press(page, 'ArrowRight', 5);
  await expect.poll(() => focused(page)).toBe('Settings');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 12 && (await focused(page)) !== 'Privacy'; i++) {
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Privacy');
  await press(page, 'Enter');
  const section = page.locator('.what-leaves');
  await expect(section.locator('h2')).toHaveText('What leaves your computer');
  await expect(section).toContainText('api.themoviedb.org');
  await expect(section).toContainText('www.youtube.com (trailers)');
  // The mock has the intro lookups on (unset means on).
  await expect(section.locator('li', { hasText: 'TheIntroDB' })).toContainText('On');
  if (await page.evaluate(() => Boolean(document.querySelector('.settings-nav .focused')))) {
    await press(page, 'ArrowRight');
  }
  for (let i = 0; i < 12 && (await focused(page)) !== 'Go to Skipping intros'; i++) {
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Go to Skipping intros');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Skipping intros');
  // In the section, not back on the list beside it.
  await expect
    .poll(() => page.evaluate(() => Boolean(document.querySelector('.settings-content .focused'))))
    .toBe(true);
});

test('Developer tools: Send a report says which file to attach, and opens the form only on its own press', async ({
  page,
}) => {
  // Developer tools are made for a mouse on a desktop (notes/CLAUDE.md).
  await open(page, 'windows');
  await page.locator('.top-bar button, nav button', { hasText: 'Settings' }).first().click();
  await page.locator('.settings-nav button', { hasText: 'Advanced' }).click();
  const tools = page.locator('.settings-section', { hasText: 'Developer tools' });
  await expect(tools).toContainText('Kinema sends nothing');
  await expect(tools).toContainText('replaced by ~');
  await tools.locator('button', { hasText: 'Send a report' }).click();
  await expect(tools.locator('.settings-ok')).toContainText(
    'Saved kinema-report-2026-10-23-1405.zip in C:\\Users\\you\\Downloads (app.log, app.previous.log, mpv.log, equipment.txt)'
  );
  const opened = () =>
    page.evaluate(
      () => (window as unknown as { __kinemaMock: { openedLinks: string[] } }).__kinemaMock.openedLinks
    );
  // The browser would cover the note: nothing opens until it is asked for.
  expect(await opened()).not.toContain('https://github.com/Basswaves/kinema/issues/new?template=bug_report.yml');
  await tools.locator('button', { hasText: 'Open the report form' }).click();
  await expect
    .poll(opened)
    .toContain('https://github.com/Basswaves/kinema/issues/new?template=bug_report.yml');
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

for (const system of ['windows', 'android'] as const) {
  test(`${system}: the system's Back button is listened for only where there is one`, async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
    });
    await page.addInitScript((s) => {
      if (s === 'android') localStorage.setItem('kinemaMockSystem', 'android');
      else localStorage.removeItem('kinemaMockSystem');
    }, system);
    await page.goto('/');
    await expect.poll(() => focused(page)).toContain('Play');
    await page.waitForTimeout(300);
    const asked = await page.evaluate(
      () => (window as unknown as { __kinemaMock: { backListeners: string[] } }).__kinemaMock.backListeners
    );
    // A desktop has no such button: nothing asked, and nothing in the log.
    expect(asked).toEqual(system === 'android' ? ['back-button'] : []);
    expect(warnings.filter((w) => w.includes('back button'))).toEqual([]);
  });
}

test('Android: a web page nothing can open is shown as its address and a QR code', async ({
  page,
}) => {
  await androidSettings(page, 'Posters & ratings');
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
  // Beside "Show developer tools", in the same row. Down from the Restore
  // buttons on the right lands on the nearer of the two.
  const row = ['Show developer tools', 'Share the log'];
  for (let i = 0; i < 20 && !row.includes((await focused(page)) ?? ''); i++) {
    await press(page, 'ArrowDown');
  }
  if ((await focused(page)) === 'Share the log') await press(page, 'ArrowLeft');
  await expect.poll(() => focused(page)).toBe('Show developer tools');
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

test('Android: a computer that shares no folder says so, and a typed path is explained', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockEmpty', '1');
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
  await browser.locator('input').fill('laptop');
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect(browser.locator('.folder-where')).toHaveText('Network drives › laptop');
  await browser.locator('input').first().fill('someone');
  await browser.locator('.folder-password input').fill('secret');
  await browser.getByRole('button', { name: 'Connect' }).click();
  // Nothing shared: said in words, with the ring on Try again.
  await expect(browser).toContainText('laptop shares no folders yet');
  await expect.poll(() => focused(page)).toBe('Try again');
  await press(page, 'Enter');
  await expect(browser).toContainText('laptop shares no folders yet');
  // A path on the laptop is not a share's name, and Open does not take it.
  const field = browser.locator('input');
  await field.fill('C:\\Users\\someone\\Downloads\\Movie');
  await expect(browser.locator('.leave-error')).toContainText(
    'That is a path on the computer, not a shared folder’s name. Type the name the folder is shared as, such as Movie'
  );
  await browser.getByRole('button', { name: 'Open' }).click();
  await expect(browser.locator('.folder-where')).toHaveText('Network drives › laptop');
  // A name the laptop does not share: its own words, never the status.
  await field.fill('Movie');
  await browser.getByRole('button', { name: 'Open' }).click();
  await expect(browser.locator('.leave-error')).toHaveText(
    'laptop has no shared folder called “Movie”. Pick one of the folders it shares, or share the folder on laptop first.'
  );
  await expect(browser).not.toContainText('0xc00000cc');
  await expect(browser).not.toContainText('No folders inside');
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

// A file far heavier than the video chip Android reports is made for gets a
// line under Play (heavyFile.ts): the fixture film averages 88 Mbit/s where
// the fake box reports 35 for HEVC. Read, never pressed; Play still works.
for (const system of ['android', 'windows'] as const) {
  test(`${system}: a film far above the video chip's limit is ${
    system === 'android' ? 'told so under Play' : 'not mentioned'
  }`, async ({ page }) => {
    await page.addInitScript((s) => {
      if (s === 'android') localStorage.setItem('kinemaMockSystem', 'android');
      else localStorage.removeItem('kinemaMockSystem');
    }, system);
    await page.goto('/');
    await expect.poll(() => focused(page)).toContain('Play');
    for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
      await press(page, 'ArrowDown');
    }
    await press(page, 'Enter');
    await expect.poll(() => focused(page)).toBe('▶ Play');
    // The badges have been read by now; the line is made from the same facts.
    await expect(page.locator('.media-badges')).toBeVisible();

    const note = page.locator('.heavy-file-note');
    if (system === 'windows') {
      await page.waitForTimeout(500);
      await expect(note).toHaveCount(0);
      return;
    }
    await expect(note).toHaveText(
      "Android says this device's video chip is made for up to 35 Mbit/s; this film averages about 88 Mbit/s. It may stutter or show no picture."
    );
    // Under the buttons, and the remote walks past it as it does the badges.
    expect(
      await page.evaluate(() => {
        const note = document.querySelector('.heavy-file-note')!.getBoundingClientRect();
        const play = document.querySelector('.btn-primary')!.getBoundingClientRect();
        return note.top >= play.bottom;
      })
    ).toBe(true);
    expect(await note.evaluate((el) => el.closest('[tabindex]') === null)).toBe(true);
    for (let i = 0; i < 4; i++) {
      await press(page, 'ArrowDown');
      expect(await focused(page)).not.toContain('Android says');
    }
  });
}

/** The first run, up to the point of picking a TV folder that holds two already added. */
async function pickFolderHoldingFolders(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockEmpty', '1');
    localStorage.setItem('kinemaMockMerge', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toBe('A TV, from the sofa');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Add TV folder');
  await press(page, 'Enter');
  // The offer names what would be merged, and the ring is on the button that does it.
  await expect(page.locator('.merge-offer')).toContainText('2 library folders');
  await expect.poll(() => focused(page)).toBe('Merge them');
}

test('a folder that holds folders already added: merged by remote', async ({ page }) => {
  await pickFolderHoldingFolders(page);
  await press(page, 'Enter');
  await expect(page.locator('.merge-offer')).toHaveCount(0);
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
});

test('a folder that holds folders already added: Not now leaves everything as it was', async ({ page }) => {
  await pickFolderHoldingFolders(page);
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Not now');
  await press(page, 'Enter');
  await expect(page.locator('.merge-offer')).toHaveCount(0);
  await expect(page.locator('.first-run-roots li')).toHaveCount(0);
});

test('Android: Home shows a new version beside the titles to review, as a computer does', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kinemaMockSystem', 'android');
    localStorage.setItem('kinemaMockUpdate', '99.0.0');
    localStorage.setItem('kinemaMockReview', '3');
  });
  await page.goto('/');
  const settings = page.locator('.top-nav button', { hasText: 'Settings' });
  await expect(settings.locator('.nav-badge')).toBeVisible();
  await expect(settings.locator('.nav-dot')).toBeVisible();
});

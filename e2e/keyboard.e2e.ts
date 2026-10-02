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
  // hidden OK takes whatever prompt is showing, no ring needed (Player.tsx).
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
  await expect(page.locator('.setup-progress')).toContainText('1 of 3');
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

  // On the last page the way on finishes, to the library.
  await press(page, 'ArrowUp');
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

  // Skip, then Finish later: straight back to the library.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Skip');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Finish later');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Play');
  await expect.poll(() => setting('setup_pages')).toBe('done');
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

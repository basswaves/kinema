/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): Privacy, developer tools, and Android: Back, web pages, shares, folders.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test } from '@playwright/test';
import { press, focused, open, androidSettings } from './kb';

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

/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): The equipment notice, Settings sections, reading on and back, typing, quick keys.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { press, focused, open, androidSettings, settled } from './kb';

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
  // A film's page ends in its file details under their button, never
  // focusable; in a short window they are more than fits beneath it.
  await open(page, 'windows');
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play');
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.waitForTimeout(400);
  const details = '▾ File details';
  for (let i = 0; i < 6 && !(await focused(page))?.includes('File details'); i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(200);
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe(details);
  await page.waitForTimeout(400);
  const lastRow = page.locator('.file-info-row').last();
  const rowShown = () =>
    lastRow.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight);
  expect(await rowShown()).toBe(false);

  for (let i = 0; i < 6 && !(await rowShown()); i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(400);
  }
  expect(await rowShown()).toBe(true);
  expect(await focused(page)).toBe(details);

  // Back up: the button comes back into view before focus moves anywhere.
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
  expect(await focused(page)).toBe(details);
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
    await settled(page);
    seen.push(await headingClear());
  }
  const goingUp: (boolean | null)[] = [];
  for (let i = 0; i < 2; i++) {
    await press(page, 'ArrowUp');
    await settled(page);
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

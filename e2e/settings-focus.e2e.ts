/**
 * Settings by keys, as the owner asked after round 7 F6 (2026-11-01):
 * (2) it scrolls by the rule every page has — the focused row a bit above
 * the middle once the page must scroll; (5) entering a section, and Up and
 * Down between rows of choices, lands on the leftmost choice, not the chosen
 * one (Settings only; the setup pages keep the chosen one); (7) Left to the
 * section list leaves the open section where it was read to, and Right comes
 * back to the same control — the top again only when another section is
 * opened, or Settings is left and entered again.
 */
import { expect, test, type Page } from '@playwright/test';
import { focusKey, focused, open, press, settled } from './kb';

const scrollTop = (page: Page) => page.evaluate(() => Math.round(document.querySelector('.browse')!.scrollTop));

async function settings(page: Page): Promise<void> {
  await open(page, 'windows');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.locator('.settings')).toBeVisible();
}

/** The section's entry in the list, with the ring on it (a click puts it there). */
async function onSection(page: Page, name: string): Promise<void> {
  await page.locator('.settings-nav button', { hasText: name }).first().click();
  await expect.poll(() => focusKey(page)).toMatch(/^settings-nav:/);
  await expect(page.locator('.settings-nav button.active')).toHaveText(name);
}

/** Where the ring is in its row of choices, and where the chosen one is (-1: not a choice row). */
const place = (page: Page) =>
  page.evaluate(() => {
    const f = document.querySelector('.focused');
    const row = f?.closest('.choice-options');
    const items = row ? Array.from(row.children) : [];
    return { at: items.indexOf(f!), chosen: items.findIndex((c) => c.classList.contains('chosen')) };
  });

test('a section is entered on its first row’s leftmost choice, and Up and Down land leftmost', async ({ page }) => {
  await settings(page);
  await onSection(page, 'Playback');
  // The first two rows answered with a choice that is not the leftmost.
  const rows = page.locator('.settings-content .choice-options');
  await rows.nth(0).locator('.choice').nth(1).click();
  await rows.nth(1).locator('.choice').nth(1).click();
  await expect(rows.nth(0).locator('.choice').nth(1)).toHaveClass(/chosen/);
  await expect(rows.nth(1).locator('.choice').nth(1)).toHaveClass(/chosen/);
  // Opened afresh: another section, then this one again.
  await onSection(page, 'Advanced');
  await onSection(page, 'Playback');
  await press(page, 'ArrowRight');
  expect(await place(page)).toEqual({ at: 0, chosen: 1 });
  await press(page, 'ArrowRight');
  expect((await place(page)).at).toBe(1);
  await press(page, 'ArrowDown');
  expect(await place(page)).toEqual({ at: 0, chosen: 1 });
  await press(page, 'ArrowUp');
  expect(await place(page)).toEqual({ at: 0, chosen: 1 });
});

test('Settings scrolls by the page rule: the focused row a bit above the middle', async ({ page }) => {
  await settings(page);
  await onSection(page, 'Picture & sound');
  await press(page, 'ArrowRight');
  let checked = 0;
  let onLine = 0;
  for (let i = 0; i < 14; i++) {
    const before = await focusKey(page);
    await press(page, 'ArrowDown');
    // The last control: Down reads on, which is not a row lined up.
    if ((await focusKey(page)) === before) break;
    await settled(page);
    const m = await page.evaluate(() => {
      const browse = document.querySelector<HTMLElement>('.browse')!;
      const f = document.querySelector('.focused')!;
      const row = (f.closest('.choice-options') ?? f).getBoundingClientRect();
      const bar = document.querySelector('[data-sticky-top]')!.getBoundingClientRect().bottom;
      return {
        top: row.top,
        bar,
        vh: browse.clientHeight,
        scroll: browse.scrollTop,
        end: browse.scrollTop >= browse.scrollHeight - browse.clientHeight - 1,
      };
    });
    // Once the page has had to scroll, and before it runs out at its end.
    if (m.scroll <= 0 || m.end) continue;
    checked++;
    expect(m.top, `Down ${i + 1}: under the bar`).toBeGreaterThanOrEqual(m.bar);
    // A third of the way down, as on Movies; a little lower where the row's
    // own heading stands right above it and goes there instead.
    expect(m.top, `Down ${i + 1}: above the middle (${Math.round(m.top)} of ${m.vh})`).toBeLessThan(m.vh * 0.55);
    if (Math.abs(m.top - m.vh / 3) <= 2) onLine++;
  }
  expect(checked).toBeGreaterThan(2);
  expect(onLine, 'rows at the third').toBeGreaterThan(2);
});

test('Left to the list keeps the section where it was; Right comes back to the same control', async ({ page }) => {
  await settings(page);
  await onSection(page, 'Picture & sound');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 6; i++) await press(page, 'ArrowDown');
  await settled(page);
  const at = await focusKey(page);
  const down = await scrollTop(page);
  expect(down).toBeGreaterThan(0);
  for (let i = 0; i < 4 && !(await focusKey(page))?.startsWith('settings-nav:'); i++) await press(page, 'ArrowLeft');
  expect(await focusKey(page)).toBe('settings-nav:picture');
  await settled(page);
  expect(await scrollTop(page)).toBe(down);
  await press(page, 'ArrowRight');
  await settled(page);
  expect(await focusKey(page)).toBe(at);
  expect(await scrollTop(page)).toBe(down);

  // Another section opened: its top.
  for (let i = 0; i < 4 && !(await focusKey(page))?.startsWith('settings-nav:'); i++) await press(page, 'ArrowLeft');
  await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-nav button.active')).toHaveText('Language & subtitles');
  await settled(page);
  expect(await scrollTop(page)).toBe(0);

  // Left and entered again: its top too.
  await press(page, 'ArrowRight');
  for (let i = 0; i < 6; i++) await press(page, 'ArrowDown');
  await settled(page);
  expect(await scrollTop(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Home' }).first().click();
  await expect.poll(() => focused(page), { timeout: 30_000 }).toBeTruthy();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.locator('.settings')).toBeVisible();
  await settled(page);
  expect(await scrollTop(page)).toBe(0);
});

// Owner, 2026-11-01: "Bring it in" could not be reached until both fields
// were filled (a disabled control is passed over). Reached by keys with the
// fields empty, it says which one to fill.
test('Bring it in is reached by keys with empty fields, and says which field to fill', async ({ page }) => {
  await settings(page);
  await onSection(page, 'Keep track of what I watch');
  await press(page, 'ArrowRight');
  for (let i = 0; i < 30 && (await focused(page)) !== 'Bring it in'; i++) await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Bring it in');
  await press(page, 'Enter');
  await expect(page.locator('.settings-warn')).toHaveText('Fill in the server’s address first.');
  await page.getByPlaceholder('http://192.168.1.10:8096').fill('http://192.168.1.10:8096');
  for (let i = 0; i < 4 && (await focused(page)) !== 'Bring it in'; i++) await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Bring it in');
  await press(page, 'Enter');
  await expect(page.locator('.settings-warn')).toHaveText('Fill in the API key first.');
});

test('in a small window the chosen section stays fully in view in the list (A10-07)', async ({ page }) => {
  await page.setViewportSize({ width: 854, height: 480 });
  await settings(page);
  const inView = () =>
    page.evaluate(() => {
      const b = document.querySelector('.settings-nav button.active')!.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: window.innerHeight };
    });
  const names = (await page.locator('.settings-nav button').allTextContents()).map((n) => n.trim());
  // The last sections, chosen by keys (Enter on the entry).
  for (const name of [names[names.length - 2], names[names.length - 1]]) {
    await page.locator('.settings-nav button', { hasText: name }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.settings-nav button.active')).toContainText(name);
    await settled(page);
    const r = await inView();
    expect(r.top, `${name} top`).toBeGreaterThanOrEqual(0);
    expect(r.bottom, `${name} bottom`).toBeLessThanOrEqual(r.height);
    // And with the page at its top, where the list is not stuck yet: CI's
    // WebKit got there by timing, so it is set here outright.
    await page.evaluate(() => {
      // The page scrolls in a box of its own, not the window.
      let box = document.querySelector('.settings-nav')!.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
        box = box.parentElement;
      (box ?? document.scrollingElement!).scrollTop = 0;
    });
    await settled(page);
    const top = await inView();
    expect(top.bottom, `${name} bottom, page at its top`).toBeLessThanOrEqual(top.height);
  }
  // By mouse: the first, then the last again.
  await page.locator('.settings-nav button').first().click();
  await settled(page);
  await page.locator('.settings-nav button', { hasText: names[names.length - 1] }).first().click();
  await settled(page);
  const r = await inView();
  expect(r.bottom).toBeLessThanOrEqual(r.height);
});

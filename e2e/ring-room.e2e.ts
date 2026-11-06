/**
 * The focus ring never covers text (owner, 2026-11-01): walked by keys over
 * the screens where it did — a setup page's choice rows with their captions,
 * the Poster dialog's line above Cancel — and Settings and a title page, at
 * every press, in TV mode (the ring is thickest there) and at a desk.
 * `ringCovers` (kb.ts) lists the text the ring is drawn over.
 */
import { expect, test, type Page } from '@playwright/test';
import { firstRunToSetupPage, focused, open, press, ringCovers, settled, tvMode } from './kb';

/** Every press of `keys`, the ring checked after each; returns what it covered, by control. */
async function walk(page: Page, keys: string[]): Promise<string[]> {
  const found: string[] = [];
  const check = async () => {
    await settled(page);
    const hits = await ringCovers(page);
    if (hits.length) found.push(`${await focused(page)} covers ${hits.join(' | ')}`);
  };
  await check();
  for (const key of keys) {
    await press(page, key);
    await check();
  }
  return found;
}

test('a setup page: the ring on each choice leaves the captions readable', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockEmpty', '1'));
  await firstRunToSetupPage(page, 'windows', 'Skipping intros');
  await expect.poll(() => focused(page)).toBe('✓Show a Skip button');
  expect(await walk(page, ['ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowRight'])).toEqual([]);
});

for (const tv of [true, false]) {
  test(`Home walked: the ring covers no text${tv ? ', TV mode' : ''}`, async ({ page }) => {
    await open(page, 'windows');
    if (tv) await tvMode(page);
    const keys = ['ArrowUp', 'ArrowRight', 'ArrowDown', ...Array(7).fill('ArrowDown'), 'ArrowRight', 'ArrowRight'];
    expect(await walk(page, keys)).toEqual([]);
  });

  test(`the Poster dialog: Cancel's ring leaves the line above it readable${tv ? ', TV mode' : ''}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('kinemaMockPeople', '1'));
    await open(page, 'windows');
    if (tv) await tvMode(page);
    await page.getByRole('button', { name: 'Movies' }).first().click();
    // A film with one picture: no row of choices, Cancel right under the words.
    await page.locator('.search .card', { hasText: 'Example Film' }).click();
    await expect(page.locator('.detail h1')).toHaveText('Example Film');
    for (let i = 0; i < 10 && !/^Poster/.test((await focused(page)) ?? ''); i++) await press(page, 'ArrowRight');
    await press(page, 'Enter');
    const dialog = page.getByRole('dialog', { name: 'Poster' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => focused(page)).toBe('Cancel');
    expect(await walk(page, ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'])).toEqual([]);
  });

  test(`Settings, every section walked: the ring covers no text${tv ? ', TV mode' : ''}`, async ({ page }) => {
    await open(page, 'windows');
    if (tv) await tvMode(page);
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.locator('.settings')).toBeVisible();
    const sections = await page.locator('.settings-nav button').count();
    expect(sections).toBeGreaterThan(5);
    const found: string[] = [];
    for (let s = 0; s < sections; s++) {
      found.push(...(await walk(page, ['ArrowRight', ...Array(14).fill('ArrowDown'), ...Array(3).fill('ArrowRight')])));
      for (let i = 0; i < 6; i++) await press(page, 'ArrowLeft');
      await press(page, 'ArrowDown');
    }
    expect(found).toEqual([]);
  });

  test(`a film page walked: the ring covers no text${tv ? ', TV mode' : ''}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('kinemaMockPeople', '1'));
    await open(page, 'windows');
    if (tv) await tvMode(page);
    await page.getByRole('button', { name: 'Movies' }).first().click();
    await page.locator('.search .card', { hasText: 'Example Part Two' }).click();
    await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
    const keys = [...Array(6).fill('ArrowRight'), ...Array(6).fill('ArrowDown'), 'ArrowRight', 'ArrowRight'];
    expect(await walk(page, keys)).toEqual([]);
  });
}

test('the search box stays under the top bar while results scroll, and the ring is never under it', async ({ page }) => {
  // A short window, so a few results already scroll.
  await page.setViewportSize({ width: 960, height: 320 });
  await open(page, 'windows');
  await page.evaluate(async () => {
    const path = '/src/ui/lightLook.ts';
    (await import(/* @vite-ignore */ path)).setLook('full');
  });
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Search'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  const box = page.locator('.search-bar');
  await expect(box).toBeVisible();
  // A letter every title has, so the grid is long.
  await page.keyboard.type('e');
  await press(page, 'ArrowDown', 12);
  await settled(page);
  const geometry = () =>
    page.evaluate(() => {
      const page = document.querySelector('.browse')!;
      const bar = document.querySelector('.search-bar')!.getBoundingClientRect();
      const nav = document.querySelector('.top-nav')!.getBoundingClientRect();
      const card = document.querySelector('.focused .card-art, .focused')!.getBoundingClientRect();
      return { scroll: page.scrollTop, barTop: bar.top, barBottom: bar.bottom, navBottom: nav.bottom, cardTop: card.top };
    });
  let g = await geometry();
  expect(g.scroll, 'the page scrolled').toBeGreaterThan(20);
  expect(g.barTop, 'the box is still on screen, under the top bar').toBeGreaterThanOrEqual(g.navBottom - 30);
  expect(g.barBottom, 'and visible').toBeGreaterThan(g.navBottom - 1);
  for (let i = 0; i < 8; i++) {
    await press(page, 'ArrowUp');
    await settled(page);
    g = await geometry();
    if ((await focused(page)) === '') break;
    const key = await page.evaluate(() => document.querySelector('.focused')?.getAttribute('data-nav-key'));
    if (key === 'search-input') break;
    expect(g.cardTop, `the ring on ${key} is clear of the box`).toBeGreaterThanOrEqual(g.barBottom - 1);
  }
});

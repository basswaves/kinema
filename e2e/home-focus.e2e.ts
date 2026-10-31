/**
 * Home and the shelves on Kinema's own focus engine (round 7, focusStore.ts):
 * what a browser has to show and the unit tests of the moves
 * (focusModel.test.ts) cannot — the ring is always on screen, never under the
 * top bar, one ring only and the DOM focus with it; Tab moves by area; a
 * pointer moves the ring without moving the page; a held key keeps up. Waits
 * for states only, never a fixed time.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, open, press, settled } from './kb';

interface Ring {
  key: string | null;
  rings: number;
  domFocus: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  barBottom: number;
  inBar: boolean;
  vw: number;
  vh: number;
  scroll: number;
}

function ring(page: Page): Promise<Ring> {
  return page.evaluate(() => {
    const nav = (window as unknown as { __nav: { current: () => string | null } }).__nav;
    const all = document.querySelectorAll('.focused');
    const el = all[0] as HTMLElement | undefined;
    // A card draws its ring on its picture.
    const drawn = (el?.querySelector('.card-art') as HTMLElement | null) ?? el;
    const r = drawn?.getBoundingClientRect();
    const key = nav.current();
    return {
      key,
      rings: all.length,
      domFocus: (document.activeElement as HTMLElement | null)?.dataset?.navKey === key,
      top: r?.top ?? NaN,
      bottom: r?.bottom ?? NaN,
      left: r?.left ?? NaN,
      right: r?.right ?? NaN,
      barBottom: document.querySelector('.top-nav')!.getBoundingClientRect().bottom,
      inBar: Boolean(el?.closest('.top-nav')),
      vw: window.innerWidth,
      vh: window.innerHeight,
      scroll: document.querySelector('.browse')!.scrollTop,
    };
  });
}

/** One ring, with the DOM focus, wholly on screen and clear of the top bar. */
function expectSeen(r: Ring, where: string): void {
  expect(r.rings, `one ring ${where}`).toBe(1);
  expect(r.domFocus, `DOM focus with the ring ${where}`).toBe(true);
  if (!r.inBar) expect(r.top, `clear of the bar ${where} (${r.key})`).toBeGreaterThanOrEqual(r.barBottom - 1);
  expect(r.bottom, `above the bottom ${where} (${r.key})`).toBeLessThanOrEqual(r.vh + 1);
  expect(r.left, `inside the left edge ${where} (${r.key})`).toBeGreaterThanOrEqual(-1);
  expect(r.right, `inside the right edge ${where} (${r.key})`).toBeLessThanOrEqual(r.vw + 1);
}

test('Home by keys: the ring always on screen and clear of the bar, down to the end and back up', async ({ page }) => {
  await open(page, 'windows');
  const keys: string[] = [];
  for (let i = 0; i < 20; i++) {
    await press(page, 'ArrowDown');
    await settled(page);
    const r = await ring(page);
    expectSeen(r, `after Down ${i + 1}`);
    if (r.key === keys[keys.length - 1]) break;
    keys.push(r.key ?? '');
  }
  // Along the last rail and back.
  for (let i = 0; i < 6; i++) {
    await press(page, 'ArrowRight');
    await settled(page);
    expectSeen(await ring(page), `after Right ${i + 1}`);
  }
  for (let i = 0; i < 30 && (await ring(page)).key !== 'hero-play'; i++) {
    await press(page, 'ArrowUp');
    await settled(page);
    expectSeen(await ring(page), `after Up ${i + 1}`);
  }
  // Up to the first area brings the page back to its top.
  const top = await ring(page);
  expect(top.key).toBe('hero-play');
  expect(top.scroll).toBe(0);
  await press(page, 'ArrowUp');
  expect((await ring(page)).key).toBe('nav:home');
});

test('a held arrow keeps up: every repeat one move, the ring on screen when let go', async ({ page }) => {
  await open(page, 'windows');
  await page.keyboard.down('ArrowDown');
  for (let i = 0; i < 15; i++) await page.keyboard.down('ArrowDown');
  await page.keyboard.up('ArrowDown');
  await settled(page);
  expectSeen(await ring(page), 'after a held Down');
  await page.keyboard.down('ArrowUp');
  for (let i = 0; i < 30; i++) await page.keyboard.down('ArrowUp');
  await page.keyboard.up('ArrowUp');
  await settled(page);
  const r = await ring(page);
  expect(r.key).toBe('nav:home');
  expect(r.scroll).toBe(0);
});

test('Tab and Shift+Tab go from area to area, as on a web page', async ({ page }) => {
  await open(page, 'windows');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('More info');
  await press(page, 'Tab');
  const next = await ring(page);
  expect(next.key).not.toMatch(/^hero-/);
  expectSeen(next, 'after Tab');
  await press(page, 'Shift+Tab');
  // Back into the hero, which lands on its current item.
  expect((await ring(page)).key).toBe('hero-play');
  await press(page, 'Shift+Tab');
  expect((await ring(page)).key).toBe('nav:home');
});

test('a pointer moves the ring where it points and leaves the page where it is', async ({ page }) => {
  await open(page, 'windows');
  const card = page.locator('.rail .card').first();
  await card.scrollIntoViewIfNeeded();
  const before = (await ring(page)).scroll;
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 3);
  await expect(card).toHaveClass(/focused/);
  await settled(page);
  expect((await ring(page)).scroll).toBe(before);
  expect((await ring(page)).rings).toBe(1);
  // The keys go on from where the pointer left the ring.
  await press(page, 'ArrowRight');
  expect((await ring(page)).key).not.toBe(await card.getAttribute('data-nav-key'));
});

test('the Movies shelf: the ring on screen down the grid and back to the order row', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockTitles', '60'));
  await open(page, 'windows');
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await expect.poll(async () => (await ring(page)).key).toMatch(/^grid:/);
  for (let i = 0; i < 8; i++) {
    await press(page, 'ArrowDown');
    await settled(page);
    expectSeen(await ring(page), `grid Down ${i + 1}`);
  }
  for (let i = 0; i < 12 && !(await ring(page)).key?.startsWith('grid-sort:'); i++) {
    await press(page, 'ArrowUp');
    await settled(page);
    expectSeen(await ring(page), `grid Up ${i + 1}`);
  }
  // Up from the first row is the order in use.
  expect((await ring(page)).key).toBe('grid-sort:added');
  // The shelf's title in sight again.
  const heading = await page.locator('.grid-heading').boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual((await ring(page)).barBottom - 1);
});

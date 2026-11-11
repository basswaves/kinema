/**
 * A big Movies grid (round 8, part I): only the rows near the screen are
 * drawn, and the keys, Back and a jump of the scroll bar still land on a card
 * that is there. Against `dev:mock` with a thousand films; see kb.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { focusKey, focused, press, settled } from './kb';

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockTitles', '1000');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.evaluate(async () => {
    const path = '/src/ui/lightLook.ts';
    (await import(/* @vite-ignore */ path)).setLook('full');
  });
  await expect(page.locator('.search .card').first()).toBeVisible();
}

const drawnCards = (page: Page) => page.locator('.search-grid .card').count();
const ringIsOnScreen = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.search-grid .card.focused');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  });

test('a thousand films: a few rows drawn, the page as tall as all of them', async ({ page }) => {
  await open(page);
  const total = await page.evaluate(() => document.querySelector('.browse')!.scrollHeight);
  expect(await drawnCards(page)).toBeLessThan(200);
  // A whole grid of this size is more than 100 rows of 280 px; the empty space holds them.
  expect(total).toBeGreaterThan(20000);
});

test('keys walk to the last film and back to the first, the ring always drawn', async ({ page }) => {
  await open(page);
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const before = await focusKey(page);
    await press(page, 'ArrowDown');
    if (i % 10 === 0) {
      await settled(page);
      expect(await ringIsOnScreen(page)).toBe(true);
      expect(await drawnCards(page)).toBeLessThan(200);
    }
    const after = await focusKey(page);
    if (after) seen.add(after);
    if (after === before) break;
  }
  await settled(page);
  expect(seen.size).toBeGreaterThan(100);
  // At the end: the ring is on the grid's last row and no space is left below.
  const atEnd = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('.search-grid')!;
    return {
      last: (grid.querySelector<HTMLElement>('.card.focused')?.offsetTop ?? -1) === (grid.lastElementChild as HTMLElement).offsetTop,
      pad: parseFloat(grid.style.paddingBottom || '0'),
    };
  });
  expect(atEnd.last).toBe(true);
  expect(atEnd.pad).toBe(0);
  expect(await drawnCards(page)).toBeLessThan(200);

  for (let i = 0; i < 500; i++) {
    const before = await focusKey(page);
    await press(page, 'ArrowUp');
    const after = await focusKey(page);
    if (after === before || after?.startsWith('grid:') === false) break;
  }
  await settled(page);
  const atStart = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('.search-grid')!;
    return {
      first: grid.firstElementChild?.classList.contains('focused') ?? false,
      pad: parseFloat(grid.style.paddingTop || '0'),
    };
  });
  expect(atStart.pad).toBe(0);
});

test('Back from a title far down lands on the same card', async ({ page }) => {
  await open(page);
  await press(page, 'ArrowDown', 60);
  await settled(page);
  const before = await focusKey(page);
  expect(before).toMatch(/^grid:/);
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await press(page, 'Escape');
  await expect.poll(() => focusKey(page)).toBe(before);
  await settled(page);
  expect(await ringIsOnScreen(page)).toBe(true);
  expect(await drawnCards(page)).toBeLessThan(200);
});

test('the scroll bar dragged far away draws the films there', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const b = document.querySelector('.browse')!;
    b.scrollTo({ top: Math.round(b.scrollHeight * 0.6), behavior: 'instant' });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.search-grid .card')).some((c) => {
          const r = c.getBoundingClientRect();
          return r.top > 0 && r.bottom < window.innerHeight;
        })
      )
    )
    .toBe(true);
  expect(await drawnCards(page)).toBeLessThan(200);
  // A key from there goes on from a card that is drawn.
  await press(page, 'ArrowDown');
  await press(page, 'ArrowDown');
  await settled(page);
  expect(await ringIsOnScreen(page)).toBe(true);
});

test('a held key runs ahead of the drawing and the ring still lands on a drawn card', async ({ page }) => {
  await open(page);
  const start = await focusKey(page);
  // Repeats as a held key sends them: no wait for a frame between any two.
  for (let i = 0; i < 150; i++) await page.keyboard.down('ArrowDown');
  await page.keyboard.up('ArrowDown');
  await settled(page);
  expect(await focusKey(page)).not.toBe(start);
  expect(await ringIsOnScreen(page)).toBe(true);
  expect(await drawnCards(page)).toBeLessThan(200);
  // And it still answers: one press up moves it a row.
  const here = await focusKey(page);
  await press(page, 'ArrowUp');
  expect(await focusKey(page)).not.toBe(here);
});

test('a wheel turned away from the ring keeps its distance and the ring', async ({ page }) => {
  await open(page);
  await press(page, 'ArrowDown', 3);
  await settled(page);
  const ring = await focusKey(page);
  expect(ring).toMatch(/^grid:/);
  const box = page.locator('.browse');
  const start = await box.evaluate((b) => b.scrollTop);
  await page.mouse.move(640, 400);
  // Far past the rows around the ring: they are no longer the ones on screen.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 150);
  await expect.poll(() => box.evaluate((b) => b.scrollTop)).toBeGreaterThan(start + 5000);
  // The rows there are drawn (the ring's rows left out, before the fix), and
  // whatever the engine did about it has finished.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.search-grid .card')).some((c) => {
          const r = c.getBoundingClientRect();
          return r.top > 0 && r.bottom < window.innerHeight;
        })
      )
    )
    .toBe(true);
  await settled(page);
  // Nothing scrolled the page back to the ring, and the ring stayed where it was.
  expect(await box.evaluate((b) => b.scrollTop)).toBeGreaterThan(start + 5000);
  expect(await focusKey(page)).toBe(ring);
  expect(await drawnCards(page)).toBeLessThan(200);
  // A key then goes on from the ring: the page comes back to it.
  await press(page, 'ArrowDown');
  await settled(page);
  expect(await ringIsOnScreen(page)).toBe(true);
});

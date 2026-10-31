/**
 * The menu on cards (cardMenuStore.ts, CardMenu.tsx): opened by OK held, the
 * Menu key, right-click and the "⋯"; a short OK still opens the title's page.
 * Against `dev:mock`; see kb.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { focused, press } from './kb';

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.removeItem('kinemaMockSystem'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

/** Down from the hero to the first card of the first rail of titles. */
async function toCard(page: Page): Promise<string> {
  for (let i = 0; i < 6 && !/Example (Film|Show|Saga)/.test((await focused(page)) ?? ''); i++) {
    await press(page, 'ArrowDown');
  }
  const card = (await focused(page)) ?? '';
  expect(card).toMatch(/Example (Film|Show|Saga)/);
  return card;
}

const menu = (page: Page) => page.getByRole('menu');

/**
 * Until a card stops moving: on a loaded machine Home's late rails push it
 * down and its own hover zoom runs, and a click aimed meanwhile lands on
 * whatever moved under the point.
 */
async function pressAt(page: Page, target: Locator, button: 'left' | 'right'): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button });
}

async function still(card: Locator): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await card.boundingBox());
      const same = box === last;
      last = box;
      return same;
    }, { intervals: [250] })
    .toBe(true);
}

test('OK held opens the menu, its release chooses nothing, and an item acts', async ({ page }) => {
  await open(page);
  const card = await toCard(page);
  // A held key repeats every ~60 ms, past the menu opening (the real app
  // once let one repeat through to the menu's Play).
  await page.keyboard.down('Enter');
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(60);
    await page.keyboard.down('Enter');
  }
  await expect(menu(page)).toBeVisible();
  await page.keyboard.up('Enter');
  // Still the menu, on its first item: the hold chose nothing.
  await page.waitForTimeout(400);
  await expect(menu(page)).toBeVisible();
  expect(await focused(page)).toMatch(/^(Play|Resume)$/);

  await press(page, 'ArrowDown');
  expect(await focused(page)).toMatch(/^Mark (show )?(un)?watched$/);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Add to My list');
  await press(page, 'Enter');
  await expect(menu(page)).toHaveCount(0);
  // Back on the card it was opened from, now on My list.
  await expect.poll(() => focused(page)).toBe(card);
  await expect(page.locator('.card.focused .card-listed')).toHaveCount(1);
});

test('a short OK still opens the page; the Menu key and Back', async ({ page }) => {
  await open(page);
  const card = await toCard(page);
  await press(page, 'ContextMenu');
  await expect(menu(page)).toBeVisible();
  await press(page, 'Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(card);
  // Back closed the menu and did nothing else: still Home.
  await expect(page.locator('.home')).toBeVisible();

  await press(page, 'Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('by mouse: right-click and the ⋯ on a card', async ({ page }) => {
  await open(page);
  const card = page.locator('.home .rail .card').first();
  const name = (await card.locator('.card-title').innerText()).trim();
  await card.scrollIntoViewIfNeeded();
  await still(card);
  // As a pointer does, at where the card is: a locator's click scrolls the
  // page and the rail itself, and under load they were still sliding when it
  // pressed (CI, WebKit).
  await pressAt(page, card, 'right');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('heading')).toHaveText(name);
  // Outside the menu closes it.
  await page.mouse.click(5, 5);
  await expect(menu(page)).toHaveCount(0);

  await card.hover();
  await still(card);
  await pressAt(page, card.locator('.card-more'), 'left');
  await menu(page).getByRole('button', { name: 'Open page' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

// The light look once collapsed every poster to the My list ribbon's size (a
// rule merged into another selector list), and the ⋯ fell onto the title.
test('in the light look a card keeps its poster, with the ⋯ on it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-look', 'light'));
  const card = page.locator('.home .rail .card').first();
  const art = (await card.locator('.card-art').boundingBox())!;
  expect(art.height).toBeGreaterThan(150);
  const more = (await card.locator('.card-more').boundingBox())!;
  expect(more.x).toBeGreaterThanOrEqual(art.x);
  expect(more.x + more.width).toBeLessThanOrEqual(art.x + art.width);
  expect(more.y).toBeGreaterThanOrEqual(art.y);
});

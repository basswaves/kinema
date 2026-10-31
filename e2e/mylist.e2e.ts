/**
 * My list and Play something: keyboard only first, then the mouse.
 * Against `dev:mock`; see kb.ts and keyboard-*.e2e.ts for the conventions.
 */
import { expect, test, type Page } from '@playwright/test';
import { afterPress, press } from './kb';

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('.focused')?.textContent?.trim());
}

/**
 * Home, ring on the hero's Play. The date is not fixed: with it fixed every
 * key press carries one time and arrow keys are taken for repeats (kb.ts).
 */
async function open(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.removeItem('kinemaMockSystem'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

/** Press `key` until the ring's text contains `text` (at most `max` presses). */
async function until(page: Page, key: string, text: string, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    const before = (await focused(page)) ?? '';
    if (before.includes(text)) break;
    await page.keyboard.press(key);
    // Wait for the ring to move before looking again: on a busy machine (the
    // flows run side by side) a press can land after a fixed pause, and the
    // next press then steps past the control.
    await expect.poll(() => focused(page), { timeout: 1500 }).not.toBe(before).catch(() => {});
    await afterPress(page);
  }
  expect(await focused(page)).toContain(text);
}

/** From the hero down to the first card of the first rail, then its page. */
async function firstCardPage(page: Page): Promise<void> {
  // Past any notice under the hero, one press at a time.
  for (let i = 0; i < 6; i++) {
    await press(page, 'ArrowDown');
    if (await page.evaluate(() => !!document.querySelector('.card.focused'))) break;
  }
  expect(await page.evaluate(() => !!document.querySelector('.card.focused'))).toBe(true);
  await press(page, 'Enter');
  await expect(page.getByRole('button', { name: /My list/ })).toBeVisible();
}

async function visibleFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

test('My list by keyboard: add on the page, see the rail, L takes it off, L adds from a rail', async ({ page }) => {
  await open(page);
  await firstCardPage(page);
  await until(page, 'ArrowRight', 'My list').catch(async () => until(page, 'ArrowDown', 'My list'));
  expect(await focused(page)).toContain('+ My list');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('✓ On My list');

  await press(page, 'Escape');
  await expect(page.getByRole('heading', { name: 'My list' })).toBeVisible();
  const rail = page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'My list' }) }).last();
  await expect(rail.locator('.card').first()).toBeVisible();

  // To My list's card and L. Where Back puts the ring differs by engine, so
  // up first, then down, and only press L once the ring is in the rail.
  const inList = () =>
    page.evaluate(() => {
      const f = document.querySelector('.card.focused');
      const h = Array.from(document.querySelectorAll('h2, h3')).find((x) => x.textContent?.trim() === 'My list');
      const sec = h?.closest('section');
      return !!(f && sec && sec.contains(f));
    });
  for (let i = 0; i < 6 && !(await inList()); i++) await press(page, 'ArrowUp');
  for (let i = 0; i < 8 && !(await inList()); i++) await press(page, 'ArrowDown');
  expect(await inList()).toBe(true);
  await press(page, 'l');
  await expect(page.getByRole('heading', { name: 'My list' })).toHaveCount(0);
  await expect.poll(() => visibleFocus(page)).toBe(true);

  // L on a card in another rail adds it: the ribbon appears.
  await expect(page.getByLabel('On My list')).toHaveCount(0);
  for (let i = 0; i < 6 && !(await page.evaluate(() => !!document.querySelector('.card.focused'))); i++)
    await press(page, 'ArrowDown');
  expect(await page.evaluate(() => !!document.querySelector('.card.focused'))).toBe(true);
  await press(page, 'l');
  await expect(page.getByLabel('On My list').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My list' })).toBeVisible();
});

test('Play something by keyboard: S, Another keeps the ring, Escape returns, hero button plays', async ({ page }) => {
  await open(page);
  await press(page, 's');
  const dialog = page.getByRole('dialog', { name: 'Play something' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h3, .something-name, strong').first()).not.toBeEmpty();
  await expect.poll(() => focused(page)).toContain('Play');
  await until(page, 'ArrowRight', 'Another', 3).catch(async () => until(page, 'ArrowDown', 'Another', 3));
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Another');
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => visibleFocus(page)).toBe(true);

  // Again, from the hero's own button; OK on Play starts the player.
  await until(page, 'ArrowRight', 'Play something', 4);
  await press(page, 'Enter');
  await expect(dialog).toBeVisible();
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeAttached();
});

test('My list and Play something by mouse', async ({ page }) => {
  await open(page);
  await firstCardPage(page);
  const add = page.getByRole('button', { name: '+ My list' });
  await add.click();
  await expect(page.getByRole('button', { name: '✓ On My list' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Movies' }).first().click();
  await page.getByRole('button', { name: 'Play something' }).click();
  const dialog = page.getByRole('dialog', { name: 'Play something' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Play$/ }).click();
  await expect(page.locator('.player')).toBeAttached();
});

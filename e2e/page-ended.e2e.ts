/**
 * The page's process ended and a new page started (page_life.rs): the new page
 * says so, Home works, and an ordinary start says nothing.
 */
import { expect, test } from '@playwright/test';
import { focused, press } from './kb';

test('a page started again says what happened, keeps the keys, and says it once', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seen')) localStorage.setItem('kinemaMockPageEnded', 'ended');
    sessionStorage.setItem('seen', '1');
  });
  await page.goto('/');
  const notice = page.getByRole('status').filter({ hasText: 'started again' });
  await expect(notice).toContainText('Your library is not affected');
  await expect(notice).not.toContainText('film');

  // It takes no focus: the remote still has Home.
  await expect.poll(() => focused(page)).not.toBe('');
  const before = await focused(page);
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).not.toBe(before);

  await page.reload();
  await expect(page.locator('.page-ended-notice')).toHaveCount(0);
});

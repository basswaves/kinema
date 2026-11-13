/**
 * The resume point cannot be kept (review A5-03): a full disk or a folder that
 * cannot be written. The player says so once, in plain words, and keeps
 * trying: when saving works again the film's place is kept. Keyboard only.
 */
import { expect, test, type Page } from '@playwright/test';

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    return el?.getAttribute('aria-label') ?? el?.textContent?.trim();
  });
}

test('a save that fails is said once, and saving mends itself', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00'));
  await page.goto('/');
  await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
  await page.evaluate(() => {
    (window as unknown as { __mockSaveError: string }).__mockSaveError = 'database or disk is full';
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.player')).toBeAttached();
  const notice = page.locator('.player-notice');
  await expect(notice).toContainText('cannot be kept right now: the disk is full', { timeout: 20_000 });
  // Writable again: the next save goes through, with no second notice.
  await page.evaluate(() => {
    delete (window as unknown as { __mockSaveError?: string }).__mockSaveError;
  });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await expect.poll(() => logs.join('\n'), { timeout: 20_000 }).toContain('saving works again');
});

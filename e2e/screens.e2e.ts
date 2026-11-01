/**
 * How the key screens are drawn: screenshots against committed baselines
 * (`e2e/screens.e2e.ts-snapshots/`), in both looks and both engines. The
 * other flows check where the ring is; none looks at the picture, which is how
 * the light look's posters stayed broken for a week.
 *
 * The tolerance ignores anti-aliasing (a pixel counts as different only past
 * `threshold`, and a few percent of them may differ) but not a missing poster,
 * a shifted row or a wrong colour. Baselines are per engine and per OS, as
 * fonts differ. To change them on purpose: CONTRIBUTING.md, "Screenshots".
 *
 * Against `dev:mock`; the fixed clock, no animation and the mock's own posters
 * make the pictures the same every run.
 */
import { expect, test, type Page } from '@playwright/test';
import { drawn, firstRunToSetupPage, focused, press, ringCovers, settled } from './kb';

type Look = 'full' | 'light';

/** Comparison settings shared by every shot. */
const SHOT = { maxDiffPixelRatio: 0.02, threshold: 0.25, animations: 'disabled' as const, caret: 'hide' as const };

/** Opens the mock with the look chosen, and waits for the page it asks for. */
async function start(page: Page, look: Look, init: () => void = () => {}): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-06-01T12:00:00Z'));
  await page.addInitScript(init);
  await page.addInitScript((l) => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockLook', l);
  }, look);
  await page.goto('/');
}

async function still(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  await drawn(page);
}

for (const look of ['full', 'light'] as const) {
  test.describe(`${look} look`, () => {
    test('Home', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await expect(page.locator('html')).toHaveAttribute('data-look', look);
      await still(page);
      await expect(page).toHaveScreenshot(`home-${look}.png`, SHOT);
    });

    test('a film page', async ({ page }) => {
      await start(page, look, () => localStorage.setItem('kinemaMockPeople', '1'));
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'Movies' }).first().click();
      await page.locator('.search .card', { hasText: 'Example Part Two' }).click();
      await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
      await still(page);
      await expect(page).toHaveScreenshot(`film-${look}.png`, SHOT);
    });

    test('a show page', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'TV' }).first().click();
      await page.locator('.search .card', { hasText: 'Example Show' }).click();
      await expect(page.locator('.detail h1')).toHaveText('Example Show');
      await still(page);
      await expect(page).toHaveScreenshot(`show-${look}.png`, SHOT);
    });

    test('Settings', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'Settings' }).first().click();
      await expect(page.locator('.settings')).toBeVisible();
      await still(page);
      await expect(page).toHaveScreenshot(`settings-${look}.png`, SHOT);
    });

    test('search', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'Search' }).first().click();
      await expect(page.locator('input[type="search"], input[placeholder*="earch"]').first()).toBeVisible();
      await still(page);
      await expect(page).toHaveScreenshot(`search-${look}.png`, SHOT);
    });

    test('the player: Audio & subtitles', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await press(page, 'Enter');
      await expect(page.locator('.player')).toBeAttached();
      await press(page, 'ArrowDown');
      for (let i = 0; i < 6 && (await focused(page)) !== 'Audio & subtitles'; i++) await press(page, 'ArrowRight');
      await press(page, 'Enter');
      await expect(page.locator('.track-panel')).toBeVisible();
      await still(page);
      await expect(page).toHaveScreenshot(`player-tracks-${look}.png`, SHOT);
    });

    // The ring with text right beside it (owner, 2026-11-01): a choice row
    // with its caption below, and Cancel under the Poster dialog's line.
    test('a setup page, the ring on a choice', async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-06-01T12:00:00Z'));
      await page.addInitScript((l) => {
        localStorage.removeItem('kinemaMockSystem');
        localStorage.setItem('kinemaMockLook', l);
        localStorage.setItem('kinemaMockEmpty', '1');
      }, look);
      await firstRunToSetupPage(page, 'windows', 'Skipping intros');
      await expect.poll(() => focused(page)).toBe('✓Show a Skip button');
      expect(await ringCovers(page)).toEqual([]);
      await still(page);
      await expect(page).toHaveScreenshot(`setup-ring-${look}.png`, SHOT);
    });

    test('the Poster dialog, the ring on Cancel', async ({ page }) => {
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'Movies' }).first().click();
      await page.locator('.search .card', { hasText: 'Example Film' }).click();
      await expect(page.locator('.detail h1')).toHaveText('Example Film');
      for (let i = 0; i < 10 && !/^Poster/.test((await focused(page)) ?? ''); i++) await press(page, 'ArrowRight');
      await press(page, 'Enter');
      await expect(page.getByRole('dialog', { name: 'Poster' })).toBeVisible();
      await expect.poll(() => focused(page)).toBe('Cancel');
      expect(await ringCovers(page)).toEqual([]);
      await still(page);
      await expect(page).toHaveScreenshot(`poster-ring-${look}.png`, SHOT);
    });

    test('the Poster dialog, a grid of posters with the ring on one', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('kinemaMockPeople', '1');
        localStorage.setItem('kinemaMockPosters', '1');
      });
      await start(page, look);
      await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
      await page.getByRole('button', { name: 'Movies' }).first().click();
      await page.locator('.search .card', { hasText: 'Example Part Two' }).click();
      await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
      for (let i = 0; i < 10 && !/^Poster/.test((await focused(page)) ?? ''); i++) await press(page, 'ArrowRight');
      await press(page, 'Enter');
      await expect(page.locator('.poster-choice')).toHaveCount(13);
      await press(page, 'ArrowRight');
      await press(page, 'ArrowDown');
      expect(await ringCovers(page)).toEqual([]);
      await still(page);
      await expect(page).toHaveScreenshot(`poster-grid-${look}.png`, SHOT);
    });

    test('first run', async ({ page }) => {
      await start(page, look, () => localStorage.setItem('kinemaMockEmpty', '1'));
      await expect(page.locator('.first-run')).toBeVisible({ timeout: 30_000 });
      await still(page);
      await expect(page).toHaveScreenshot(`first-run-${look}.png`, SHOT);
    });
  });
}

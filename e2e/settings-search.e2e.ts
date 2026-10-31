/**
 * Settings' search box (SettingsSearch.tsx), by keyboard, by Kinema's own
 * letters in the TV layout, and by mouse: a match opens its section with the
 * ring on that very setting.
 */
import { expect, test, type Page } from '@playwright/test';
import { press } from './kb';

function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const el = document.querySelector('.focused');
    return el instanceof HTMLInputElement ? `[${el.placeholder}]` : el?.textContent?.trim();
  });
}

/** Home → Settings, the ring on the section list. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Settings'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Library');
}

/** Up from the first section to the box. */
async function toSearchBox(page: Page): Promise<void> {
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('[Search settings]');
}

test('typing finds a setting by what it does, and OK lands on its field', async ({ page }) => {
  await openSettings(page);
  await toSearchBox(page);
  await page.keyboard.type('rotten');
  await expect(page.locator('.settings-search-result')).toHaveText(['OMDb keyPosters & ratings']);
  await expect(page.locator('.settings-nav button.active')).toHaveCount(0);
  // Enter goes to the first match, and OK on it to the setting.
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('OMDb keyPosters & ratings');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Posters and ratings');
  await expect.poll(() => focused(page)).toBe('[Paste your OMDb key]');
  // The section it opened is the one the list marks, and the box is empty.
  await expect(page.locator('.settings-nav button.active')).toHaveText('Posters & ratings');
  await expect(page.locator('.settings-search-box input')).toHaveValue('');
  // Typing goes into the field it landed on.
  await expect
    .poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.placeholder))
    .toBe('Paste your OMDb key');
  await page.keyboard.type('k1');
  await expect(page.locator('.settings-field input[placeholder="Paste your OMDb key"]')).toHaveValue('k1');
});

test('a choice is found by its name, and the ring lands on the one chosen', async ({ page }) => {
  await openSettings(page);
  await toSearchBox(page);
  await page.keyboard.type('skip them');
  await expect(page.locator('.settings-search-result').first()).toContainText('Skipping intros · Skip them');
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Skipping intros');
  // Not on "Skip them": on what is chosen now, so OK changes nothing by surprise.
  await expect.poll(() => focused(page)).toBe('✓Show a Skip button');
});

test('nothing found says so, and a section chosen from the list ends the search', async ({
  page,
}) => {
  await openSettings(page);
  await toSearchBox(page);
  await page.keyboard.type('zzz');
  await expect(page.locator('.settings-search')).toContainText('Nothing in Settings matches');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toBe('Library');
  await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Playback');
  await expect(page.locator('.settings-search-box input')).toHaveValue('');
});

test('TV layout: OK on the box brings up the letters, and a match is reached by remote', async ({
  page,
}) => {
  await openSettings(page);
  await page.evaluate(async () => {
    const path = '/src/ui/tv.ts';
    const tv = await import(/* @vite-ignore */ path);
    await tv.setTvMode(true);
  });
  await toSearchBox(page);
  await press(page, 'Enter');
  await expect(page.locator('.settings-search .osk')).toBeVisible();
  await expect.poll(() => focused(page)).toBe('a');
  // "l", "o", "o", "k" on the letters.
  await press(page, 'ArrowRight', 11);
  await expect.poll(() => focused(page)).toBe('l');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 13 && (await focused(page)) !== 'o'; i++) await press(page, 'ArrowLeft');
  await press(page, 'Enter', 2);
  await press(page, 'ArrowUp');
  for (let i = 0; i < 13 && (await focused(page)) !== 'k'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.settings-search-box input')).toHaveValue('look');
  await expect(page.locator('.settings-search-result').first()).toHaveText('LookPlayback');
  for (let i = 0; i < 8 && (await focused(page)) !== 'LookPlayback'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section h2').first()).toHaveText('Playback');
  await expect.poll(() => focused(page)).toBe('✓Auto');
});

test('every setting the search knows is found on its section, next to its name', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSettings(page);
  // The index as the app has it, less what this system leaves out and the
  // Trakt row, drawn only once Trakt is connected (trakt-resume.e2e.ts).
  const entries = await page.evaluate(async () => {
    const indexPath = '/src/ui/settingsIndex.ts';
    const capsPath = '/src/capabilities.ts';
    const index = await import(/* @vite-ignore */ indexPath);
    const caps = await import(/* @vite-ignore */ capsPath);
    const can = caps.capabilitiesNow();
    return (index.SETTINGS_INDEX as { label: string; find?: string; when?: (c: unknown) => boolean }[])
      .filter((e) => !e.when || e.when(can))
      .map((e) => ({ label: e.label, find: e.find ?? e.label }));
  });
  expect(entries.length).toBeGreaterThan(30);
  const missed: string[] = [];
  for (const { label, find } of entries.filter((e) => !e.label.startsWith('Continue where'))) {
    const box = page.locator('.settings-search-box input');
    // Again until it holds: the last pick's ring can still be settling, and
    // the box taking it mid-fill dropped the whole name under load.
    await expect(async () => {
      await box.fill(label);
      await page
        .locator('.settings-search-result', { has: page.locator('span:first-child', { hasText: label }) })
        .first()
        .click({ timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    // The ring on a control in the same row, field or part as the name.
    const near = await page
      .waitForFunction(
        (want) => {
          const ring = document.querySelector('.settings-content .focused');
          if (!ring) return false;
          const part = ring.closest('.choice-row, .settings-field') ?? ring.closest('section');
          const logos = part ? Array.from(part.querySelectorAll('img[alt]')) : [];
          const said = [part?.textContent ?? '', ...logos.map((i) => i.getAttribute('alt'))];
          return said.join(' ').toLowerCase().includes(want.toLowerCase());
        },
        find,
        { timeout: 4000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!near) missed.push(label);
  }
  expect(missed).toEqual([]);
});

test('a click on a match lands on it as OK does', async ({ page }) => {
  await openSettings(page);
  await page.locator('.settings-search-box input').click();
  await page.keyboard.type('trakt');
  await page.locator('.settings-search-result', { hasText: 'Continue where you stopped' }).click();
  await expect(page.locator('.settings-section h2').first()).toHaveText('Keep track of what I watch');
  // Trakt is not connected in the mock, so its resume row is not drawn: the
  // ring goes to the section, never back to the list.
  await expect
    .poll(() => page.evaluate(() => Boolean(document.querySelector('.settings-content .focused'))), {
      timeout: 5000,
    })
    .toBe(true);
});

test('high contrast by remote: found, switched on, kept', async ({ page }) => {
  await openSettings(page);
  await toSearchBox(page);
  await page.keyboard.type('contrast');
  await press(page, 'Enter');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('✓Off');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('On');
  await press(page, 'Enter');
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim())
    )
    .toBe('5px');
  await expect
    .poll(() =>
      page.evaluate(async (m) => {
        const api = await import(/* @vite-ignore */ m);
        return api.getSetting('high_contrast') as Promise<string | null>;
      }, '/src/metadata/api.ts')
    )
    .toBe('on');
});

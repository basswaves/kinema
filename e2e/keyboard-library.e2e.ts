/**
 * Keyboard flows (split from keyboard.e2e.ts, 2026-10-29): The library: Needs attention, add without a match, the startup scan, power and sections.
 * Keys only, in each engine `playwright.config.ts` lists. Nothing here touches
 * the mouse: one stray hover repairs focus and hides the failure
 * (CONTRIBUTING, "Two failure modes"). Shared helpers: kb.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { press, focused, tvMode, open } from './kb';

/**
 * Whether the focused control is wholly on screen, below the top bar. Its own
 * box, without the zoom a focused control grows by (a few pixels past the
 * edge is the zoom, not the control).
 */
function focusedOnScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ring = document.querySelector<HTMLElement>('.focused');
    if (!ring) return false;
    const bar = document.querySelector('.top-nav')?.getBoundingClientRect().bottom ?? 0;
    const r = ring.getBoundingClientRect();
    const middle = (r.top + r.bottom) / 2;
    const top = middle - ring.offsetHeight / 2;
    const bottom = middle + ring.offsetHeight / 2;
    return top >= bar - 1 && bottom <= window.innerHeight + 1;
  });
}

// TV-FEEL N9 and N8, at a TV's layout: Home's notice opens Settings with the
// Review button in sight, and an item opened by remote brings what opened
// into sight with it.
test('needs attention by remote: the Review button and an opened item are on screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockReview', 'items'));
  await open(page, 'windows');
  await tvMode(page);
  for (let i = 0; i < 4 && (await focused(page)) !== 'Review'; i++) await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Review');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);
  await expect.poll(() => focusedOnScreen(page)).toBe(true);

  // The queue is open already: Home's notice asked for it.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await press(page, 'Enter');
  const box = page.locator('.fixmatch-row.open .fixmatch-input').first();
  await expect(box).toBeVisible();
  await expect
    .poll(() =>
      box.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      })
    )
    .toBe(true);
});

// LOCAL-MEDIA.md phase 3: what no database lists is kept under its own name,
// renamed on its own page, and sent back to be matched after all — the whole
// way by remote.
test('add without a match, rename it, and send it back to find a match', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockReview', 'items'));
  await open(page, 'windows');
  const placeholder = () =>
    page.evaluate(() => document.querySelector('.focused')?.getAttribute('placeholder'));
  for (let i = 0; i < 4 && (await focused(page)) !== 'Review'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);

  // The series' row, opened; under its search, the name it came with.
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await press(page, 'ArrowDown');
  await expect.poll(() => focused(page)).toContain('Sample Series');
  await press(page, 'Enter');
  for (let i = 0; i < 4 && (await placeholder()) !== 'Name'; i++) await press(page, 'ArrowDown');
  expect(await placeholder()).toBe('Name');
  await expect(page.locator('.fixmatch-local .fixmatch-input').first()).toHaveValue('Sample Series');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Our Holiday');
  await press(page, 'Enter');
  await expect(page.getByText('Added “Our Holiday” to TV shows without a match.')).toBeVisible();
  // Gone from the queue, and the ring on what is left rather than lost.
  await expect.poll(() => focused(page)).toContain('Fixture Movie');
  await expect(page.locator('.fixmatch-title', { hasText: 'Sample Series' })).toHaveCount(0);

  // In TV shows, newest first.
  for (let i = 0; i < 8 && !(await focused(page))?.startsWith('Settings'); i++) {
    await press(page, 'ArrowUp');
  }
  await press(page, 'ArrowLeft', 3);
  await expect.poll(() => focused(page)).toBe('TV shows');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toContain('Our Holiday');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play S02E03');

  // Renamed in place (past My list, which sits beside Play).
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('+ My list');
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Rename');
  await press(page, 'Enter');
  await expect.poll(placeholder).toBe('Name');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Summer by the Sea');
  await press(page, 'Enter');
  await expect(page.locator('.detail h1')).toHaveText('Summer by the Sea');
  await expect.poll(() => focused(page)).toBe('Rename');

  // Find a match: back in the queue, which opens on its Review button.
  await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Find a match');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toMatch(/^Review 3 items/);
  await expect(page.locator('.fixmatch-title', { hasText: 'Sample Series' })).toHaveCount(1);
});

// Matched by hand afterwards (or with a TMDB key added since), nothing waits
// any more, and Home stops saying that films do (owner, 2026-10-09).
test("the startup scan's notice: Wikipedia's line goes once nothing waits", async ({ page }) => {
  const busy = 'A film: Wikimedia is busy: Wikidata query: HTTP 503';
  await page.addInitScript((e) => {
    localStorage.setItem('kinemaMockScanErrors', e);
    if (!sessionStorage.getItem('reviewSet')) {
      localStorage.setItem('kinemaMockReview', '2');
      sessionStorage.setItem('reviewSet', '1');
    }
  }, JSON.stringify([busy]));
  await open(page, 'windows');
  const notice = page.locator('.home-notice-scan .home-notice-text');
  await expect(notice).toHaveText(
    'Wikipedia was busy, so some films wait to be matched until the next scan'
  );

  // Both matched in Settings; back on Home, the line is gone.
  await page.evaluate(() => localStorage.setItem('kinemaMockReview', '0'));
  // One Up: an empty Continue Watching once caught it, with this line
  // pushing Home down, and the ring vanished.
  await press(page, 'ArrowUp');
  await expect.poll(() => focused(page)).toBe('Home');
  await press(page, 'ArrowRight', 5);
  // With its badge: still 2 to review when Home was read.
  await expect.poll(() => focused(page)).toBe('Settings2');
  await press(page, 'Enter');
  await expect(page.locator('.settings-section').first()).toBeVisible();
  // Settings read the queue again, and the badge above it follows at once —
  // it used to keep its 2 until another tab was opened.
  await expect(page.locator('.top-nav .nav-badge')).toHaveCount(0);
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toContain('Play');
  await expect(notice).toHaveCount(0);
});

for (const [label, system, noPower, choices] of [
  ['windows', 'windows', false, ['Close Kinema', 'Put the PC to sleep', 'Shut down the PC', 'Cancel']],
  ['linux', 'linux', false, ['Close Kinema', 'Put the PC to sleep', 'Shut down the PC', 'Cancel']],
  // A system whose logind will not let Kinema, or has none (power.rs).
  ['linux without logind', 'linux', true, ['Close Kinema', 'Cancel']],
] as const) {
  test(`Leave offers what ${label} can do`, async ({ page }) => {
    if (noPower) await page.addInitScript(() => localStorage.setItem('kinemaMockNoPower', '1'));
    await open(page, system);
    await tvMode(page);
    await press(page, 'Escape');
    await expect(page.locator('.leave-choice')).toHaveText([...choices]);
    await expect.poll(() => focused(page)).toBe('Close Kinema');
    await press(page, 'ArrowDown', choices.length - 1);
    await expect.poll(() => focused(page)).toBe('Cancel');
  });
}

for (const [system, sections] of [
  ['windows', ['Screen', 'Sound', 'Your equipment']],
  // Linux: sound, what it cannot do yet, then the equipment it can see.
  ['linux', ['Sound', 'Picture & sound', 'Your equipment']],
] as const) {
  test(`Picture & sound shows what ${system} can do`, async ({ page }) => {
    await open(page, system);
    await press(page, 'ArrowUp', 2);
    await expect.poll(() => focused(page)).toBe('Home');
    await press(page, 'ArrowRight', 5);
    await expect.poll(() => focused(page)).toBe('Settings');
    await press(page, 'Enter');
    await press(page, 'ArrowDown');
    await expect.poll(() => focused(page)).toBe('Library');
    // A column down the left at this width (a row of tabs when narrower).
    await press(page, 'ArrowDown', 2);
    await expect.poll(() => focused(page)).toBe('Picture & sound');
    await press(page, 'Enter');
    await expect(page.locator('.settings-section h2')).toHaveText([...sections]);
    // Nothing about Windows' mixer where there is none.
    const equipment = page
      .locator('.settings-section')
      .filter({ has: page.locator('h2', { hasText: 'Your equipment' }) });
    await expect(equipment).toContainText(system === 'linux' ? 'What Linux reports' : 'What Windows reports');
    if (system === 'linux') await expect(equipment).not.toContainText('Windows');
  });
}

test('Wrong title? on the title page: the queue’s search, by remote; Back closes it, Unlink goes to the queue', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('kinemaMockVersions', '1'));
  // A window narrow enough that the row under the title wraps on every
  // engine: Right still reaches the button on the second line.
  await page.setViewportSize({ width: 1000, height: 720 });
  await open(page, 'windows');
  for (let i = 0; i < 6 && !(await focused(page))?.startsWith('Example Film'); i++) {
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('▶ Play');
  // Last in the row under the title.
  for (let i = 0; i < 8 && (await focused(page)) !== 'Wrong title?'; i++) await press(page, 'ArrowRight');
  await expect.poll(() => focused(page)).toBe('Wrong title?');

  // Opens on the search box, the title's name in it, and what is linked said.
  await press(page, 'Enter');
  const dialog = page.locator('[role="dialog"][aria-label="Wrong title?"]');
  await expect(dialog).toContainText('2 files are linked to “Example Film” (2017)');
  await expect(dialog.locator('.fixmatch-input')).toHaveValue('Example Film');
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('fixmatch-input');

  // Back closes it; the ring is back on the button.
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Wrong title?');

  // Again, down to Unlink: the files wait in Needs attention, which opens.
  await press(page, 'Enter');
  await expect(dialog).toHaveCount(1);
  // Down to the foot row (either of its two, by each engine's measure), then along it.
  for (let i = 0; i < 4 && !/^(Unlink, decide later|Cancel)$/.test((await focused(page)) ?? ''); i++) {
    await press(page, 'ArrowDown');
  }
  for (let i = 0; i < 2 && (await focused(page)) !== 'Unlink, decide later'; i++) await press(page, 'ArrowLeft');
  await expect.poll(() => focused(page)).toBe('Unlink, decide later');
  await press(page, 'Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.settings-section h2').first()).toHaveText('Folders');
});

/**
 * A title's page, an actor's page and the dialogs over them on Kinema's own
 * focus engine (round 7, F2): what a browser has to show and the unit tests of
 * the moves (focusModel.test.ts) cannot — the ring always on screen, never
 * under the top bar or the sticky Back, one ring with the DOM focus; Back
 * returns to the control it left; a dialog holds the ring and gives it back.
 * Waits for states only, never a fixed time. Against `dev:mock` with
 * `kinemaMockPeople` (a cast, a collection).
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, press, settled } from './kb';

interface Ring {
  key: string | null;
  text: string;
  rings: number;
  domFocus: boolean;
  top: number;
  bottom: number;
  barBottom: number;
  inBar: boolean;
  vh: number;
  scroll: number;
}

function ring(page: Page): Promise<Ring> {
  return page.evaluate(() => {
    const nav = (window as unknown as { __nav: { current: () => string | null } }).__nav;
    const all = document.querySelectorAll('.focused');
    const el = all[0] as HTMLElement | undefined;
    const drawn = (el?.querySelector('.card-art') as HTMLElement | null) ?? el;
    const r = drawn?.getBoundingClientRect();
    const key = nav.current();
    // Every bar the page keeps over it (the top bar, a title page's Back),
    // but the one the ring is on.
    const bars = Array.from(document.querySelectorAll<HTMLElement>('[data-sticky-top]')).filter(
      (b) => !(el && b.contains(el)) && b.getBoundingClientRect().height > 0
    );
    return {
      key,
      text: el?.textContent?.trim() ?? '',
      rings: all.length,
      domFocus: Boolean(el && (el === document.activeElement || el.contains(document.activeElement))),
      top: r?.top ?? NaN,
      bottom: r?.bottom ?? NaN,
      barBottom: Math.max(0, ...bars.map((b) => b.getBoundingClientRect().bottom)),
      inBar: Boolean(el?.closest('.top-nav')),
      vh: window.innerHeight,
      scroll: document.querySelector('.browse')!.scrollTop,
    };
  });
}

/** One ring, with the DOM focus, wholly on screen and clear of every bar. */
function expectSeen(r: Ring, where: string): void {
  expect(r.rings, `one ring ${where}`).toBe(1);
  expect(r.domFocus, `DOM focus with the ring ${where} (${r.key})`).toBe(true);
  if (!r.inBar) expect(r.top, `clear of the bars ${where} (${r.key})`).toBeGreaterThanOrEqual(r.barBottom - 1);
  expect(r.bottom, `above the bottom ${where} (${r.key})`).toBeLessThanOrEqual(r.vh + 1);
}

/** Press, let the page settle, and check the ring. */
async function step(page: Page, key: string, where: string): Promise<Ring> {
  await press(page, key);
  await settled(page);
  const r = await ring(page);
  expectSeen(r, where);
  return r;
}

async function open(page: Page, height = 720): Promise<void> {
  await page.setViewportSize({ width: 1280, height });
  await page.addInitScript(() => {
    localStorage.removeItem('kinemaMockSystem');
    localStorage.setItem('kinemaMockPeople', '1');
  });
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
}

/** A title's page from its shelf, opened by a click on its card. */
async function openTitle(page: Page, shelf: 'Movies' | 'TV shows', name: string): Promise<void> {
  await page.getByRole('button', { name: shelf }).first().click();
  await page.locator('.search .card', { hasText: name }).click();
  await expect(page.locator('.detail h1')).toHaveText(name);
  await expect.poll(() => focused(page)).toMatch(/Play/);
}

test("a film's page by keys: every area on screen and clear of the bars, and Back to the card", async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  expectSeen(await ring(page), 'on arrival');
  expect((await step(page, 'ArrowUp', 'Up to Back')).key).toBe('detail-back');
  expect((await step(page, 'ArrowDown', 'Down to Play')).key).toBe('detail-play');
  for (let i = 0; i < 8; i++) await step(page, 'ArrowRight', `along the buttons ${i + 1}`);
  // Down area by area: the collection, the cast, the file's details.
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await step(page, 'ArrowDown', `Down ${i + 1}`);
    if (seen[seen.length - 1] === r.key) break;
    seen.push(r.key ?? '');
  }
  expect(seen.some((k) => k.startsWith('detail-cast:'))).toBe(true);
  expect(await focused(page)).toMatch(/File details/);
  // Back up to the buttons, which land on Play, with the page at its top.
  for (let i = 0; i < 6 && (await ring(page)).key !== 'detail-play'; i++) await step(page, 'ArrowUp', `Up ${i + 1}`);
  const play = await ring(page);
  expect(play.key).toBe('detail-play');
  expect(play.scroll).toBe(0);
  // Back: the shelf, the ring on the card it came from.
  await press(page, 'Escape');
  await expect(page.locator('.detail')).toHaveCount(0);
  await expect.poll(() => focused(page)).toContain('Example Part Two');
  expectSeen(await ring(page), 'back on the shelf');
});

test("a show's page: down every episode and back up, never under the sticky Back", async ({ page }) => {
  // A short window: the episodes run past its bottom, and Back sticks.
  await open(page, 480);
  await openTitle(page, 'TV shows', 'Example Show');
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await step(page, 'ArrowDown', `Down ${i + 1}`);
    if (keys[keys.length - 1] === r.key) break;
    keys.push(r.key ?? '');
  }
  expect(keys.filter((k) => k.startsWith('episode:')).length).toBe(5);
  // The page scrolled under the sticky Back on the way.
  expect((await ring(page)).scroll).toBeGreaterThan(0);
  // Along the last episode's row and back.
  await page.locator('.episode-row').last().scrollIntoViewIfNeeded();
  for (let i = 0; i < 12 && !(await ring(page)).key?.startsWith('detail-play'); i++) {
    await step(page, 'ArrowUp', `Up ${i + 1}`);
  }
  expect((await ring(page)).key).toBe('detail-play');
  const back = await step(page, 'ArrowUp', 'Up to Back');
  expect(back.key).toBe('detail-back');
  expect(back.scroll).toBe(0);
  await press(page, 'Escape');
  await expect.poll(() => focused(page)).toContain('Example Show');
  expectSeen(await ring(page), 'back on the shelf');
});

test("an actor's page by keys, and Back to the cast member", async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  for (let i = 0; i < 6 && !/Pat Fixture/.test(await focused(page) ?? ''); i++) await step(page, 'ArrowDown', `Down ${i + 1}`);
  expect(await focused(page)).toMatch(/Pat Fixture/);
  await press(page, 'Enter');
  await expect(page.locator('.person-page h1')).toHaveText('Pat Fixture');
  await expect.poll(async () => (await ring(page)).key).toMatch(/^grid:/);
  expectSeen(await ring(page), 'on the actor');
  await step(page, 'ArrowRight', 'along the titles');
  for (let i = 0; i < 4 && (await ring(page)).key !== 'person-back'; i++) await step(page, 'ArrowUp', `Up ${i + 1}`);
  expect((await ring(page)).key).toBe('person-back');
  await press(page, 'Escape');
  await expect(page.locator('.detail h1')).toHaveText('Example Part Two');
  await expect.poll(() => focused(page)).toMatch(/Pat Fixture/);
  expectSeen(await ring(page), 'back on the cast');
});

test('a dialog holds the ring: arrows and Tab stay in it, Back gives it to the button', async ({ page }) => {
  await open(page);
  await openTitle(page, 'Movies', 'Example Part Two');
  for (let i = 0; i < 10 && !/^Poster/.test(await focused(page) ?? ''); i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  const dialog = page.getByRole('dialog', { name: 'Poster' });
  await expect(dialog).toBeVisible();
  const inDialog = () =>
    page.evaluate(() => {
      const el = document.querySelector('.focused');
      const box = document.querySelector('.posters');
      return Boolean(el && box?.contains(el) && box.contains(document.activeElement));
    });
  await expect.poll(inDialog).toBe(true);
  for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'Tab', 'Tab', 'Shift+Tab']) {
    await press(page, key);
    expect(await inDialog(), `after ${key}`).toBe(true);
  }
  await press(page, 'Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatch(/^Poster/);
  expectSeen(await ring(page), 'back on the button');
});

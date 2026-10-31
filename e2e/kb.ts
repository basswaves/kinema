/**
 * Shared by the keyboard flows (keyboard-*.e2e.ts): key presses, where the
 * focus ring is, the fake mpv, TV mode and opening the mock as a system.
 */
import { expect, type Page } from '@playwright/test';

/** Whether Kinema's own focus engine answers the keys now (focusStore.ts). */
function onKinemaEngine(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __nav?: { answering?: () => boolean } }).__nav?.answering?.() ?? false
  );
}

/**
 * The one place a fixed wait lives (eslint bans `waitForTimeout` elsewhere in
 * e2e/). Only for input pacing or for a check that measures time on purpose;
 * `why` says which. Everything else waits for a state: `expect.poll`,
 * `drawn`, `settled`, the focus key.
 */
export async function pause(page: Page, ms: number, why: string): Promise<void> {
  void why;
  await page.waitForTimeout(ms);
}

/** A press done: at once on Kinema's own engine, spaced on the spatial library's. */
export async function afterPress(page: Page): Promise<void> {
  if (!(await onKinemaEngine(page))) await pause(page, 150, 'input pacing: no screen answers yet, so presses are spaced');
}

/**
 * The page has answered everything sent so far and drawn the result: two
 * frames. For checking that something did *not* happen, without a fixed wait.
 */
export async function drawn(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  );
}

/** The page has stopped moving: no scroll the ring caused is still gliding. */
export async function settled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __nav?: { still?: () => boolean } }).__nav?.still?.() ?? true))
    .toBe(true);
}

/**
 * Key presses. On a screen on Kinema's own engine a press is answered before
 * it returns, so the next can follow at once; a screen still on the spatial
 * library drops presses closer than its throttle (docs/GOTCHAS.md), so they
 * are spaced there until it moves over (round 7).
 */
export async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await afterPress(page);
  }
}

/**
 * Asking the engine directly (the `__nav` probe, src/dev/navProbe.ts,
 * dev:mock only — never in a release build): which focus key holds the ring,
 * and the screen's tree. Flows assert on these instead of reading DOM classes
 * after a delay.
 */
export function focusKey(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __nav: { current(): string | null } }).__nav.current());
}

/** The ring is on the control with this focus key: waits for it, never a time. */
export async function expectFocusKey(page: Page, key: string): Promise<void> {
  await expect.poll(() => focusKey(page)).toBe(key);
}

export interface TreeNode {
  key: string;
  parent: string;
  kind: string;
  disabled: boolean;
}

/** Every node the screen has registered, in registration order. */
export function focusTree(page: Page): Promise<TreeNode[]> {
  return page.evaluate(() => (window as unknown as { __nav: { tree(): TreeNode[] } }).__nav.tree());
}

/** The text of the control the focus ring is on. */
export function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('.focused')?.textContent?.trim());
}

export interface FakeMpv {
  path: string | null;
  paused: boolean;
  position: number;
}

export function mpv(page: Page): Promise<FakeMpv> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeMpv: FakeMpv }).__fakeMpv;
    return { path: f.path, paused: f.paused, position: f.position };
  });
}

/** Switch TV mode on through the app's own module, as Settings would. */
export async function tvMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = '/src/ui/tv.ts';
    const tv = await import(/* @vite-ignore */ path);
    await tv.setTvMode(true);
  });
}

/**
 * Home's hero is a different title each calendar day (hero.ts); the flows
 * that press its Play need it to be the fixture show, so they run on a
 * fixed day. Only those: with the date fixed, key presses all carry the
 * same time, and the navigation the other flows rely on takes them for
 * repeats.
 */
export async function onFixtureDay(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00'));
}

/** Open the mock as a given system (`kinemaMockSystem`), Home focused. */
export async function open(page: Page, system: 'windows' | 'linux'): Promise<void> {
  await page.addInitScript((s) => {
    if (s === 'linux') localStorage.setItem('kinemaMockSystem', 'linux');
    else localStorage.removeItem('kinemaMockSystem');
  }, system);
  await page.goto('/');
  // The page, not a guess at how long it takes: a starved runner needs more than expect's 5 s.
  await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
}

/**
 * Through the first run by remote, with one folder, to the setup page titled
 * `title` — passing the pages before it with their way on. Switches for the
 * mock go in an init script first.
 */
export async function firstRunToSetupPage(
  page: Page,
  system: 'android' | 'windows',
  title: string
): Promise<void> {
  await page.goto('/');
  if (system === 'windows') {
    await expect.poll(() => focused(page)).toBe('A TV, from the sofa');
    await press(page, 'Enter');
    await press(page, 'ArrowDown');
  }
  await expect.poll(() => focused(page)).toBe('Add movies folder');
  await press(page, 'Enter');
  if (system === 'android') {
    await expect.poll(() => focused(page)).toBe('USB driveUSB drive or card');
    await press(page, 'Enter');
    await press(page, 'ArrowUp');
    await expect.poll(() => focused(page)).toBe('Use this folder');
    await press(page, 'Enter');
  }
  await expect(page.locator('.first-run-roots li')).toHaveCount(1);
  for (let i = 0; i < 5 && (await focused(page)) !== 'Scan my library'; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  for (let i = 0; i < 6 && (await page.locator('.setup-pages h1').textContent()) !== title; i++) {
    await expect.poll(() => focused(page)).not.toBeUndefined();
    for (let j = 0; j < 4 && (await focused(page)) !== 'Next'; j++) {
      await press(page, 'ArrowUp');
    }
    await press(page, 'Enter');
    await drawn(page);
  }
  await expect(page.locator('.setup-pages h1')).toHaveText(title);
}

export async function androidSettings(page: Page, section: string): Promise<void> {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => localStorage.setItem('kinemaMockSystem', 'android'));
  await page.goto('/');
  await expect.poll(() => focused(page)).toContain('Play');
  await press(page, 'ArrowUp', 2);
  for (let i = 0; i < 6 && (await focused(page)) !== 'Settings'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await press(page, 'ArrowDown');
  for (let i = 0; i < 8 && (await focused(page)) !== section; i++) await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await press(page, 'ArrowRight');
}

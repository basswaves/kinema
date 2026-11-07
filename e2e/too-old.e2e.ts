/**
 * The message in `index.html` for a web engine too old to read Kinema's scripts.
 * A browser here is new, so the engine's failure is put in the way: the script
 * it cannot read is answered with what it would choke on. Real proof on an old
 * WebView needs the emulator (notes/TEST-SETUP.md); this holds the rules.
 */
import { expect, test, type Page } from '@playwright/test';
import { focused, pause } from './kb';

const unreadable = (page: Page) =>
  page.route(/\/src\/main\.tsx/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'const a = 1 +;' })
  );

test('scripts that cannot be read: says what to do, and nothing there takes focus', async ({ page }) => {
  await unreadable(page);
  await page.goto('/');
  const box = page.locator('#too-old');
  await expect(box).toBeVisible();
  await expect(box.locator('h1')).toHaveText('Kinema needs a newer web engine');
  await expect(box).toContainText('WebView2');
  await expect(box).toContainText('SyntaxError');
  await expect(box.locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  // The message has the background, the window behind it stays see-through.
  const backgrounds = await page.evaluate(() =>
    ['html', 'body', '#root'].map((s) => getComputedStyle(document.querySelector(s)!).backgroundColor)
  );
  for (const b of backgrounds) expect(b).toBe('rgba(0, 0, 0, 0)');
});

test('on Android, and at a TV page’s size, it names the WebView and all of it fits', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 960, height: 540 },
    userAgent: 'Mozilla/5.0 (Linux; Android 9; TV) AppleWebKit/537.36 Chrome/66.0 Safari/537.36',
  });
  const page = await context.newPage();
  await unreadable(page);
  await page.goto('/');
  const box = page.locator('#too-old');
  await expect(box.locator('h1')).toHaveText('Kinema needs a newer Android System WebView');
  await expect(box).toContainText('Google Play');
  const fits = await box.evaluate((el) => el.scrollHeight <= el.clientHeight);
  expect(fits).toBe(true);
  await context.close();
});

test('a slow start says nothing, however long it takes', async ({ page }) => {
  await page.route(/\/src\/main\.tsx/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await route.continue();
  });
  await page.goto('/');
  await pause(page, 6000, 'a start this slow, with nothing on the screen yet');
  await expect(page.locator('#too-old')).toHaveCount(0);
  await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
  await expect(page.locator('#too-old')).toHaveCount(0);
});

test('a fault on a new engine is not blamed on the engine', async ({ page }) => {
  await page.route(/\/src\/main\.tsx/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "window.__kinemaRan = true; JSON.parse('{'); ",
    })
  );
  await page.goto('/');
  await pause(page, 1000, 'the error has been heard by then');
  await expect(page.locator('#too-old')).toHaveCount(0);

  await page.route(/\/src\/main\.tsx/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "window.__kinemaRan = true; null.nothing; ",
    })
  );
  await page.reload();
  await pause(page, 1000, 'the error has been heard by then');
  await expect(page.locator('#too-old')).toHaveCount(0);
});

test('an engine that reads the scripts but lacks what they use says so', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Object as unknown as { hasOwn?: unknown }).hasOwn;
  });
  await page.route(/\/src\/main\.tsx/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "window.__kinemaRan = true; Object.hasOwn({}, 'a');",
    })
  );
  await page.goto('/');
  await expect(page.locator('#too-old')).toBeVisible();
});

test('a healthy start: no message, nothing heard, and a late fault changes nothing', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => focused(page), { timeout: 30_000 }).toContain('Play');
  await page.evaluate(() => {
    setTimeout(() => {
      throw new SyntaxError('late');
    }, 0);
  });
  await pause(page, 300, 'the error has been heard by then');
  await expect(page.locator('#too-old')).toHaveCount(0);
});

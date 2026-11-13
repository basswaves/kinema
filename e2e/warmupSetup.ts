/**
 * Warms the dev server once, before any flow: loads the app in a browser so
 * Vite has transformed every module the first page needs.
 *
 * Without it the first pages of a run all wait on the same cold transforms,
 * and under load (a cargo build, the other verify lane) `page.goto` and the
 * first checks ran out of time on flows that pass alone. It only warms: a
 * failure here is ignored, the flows report their own.
 */
import { chromium, webkit, type FullConfig } from '@playwright/test';

declare const process: { platform: string };

export default async function warmup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const engine =
    process.platform === 'win32'
      ? () => chromium.launch({ channel: 'msedge' })
      : () => webkit.launch();
  try {
    const browser = await engine();
    try {
      const page = await browser.newPage();
      await page.goto(baseURL, { waitUntil: 'load', timeout: 120_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.warn('dev server warm-up skipped:', e instanceof Error ? e.message : e);
  }
}

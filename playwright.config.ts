/**
 * The interface, driven by keyboard only, in two browser engines.
 *
 * Kinema's window is Chromium on Windows (WebView2) and Android, and WebKit on
 * Linux (WebKitGTK). A difference between them in CSS or JavaScript shows up
 * here, against `dev:mock`'s fake library and fake mpv, before anyone runs
 * Linux. `npm run test:ui`; see CONTRIBUTING, "Checking Linux from Windows".
 *
 * WebKit is Playwright's own build (`npx playwright install webkit`, once).
 * Chromium is Microsoft Edge, which Windows already has — the same engine as
 * WebView2 — so it is only run on Windows, and nothing is downloaded for it.
 */
import { defineConfig } from '@playwright/test';

// Node's own global, declared rather than pulling in @types/node for one line
// (vite.config.ts does the same with a ts-expect-error).
declare const process: { platform: string };

const PORT = 1440;

export default defineConfig({
  testDir: 'e2e',
  // Not `.spec.ts`: vitest would pick those up and fail on them.
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  retries: 0,
  // One at a time: the fake mpv keeps its clock in the page, and the checks
  // time things in seconds.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'webkit', use: { browserName: 'webkit' } },
    ...(process.platform === 'win32'
      ? [{ name: 'edge', use: { browserName: 'chromium' as const, channel: 'msedge' } }]
      : []),
  ],
  webServer: {
    command: `npm run dev:mock -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

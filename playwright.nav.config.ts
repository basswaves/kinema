/**
 * The navigation checker: `npm run test:nav`.
 *
 * Walks every screen of `dev:mock` at a TV's size, pressing every arrow from
 * every control and writing down where focus goes (`e2e/navmap.nav.ts`). It
 * reports; it does not assert on the moves. Its own port, so it can run while
 * `npm run test:ui` (1440) does. Same two engines as `playwright.config.ts`.
 */
import { defineConfig } from '@playwright/test';

declare const process: { platform: string };

const PORT = 1441;

export default defineConfig({
  testDir: 'e2e',
  // Not `.spec.ts` or `.e2e.ts`: neither vitest nor `npm run test:ui` runs these.
  testMatch: '**/*.nav.ts',
  timeout: 40 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1920, height: 1080 },
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

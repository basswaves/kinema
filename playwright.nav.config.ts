/**
 * The navigation checker: `npm run test:nav`.
 *
 * Walks every screen of `dev:mock` at a TV's size, pressing every arrow from
 * every control and writing down where focus goes (`e2e/navmap.nav.ts`). It
 * reports; it does not assert on the moves. Its own port, so it can run while
 * `npm run test:ui` (1440) does. Same two engines as `playwright.config.ts`.
 */
import { defineConfig } from '@playwright/test';

declare const process: { platform: string; env: Record<string, string | undefined> };

const PORT = 1441;

const ENGINES = [
  { name: 'webkit', use: { browserName: 'webkit' as const } },
  ...(process.platform === 'win32'
    ? [{ name: 'edge', use: { browserName: 'chromium' as const, channel: 'msedge' } }]
    : []),
];

export default defineConfig({
  testDir: 'e2e',
  // Not `.spec.ts` or `.e2e.ts`: neither vitest nor `npm run test:ui` runs these.
  testMatch: '**/*.nav.ts',
  // Clears the parts of the last run (navmap-results/parts/).
  globalSetup: './e2e/navmapSetup.ts',
  timeout: 40 * 60_000,
  retries: 0,
  // Each system's walk is split into parts that share the screens out (see
  // navmap.nav.ts), every screen in its own page. As in playwright.config.ts:
  // one worker per core, 5 on CI's 4-core runner (8 on 4 cores started to
  // fail the keyboard flows).
  fullyParallel: true,
  workers: process.env.CI ? 5 : '100%',
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1920, height: 1080 },
  },
  // Per engine, in order: the Windows walk; then Linux and Android, which copy
  // Windows' moves for screens laid out the same; then the held keys, alone;
  // then the map. The last is named after the engine, so `--project webkit`
  // still runs them all. (With both engines, on Windows, one engine's held
  // keys can overlap the other's walk: run `--project edge` and `--project
  // webkit` one after the other when those numbers matter.)
  projects: ENGINES.flatMap((e) => [
    { name: `${e.name}-windows`, use: e.use, metadata: { engine: e.name }, grep: /walk the screens as windows/ },
    {
      name: `${e.name}-systems`,
      use: e.use,
      metadata: { engine: e.name },
      grep: /walk the screens as (linux|android)/,
      dependencies: [`${e.name}-windows`],
    },
    // Timed, so with nothing beside them: one worker, after every walk.
    { name: `${e.name}-lag`, use: e.use, metadata: { engine: e.name }, grep: /hold the keys as/, dependencies: [`${e.name}-systems`] },
    { name: e.name, use: e.use, metadata: { engine: e.name }, grep: /write the map/, dependencies: [`${e.name}-lag`] },
  ]),
  webServer: {
    command: `npm run dev:mock -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

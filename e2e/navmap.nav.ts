/**
 * The navigation checker: `npm run test:nav` (playwright.nav.config.ts).
 *
 * For every screen the mock can show, at a TV's size with TV mode on, it
 * puts focus on each control in turn, presses each arrow once, and writes down
 * where focus went and whether the result looked wrong (under the top bar, off
 * the screen, out of a dialog). It REPORTS today's behaviour; it asserts on
 * nothing about the moves. It fails only when it cannot get to Home.
 *
 * Never the mouse: a hover repairs focus and hides exactly the failures this
 * looks for. Keys only (Playwright's keyboard); `__nav.setFocus` is used to
 * stand on a control, and the output says which screens were reached with it.
 *
 * Output: navmap-results/ — navmap.json and NAV-MAP.generated.md (see
 * navmapReport.ts), with one file per engine and system beside them. Not
 * under test-results/: Playwright empties that at the start of every run, so
 * one `npm run test:ui` afterwards deleted the map.
 */
import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeReports } from './navmapReport';
import {
  DIRS,
  type Dir,
  type LagResult,
  type LeafInfo,
  type Move,
  type ScreenResult,
  type SystemResult,
} from './navmapTypes';

type System = 'windows' | 'linux' | 'android';
const SYSTEMS: System[] = ['windows', 'linux', 'android'];

const OUT = join(process.cwd(), 'navmap-results');

/** NAV_ONLY=regex runs only the screens whose id matches; NAV_SYSTEMS=windows,linux likewise. */
const ONLY = process.env.NAV_ONLY ? new RegExp(process.env.NAV_ONLY) : null;
const ONLY_SYSTEMS = process.env.NAV_SYSTEMS?.split(',') ?? null;

// ---- in the page ------------------------------------------------------------

/** Installed before the app loads, so it survives every reload. */
const HELPERS = `
(() => {
  const W = window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  // What "still moving" means: the focus, the page's scroll, and the focused
  // control's own position (rails scroll sideways, controls zoom).
  function sig() {
    const n = W.__nav;
    if (!n) return '';
    const b = n.box(n.current());
    const browse = document.querySelector('.browse');
    const root = document.scrollingElement;
    return [
      n.current(),
      browse ? browse.scrollTop : 0,
      root ? root.scrollTop : 0,
      b ? Math.round(b.top * 2) + ',' + Math.round(b.left * 2) : '',
    ].join('|');
  }
  // Waits at least minMs, then until two frames in a row show no change; never
  // longer than maxMs.
  async function settle(minMs, maxMs) {
    const t0 = performance.now();
    let last = sig();
    let stable = 0;
    while (performance.now() - t0 < maxMs) {
      await frame();
      const s = sig();
      stable = s === last ? stable + 1 : 0;
      last = s;
      if (performance.now() - t0 >= minMs && stable >= 2) break;
    }
  }
  W.__navw = {
    async focusAndSettle(key) {
      await W.__nav.setFocus(key);
      await settle(30, 800);
      if (W.__nav.current() !== key) {
        await sleep(120);
        await W.__nav.setFocus(key);
        await settle(30, 800);
      }
      return W.__nav.current();
    },
    async after() {
      await settle(35, 800);
      const n = W.__nav;
      return { cur: n.current(), d: n.describe(n.current()) };
    },
    current() {
      const n = W.__nav;
      const d = n.describe(n.current());
      return { key: n.current(), label: d ? d.label : '', inTopBar: d ? d.inTopBar : false };
    },
    screen() {
      const n = W.__nav;
      return n.leaves().map((l) => ({ ...l, heading: n.headingFor(l.key) }));
    },
    startSampler() {
      const S = (W.__lag = { max: 0, last: 0, run: true });
      (function loop() {
        if (!S.run) return;
        const n = W.__nav;
        const b = n.box(n.current());
        if (b) {
          const top = b.inTopBar ? 0 : b.topBarBottom;
          const o = Math.max(0, top - b.top, b.bottom - b.vh, -b.left, b.right - b.vw);
          if (o > 0.5) {
            S.last = performance.now();
            if (o > S.max) S.max = o;
          }
        }
        requestAnimationFrame(loop);
      })();
    },
    stopSampler() {
      W.__lag.run = false;
      return W.__lag;
    },
    now() {
      return performance.now();
    },
  };
})();
`;

interface Current {
  key: string;
  label: string;
  inTopBar: boolean;
}

interface Described {
  key: string;
  label: string;
  rect: { left: number; top: number; right: number; bottom: number };
  headingRect?: { top: number; bottom: number } | null;
  inTopBar: boolean;
  topBarBottom: number;
  vw: number;
  vh: number;
}

interface RawLeaf {
  key: string;
  label: string;
  heading: string;
  boundary: string | null;
  parents: string[];
  rect: { left: number; top: number; right: number; bottom: number };
}

const current = (page: Page) => page.evaluate<Current>('window.__navw.current()');
const rawLeaves = (page: Page) => page.evaluate<RawLeaf[]>('window.__navw.screen()');

// ---- keys ---------------------------------------------------------------------

/** Presses far enough apart that the app sees two (docs/GOTCHAS.md). */
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(160);
  }
}

/** Press `dir` until `match` is true of what has focus (checking first). */
async function pressUntil(
  page: Page,
  dir: string,
  match: (c: Current) => boolean,
  max = 30
): Promise<boolean> {
  for (let i = 0; i <= max; i++) {
    if (match(await current(page))) return true;
    if (i < max) await press(page, dir);
  }
  return false;
}

/** From anywhere in the page's content: Up to the top bar, along it, OK. */
async function openFromTopBar(page: Page, name: string): Promise<boolean> {
  if (!(await pressUntil(page, 'ArrowUp', (c) => c.inTopBar, 12))) return false;
  await pressUntil(page, 'ArrowLeft', (c) => c.label === 'Home', 8);
  if (!(await pressUntil(page, 'ArrowRight', (c) => c.label === name, 8))) return false;
  await press(page, 'Enter');
  await page.waitForTimeout(900);
  return true;
}

// ---- a page per screen ----------------------------------------------------------

interface Boot {
  system: System;
  /** localStorage switches for the mock (`kinemaMock…`). */
  flags?: Record<string, string>;
  /** Leave TV mode as the app starts (first run asks for it). */
  noTv?: boolean;
  /** Wait for this instead of Home. */
  ready?: (page: Page) => Promise<void>;
}

/**
 * A new page in a browser context kept per set of mock switches: the pages
 * share the context's cache, so the app's modules are fetched once rather than
 * for every screen (the mock keeps its state in the page, not in storage, so
 * nothing carries over).
 */
async function boot(
  ctx: { browser: Browser; baseURL: string; contexts: Map<string, BrowserContext> },
  b: Boot
): Promise<Page> {
  const flags = { ...(b.flags ?? {}) };
  if (b.system !== 'windows') flags.kinemaMockSystem = b.system;
  const id = JSON.stringify(flags);
  let context = ctx.contexts.get(id);
  if (!context) {
    context = await ctx.browser.newContext({
      baseURL: ctx.baseURL,
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript((f) => {
      for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v);
    }, flags);
    await context.addInitScript(HELPERS);
    ctx.contexts.set(id, context);
  }
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction('window.__nav && window.__navw');
  if (b.ready) await b.ready(page);
  else {
    await page.waitForFunction('window.__nav.leaves().length > 6', undefined, { timeout: 20_000 });
    if (!b.noTv) {
      await page.evaluate(async () => {
        const path = '/src/ui/tv.ts';
        const tv = await import(/* @vite-ignore */ path);
        await tv.setTvMode(true);
      });
    }
  }
  await quiet(page);
  return page;
}

/** Until the set of controls has stopped changing for 700 ms (notices and rails arrive late). */
async function quiet(page: Page): Promise<void> {
  let last = '';
  let since = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const now = (await rawLeaves(page)).map((l) => l.key).join(',');
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since > 700) return;
    await page.waitForTimeout(150);
  }
}

// ---- walking one screen ------------------------------------------------------------

interface Reached {
  how: 'keyboard' | 'probe';
  note?: string;
}

interface Walk {
  /** Which controls to press from; default every one except the shared top bar. */
  origins?: (l: LeafInfo) => boolean;
  /** Only these controls are on the screen being walked (a dialog over a page). */
  only?: (l: RawLeaf) => boolean;
  /** Also press from the top bar. */
  topBar?: boolean;
  /** Run before pressing from each control (the player brings its controls back up). */
  beforeLeaf?: (page: Page) => Promise<void>;
}

function groupOf(l: RawLeaf): string {
  if (l.parents.includes('top-nav')) return 'Top bar';
  if (l.key.startsWith('settings-nav:')) return 'Settings list';
  if (l.key.startsWith('rail:')) return `Rail: ${l.heading}`;
  if (l.key.startsWith('hero-')) return 'Hero (the big picture at the top)';
  if (l.key.startsWith('notice-')) return 'Notices under the hero';
  return l.heading || 'Controls';
}

/** First two rows and the last row of any group of more than 30 controls. */
function sampleRows(leaves: LeafInfo[]): { kept: Set<string>; note: string | null } {
  const byParent = new Map<string, LeafInfo[]>();
  for (const l of leaves) {
    const k = l.parents[0] ?? '';
    byParent.set(k, [...(byParent.get(k) ?? []), l]);
  }
  const kept = new Set<string>(leaves.map((l) => l.key));
  const notes: string[] = [];
  for (const [parent, list] of byParent) {
    if (list.length <= 30) continue;
    const rows: LeafInfo[][] = [];
    for (const l of [...list].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].rect.top - l.rect.top) < 14) row.push(l);
      else rows.push([l]);
    }
    // A grid, not a column of one control per row: those are all pressed.
    if (rows.length <= 3 || list.length / rows.length < 2.5) continue;
    const keep = new Set([...rows[0], ...rows[1], ...rows[rows.length - 1]].map((l) => l.key));
    for (const l of list) if (!keep.has(l.key)) kept.delete(l.key);
    notes.push(`${list.length} controls in ${parent || 'a group'}: first two rows and last row pressed from (${keep.size})`);
  }
  return { kept, note: notes.length ? `Sampled — ${notes.join('; ')}` : null };
}

function flagsFor(
  from: LeafInfo,
  d: Described | null,
  cur: string,
  table: Map<string, LeafInfo>
): string[] {
  const flags: string[] = [];
  if (cur === from.key) flags.push('no-move');
  if (!d) {
    flags.push('focus-lost');
    return flags;
  }
  const to = table.get(cur);
  if (from.boundary && to && !to.parents.includes(from.boundary)) flags.push('left-menu');
  else if (from.boundary && !to) flags.push('left-menu');
  // Where a control sits is judged only after it has been moved to: where a
  // press began is where the probe put it, not where the app scrolled to.
  if (cur === from.key) return flags;
  const bar = d.topBarBottom;
  if (!d.inTopBar && bar > 0) {
    const under = d.rect.top < bar - 1;
    const h = d.headingRect;
    // A heading half behind the bar counts only if it and the control would fit
    // below the bar together; a grid row far below its heading is not a fault.
    const headingUnder =
      h != null && h.top < bar - 1 && h.bottom > bar + 1 && d.rect.bottom - h.top <= d.vh - bar;
    if (under || headingUnder) flags.push('under-top-bar');
  }
  const r = d.rect;
  if (r.left < -2 || r.top < -2 || r.right > d.vw + 2 || r.bottom > d.vh + 2) flags.push('off-screen');
  return flags;
}

async function walk(
  page: Page,
  id: string,
  name: string,
  reached: Reached,
  opts: Walk = {},
  baseline: ScreenResult | null = null
): Promise<ScreenResult> {
  const t0 = Date.now();
  const landing = (await current(page)).key;
  let raw = await rawLeaves(page);
  if (opts.only) raw = raw.filter(opts.only);
  const leaves: LeafInfo[] = raw.map((l) => ({
    key: l.key,
    label: l.label,
    group: groupOf(l),
    heading: l.heading,
    boundary: l.boundary,
    parents: l.parents,
    rect: l.rect,
    walked: true,
  }));
  const table = new Map(leaves.map((l) => [l.key, l]));
  for (const l of leaves) {
    if (!opts.topBar && l.parents.includes('top-nav')) l.walked = false;
    if (opts.origins && !opts.origins(l)) l.walked = false;
  }
  const sample = sampleRows(leaves.filter((l) => l.walked));
  for (const l of leaves) if (l.walked && !sample.kept.has(l.key)) l.walked = false;

  const result: ScreenResult = {
    id,
    name,
    how: reached.how,
    note: reached.note ?? '',
    landing,
    sampled: sample.note,
    seconds: 0,
    leaves,
    moves: [],
    unreachable: [],
    trapped: [],
    flagCounts: {},
    reusedFrom: null,
  };

  // The same controls in the same places as another system's screen: the
  // same moves. Copied, not pressed again, and said so.
  const print = (ls: LeafInfo[]) =>
    ls
      .map((l) => `${l.key}@${Math.round(l.rect.left)},${Math.round(l.rect.top)}`)
      .sort()
      .join(';');
  if (baseline && print(baseline.leaves) === print(leaves) && baseline.moves.length > 0) {
    result.moves = baseline.moves;
    result.reusedFrom = 'windows';
    for (const l of leaves) l.walked = baseline.leaves.find((b) => b.key === l.key)?.walked ?? l.walked;
  } else {
    for (const from of leaves.filter((l) => l.walked)) {
      await opts.beforeLeaf?.(page);
      const got = await page.evaluate<string>(`window.__navw.focusAndSettle(${JSON.stringify(from.key)})`);
      if (got !== from.key) {
        result.moves.push({
          from: from.key,
          dir: 'ArrowUp',
          to: got,
          toLabel: '(could not put focus here)',
          toHeading: '',
          flags: ['not-focusable'],
        });
        continue;
      }
      for (const dir of DIRS) {
        await page.keyboard.press(dir);
        const after = await page.evaluate<{ cur: string; d: Described | null }>('window.__navw.after()');
        const to = table.get(after.cur);
        // The heading is measured only when the control is near the bar.
        if (after.d && after.cur !== from.key && after.d.topBarBottom > 0 && after.d.rect.top < after.d.topBarBottom + 160) {
          after.d.headingRect = await page.evaluate<{ top: number; bottom: number } | null>(
            `window.__nav.headingRect(${JSON.stringify(after.cur)})`
          );
        }
        const move: Move = {
          from: from.key,
          dir: dir as Dir,
          to: after.cur,
          toLabel: after.d?.label ?? to?.label ?? after.cur,
          toHeading: to?.heading ?? '',
          flags: flagsFor(from, after.d, after.cur, table),
        };
        if (move.flags.some((f) => f === 'under-top-bar' || f === 'off-screen') && after.d) {
          move.after = {
            top: Math.round(after.d.rect.top),
            bottom: Math.round(after.d.rect.bottom),
            barBottom: Math.round(after.d.topBarBottom),
            viewportHeight: after.d.vh,
            headingTop: after.d.headingRect ? Math.round(after.d.headingRect.top) : null,
          };
        }
        result.moves.push(move);
        if (after.cur !== from.key && dir !== DIRS[DIRS.length - 1]) {
          await page.evaluate<string>(`window.__navw.focusAndSettle(${JSON.stringify(from.key)})`);
        }
      }
    }
  }

  // Analysis.
  const walkedKeys = leaves.filter((l) => l.walked).map((l) => l.key);
  const landedOn = new Set(result.moves.filter((m) => m.to !== m.from).map((m) => m.to));
  result.unreachable = leaves
    .filter((l) => l.walked && l.key !== landing && !landedOn.has(l.key))
    .map((l) => l.key);
  result.trapped = walkedKeys.filter((k) => {
    const mine = result.moves.filter((m) => m.from === k && !m.flags.includes('not-focusable'));
    return mine.length === 4 && mine.every((m) => m.flags.includes('no-move'));
  });
  for (const m of result.moves) {
    for (const f of m.flags) result.flagCounts[f] = (result.flagCounts[f] ?? 0) + 1;
  }
  result.seconds = (Date.now() - t0) / 1000;
  return result;
}

// ---- held keys ---------------------------------------------------------------------

/** Holds `key` for 1.5 s at a key-repeat's pace; how far out of view focus gets, and how long after key-up. */
async function hold(page: Page, name: string, key: string): Promise<LagResult> {
  await page.evaluate('window.__navw.startSampler()');
  let presses = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    await page.keyboard.down(key);
    presses++;
    await page.waitForTimeout(33);
  }
  await page.keyboard.up(key);
  const up = await page.evaluate<number>('window.__navw.now()');
  await page.waitForTimeout(1500);
  const s = await page.evaluate<{ max: number; last: number }>('window.__navw.stopSampler()');
  return {
    name,
    keyHeld: key,
    presses,
    maxOutsidePx: Math.round(s.max),
    msUntilVisibleAfterKeyUp: Math.max(0, Math.round(s.last - up)),
  };
}

// ---- the screens ------------------------------------------------------------------------

const isLabel = (label: string | RegExp) => (c: Current) =>
  typeof label === 'string' ? c.label === label : label.test(c.label);

const SECTIONS: [string, string][] = [
  ['library', 'Library'],
  ['playback', 'Playback'],
  ['picture', 'Picture & sound'],
  ['intros', 'Intro & credits'],
  ['accounts', 'Accounts'],
  ['advanced', 'Advanced'],
];

/** Home → Movies' film card → its page. */
async function toMovieDetail(page: Page): Promise<boolean> {
  if (!(await pressUntil(page, 'ArrowDown', isLabel('Example Film'), 14))) return false;
  await press(page, 'Enter');
  await page.waitForFunction("window.__nav.leaves().some((l) => l.key === 'detail-play')", undefined, {
    timeout: 8000,
  });
  await page.waitForTimeout(600);
  return true;
}

async function toSettings(page: Page): Promise<boolean> {
  if (!(await openFromTopBar(page, 'Settings'))) return false;
  // Settings lands on the top bar; Down goes to the section list.
  return pressUntil(page, 'ArrowDown', (c) => c.label === 'Library', 3);
}

async function toSection(page: Page, id: string): Promise<boolean> {
  if (!(await toSettings(page))) return false;
  if (id !== 'library') {
    if (!(await pressUntil(page, 'ArrowDown', (c) => c.label === SECTIONS.find((s) => s[0] === id)?.[1], 8)))
      return false;
    await press(page, 'Enter');
    await page.waitForTimeout(700);
  }
  await quiet(page);
  return true;
}

function skip(id: string, name: string, note: string): ScreenResult {
  return {
    id,
    name,
    how: 'skipped',
    note,
    landing: null,
    sampled: null,
    seconds: 0,
    leaves: [],
    moves: [],
    unreachable: [],
    trapped: [],
    flagCounts: {},
    reusedFrom: null,
  };
}

type Baselines = Map<string, ScreenResult>;

interface Ctx {
  browser: Browser;
  baseURL: string;
  system: System;
  contexts: Map<string, BrowserContext>;
  baselines: Baselines;
  out: ScreenResult[];
  lag: LagResult[];
}

/** Boots a page for one screen, runs it, closes it; a screen that cannot be reached is skipped with its reason. */
async function screen(
  ctx: Ctx,
  id: string,
  name: string,
  b: Omit<Boot, 'system'>,
  run: (page: Page) => Promise<ScreenResult[] | ScreenResult | null>
): Promise<void> {
  if (ONLY && !ONLY.test(id)) return;
  let page: Page | null = null;
  try {
    page = await boot(ctx, { ...b, system: ctx.system });
    const r = await run(page);
    const list = r === null ? [] : Array.isArray(r) ? r : [r];
    if (list.length === 0) ctx.out.push(skip(id, name, 'Could not be reached by the arrows from Home.'));
    ctx.out.push(...list);
  } catch (e) {
    if (id === 'home') throw e;
    ctx.out.push(skip(id, name, `Could not be reached: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`));
  } finally {
    await page?.close();
  }
}

const base = (ctx: Ctx, id: string) => ctx.baselines.get(id) ?? null;

async function walkSystem(ctx: Ctx): Promise<void> {
  const w = (page: Page, id: string, name: string, how: Reached, opts?: Walk) =>
    walk(page, id, name, how, opts, base(ctx, id));
  const KB: Reached = { how: 'keyboard' };

  await screen(ctx, 'home', 'Home', {}, async (p) => w(p, 'home', 'Home', KB, { topBar: true }));

  await screen(ctx, 'movies', 'Movies (the whole shelf)', { flags: { kinemaMockTitles: '60' } }, async (p) => {
    if (!(await openFromTopBar(p, 'Movies'))) return null;
    await quiet(p);
    return w(p, 'movies', 'Movies (the whole shelf)', { how: 'keyboard', note: 'Library padded with 60 extra films so the grid has rows.' });
  });

  await screen(ctx, 'tv', 'TV shows (the whole shelf)', {}, async (p) => {
    if (!(await openFromTopBar(p, 'TV shows'))) return null;
    await quiet(p);
    return w(p, 'tv', 'TV shows (the whole shelf)', KB);
  });

  await screen(ctx, 'search', 'Search (an empty query lists every title)', {}, async (p) => {
    if (!(await openFromTopBar(p, 'Search'))) return null;
    await quiet(p);
    return w(p, 'search', 'Search (an empty query lists every title)', KB);
  });

  await screen(ctx, 'detail-movie', 'A film’s page', {}, async (p) => {
    if (!(await toMovieDetail(p))) return null;
    return w(p, 'detail-movie', 'A film’s page', KB);
  });

  await screen(ctx, 'detail-series', 'A series’ page (seasons and episodes)', {}, async (p) => {
    if (!(await pressUntil(p, 'ArrowDown', isLabel('Example Show'), 14))) return null;
    await press(p, 'Enter');
    await p.waitForFunction("window.__nav.leaves().some((l) => l.key.startsWith('episode:'))", undefined, { timeout: 8000 });
    await quiet(p);
    return w(p, 'detail-series', 'A series’ page (seasons and episodes)', KB);
  });

  await screen(ctx, 'detail-saga', 'A series’ page with several seasons', {}, async (p) => {
    if (!(await pressUntil(p, 'ArrowDown', (c) => c.key.startsWith('rail:'), 14))) return null;
    if (!(await pressUntil(p, 'ArrowRight', isLabel('Example Saga'), 4))) return null;
    await press(p, 'Enter');
    await p.waitForFunction("window.__nav.leaves().some((l) => l.key.startsWith('episode:'))", undefined, { timeout: 8000 });
    await quiet(p);
    return w(p, 'detail-saga', 'A series’ page with several seasons', {
      how: 'keyboard',
      note: 'Example Saga: Season 1, Season 2 and Specials, with an episode the library lacks.',
    });
  });

  // Settings: every section in the list. The top bar and the list are pressed
  // from once, in the first section.
  for (const [sid, label] of SECTIONS) {
    await screen(ctx, `settings-${sid}`, `Settings → ${label}`, {}, async (p) => {
      if (!(await toSection(p, sid))) return null;
      return w(p, `settings-${sid}`, `Settings → ${label}`, KB, {
        topBar: sid === 'library',
        origins: (l) => sid === 'library' || !l.key.startsWith('settings-nav:'),
      });
    });
  }

  // Needs attention: the queue open in Settings → Library, then one item
  // opened. `kinemaMockReview=items` gives the mock three files to list.
  await screen(ctx, 'settings-review', 'Settings → Library, Needs attention queue open', { flags: { kinemaMockReview: 'items' } }, async (p) => {
    if (!(await toSection(p, 'library'))) return null;
    const base = new Set((await rawLeaves(p)).map((l) => l.key));
    await press(p, 'ArrowRight');
    if (!(await pressUntil(p, 'ArrowDown', (c) => /^Review/.test(c.label), 12))) return null;
    await press(p, 'Enter');
    await p.waitForTimeout(900);
    await quiet(p);
    const out: ScreenResult[] = [];
    out.push(
      await w(p, 'settings-review', 'Settings → Library, Needs attention queue open', KB, {
        origins: (l) => !base.has(l.key),
      })
    );
    const queue = new Set((await rawLeaves(p)).map((l) => l.key));
    // The first item of the queue, by the arrows from the Review button.
    await p.evaluate("window.__navw.focusAndSettle('settings-review-button')");
    await press(p, 'ArrowDown');
    if (!base.has((await current(p)).key) && (await current(p)).key !== 'settings-review-button') {
      await press(p, 'Enter');
      await p.waitForTimeout(800);
      await quiet(p);
      out.push(
        await w(p, 'settings-review-item', 'Needs attention: one item opened', {
          how: 'keyboard',
          note: 'Down from the Review button to the first item, OK. The Review button itself was reached with the arrows; the probe stood on it again before Down.',
        }, { origins: (l) => !queue.has(l.key) })
      );
    } else {
      out.push(skip('settings-review-item', 'Needs attention: one item opened', 'Down from the Review button did not reach an item.'));
    }
    return out;
  });

  await screen(ctx, 'leave', 'The leave dialog (Back from Home)', {}, async (p) => {
    await press(p, 'Escape');
    await p.waitForFunction("window.__nav.current() === 'leave-close'", undefined, { timeout: 4000 });
    return w(p, 'leave', 'The leave dialog (Back from Home)', { how: 'keyboard', note: 'Only the dialog’s own buttons; the page behind it is not walked.' }, {
      only: (l) => l.boundary !== null,
    });
  });

  // The player, and the panel over it. Played from the film's page with OK;
  // the fake mpv is playing, and each arrow wakes the controls.
  const intoPlayer = async (p: Page): Promise<boolean> => {
    if (!(await toMovieDetail(p))) return false;
    await press(p, 'Enter');
    await p.waitForFunction("window.__nav.leaves().some((l) => l.key === 'player-play')", undefined, { timeout: 10_000 });
    await p.waitForTimeout(700);
    return true;
  };
  // While watching, the spatial library is paused: the controls (and the
  // arrows) come up only on Up or Down, and are handed back after six idle
  // seconds (docs/DESIGN.md). Each control is therefore started from with the
  // controls up; the number of times they had gone is written in the note.
  await screen(ctx, 'player', 'The player’s controls', {}, async (p) => {
    if (!(await intoPlayer(p))) return null;
    const first = await current(p);
    await press(p, 'ArrowDown');
    const landed = await current(p);
    let raised = 0;
    const r = await w(
      p,
      'player',
      'The player’s controls',
      { how: 'keyboard', note: '' },
      {
        beforeLeaf: async (pg) => {
          if ((await pg.locator('.player.osd-hidden').count()) > 0) {
            await pg.keyboard.press('ArrowDown');
            await pg.waitForTimeout(200);
            raised++;
          }
        },
      }
    );
    r.landing = landed.key;
    r.note =
      `Played from the film’s page with OK, then Down to bring the controls up (before it nothing had focus: “${first.label || first.key}”; after it: “${landed.label || landed.key}”). ` +
      `The controls had gone (six idle seconds) and were brought back with Down ${raised} time${raised === 1 ? '' : 's'} during the walk.`;
    return r;
  });
  await screen(ctx, 'player-tracks', 'The Audio & subtitles panel', {}, async (p) => {
    if (!(await intoPlayer(p))) return null;
    const before = new Set((await rawLeaves(p)).map((l) => l.key));
    // As player.e2e.ts does: Down brings the controls up, Right along to the button.
    let how: Reached = { how: 'keyboard', note: 'Down to bring the controls up, Right to the button, OK.' };
    const tracks = (c: Current) => c.label === 'Audio & subtitles';
    await press(p, 'ArrowDown');
    if (!(await pressUntil(p, 'ArrowRight', tracks, 6))) {
      await p.evaluate("window.__navw.focusAndSettle('player-tracks-button')");
      how = { how: 'probe', note: 'Right from the controls never reached the Audio & subtitles button; stood on it with the probe.' };
    }
    await press(p, 'Enter');
    await p.waitForTimeout(900);
    const panel = (await rawLeaves(p)).filter((l) => !before.has(l.key));
    if (panel.length === 0) return skip('player-tracks', 'The Audio & subtitles panel', 'OK on the button did not open a panel.');
    return w(p, 'player-tracks', 'The Audio & subtitles panel', how, { only: (l) => !before.has(l.key) });
  });

  // First run and the setup pages (an empty library).
  await screen(
    ctx,
    'first-run',
    'First run',
    {
      flags: { kinemaMockEmpty: '1' },
      noTv: true,
      ready: async (p) => {
        await p.waitForFunction("window.__nav.leaves().length > 1 && document.querySelector('.first-run') !== null", undefined, { timeout: 20_000 });
      },
    },
    async (p) => {
      const out: ScreenResult[] = [];
      const android = ctx.system === 'android';
      if (!android) {
        await pressUntil(p, 'ArrowDown', isLabel('A TV, from the sofa'), 4);
        await press(p, 'Enter');
        await p.waitForTimeout(600);
        await press(p, 'ArrowDown');
      }
      await pressUntil(p, 'ArrowDown', isLabel('Add movies folder'), 4);
      await press(p, 'Enter');
      await p.waitForTimeout(700);
      if (android) {
        await quiet(p);
        out.push(
          await w(p, 'first-run-folders', 'First run: Kinema’s own folder browser', KB)
        );
        await press(p, 'Enter');
        await press(p, 'ArrowUp');
        await press(p, 'Enter');
        await p.waitForTimeout(700);
      }
      await quiet(p);
      out.push(
        await w(p, 'first-run', 'First run (one folder added)', {
          how: 'keyboard',
          note: android ? 'Android has no “where will you watch” question.' : 'Answered “A TV, from the sofa”, then added a folder.',
        })
      );
      if (!(await pressUntil(p, 'ArrowDown', isLabel('Scan my library'), 6))) return out;
      await press(p, 'Enter');
      for (let i = 0; i < 7; i++) {
        await p.waitForSelector('.setup-pages h1', { timeout: 6000 }).catch(() => null);
        if ((await p.locator('.setup-pages h1').count()) === 0) break;
        const title = ((await p.locator('.setup-pages h1').first().textContent()) ?? `page ${i + 1}`).trim();
        await p.waitForTimeout(1200);
        await quiet(p);
        out.push(
          await w(p, `setup-${i + 1}`, `Setup page ${i + 1}: ${title}`, KB)
        );
        if (!(await pressUntil(p, 'ArrowUp', (c) => /^(Next|Done|Finish)/.test(c.label), 6))) {
          const next = (await rawLeaves(p)).find((l) => /^(Next|Done|Finish)/.test(l.label));
          if (!next) break;
          await p.evaluate(`window.__navw.focusAndSettle(${JSON.stringify(next.key)})`);
        }
        await press(p, 'Enter');
        await p.waitForTimeout(500);
      }
      return out;
    }
  );

  // ---- held keys: how far focus runs ahead of the page ----
  if (!ONLY || ONLY.test('lag')) {
    const runLag = async (name: string, b: Omit<Boot, 'system'>, prep: (p: Page) => Promise<boolean>, key: string) => {
      let page: Page | null = null;
      try {
        page = await boot(ctx, { ...b, system: ctx.system });
        if (await prep(page)) ctx.lag.push(await hold(page, name, key));
      } catch {
        /* a lag test that cannot be set up is simply absent */
      } finally {
        await page?.close();
      }
    };
    await runLag('Home, Down through the rails', {}, async () => true, 'ArrowDown');
    await runLag(
      'A rail, Right along it',
      { flags: { kinemaMockTitles: '60' } },
      async (p) => pressUntil(p, 'ArrowDown', (c) => /^Example/.test(c.label) && c.key.startsWith('rail:'), 12),
      'ArrowRight'
    );
    await runLag(
      'Settings → Library, Down the section',
      {},
      async (p) => {
        if (!(await toSection(p, 'library'))) return false;
        return pressUntil(p, 'ArrowRight', (c) => !c.label.includes('Library') && !c.inTopBar && c.label !== '', 3);
      },
      'ArrowDown'
    );
    await runLag(
      'Movies grid (60 extra films), Down',
      { flags: { kinemaMockTitles: '60' } },
      async (p) => {
        if (!(await openFromTopBar(p, 'Movies'))) return false;
        await quiet(p);
        return pressUntil(p, 'ArrowDown', (c) => c.key.startsWith('grid:'), 4);
      },
      'ArrowDown'
    );
  }
}

// ---- the tests ------------------------------------------------------------------------------

function readSystem(engine: string, system: string): SystemResult | null {
  const file = join(OUT, `${engine}.${system}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SystemResult) : null;
}

for (const system of SYSTEMS) {
  test(`walk the screens as ${system}`, async ({ browser, baseURL }, info) => {
    if (ONLY_SYSTEMS && !ONLY_SYSTEMS.includes(system)) test.skip();
    const engine = info.project.name;
    const t0 = Date.now();
    const baselines: Baselines = new Map();
    if (system !== 'windows') {
      for (const s of readSystem(engine, 'windows')?.screens ?? []) baselines.set(s.id, s);
    }
    const ctx: Ctx = {
      browser,
      baseURL: baseURL ?? 'http://localhost:1441',
      system,
      contexts: new Map(),
      baselines,
      out: [],
      lag: [],
    };
    try {
      await walkSystem(ctx);
    } finally {
      for (const c of ctx.contexts.values()) await c.close();
    }
    mkdirSync(OUT, { recursive: true });
    const result: SystemResult = {
      system,
      engine,
      seconds: Math.round((Date.now() - t0) / 1000),
      screens: ctx.out,
      lag: ctx.lag,
    };
    writeFileSync(join(OUT, `${engine}.${system}.json`), JSON.stringify(result, null, 1));
    console.log(`${engine}/${system}: ${result.seconds}s, ${ctx.out.length} screens`);
  });
}

test('write the map', async ({ browserName: _browserName }, info) => {
  const engine = info.project.name;
  const systems = SYSTEMS.map((s) => readSystem(engine, s)).filter((s): s is SystemResult => s !== null);
  mkdirSync(OUT, { recursive: true });
  writeReports(OUT, engine, systems, (e, s) => readSystem(e, s));
});

#!/usr/bin/env node
/**
 * Every check a change needs, in one command, as fast and as quiet as it can.
 *
 *   npm run verify              what the changes since origin/master need
 *   npm run verify -- --all     everything (before a release, or when unsure)
 *   npm run verify -- js rust ui   just these groups (also: build, nav, smoke)
 *   npm run verify -- --dry     say what would run, run nothing
 *
 * What runs is picked from the changed files (committed since the base, staged,
 * unstaged and untracked): the TypeScript checks and the bundler for anything
 * under src/, e2e/ or the configs; cargo for src-tauri/; the keyboard flows for
 * src/ and e2e/. Docs-only changes run nothing. Independent steps run at the
 * same time; the two cargo steps share a target folder, so they run one after
 * the other beside the rest.
 *
 * The output is one line per step. A failing step prints the end of its output;
 * every step's full output is in .verify/<step>.log, to read only when the
 * printed part is not enough. Exit code 0 only when every step passed.
 *
 * The same command works on Windows, Linux (and WSL, through scripts\wsl.ps1)
 * and macOS. The keyboard flows run in the engines that matter on this system:
 * Edge on Windows (the same engine as WebView2), WebKit elsewhere (the engine
 * of Linux's window). `--engines all` adds Playwright's WebKit on Windows,
 * which is not Linux's WebKitGTK and so rarely worth its minutes.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const logDir = join(root, '.verify');
mkdirSync(logDir, { recursive: true });

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const base = flag('--base') ?? 'origin/master';
const engines = flag('--engines') ?? 'default';
const all = args.includes('--all');
const dry = args.includes('--dry');
const groups = new Set(args.filter((a) => !a.startsWith('--')));
const win = process.platform === 'win32';

function changedFiles() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const mergeBase = run(`git merge-base HEAD ${base}`)?.trim();
  const committed = mergeBase ? run(`git diff --name-only ${mergeBase} HEAD`) : null;
  if (committed === null) return null; // no base to compare with: run everything
  const local = run('git status --porcelain --untracked-files=all') ?? '';
  const files = new Set(committed.split('\n').filter(Boolean));
  for (const line of local.split('\n')) {
    const path = line.slice(3).split(' -> ').pop();
    if (path) files.add(path.replace(/^"|"$/g, ''));
  }
  return [...files];
}

// The private word list (scripts/privacy-check.mjs): when there is one, every
// run checks what the change adds, docs-only changes included.
const privacyList =
  existsSync(process.env.KINEMA_PRIVATE_WORDS ?? '') || existsSync(join(root, 'notes', 'private-words.txt'));

if (!all && groups.size === 0) {
  const files = changedFiles();
  if (files === null) {
    for (const g of ['js', 'build', 'rust', 'ui']) groups.add(g);
  } else {
    const js = files.some(
      (f) =>
        /^(src|e2e|public)\//.test(f) ||
        /^(package(-lock)?\.json|tsconfig.*\.json|vite\.config\.ts|eslint\.config\.js|index\.html|playwright.*\.ts)$/.test(f)
    );
    const rust = files.some((f) => f.startsWith('src-tauri/') && !f.startsWith('src-tauri/gen/'));
    const ui = files.some(
      (f) => /^(src|e2e)\//.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('src/trust/')
    ) || files.some((f) => /^(package-lock\.json|playwright\.config\.ts|index\.html)$/.test(f));
    if (js) groups.add('js').add('build');
    if (rust) groups.add('rust');
    if (ui) groups.add('ui');
    if (groups.size === 0 && !privacyList) {
      console.log(`Nothing to check: ${files.length} changed file(s), none of them code.`);
      process.exit(0);
    }
  }
}
if (all) for (const g of ['js', 'build', 'rust', 'ui']) groups.add(g);

const cargo = 'cargo';
const manifest = '--manifest-path src-tauri/Cargo.toml';
const pwProjects =
  engines === 'all' ? '' : win ? '--project edge' : '--project webkit';

/** Each lane runs its steps in order; lanes run side by side. */
const lanes = [];
if (privacyList) lanes.push([{ name: 'privacy', cmd: `node scripts/privacy-check.mjs --base ${base}` }]);
if (groups.has('js')) {
  lanes.push([{ name: 'tsc', cmd: 'npx tsc --noEmit' }]);
  lanes.push([{ name: 'tsc e2e', cmd: 'npx tsc --noEmit -p tsconfig.e2e.json' }]);
  lanes.push([{ name: 'eslint', cmd: 'npx eslint --cache --cache-location .verify/eslintcache .' }]);
  lanes.push([{ name: 'vitest', cmd: 'npx vitest run --reporter=dot' }]);
}
if (groups.has('build')) {
  // `npm run build` is `tsc && vite build`; tsc already runs above.
  lanes.push([{ name: 'vite build', cmd: 'npx vite build --logLevel warn' }]);
}
if (groups.has('rust')) {
  lanes.push([
    { name: 'cargo test', cmd: `${cargo} test ${manifest} -q` },
    { name: 'clippy', cmd: `${cargo} clippy ${manifest} -q --all-targets -- -D warnings` },
  ]);
}
if (groups.has('ui')) {
  lanes.push([{ name: 'playwright', cmd: `npx playwright test ${pwProjects} --reporter=dot` }]);
}
if (groups.has('smoke')) {
  // Linux only, never picked by itself: the real app plays a clip headless
  // (scripts/smoke.sh), with the newest built exe.
  lanes.push([{ name: 'smoke', cmd: 'bash scripts/smoke.sh' }]);
}
if (groups.has('nav')) {
  lanes.push([{ name: 'test:nav', cmd: `npx playwright test -c playwright.nav.config.ts ${pwProjects}` }]);
}

const TAIL = 40;
const results = [];

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, {
      cwd: root,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const file = join(logDir, `${step.name.replace(/[^a-z0-9]+/gi, '-')}.log`);
      writeFileSync(file, out);
      const ok = code === 0;
      const summary = summarise(step.name, out);
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.name.padEnd(11)} ${secs.padStart(6)}s  ${summary}`);
      if (!ok) {
        const lines = out.trimEnd().split('\n');
        console.log(lines.slice(-TAIL).map((l) => `      ${l}`).join('\n'));
        console.log(`      (full output: .verify/${file.split(/[\\/]/).pop()})`);
      }
      results.push({ step: step.name, ok });
      resolve(ok);
    });
  });
}

/** One short fact from a step's output: how many tests, or nothing. */
function summarise(name, out) {
  const pick = (re) => out.match(re)?.[0] ?? '';
  if (name === 'smoke') return out.trim().split('\n').pop().slice(0, 120);
  if (name === 'privacy') return out.trim().split('\n')[0];
  if (name === 'vitest') return pick(/Tests\s+[^\n]+/).replace(/\s+/g, ' ');
  if (name === 'cargo test') {
    let passed = 0;
    let failed = 0;
    for (const m of out.matchAll(/(\d+) passed; (\d+) failed/g)) {
      passed += Number(m[1]);
      failed += Number(m[2]);
    }
    return `${passed} passed, ${failed} failed`;
  }
  if (name === 'playwright' || name === 'test:nav') {
    return ['passed', 'failed', 'flaky', 'skipped']
      .map((w) => pick(new RegExp(`\\d+ ${w}`)))
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

console.log(`verify: ${[...groups].join(', ')}`);
if (dry) process.exit(0);
const t0 = Date.now();
await Promise.all(
  lanes.map(async (lane) => {
    for (const step of lane) if (!(await runStep(step))) break;
  })
);
const failed = results.filter((r) => !r.ok).map((r) => r.step);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(failed.length ? `FAILED: ${failed.join(', ')} (${secs}s)` : `All passed (${secs}s)`);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// The Kinema MCP: lets Claude Code drive and read the real app, a step at a
// time, instead of writing a whole self-test plan and reading its report.
//
// It starts kinema.exe as a self-test (KINEMA_SELFTEST, an `interactive`
// plan), so the app works on a copy of the library, never talks to SIMKL or
// Trakt, sits on the second screen on top and is muted. It reaches the page
// through WebView2's own debugging port, which only this launcher opens
// (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS): the app itself listens on nothing,
// in any build, and a release started normally has no port at all.
// Keys, typing and clicks go in through that port as the webview's own input
// (trusted events), never through the PC's mouse or keyboard.
//
// No dependencies: MCP over stdio is newline-delimited JSON-RPC, the
// debugging port is a WebSocket (Node's own), the library copy is read with
// node:sqlite. Windows only for now (WebKitGTK has no such port).
//
// Registered in .mcp.json. Docs: CONTRIBUTING.md "Testing".

import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const work = join(tmpdir(), 'kinema-mcp');
const planFile = join(work, 'plan.json');
const dataDir = join(work, 'data');

let app = null; // { process, port, exe }
let cdp = null; // { socket, next, waiting }

// ---------------------------------------------------------------- the app

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageSocketUrl(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`the app's page did not appear on port ${port} within ${timeoutMs} ms`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not open the debugging socket'));
  });
  const state = { socket, next: 1, waiting: new Map() };
  socket.onmessage = (message) => {
    const reply = JSON.parse(message.data);
    const pending = reply.id && state.waiting.get(reply.id);
    if (!pending) return;
    state.waiting.delete(reply.id);
    if (reply.error) pending.fail(new Error(reply.error.message));
    else pending.done(reply.result);
  };
  socket.onclose = () => {
    for (const pending of state.waiting.values()) pending.fail(new Error('the app closed'));
    state.waiting.clear();
    if (cdp === state) cdp = null;
  };
  return state;
}

function send(method, params = {}) {
  if (!cdp) throw new Error('Kinema is not running here; call kinema_app start first');
  const id = cdp.next++;
  return new Promise((done, fail) => {
    cdp.waiting.set(id, { done, fail });
    cdp.socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate an expression in the page; promises are awaited, the value comes back as JSON. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description ?? ex.text ?? 'the expression threw');
  }
  return result.result.value;
}

async function waitForHooks(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate('!!window.__kinemaSelfTest').catch(() => false)) return;
    await sleep(250);
  }
  throw new Error('the page came up but the self-test hooks did not (is the exe older than the code?)');
}

/**
 * The newer of the release build and the test build (`npm run app:build:test`,
 * the same code without the slow whole-program optimisation, in its own
 * target folder so neither build undoes the other's cache).
 */
function newestExe() {
  const builds = [
    join(root, 'src-tauri', 'target', 'release', 'kinema.exe'),
    join(root, 'src-tauri', 'target', 'fast', 'release', 'kinema.exe'),
  ].filter((p) => existsSync(p));
  builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return builds[0] ?? join(root, 'src-tauri', 'target', 'release', 'kinema.exe');
}

async function start({ fresh = false, exe, env = {} } = {}) {
  if (app) return { already: true, ...status() };
  const exePath = resolve(exe ?? newestExe());
  if (!existsSync(exePath)) throw new Error(`no exe at ${exePath}; build it (npx tauri build --no-bundle)`);
  mkdirSync(work, { recursive: true });
  if (fresh) rmSync(dataDir, { recursive: true, force: true });
  // The last run's screenshots: test pictures, never kept.
  for (const name of readdirSync(work)) {
    if (/^shot-\d+\.png$/.test(name)) rmSync(join(work, name), { force: true });
  }
  const plan = { interactive: true, path: '', fileId: null, titleId: null, seconds: 0 };
  writeFileSync(planFile, JSON.stringify(plan));
  const port = await freePort();
  const child = spawn(exePath, [], {
    cwd: dirname(exePath),
    // `env` first, so a run cannot point the app at another plan or port.
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
      KINEMA_SELFTEST: planFile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
    windowsHide: false,
  });
  app = { process: child, port, exe: exePath, started: Date.now() };
  child.on('exit', () => {
    if (app?.process === child) app = null;
  });
  cdp = await connect(await pageSocketUrl(port, 30000));
  await waitForHooks(20000);
  return status();
}

/**
 * Drive a Kinema that is already running and whose page has a debugging port
 * on this computer: the Android app (a debug build's WebView, forwarded by
 * `scripts/android-bench.sh mcp`, which also starts it as an interactive
 * self-test), or any page with the same hooks. `android` is the adb serial
 * (or true for the only device): logs and the library copy are then read
 * from the device.
 */
async function attach({ port, android }) {
  if (app) return { already: true, ...status() };
  if (!port) throw new Error('attach needs the debugging port (scripts/android-bench.sh mcp prints it)');
  app = { attached: true, port, android: android === true ? '' : android ?? null, started: Date.now() };
  try {
    cdp = await connect(await pageSocketUrl(port, 15000));
    await waitForHooks(20000);
  } catch (e) {
    cdp?.socket.close();
    cdp = null;
    app = null;
    throw e;
  }
  return status();
}

async function stop() {
  if (!app) return { running: false };
  if (app.attached) {
    await evaluate(
      "window.__TAURI_INTERNALS__.invoke('selftest_finish', { report: { interactive: true } })"
    ).catch(() => {});
    cdp?.socket.close();
    cdp = null;
    app = null;
    return { running: false };
  }
  const { process: child } = app;
  try {
    // The self-test's own ending: Rust writes report.json beside the plan and
    // exits the app cleanly (selftest.rs).
    await evaluate(
      "window.__TAURI_INTERNALS__.invoke('selftest_finish', { report: { interactive: true } })"
    );
  } catch {
    // fall through to the kill
  }
  for (let i = 0; i < 40 && app; i++) await sleep(250);
  if (app) {
    child.kill();
    app = null;
  }
  cdp?.socket.close();
  cdp = null;
  return { running: false };
}

function status() {
  if (!app) return { running: false, library: dataDir };
  if (app.attached) {
    return { running: true, attached: true, port: app.port, android: app.android ?? undefined };
  }
  const built = statSync(app.exe).mtime;
  return {
    running: true,
    pid: app.process.pid,
    exe: app.exe,
    exeBuilt: built.toISOString(),
    library: dataDir,
    logs: join(dataDir, 'logs'),
  };
}

// ---------------------------------------------------------------- input

const KEYS = {
  Enter: [13, 'Enter', '\r'],
  Escape: [27, 'Escape'],
  Backspace: [8, 'Backspace'],
  Tab: [9, 'Tab'],
  ' ': [32, 'Space', ' '],
  Space: [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft'],
  ArrowUp: [38, 'ArrowUp'],
  ArrowRight: [39, 'ArrowRight'],
  ArrowDown: [40, 'ArrowDown'],
  PageUp: [33, 'PageUp'],
  PageDown: [34, 'PageDown'],
  End: [35, 'End'],
  Home: [36, 'Home'],
  Delete: [46, 'Delete'],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

async function pressKey(spec) {
  const parts = spec.split('+');
  const name = parts.pop() || '+';
  let modifiers = 0;
  for (const part of parts) {
    if (!MODIFIERS[part]) throw new Error(`unknown modifier ${part} in ${spec}`);
    modifiers |= MODIFIERS[part];
  }
  let vk;
  let code;
  let text;
  let key = name;
  if (KEYS[name]) [vk, code, text] = KEYS[name];
  else if (/^F([1-9]|1[0-2])$/.test(name)) {
    vk = 111 + Number(name.slice(1));
    code = name;
  } else if (name.length === 1) {
    const upper = name.toUpperCase();
    vk = upper.charCodeAt(0);
    code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : undefined;
    text = modifiers & ~MODIFIERS.Shift ? undefined : name;
  } else throw new Error(`unknown key ${name}`);
  if (key === 'Space') key = ' ';
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function click(selector, button = 'left') {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`nothing matches ${selector}`);
  const at = { x: box.x, y: box.y, button, clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  return box;
}

// ---------------------------------------------------------------- reading

const STATE = `(() => {
  const t = window.__kinemaSelfTest;
  const el = document.activeElement;
  return Promise.resolve(t.nowPlaying().catch(() => null)).then((playing) => ({
    screen: t.screen(),
    heading: document.querySelector('h1, h2')?.textContent?.trim() ?? null,
    activeElement: el && el !== document.body
      ? { tag: el.tagName.toLowerCase(), label: el.getAttribute('aria-label'),
          value: 'value' in el ? el.value : undefined }
      : null,
    playing,
  }));
})()`;

/**
 * A file of the run's library copy, as a local path. On Android it is fetched
 * from the app's private folder first (a debug build lets adb read it).
 */
function localFile(rel) {
  if (app?.android == null) return join(dataDir, rel);
  const out = join(work, 'android', rel);
  mkdirSync(dirname(out), { recursive: true });
  const serial = app.android ? ['-s', app.android] : [];
  const args = [...serial, 'exec-out', 'run-as', 'com.kinema.app', 'cat', `selftest/data/${rel}`];
  // The bench's adb lives in WSL (scripts/android-bench.sh); KINEMA_ADB names another.
  const [cmd, ...pre] =
    process.env.KINEMA_ADB
      ? [process.env.KINEMA_ADB]
      : process.platform === 'win32'
        ? ['wsl.exe', '-e', 'bash', '-lc', 'exec "${ANDROID_HOME:-$HOME/Android}/platform-tools/adb" "$@"', 'adb']
        : ['adb'];
  const bytes = execFileSync(cmd, [...pre, ...args], { maxBuffer: 512 * 1024 * 1024 });
  writeFileSync(out, bytes);
  return out;
}

function logs({ file = 'app', grep, last = 40 }) {
  const path = localFile(`logs/${file}.log`);
  if (!existsSync(path)) throw new Error(`no ${path} yet`);
  let lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (grep) {
    const pattern = new RegExp(grep, 'i');
    lines = lines.filter((line) => pattern.test(line));
  }
  const cap = Math.min(Math.max(1, last), 200);
  return { file: path, matched: lines.length, lines: lines.slice(-cap) };
}

async function sql({ query, params = [] }) {
  if (!/^\s*(select|with|pragma)\b/i.test(query)) throw new Error('read-only: SELECT, WITH or PRAGMA only');
  const path = localFile('library.db');
  if (app?.android != null) {
    // Recent writes are still in the write-ahead log; without it the copy is old.
    try {
      localFile('library.db-wal');
    } catch {
      rmSync(`${path}-wal`, { force: true });
    }
  }
  if (!existsSync(path)) throw new Error(`no library copy at ${path}; start the app once`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(query).all(...params);
    return { rows: rows.slice(0, 200), total: rows.length };
  } finally {
    db.close();
  }
}

async function screenshot({ scale = 0.4 } = {}) {
  if (!app) throw new Error('Kinema is not running here');
  if (app.attached) {
    // The page only (on Android the picture is drawn under it, by Media3).
    // JPEG: a fraction of a PNG's size, and so of the tokens it costs.
    const view = await evaluate('({ w: innerWidth, h: innerHeight })');
    const shot = await send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: 0, y: 0, width: view.w, height: view.h, scale: Math.min(Math.max(scale, 0.1), 1) },
    });
    const out = join(work, `shot-${Date.now()}.jpg`);
    mkdirSync(work, { recursive: true });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    return { file: out, where: 'page', mimeType: 'image/jpeg' };
  }
  const out = join(work, `shot-${Date.now()}.png`);
  const where = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'window-shot.ps1'),
      '-ProcessId', String(app.process.pid), '-Out', out, '-Scale', String(scale)],
    { stdio: 'pipe', encoding: 'utf8' }
  );
  return { file: out, where: where.trim() };
}

// ---------------------------------------------------------------- a run of steps

async function waitUntil(js, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    // `!!`: an element or other live object cannot come back as JSON.
    last = await evaluate(`!!(${js})`).catch((e) => `threw: ${e.message}`);
    if (last === true) return last;
    await sleep(100);
  }
  throw new Error(`not true within ${timeoutMs} ms: ${js} (last: ${short(last)})`);
}

const short = (v, max = 300) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text === undefined ? 'undefined' : text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * One step of `kinema_run`; returns a short description of what happened,
 * or throws with why it failed.
 */
async function runStep(step) {
  if (step.keys) {
    for (const key of step.keys) {
      await pressKey(key);
      await sleep(step.waitMs ?? 150);
    }
    return `keys ${step.keys.join(' ')}`;
  }
  if (step.text !== undefined) {
    await send('Input.insertText', { text: step.text });
    return `typed ${short(step.text, 60)}`;
  }
  if (step.click) {
    await click(step.click, step.button);
    return `clicked ${step.click}`;
  }
  if (step.wait) {
    await sleep(Math.min(step.wait, 60000));
    return `waited ${step.wait} ms`;
  }
  if (step.until) {
    await waitUntil(step.until, step.timeoutMs ?? 10000);
    return `until ${short(step.until, 80)}`;
  }
  if (step.expect) {
    const value = await evaluate(step.expect);
    const ok = 'equals' in step ? JSON.stringify(value) === JSON.stringify(step.equals) : !!value;
    if (!ok) {
      throw new Error(`expected ${'equals' in step ? short(step.equals) : 'true'}, got ${short(value)}: ${step.expect}`);
    }
    return `expect ${short(step.expect, 80)}`;
  }
  if (step.read) return `read ${short(step.read, 60)} = ${short(await evaluate(step.read))}`;
  if (step.state) return `state ${short(await evaluate(STATE), 600)}`;
  if (step.sql) {
    const { rows, total } = await sql({ query: step.sql, params: step.params });
    const ok = !('rows' in step) || total === step.rows;
    if (!ok) throw new Error(`expected ${step.rows} rows, got ${total}: ${short(rows)}`);
    return `sql ${total} row(s) ${short(rows.slice(0, 20))}`;
  }
  if (step.mpv) {
    const value = await evaluate(`window.__kinemaSelfTest.probe(${JSON.stringify(step.mpv)})`);
    return `mpv ${short(value)}`;
  }
  if (step.call) {
    const value = await TOOLS.find((t) => t.name === 'kinema_call').run({ fn: step.call, args: step.args });
    return `call ${step.call} = ${short(value)}`;
  }
  if (step.logs) {
    const { matched, lines } = logs(step.logs);
    if ('matches' in step.logs && matched !== step.logs.matches) {
      throw new Error(`expected ${step.logs.matches} matching log lines, got ${matched}: ${short(lines.slice(-5))}`);
    }
    return `logs ${matched} matched ${short(lines.slice(-(step.logs.last ?? 5)), 600)}`;
  }
  throw new Error(`unknown step ${short(step)}`);
}

/** Runs steps in order, one line each; stops at the first failure and says what is on screen. */
async function runSteps({ steps, keepGoing = false }) {
  const out = [];
  let failed = 0;
  for (const [i, step] of steps.entries()) {
    const name = step.label ? `${step.label}: ` : '';
    try {
      out.push(`${i + 1} ok   ${name}${await runStep(step)}`);
    } catch (e) {
      failed++;
      out.push(`${i + 1} FAIL ${name}${e?.message ?? e}`);
      if (!keepGoing) {
        out.push(`on screen: ${short(await evaluate(STATE).catch((x) => x.message), 800)}`);
        out.push(`(${steps.length - i - 1} step(s) not run)`);
        break;
      }
    }
  }
  out.unshift(failed ? `FAILED ${failed} of ${steps.length}` : `PASSED ${steps.length} steps`);
  return out.join('\n');
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'kinema_app',
    description:
      'Start, attach to, stop or check the real Kinema (release exe from src-tauri/target/release, or the newer test build in src-tauri/target/fast) as an interactive self-test: a copy of the library, no SIMKL/Trakt, second screen, on top, muted. `fresh` starts from a new copy of the real library.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { enum: ['start', 'attach', 'stop', 'status'] },
        fresh: { type: 'boolean' },
        port: {
          type: 'number',
          description: 'attach: the debugging port of a Kinema already running as an interactive self-test (Android: `scripts/android-bench.sh mcp` starts it and prints the port).',
        },
        android: {
          type: ['string', 'boolean'],
          description: 'attach: the adb serial (true for the only device); logs and SQL are then read from the device.',
        },
        exe: { type: 'string', description: 'Another kinema.exe to run.' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Extra environment variables for this run only, e.g. {"HTTPS_PROXY":"http://127.0.0.1:9","NO_PROXY":"www.wikidata.org"} to make TMDB unreachable while Wikidata answers.',
        },
      },
      required: ['action'],
    },
    run: (a) =>
      a.action === 'start' ? start(a) : a.action === 'attach' ? attach(a) : a.action === 'stop' ? stop() : status(),
  },
  {
    name: 'kinema_run',
    description:
      'A whole check in one call: steps run in order, one result line each, stopping at the first failure (with what is on screen). Prefer this to separate kinema_input/kinema_state calls. Each step has one of: ' +
      '{keys:[...],waitMs} | {text} | {click:selector,button} | {wait:ms} | {until:js,timeoutMs} (poll until truthy, default 10 s) | ' +
      '{expect:js, equals?} (truthy, or equal to `equals`) | {read:js} | {state:true} | {sql,params,rows?} (rows: expected count) | ' +
      '{mpv:[props]} | {call:fn,args} | {logs:{file,grep,last,matches?}}; any step may have a `label`. `keepGoing` runs on past failures.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' } },
        keepGoing: { type: 'boolean' },
      },
      required: ['steps'],
    },
    run: runSteps,
  },
  {
    name: 'kinema_state',
    description:
      'What is on screen: the player overlay (skip, up next, error, label, controls), where the focus ring is, what the mouse is over, the heading, the focused element and what is playing. `js` evaluates a page expression instead (promises awaited; keep it read-only). `waitMs` waits first.',
    inputSchema: {
      type: 'object',
      properties: {
        js: { type: 'string' },
        waitMs: { type: 'number' },
        until: { type: 'string', description: 'A page expression to wait for (polled, up to 30 s) before reading; instead of guessing waitMs.' },
      },
    },
    run: async ({ js, waitMs, until }) => {
      if (waitMs) await sleep(Math.min(waitMs, 60000));
      if (until) await waitUntil(until, 30000);
      return evaluate(js ?? STATE);
    },
  },
  {
    name: 'kinema_input',
    description:
      "Input as the webview's own (trusted) events, never the PC's: `keys` pressed in order (Enter, Escape, ArrowDown, Ctrl+Shift+T, F, …), `text` typed into the focused field, `click` a CSS selector (button left/right). `waitMs` between keys (default 150).",
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' },
        click: { type: 'string' },
        button: { enum: ['left', 'right'] },
        waitMs: { type: 'number' },
      },
    },
    run: async ({ keys = [], text, click: selector, button, waitMs = 150 }) => {
      const done = [];
      if (selector) done.push({ clicked: selector, at: await click(selector, button) });
      for (const key of keys) {
        await pressKey(key);
        await sleep(waitMs);
      }
      if (keys.length) done.push({ pressed: keys });
      if (text) {
        await send('Input.insertText', { text });
        done.push({ typed: text });
      }
      return done;
    },
  },
  {
    name: 'kinema_call',
    description:
      "Call the app as a self-test plan's `call` does: `fn` is one of selftest.ts CALLABLE (fn 'names' lists them), or 'play' ({path,fileId,titleId,label} opens the player), 'seek' (seconds).",
    inputSchema: {
      type: 'object',
      properties: { fn: { type: 'string' }, args: { type: 'array' } },
      required: ['fn'],
    },
    run: ({ fn, args = [] }) => {
      const a = JSON.stringify(args);
      if (fn === 'names') return evaluate('window.__kinemaSelfTest.names()');
      if (fn === 'play') return evaluate(`(window.__kinemaSelfTest.play(...${a}), 'opened')`);
      if (fn === 'seek') return evaluate(`window.__kinemaSelfTest.seek(...${a})`);
      return evaluate(`window.__kinemaSelfTest.call(${JSON.stringify(fn)}, ${a})`);
    },
  },
  {
    name: 'kinema_mpv',
    description:
      "Read mpv properties as text, read-only: e.g. display-fps, video-params/gamma, video-target-params/primaries, current-ao, audio-codec-name, audio-out-params/format, hwdec-current, estimated-vf-fps, frame-drop-count.",
    inputSchema: {
      type: 'object',
      properties: { props: { type: 'array', items: { type: 'string' } } },
      required: ['props'],
    },
    run: ({ props }) => evaluate(`window.__kinemaSelfTest.probe(${JSON.stringify(props)})`),
  },
  {
    name: 'kinema_logs',
    description:
      "The run's own logs (library copy): `file` app or mpv, `grep` a case-insensitive regex, `last` lines (max 200, default 40). Always grep mpv.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { enum: ['app', 'mpv'] },
        grep: { type: 'string' },
        last: { type: 'number' },
      },
    },
    run: logs,
  },
  {
    name: 'kinema_sql',
    description: 'Read-only SQL on the run\'s library copy (SELECT/WITH/PRAGMA, ? params). At most 200 rows.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, params: { type: 'array' } },
      required: ['query'],
    },
    run: sql,
  },
  {
    name: 'kinema_screenshot',
    description:
      "A picture of Kinema's window only (with the video under the page and any popup over it), for testing; never for the README. `scale` 0.1-1, default 0.5.",
    inputSchema: { type: 'object', properties: { scale: { type: 'number' } } },
    image: true,
    run: screenshot,
  },
];

// ---------------------------------------------------------------- MCP over stdio

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'kinema', version: '1.0.0' },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool ${params?.name}`);
    try {
      const value = await tool.run(params.arguments ?? {});
      if (tool.image) {
        const data = readFileSync(value.file).toString('base64');
        return reply(id, {
          content: [
            { type: 'image', data, mimeType: value.mimeType ?? 'image/png' },
            { type: 'text', text: `${value.file} (window ${value.where})` },
          ],
        });
      }
      // Compact: every byte of a result is read again on every later turn.
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return reply(id, { content: [{ type: 'text', text: text ?? 'undefined' }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `no method ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'not JSON');
      continue;
    }
    void handle(message);
  }
});
process.stdin.on('end', () => void stop().finally(() => process.exit(0)));

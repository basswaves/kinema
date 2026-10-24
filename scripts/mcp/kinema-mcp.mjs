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

async function start({ fresh = false, exe, env = {} } = {}) {
  if (app) return { already: true, ...status() };
  const exePath = resolve(exe ?? join(root, 'src-tauri', 'target', 'release', 'kinema.exe'));
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

async function stop() {
  if (!app) return { running: false };
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

function logs({ file = 'app', grep, last = 40 }) {
  const path = join(dataDir, 'logs', `${file}.log`);
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
  const path = join(dataDir, 'library.db');
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

function screenshot({ scale = 0.5 } = {}) {
  if (!app) throw new Error('Kinema is not running here');
  const out = join(work, `shot-${Date.now()}.png`);
  const where = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'window-shot.ps1'),
      '-ProcessId', String(app.process.pid), '-Out', out, '-Scale', String(scale)],
    { stdio: 'pipe', encoding: 'utf8' }
  );
  return { file: out, where: where.trim() };
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'kinema_app',
    description:
      'Start, stop or check the real Kinema (release exe from src-tauri/target/release) as an interactive self-test: a copy of the library, no SIMKL/Trakt, second screen, on top, muted. `fresh` starts from a new copy of the real library.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { enum: ['start', 'stop', 'status'] },
        fresh: { type: 'boolean' },
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
    run: (a) => (a.action === 'start' ? start(a) : a.action === 'stop' ? stop() : status()),
  },
  {
    name: 'kinema_state',
    description:
      'What is on screen: the player overlay (skip, up next, error, label, controls), where the focus ring is, what the mouse is over, the heading, the focused element and what is playing. `js` evaluates a page expression instead (promises awaited; keep it read-only). `waitMs` waits first.',
    inputSchema: {
      type: 'object',
      properties: { js: { type: 'string' }, waitMs: { type: 'number' } },
    },
    run: async ({ js, waitMs }) => {
      if (waitMs) await sleep(Math.min(waitMs, 60000));
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
            { type: 'image', data, mimeType: 'image/png' },
            { type: 'text', text: `${value.file} (window ${value.where})` },
          ],
        });
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
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

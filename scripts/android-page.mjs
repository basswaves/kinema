// The page of a debug Kinema on Android, reached through its forwarded WebView
// socket; scripts/android-bench.sh runs this (with node's --experimental-websocket,
// which node 20 needs). Keys go in through the page, not the shared keyboard.
//
//   android-page.mjs PORT eval 'expression'      its value, as text or JSON
//   android-page.mjs PORT keys ArrowDown Enter   presses, one after another
//   android-page.mjs PORT walk                   every screen by keys, and after each
//       press: the focus ring is on an element, on screen, not covered. One line per fault and
//       a summary. The player part runs only when a film is named: walk PATH
const [port, verb, ...args] = process.argv.slice(2);

const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === 'page') ?? pages[0];
if (!page) throw new Error('no page behind that port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) {
    waiting.get(d.id)(d);
    waiting.delete(d.id);
  }
};
await new Promise((ok, no) => {
  ws.onopen = ok;
  ws.onerror = () => no(new Error('could not open the page socket'));
});
const send = (method, params = {}) =>
  new Promise((ok) => {
    const i = ++id;
    waiting.set(i, ok);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function evaluate(expression) {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result?.result?.value;
}

const CODES = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27,
  BrowserBack: 166, Backspace: 8,
};
async function press(key) {
  const vk = CODES[key] ?? key.toUpperCase().charCodeAt(0);
  const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
  const base = { key, code: CODES[key] ? key : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// What a person looks for after a press: the focus ring somewhere on the screen,
// on the element it says, with nothing lying over it.
const RING = `(() => {
  const el = document.querySelector('.focused');
  // A playing film with its controls away has no ring, on purpose.
  if (!el) return document.querySelector('.player.osd-hidden') ? {} : { fault: 'no ring' };
  const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40);
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return { fault: 'ring on nothing visible', name };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { fault: 'ring off screen', name };
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    return { fault: 'ring covered by ' + (top.className || top.tagName), name };
  }
  return { name };
})()`;

const NEXT_FRAME = 'new Promise((ok) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => ok(performance.now() - t))); })';

async function walk(film) {
  const repeat = (key, n) => Array(n).fill(key);
  // The top row: Up as far as it goes, Left as far as it goes, then Right to the tab.
  const tab = (n) => [...repeat('ArrowUp', 8), ...repeat('ArrowLeft', 6), ...repeat('ArrowRight', n), 'Enter'];
  const M = (label) => ({ mark: label });
  const sections = [
    ['Home', [...tab(0), M('Home'), ...repeat('ArrowDown', 3), ...repeat('ArrowRight', 3), ...repeat('ArrowLeft', 3), ...repeat('ArrowUp', 3)]],
    ['Movies', [...tab(1), M('Movies'), ...repeat('ArrowDown', 2), ...repeat('ArrowRight', 2), ...repeat('ArrowLeft', 2), 'Enter', M('film page'), ...repeat('ArrowDown', 2), ...repeat('ArrowUp', 2), 'Escape', M('back on the card')]],
    ['TV shows', [...tab(2), M('TV shows'), ...repeat('ArrowDown', 2), ...repeat('ArrowUp', 2)]],
    ['Library', [...tab(3), M('Library'), ...repeat('ArrowDown', 4), ...repeat('ArrowRight', 2), ...repeat('ArrowLeft', 2), ...repeat('ArrowUp', 4)]],
    ['Search', [...tab(4), M('Search'), 'k', 'i', 't', ...repeat('ArrowDown', 4), ...repeat('ArrowUp', 4), ...repeat('Backspace', 3)]],
    ['Settings', [...tab(5), M('Settings'), ...repeat('ArrowDown', 6), 'Enter', M('a section'), ...repeat('ArrowDown', 4), ...repeat('ArrowUp', 4), 'Escape', ...repeat('ArrowUp', 6)]],
  ];
  let presses = 0;
  const faults = [];
  const ms = [];
  const reached = [];
  // Where a mark stood: a walk over the wrong screens looks exactly like a clean one.
  const PLACE = `[document.querySelector('h1,h2')?.textContent?.trim().slice(0, 24), document.querySelector('.focused')?.getAttribute('aria-label') ?? document.querySelector('.focused')?.textContent?.trim().slice(0, 24)].join(' / ')`;
  const run = async (name, keys, gap = 180) => {
    for (const key of keys) {
      if (key.mark) {
        await sleep(700);
        reached.push(`${key.mark} = ${await evaluate(PLACE)}`);
        continue;
      }
      await press(key);
      presses++;
      ms.push(await evaluate(NEXT_FRAME));
      await sleep(gap);
      const ring = await evaluate(RING);
      if (ring.fault) faults.push(`${name}, after ${key}: ${ring.fault}${ring.name ? ` (${ring.name})` : ''}`);
    }
  };
  for (const [name, keys] of sections) await run(name, keys);
  if (film) {
    await evaluate(`window.__kinemaSelfTest.play(${JSON.stringify({ path: film, label: 'walk', fileId: null, titleId: null })})`);
    await sleep(6000);
    // Controls up, along them to Audio & subtitles, down and up its panel, and out.
    await run('Player', ['ArrowDown', ...repeat('ArrowLeft', 4)], 400);
    for (let i = 0; i < 8; i++) {
      const at = await evaluate(RING);
      if (/audio|subtitle/i.test(at.name ?? '')) break;
      await run('Player', ['ArrowRight'], 400);
    }
    reached.push(`player controls = ${await evaluate(PLACE)}`);
    await run('Panel', ['Enter', ...repeat('ArrowDown', 3), ...repeat('ArrowUp', 3)], 400);
    reached.push(`track panel = ${await evaluate(PLACE)}`);
    await press('Escape');
    await sleep(1500);
    if (await evaluate(`!!document.querySelector('.player')`)) await press('Escape');
    await sleep(2500);
  }
  console.log(`reached: ${reached.join('; ')}`);
  ms.sort((a, b) => a - b);
  for (const f of faults.slice(0, 12)) console.log(`fault: ${f}`);
  const at = (p) => Math.round(ms[Math.floor((ms.length - 1) * p)] ?? 0);
  console.log(`walk: ${presses} presses, ${faults.length} faults; to next frame median ${at(0.5)} ms, p95 ${at(0.95)}, worst ${at(1)}`);
  return faults.length;
}

let code = 0;
try {
  if (verb === 'eval') {
    const value = await evaluate(args[0]);
    console.log(typeof value === 'string' ? value : JSON.stringify(value));
  } else if (verb === 'keys') {
    for (const key of args) {
      await press(key);
      await sleep(180);
    }
  } else if (verb === 'walk') {
    code = (await walk(args[0])) > 0 ? 1 : 0;
  } else throw new Error(`no such verb: ${verb}`);
} catch (e) {
  console.error(`android-page: ${e.message}`);
  code = 2;
}
process.exit(code);

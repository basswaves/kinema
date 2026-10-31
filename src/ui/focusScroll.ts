/**
 * The one scroll rule (round 7, notes FOCUS-REWORK.md): a keyboard or remote
 * move scrolls the page so the area holding the ring — a rail, the hero, a
 * notice, a grid's row — sits a third of the way down the page (the owner's
 * choice, 2026-10-31, as the streaming apps keep their focused row), with its
 * heading when the two fit, never under the top bar; inside a rail the row
 * moves only when the ring nears its edge. Going up to the first areas
 * brings the page back to its top, because the page never scrolls above it.
 *
 * Before this, each page scrolled by rules of its own (`keepOnScreen`, read
 * on, a sticky Back's room kept as a constant in step with the CSS), so the
 * page jumped on one screen, glided on another and did not come back up on a
 * third. The top bar's height is read from the page (`data-sticky-top`), never
 * a number to keep in step with ui.css.
 *
 * Only moves made by a key scroll. A click leaves the page where it is, and
 * the wheel and touchpad scroll natively: a turn of the wheel or a touch
 * stops a scroll in motion.
 *
 * Every scroll moves as one spring (`glide`). Under a held key it settles
 * quicker and takes each new target on at the speed it has, so the page keeps
 * up with the ring; the system's "reduce motion" and the light look
 * (lightLook.ts) make it instant.
 */
import { isLightLook } from './lightLook';

/** How long a move takes to settle, for every scroll the ring causes
 *  (320 ms felt "a little too glidy" to the owner, 2026-10-31). */
export const MOTION_MS = 220;
/** The quickest settle, under a held key: quicker reads as a jump. */
const MIN_MOTION_MS = 110;
/** Where a key move puts the area holding the ring: this share of the way down the page. */
const KEYLINE = 1 / 3;
/** The least gap between the top bar and that area, in rem. */
const LINE_GAP_REM = 0.75;
/** The least room left under the ring at the bottom of the window, in rem. */
const BOTTOM_GAP_REM = 1.5;

function reducedMotion(): boolean {
  if (isLightLook()) return true;
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * A scroll in motion, as a critically damped spring: it starts gently, never
 * goes past its target, and a new target taken while moving keeps the speed
 * it has. An eased glide of fixed length (the first version) did most of its
 * travel in its first frames and braked hard, which read as a shove and a
 * bounce back (the owner's recording, 2026-10-31); restarted at every press of
 * a held key, it also stuttered.
 */
interface Spring {
  axis: 'x' | 'y';
  pos: number;
  vel: number;
  to: number;
  /** Stiffness, per second: settled in about 4.7 / omega seconds. */
  omega: number;
  last: number;
  frame: number;
}

const springs = new Map<HTMLElement, Spring>();
let stopperInstalled = false;

/** A wheel, a touch or a pointer press takes the page back from a scroll in motion. */
function installStopper(): void {
  if (stopperInstalled) return;
  stopperInstalled = true;
  const stop = () => {
    for (const [el, spring] of springs) {
      cancelAnimationFrame(spring.frame);
      springs.delete(el);
    }
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown']) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
}

function position(el: HTMLElement, axis: 'x' | 'y'): number {
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

function place(el: HTMLElement, axis: 'x' | 'y', at: number): void {
  if (axis === 'y') el.scrollTop = at;
  else el.scrollLeft = at;
}

/**
 * Scroll `el` along `axis` to `to`, settling in about `duration` ms (0: at
 * once). A scroll already moving there takes the new target on at the speed
 * it has.
 */
export function glide(el: HTMLElement, axis: 'x' | 'y', to: number, duration: number): void {
  installStopper();
  const max = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const target = Math.max(0, Math.min(Math.round(to), Math.max(0, max)));
  const running = springs.get(el);
  if (duration <= 0 || reducedMotion()) {
    if (running) {
      cancelAnimationFrame(running.frame);
      springs.delete(el);
    }
    place(el, axis, target);
    return;
  }
  const omega = 4.7 / (duration / 1000);
  if (running && running.axis === axis) {
    running.to = target;
    running.omega = omega;
    return;
  }
  if (running) {
    cancelAnimationFrame(running.frame);
    springs.delete(el);
  }
  const from = position(el, axis);
  if (Math.abs(target - from) < 1) return;
  const s: Spring = { axis, pos: from, vel: 0, to: target, omega, last: performance.now(), frame: 0 };
  const step = (now: number) => {
    // The time that really passed, however long: the solution below is exact
    // for any step. Capped at 50 ms (the first version), a starved page — a
    // busy machine, a weak box — moved 50 ms of the way per frame, and a
    // 220 ms scroll took seconds (focusScroll.test.ts; the WebKit CI flake).
    const dt = Math.max(0, (now - s.last) / 1000);
    s.last = now;
    // The exact solution for a critically damped spring over dt.
    const x0 = s.pos - s.to;
    const decay = Math.exp(-s.omega * dt);
    const c = s.vel + s.omega * x0;
    const x = (x0 + c * dt) * decay;
    s.vel = (s.vel - s.omega * c * dt) * decay;
    s.pos = s.to + x;
    // Within two pixels and slowing: there. Creeping the last pixel for a
    // tenth of a second read as the page still drifting.
    if (Math.abs(x) < 2 && Math.abs(s.vel) < 60) {
      place(el, axis, s.to);
      springs.delete(el);
      return;
    }
    place(el, axis, s.pos);
    s.frame = requestAnimationFrame(step);
  };
  s.frame = requestAnimationFrame(step);
  springs.set(el, s);
}

/** Take the page back from a scroll in motion, where it is (typing room moves it itself). */
export function stopGlide(el: HTMLElement): void {
  const running = springs.get(el);
  if (!running) return;
  cancelAnimationFrame(running.frame);
  springs.delete(el);
}

/** Whether a scroll the ring caused is still moving (for the browser flows). */
export function gliding(): boolean {
  return springs.size > 0;
}

/** Where a scroll in motion on `el` is going, or where it is when none moves. */
function settled(el: HTMLElement, axis: 'x' | 'y'): number {
  const s = springs.get(el);
  return s && s.axis === axis ? s.to : position(el, axis);
}

/** How quickly a key move `sinceLast` ms after the previous one settles. */
export function motionFor(sinceLast: number): number {
  return Math.max(MIN_MOTION_MS, Math.min(MOTION_MS, sinceLast));
}

function scrolls(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

/** The page: the nearest ancestor that scrolls up and down. */
export function pageOf(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) if (scrolls(el, 'y')) return el;
  return null;
}

/** A rail: the nearest ancestor below the page that scrolls sideways. */
function trackOf(node: HTMLElement, page: HTMLElement | null): HTMLElement | null {
  for (let el = node.parentElement; el && el !== page; el = el.parentElement) {
    if (scrolls(el, 'x')) return el;
  }
  return null;
}

/**
 * How far down the page's own top the sticky bars over it reach (the top bar,
 * a title page's Back): read from the page each time, so a bar that grows
 * with the TV layout or a font is followed by itself.
 */
export function barBottom(page: HTMLElement): number {
  const top = page.getBoundingClientRect().top;
  let bottom = 0;
  for (const bar of page.querySelectorAll<HTMLElement>('[data-sticky-top]')) {
    const r = bar.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, r.bottom - top);
  }
  return bottom;
}

/**
 * Where `el` starts on the page, measured from the page's own top, so a
 * glide under way does not change the answer.
 */
function contentTop(el: HTMLElement, page: HTMLElement): number {
  return page.scrollTop + el.getBoundingClientRect().top - page.getBoundingClientRect().top;
}

const HEADING = /^H[1-3]$/;

function headingIn(el: Element): HTMLElement | null {
  if (HEADING.test(el.tagName)) return el as HTMLElement;
  if (el.tagName === 'SECTION') return null;
  let found: HTMLElement | null = null;
  for (const child of el.children) if (HEADING.test(child.tagName)) found = child as HTMLElement;
  return found;
}

/**
 * The heading standing before an area: the last `h1`–`h3` before its branch
 * at the nearest level that has one (a grid's title in the row above it).
 * A heading inside the area itself (a rail's) is already part of it.
 */
function headingBefore(node: HTMLElement, page: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el && el !== page; el = el.parentElement) {
    let heading: HTMLElement | null = null;
    for (const child of el.children) {
      if (child.contains(node)) break;
      heading = headingIn(child) ?? heading;
    }
    if (heading) return heading;
  }
  return null;
}

function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * The rule, for a key move: `anchor` (scrollAnchor in focusModel.ts) a third
 * of the way down the page — higher when the area is too tall for that, never
 * under the bar — and `leaf` kept in its rail with the next card in sight.
 */
export function lineUp(anchor: HTMLElement, leaf: HTMLElement, duration: number): void {
  const page = pageOf(leaf);
  if (page) {
    const rem = remPx();
    const bar = barBottom(page);
    const top = contentTop(anchor, page);
    const leafBottom = contentTop(leaf, page) + leaf.offsetHeight;
    const room = page.clientHeight - BOTTOM_GAP_REM * rem;
    const highest = bar + LINE_GAP_REM * rem;
    const heading = headingBefore(anchor, page);
    let from = top;
    if (heading) {
      const headTop = contentTop(heading, page);
      if (headTop < top && leafBottom - headTop + highest <= room) from = headTop;
    }
    // A third of the way down; higher when what is from there to the ring's
    // bottom would not fit above the window's bottom.
    const keyline = Math.max(highest, page.clientHeight * KEYLINE);
    const line = Math.max(highest, Math.min(keyline, room - (leafBottom - from)));
    // The ring itself is always in sight, whatever the area holding it: a
    // section taller than the window (Settings) lines up by its top, and a
    // control far down it would stay below the fold. Its top clear of the
    // bar wins where both cannot be.
    const leafTop = contentTop(leaf, page);
    const to = Math.min(Math.max(from - line, leafBottom - room), leafTop - highest);
    glide(page, 'y', to, duration);
  }
  alongTrack(leaf, page, duration);
}

/**
 * Inside a rail: the row moves only when the card holding the ring comes near
 * its edge, and then by as little as keeps the next card half in sight.
 * Moving it a card at every press (the first version) shifted the whole row
 * each time.
 */
function alongTrack(leaf: HTMLElement, page: HTMLElement | null, duration: number): void {
  const track = trackOf(leaf, page);
  if (!track) return;
  let item: HTMLElement = leaf;
  while (item.parentElement && item.parentElement !== track) item = item.parentElement;
  const first = track.firstElementChild as HTMLElement | null;
  if (!first || item.parentElement !== track) return;
  const style = getComputedStyle(track);
  const span = track.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const start = item.offsetLeft - first.offsetLeft;
  const end = start + item.offsetWidth;
  const peek = item.offsetWidth / 2;
  const at = settled(track, 'x');
  if (end + peek > at + span) glide(track, 'x', end + peek - span, duration);
  else if (start - peek < at) glide(track, 'x', start - peek, duration);
}

/**
 * To the page's top: the top bar's own buttons, a title page's Back and the
 * buttons under its title — as near the top as keeps the ring above the
 * window's bottom (a long overview on a small window).
 */
export function toTop(leaf: HTMLElement, duration: number): void {
  const page = pageOf(leaf);
  if (!page) return;
  // A sticky bar (the top bar, a title page's Back) is where it is drawn,
  // not where it sits on the page: for it, the very top.
  const room = page.clientHeight - BOTTOM_GAP_REM * remPx();
  const bottom = leaf.closest('[data-sticky-top]') ? 0 : contentTop(leaf, page) + leaf.offsetHeight;
  glide(page, 'y', Math.max(0, bottom - room), duration);
  alongTrack(leaf, page, duration);
}

/** How far one press reads on, as a share of the visible page. */
const READ_STEP = 0.6;
/** The control reading on scrolled away from, while it still holds the ring. */
let leftBehind: HTMLElement | null = null;

/**
 * Down with nothing further down reads on (owner, 2026-10-04: "you can't see
 * everything"): a page that ends in text below its last control — a long
 * description, the file's details — scrolls on by most of a screen, as a TV
 * app does with text. It stops where the control is still clear of the bar,
 * or takes it off the screen entirely when it is near the top already (the
 * owner, 2026-10-05: never half under the see-through bar). False when there
 * is nothing more to read.
 */
export function readOn(leaf: HTMLElement, duration: number): boolean {
  const page = pageOf(leaf);
  if (!page) return false;
  const at = settled(page, 'y');
  const remaining = page.scrollHeight - page.clientHeight - at;
  const step = page.clientHeight * READ_STEP;
  const bar = barBottom(page);
  const top = contentTop(leaf, page) - at;
  let by = Math.min(step, remaining);
  if (top - by < bar && top - by + leaf.offsetHeight > 0) {
    // A full step would leave it half under the bar: stop with it just
    // clear, unless that is hardly a step — then past it altogether, where
    // the page goes that far.
    const keep = Math.max(0, top - bar);
    const past = top + leaf.offsetHeight;
    by = keep >= step / 3 || past > remaining ? keep : past;
  }
  if (by < 1) return false;
  leftBehind = leaf;
  glide(page, 'y', at + by, duration);
  return true;
}

/**
 * Up while the control reading on left behind is above the bar: the page
 * scrolls back until it is clear, before the ring moves anywhere. Only then —
 * a control the ring has just moved to is above the bar too until the page
 * has scrolled to it. False when there was nothing to read back.
 */
export function readBack(leaf: HTMLElement, duration: number): boolean {
  if (leaf !== leftBehind) {
    leftBehind = null;
    return false;
  }
  const page = pageOf(leaf);
  if (!page) return false;
  const at = settled(page, 'y');
  const bar = barBottom(page);
  const top = contentTop(leaf, page) - at;
  if (top >= bar - 1 || at <= 0) return false;
  glide(page, 'y', at - Math.min(page.clientHeight * READ_STEP, bar - top), duration);
  return true;
}

/**
 * Inside a list drawn over the film (the player's panels, marked
 * `data-scroll="nearest"`): the list moves only when the ring has gone out
 * of its sight, and then just far enough to show it — the film behind is
 * what is being watched, and a list that re-centred at every press would
 * pull the eye away from it.
 */
export function nearest(leaf: HTMLElement, duration: number): void {
  const page = pageOf(leaf);
  if (!page) return;
  const gap = LINE_GAP_REM * remPx();
  const top = contentTop(leaf, page);
  const bottom = top + leaf.offsetHeight;
  const at = settled(page, 'y');
  if (top - gap < at) glide(page, 'y', Math.max(0, top - gap), duration);
  else if (bottom + gap > at + page.clientHeight) glide(page, 'y', bottom + gap - page.clientHeight, duration);
}

/**
 * For a ring put somewhere by the app (a landing, a return): nothing moves if
 * it is on screen clear of the bar; otherwise the rule, at once.
 */
export function reveal(anchor: HTMLElement, leaf: HTMLElement): void {
  const page = pageOf(leaf);
  if (page) {
    const r = leaf.getBoundingClientRect();
    const view = page.getBoundingClientRect();
    const scroll = settled(page, 'y') - page.scrollTop;
    const top = r.top - scroll - view.top;
    const bottom = r.bottom - scroll - view.top;
    if (top < barBottom(page) || bottom > page.clientHeight) {
      lineUp(anchor, leaf, 0);
      return;
    }
  }
  const track = trackOf(leaf, page);
  if (track) {
    const r = leaf.getBoundingClientRect();
    const t = track.getBoundingClientRect();
    if (r.left < t.left || r.right > t.right) alongTrack(leaf, page, 0);
  }
}

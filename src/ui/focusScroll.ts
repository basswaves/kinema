/**
 * The one scroll rule (round 7, notes FOCUS-REWORK.md): a keyboard or remote
 * move scrolls the page so the area holding the ring — a rail, the hero, a
 * notice, a grid's row — sits at a fixed line just below the top bar, with
 * its heading when the two fit together; inside a rail the card holding the
 * ring sits where the rail's first card does. Going up to the first areas
 * brings the page back to its top, because the page never scrolls above it.
 *
 * Before this, each page scrolled by rules of its own (`keepOnScreen`, read
 * on, a sticky Back's room kept as a constant in step with the CSS), so the
 * page jumped on one screen, glided on another and did not come back up on a
 * third. The top bar's height is read from the page (`data-sticky-top`), never
 * a number to keep in step with ui.css.
 *
 * Only moves made by a key scroll. A pointer that moves the ring leaves the
 * page where it is, and the wheel and touchpad scroll natively: a turn of the
 * wheel or a touch stops a glide under way.
 *
 * Every glide has one length and one easing. Under a held key each press
 * shortens it to the time since the last one, so the page keeps up with the
 * ring instead of starting a new glide behind it at every repeat; the
 * system's "reduce motion" and the light look (lightLook.ts) make it instant.
 */
import { isLightLook } from './lightLook';

/** One glide's length, for every scroll the ring causes. */
export const MOTION_MS = 200;
/** The shortest glide under a held key: shorter is a jump. */
const MIN_MOTION_MS = 50;
/** The gap between the top bar and the area lined up below it, in rem. */
const LINE_GAP_REM = 0.75;

/** Decelerating: quick off the mark, gentle into place. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

function reducedMotion(): boolean {
  if (isLightLook()) return true;
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

interface Glide {
  axis: 'x' | 'y';
  from: number;
  to: number;
  start: number;
  duration: number;
  frame: number;
}

const glides = new Map<HTMLElement, Glide>();
let stopperInstalled = false;

/** A wheel, a touch or a pointer press takes the page back from a glide. */
function installStopper(): void {
  if (stopperInstalled) return;
  stopperInstalled = true;
  const stop = () => {
    for (const [el, glide] of glides) {
      cancelAnimationFrame(glide.frame);
      glides.delete(el);
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
 * Scroll `el` along `axis` to `to` over `duration` (0: at once). A glide
 * already under way there is taken over from where it is, not restarted.
 */
export function glide(el: HTMLElement, axis: 'x' | 'y', to: number, duration: number): void {
  installStopper();
  const max = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const target = Math.max(0, Math.min(Math.round(to), Math.max(0, max)));
  const running = glides.get(el);
  if (running && running.axis === axis && running.to === target) return;
  if (running) {
    cancelAnimationFrame(running.frame);
    glides.delete(el);
  }
  const from = position(el, axis);
  if (Math.abs(target - from) < 1) return;
  if (duration <= 0 || reducedMotion()) {
    place(el, axis, target);
    return;
  }
  const g: Glide = { axis, from, to: target, start: performance.now(), duration, frame: 0 };
  const step = (now: number) => {
    const t = Math.min(1, (now - g.start) / g.duration);
    place(el, axis, g.from + (g.to - g.from) * ease(t));
    if (t < 1) g.frame = requestAnimationFrame(step);
    else glides.delete(el);
  };
  g.frame = requestAnimationFrame(step);
  glides.set(el, g);
}

/** Whether a glide the ring caused is still under way (for the browser flows). */
export function gliding(): boolean {
  return glides.size > 0;
}

/** Where a running glide on `el` ends, or where it is when none runs. */
function settled(el: HTMLElement, axis: 'x' | 'y'): number {
  const g = glides.get(el);
  return g && g.axis === axis ? g.to : position(el, axis);
}

/** The length of a glide for a key move `sinceLast` ms after the previous one. */
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
 * The rule, for a key move: `anchor` (scrollAnchor in focusModel.ts) at the
 * line below the bar, `leaf` where the rail's first card is.
 */
export function lineUp(anchor: HTMLElement, leaf: HTMLElement, duration: number): void {
  const page = pageOf(leaf);
  if (page) {
    const line = barBottom(page) + LINE_GAP_REM * remPx();
    const top = contentTop(anchor, page);
    const heading = headingBefore(anchor, page);
    let from = top;
    if (heading) {
      const headTop = contentTop(heading, page);
      const leafBottom = contentTop(leaf, page) + leaf.offsetHeight;
      if (headTop < top && leafBottom - headTop + line <= page.clientHeight) from = headTop;
    }
    glide(page, 'y', from - line, duration);
  }
  alongTrack(leaf, page, duration);
}

/** Inside a rail: the card holding the ring where the first card sits. */
function alongTrack(leaf: HTMLElement, page: HTMLElement | null, duration: number): void {
  const track = trackOf(leaf, page);
  if (!track) return;
  let item: HTMLElement = leaf;
  while (item.parentElement && item.parentElement !== track) item = item.parentElement;
  const first = track.firstElementChild as HTMLElement | null;
  if (!first || item.parentElement !== track) return;
  glide(track, 'x', item.offsetLeft - first.offsetLeft, duration);
}

/** To the page's top: the top bar's own buttons. */
export function toTop(leaf: HTMLElement, duration: number): void {
  const page = pageOf(leaf);
  if (page) glide(page, 'y', 0, duration);
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

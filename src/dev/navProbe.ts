/**
 * A read-only window into the spatial-navigation library, for the navigation
 * checker (`e2e/navmap.nav.ts`, `npm run test:nav`).
 *
 * Installed only by `dev:mock` (src/main.tsx), never in a real build. It reads
 * the library's registry the same way `focus.ts` does; it moves focus only
 * when the checker asks (`setFocus`), and it never touches the pointer.
 */
import {
  getCurrentFocusKey,
  setFocus,
  SpatialNavigation,
} from '@noriginmedia/norigin-spatial-navigation';

interface Registered {
  focusKey: string;
  parentFocusKey: string;
  node?: HTMLElement;
  focusable: boolean;
  isFocusBoundary: boolean;
}

export interface NavLeaf {
  key: string;
  label: string;
  rect: { left: number; top: number; right: number; bottom: number };
  /** Parent focus keys, nearest first. */
  parents: string[];
  /** The nearest ancestor that is an `isFocusBoundary` container, or null. */
  boundary: string | null;
}

function registry(): Record<string, Registered> {
  return (
    (SpatialNavigation as unknown as { focusableComponents?: Record<string, Registered> })
      .focusableComponents ?? {}
  );
}

/**
 * What a control is called: its aria-label, else (for a card or an episode)
 * its title, else its text without badges, else its placeholder or tooltip,
 * else its focus key.
 */
function labelOf(c: Registered): string {
  const node = c.node;
  const aria = node?.getAttribute?.('aria-label');
  if (aria) return aria;
  const named = node?.querySelector?.('.card-title,.episode-name')?.textContent?.trim();
  if (named) return named.slice(0, 50);
  const copy = node?.cloneNode?.(true) as HTMLElement | undefined;
  copy?.querySelectorAll?.('.nav-badge,.nav-dot,.nav-count').forEach((e) => e.remove());
  const text = (copy?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 50);
  const hint = node?.getAttribute?.('placeholder') ?? node?.getAttribute?.('title');
  return hint ? hint.slice(0, 50) : c.focusKey;
}

/** Every focusable leaf now registered and on the page. */
function leaves(): NavLeaf[] {
  const all = registry();
  const parentsInUse = new Set<string>();
  for (const c of Object.values(all)) if (c.focusable) parentsInUse.add(c.parentFocusKey);
  const out: NavLeaf[] = [];
  for (const c of Object.values(all)) {
    if (!c.focusable || parentsInUse.has(c.focusKey)) continue;
    const node = c.node;
    if (!node || !node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const parents: string[] = [];
    let boundary: string | null = null;
    let p = all[c.parentFocusKey];
    for (let guard = 0; p && guard < 50; guard++) {
      parents.push(p.focusKey);
      if (boundary === null && p.isFocusBoundary) boundary = p.focusKey;
      p = all[p.parentFocusKey];
    }
    out.push({
      key: c.focusKey,
      label: labelOf(c),
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      parents,
      boundary,
    });
  }
  return out;
}

/**
 * The nearest visible heading for a control's group.
 *
 * Heuristic: walk up from the control's element; at each ancestor look at its
 * h1–h3 and `[class*="title"]` / `[class*="heading"]` descendants that come
 * before the control in the page, are on the page, and are not inside some
 * focusable leaf (a card's own title is not its group's heading). The first
 * ancestor with any such heading wins, and the last of them before the
 * control is the answer. Null when nothing is found.
 */
function headingElement(key: string): HTMLElement | null {
  const node = registry()[key]?.node;
  if (!node) return null;
  const leafKeys = new Set(leaves().map((l) => l.key));
  const leafNodes = Object.values(registry())
    .filter((c) => leafKeys.has(c.focusKey))
    .map((c) => c.node)
    .filter((n): n is HTMLElement => Boolean(n));
  const inLeaf = (el: Element) => leafNodes.some((n) => n !== el && n.contains(el));
  let scope: HTMLElement | null = node.parentElement;
  while (scope && scope !== document.body) {
    const found = Array.from(
      scope.querySelectorAll<HTMLElement>('h1,h2,h3,[class*="title"],[class*="heading"]')
    ).filter(
      (h) =>
        !h.contains(node) &&
        !inLeaf(h) &&
        (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        h.getBoundingClientRect().width > 0 &&
        (h.textContent ?? '').trim() !== ''
    );
    if (found.length > 0) return found[found.length - 1];
    scope = scope.parentElement;
  }
  return null;
}

function headingFor(key: string): string {
  const h = headingElement(key);
  return h ? (h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

/**
 * Where the top bar ends, or 0 when there is none showing. A page laid over
 * Home (the first run, the setup pages) leaves the bar in the tree, behind it:
 * the bar counts only if it is what is drawn at its own centre.
 */
function visibleBarBottom(): number {
  const bar = document.querySelector('.top-nav');
  if (!bar) return 0;
  const r = bar.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return top && bar.contains(top) ? r.bottom : 0;
}

/** The heading's place on the page, for the checker's under-the-bar test. */
function headingRect(key: string) {
  const h = headingElement(key)?.getBoundingClientRect();
  return h ? { top: h.top, bottom: h.bottom } : null;
}

/** What the checker needs to know about one control right now. */
function describe(key: string) {
  const c = registry()[key];
  const node = c?.node;
  if (!c || !node || !node.isConnected) return null;
  const r = node.getBoundingClientRect();
  return {
    key,
    label: labelOf(c),
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    inTopBar: node.closest('.top-nav') !== null,
    topBarBottom: visibleBarBottom(),
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollTop: document.querySelector('.browse')?.scrollTop ?? 0,
  };
}

/** The cheap part of `describe`, for sampling every animation frame. */
function box(key: string) {
  const node = registry()[key]?.node;
  if (!node || !node.isConnected) return null;
  const r = node.getBoundingClientRect();
  return {
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right: r.right,
    inTopBar: node.closest('.top-nav') !== null,
    topBarBottom: visibleBarBottom(),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

export function installNavProbe(): void {
  (window as unknown as { __nav: unknown }).__nav = {
    setFocus: (key: string) => setFocus(key),
    current: () => getCurrentFocusKey(),
    leaves,
    headingFor,
    describe,
    headingRect,
    box,
  };
}

/**
 * Kinema's own focus engine (round 7, notes FOCUS-REWORK.md): one store that
 * says which control holds the ring, the live tree of areas the screens
 * declare, and the keys, pointer and scrolling around it. Where an arrow goes
 * is focusModel.ts, a pure function of that tree; how the page scrolls is
 * focusScroll.ts; the components are focusEngine.tsx.
 *
 * Synchronous, and owned here. The spatial library it replaces kept a focus
 * of its own beside React's, updated it later (300 ms after an unmount) and
 * was corrected by timers that raced on a slow machine — "focus behind the
 * top bar", "the ring vanished", "Up does nothing". Here a press is answered
 * in the same event, and nothing moves the ring by itself except recovery
 * when the control holding it goes away, decided once the screen's change has
 * been committed (a microtask, not a timer).
 *
 * Every screen is wrapped in `FocusScreen`; while one is mounted it answers
 * the keys (the player's only while its controls hold the ring), and the
 * controls outside it (the top bar, the dialogs over any screen) register
 * here too. Screens moved over from the spatial library one at a time
 * (F1–F3); since F4 it is gone, with the three rules that handed the keys
 * between the two (docs/HISTORY.md, round 7).
 *
 * Accessibility: the control holding the ring has the DOM focus too (without
 * the browser scrolling to it), is the one tab stop (roving tabindex), and Tab
 * and Shift+Tab go from area to area as on a web page (`tabMove`).
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import {
  enter,
  move,
  recover,
  remembered,
  scrollAnchor,
  tabMove,
  tabStops,
  within,
  type AreaSpec,
  type Arrow,
  type NavNode,
  type NavTree,
} from './focusModel';
import { lineUp, motionFor, MOTION_MS, nearest, readBack, readOn, reveal, toTop } from './focusScroll';

/** The tree's top: a column holding the top bar and the screen. */
export const ROOT = 'nav-root';

interface Entry {
  key: string;
  parent: string;
  node: HTMLElement | null;
  area?: AreaSpec;
  /** An area: scroll to the page's top when the ring is in it (the top bar). */
  pageTop?: boolean;
  /** An area: a dialog over the screen, which holds the ring while it is here. */
  modal?: boolean;
  disabled: boolean;
  select?: () => void;
  highlight?: () => void;
  /** A control that keeps some arrows to itself (the seek bar, the volume): true when it took this one. */
  arrow?: (arrow: Arrow, event: KeyboardEvent) => boolean;
}

interface Screen {
  id: number;
  /** The input count when it arrived: a page takes the ring until the person acts. */
  arrivedAt: number;
  /**
   * Whether it answers the keys now. The player's does only while its
   * controls hold the ring: otherwise the arrows seek, by the player's own
   * handler, and exactly one of the two answers each press.
   */
  keys: boolean;
}

const entries = new Map<string, Entry>();
/** Per parent, its children; ordered lazily (`ordered`). */
const childSets = new Map<string, Set<string>>();
/** Per parent, its children in document order, and the press it was checked at. */
const orders = new Map<string, { keys: string[]; checked: number }>();
let generation = 0;

const memory = new Map<string, string>();
let focused: string | null = null;
/**
 * Dialogs open now (`modal` areas), oldest first, each with the control that
 * held the ring when it opened: the ring stays inside the newest, and goes
 * back to that control when it closes.
 */
const modals: { key: string; opener: string | null }[] = [];
/** A dialog just closed: where the ring goes back to, once the change is committed. */
let returnFromModal: string | null = null;
/** Where the ring was, nearest area first, for recovery when its control goes. */
let focusPath: { area: string; index: number }[] = [];
const screens: Screen[] = [];
/** Per screen, where it lands (`useLanding`); set before the screen itself registers. */
const landings = new Map<number, string | null>();
let screenIds = 0;
let inputs = 0;
let pending: { key: string; scrollTop?: number } | null = null;
let lastKeyMoveAt = -Infinity;

const keyListeners = new Map<string, Set<() => void>>();

/** Tell `key` and the areas holding it (`useFocusWithin`) that the ring moved. */
function notify(key: string | null): void {
  for (let at: string | null | undefined = key; at; at = at === ROOT ? null : entries.get(at)?.parent) {
    for (const listener of keyListeners.get(at) ?? []) listener();
  }
}

function documentOrder(a: string, b: string): number {
  const na = entries.get(a)?.node;
  const nb = entries.get(b)?.node;
  if (!na || !nb || na === nb) return 0;
  return na.compareDocumentPosition(nb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/**
 * A parent's children in document order. Checked once per press (a grid
 * re-sorted moves its cards without anything registering again) and sorted
 * only when out of order.
 */
function ordered(parent: string): string[] {
  const set = childSets.get(parent);
  if (!set || set.size === 0) return [];
  let order = orders.get(parent);
  if (!order || order.keys.length !== set.size || order.keys.some((k) => !set.has(k))) {
    order = { keys: [...set].sort(documentOrder), checked: generation };
    orders.set(parent, order);
    return order.keys;
  }
  if (order.checked !== generation) {
    order.checked = generation;
    for (let i = 1; i < order.keys.length; i++) {
      if (documentOrder(order.keys[i - 1], order.keys[i]) > 0) {
        order.keys.sort(documentOrder);
        break;
      }
    }
  }
  return order.keys;
}

/** The live registry, as focusModel.ts reads a tree. */
const tree: NavTree = {
  get(key: string): NavNode | undefined {
    if (key === ROOT) return { key, parent: null, children: ordered(ROOT), area: { kind: 'column' } };
    const e = entries.get(key);
    if (!e) return undefined;
    return {
      key,
      parent: e.parent,
      children: e.area ? ordered(key) : [],
      area: e.area,
      // Not drawn (display: none): nowhere a ring could show.
      disabled: e.disabled || !e.node?.isConnected,
    };
  },
};

function active(): boolean {
  return screens.length > 0;
}

/** Whether this engine answers the keys now. */
function answering(): boolean {
  return active() && screens[screens.length - 1].keys;
}

/** The dialog holding the ring now, if one is open and holds anything. */
function topModal(): string | null {
  for (let i = modals.length - 1; i >= 0; i--) {
    if (entries.has(modals[i].key) && enter(tree, modals[i].key, memory)) return modals[i].key;
  }
  return null;
}

/** Whether `key` is where the ring may be: inside the open dialog, when there is one. */
function allowed(key: string): boolean {
  const modal = topModal();
  return modal === null || within(tree, key, modal);
}

// ---- focusing -------------------------------------------------------------

type How = 'key' | 'tab' | 'pointer' | 'program' | 'return';

function pathOf(key: string): { area: string; index: number }[] {
  const out: { area: string; index: number }[] = [];
  let child = key;
  for (let parent = entries.get(key)?.parent ?? null; parent !== null; ) {
    out.push({ area: parent, index: ordered(parent).indexOf(child) });
    child = parent;
    parent = parent === ROOT ? null : (entries.get(parent)?.parent ?? null);
  }
  return out;
}

function pageTopArea(key: string): boolean {
  for (let at: string | undefined = key; at && at !== ROOT; at = entries.get(at)?.parent) {
    if (entries.get(at)?.pageTop) return true;
  }
  return false;
}

function scrollFor(key: string, how: How, sinceLast: number): void {
  const leaf = entries.get(key)?.node;
  if (!leaf || how === 'pointer') return;
  const duration = how === 'key' ? motionFor(sinceLast) : how === 'tab' ? MOTION_MS : 0;
  // The player's panels are lists drawn over the film, not a page: only
  // what has gone out of sight is brought back (focusScroll.ts, `nearest`).
  if (leaf.closest('[data-scroll="nearest"]')) {
    nearest(leaf, duration);
    return;
  }
  if (pageTopArea(key)) {
    if (how === 'key' || how === 'tab') toTop(leaf, duration);
    return;
  }
  const anchorKey = scrollAnchor(tree, key);
  const anchor = entries.get(anchorKey)?.node ?? leaf;
  if (how === 'key' || how === 'tab') lineUp(anchor, leaf, duration);
  else reveal(anchor, leaf);
}

function setFocused(key: string, how: How): void {
  generation++;
  const since = performance.now() - lastKeyMoveAt;
  if (how === 'key') lastKeyMoveAt = performance.now();
  const before = focused;
  if (before !== key) {
    focused = key;
    for (const [area, child] of remembered(tree, key)) memory.set(area, child);
    focusPath = pathOf(key);
    const old = before ? entries.get(before)?.node : null;
    if (old) old.tabIndex = -1;
    notify(before);
    notify(key);
    entries.get(key)?.highlight?.();
  }
  const node = entries.get(key)?.node;
  if (node) {
    node.tabIndex = 0;
    // The DOM focus follows, for a screen reader and the web's own keys,
    // without the browser's scroll: the rule below is the only one. Not a
    // text box: it takes the caret itself (typing.ts), after telling the
    // system whether its keyboard should come up — a focus from here first
    // would bring up Android's on arriving at a field.
    if (answering() && how !== 'pointer' && document.activeElement !== node && node.tagName !== 'INPUT') {
      node.focus({ preventScroll: true });
    }
  }
  scrollFor(key, how, since);
}

function landingOf(screen: Screen | undefined): string | null {
  return screen ? (landings.get(screen.id) ?? null) : null;
}

/** The current screen's landing control, if it is here; else the tree's first. */
function landingLeaf(): string | null {
  const modal = topModal();
  if (modal) return enter(tree, modal, memory);
  const landing = landingOf(screens[screens.length - 1]);
  return (landing ? enter(tree, landing, memory) : null) ?? enter(tree, ROOT, memory);
}

let settleQueued = false;

/**
 * After a change to the tree has been committed: a return waiting for its
 * control, a page taking the ring on arrival, or the ring's control gone.
 */
/** The count of presses and pointer moves when the ring last had to be recovered. */
let recoveredAt = -1;

function scheduleSettle(): void {
  if (settleQueued) return;
  settleQueued = true;
  queueMicrotask(() => {
    settleQueued = false;
    settle();
  });
}

function settle(): void {
  if (!active()) return;
  generation++;
  const screen = screens[screens.length - 1];
  const fresh = screen.arrivedAt === inputs;

  // A dialog open: the ring is in it (by its rules: a menu's current, else
  // its first), whatever else is waiting.
  const modal = topModal();
  if (modal) {
    if (focused === null || !entries.has(focused) || !within(tree, focused, modal)) {
      const land = enter(tree, modal, memory);
      if (land) setFocused(land, 'program');
    }
    return;
  }
  // A dialog closed: back to the control that opened it, if it is still here.
  if (returnFromModal) {
    const back = returnFromModal;
    returnFromModal = null;
    const liveInside = focused !== null && entries.has(focused) && enter(tree, focused, memory) === focused;
    if (!liveInside && entries.has(back) && enter(tree, back, memory) === back) {
      setFocused(back, 'program');
      return;
    }
  }

  if (pending) {
    const { key, scrollTop } = pending;
    if (entries.has(key) && enter(tree, key, memory) === key) {
      pending = null;
      const page = entries.get(key)?.node?.closest<HTMLElement>('.browse');
      if (page && scrollTop !== undefined) page.scrollTop = scrollTop;
      setFocused(key, 'return');
      return;
    }
    // Not here (yet): the landing meanwhile; the return still wins if its
    // control comes before the person does anything.
    if (!fresh) pending = null;
  }

  const live = focused !== null && entries.has(focused) && enter(tree, focused, memory) === focused;
  const landing = landingOf(screen);
  if (fresh && !pending && landing) {
    const land = enter(tree, landing, memory);
    if (land && land !== focused) setFocused(land, 'program');
    if (land) return;
  }
  if (live) return;
  // Never by way of the root: that is a whole other screen, where the
  // landing spot is the answer.
  const path = focusPath.filter((p) => p.area !== ROOT);
  const replacement = (focused !== null && recover(tree, path, memory)) || landingLeaf();
  if (replacement) {
    recoveredAt = inputs;
    setFocused(replacement, 'program');
  }
}

// ---- registering ----------------------------------------------------------

function add(entry: Entry): void {
  if (entries.has(entry.key)) console.warn(`focus: ${entry.key} registered twice`);
  entries.set(entry.key, entry);
  // A dialog opened as another closed (Playback details from Audio &
  // subtitles): the ring goes back to where the closed one came from.
  if (entry.modal) {
    const opener = focused !== null && !entries.has(focused) && returnFromModal ? returnFromModal : focused;
    modals.push({ key: entry.key, opener });
  }
  let set = childSets.get(entry.parent);
  if (!set) childSets.set(entry.parent, (set = new Set()));
  set.add(entry.key);
  if (entry.key === focused && entry.node) entry.node.tabIndex = 0;
  scheduleSettle();
}

function remove(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  childSets.get(entry.parent)?.delete(key);
  const m = modals.findIndex((x) => x.key === key);
  if (m >= 0) {
    returnFromModal = modals[m].opener;
    modals.splice(m, 1);
    scheduleSettle();
  }
  if (key === focused || pending) scheduleSettle();
}

// ---- keys and pointer -----------------------------------------------------

const ARROWS: Record<string, Arrow> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function onKeyDown(event: KeyboardEvent): void {
  // A control keeping a key to itself stops its propagation (a card's OK
  // held, a text box's Left), and the press never gets here.
  if (!answering()) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const arrow = ARROWS[event.key];
  if (!arrow && event.key !== 'Enter' && event.key !== 'Tab') return;
  generation++;
  const live = focused !== null && entries.has(focused) && allowed(focused);
  if (!live) {
    // Nothing holds the ring (or it is outside the dialog open): this press
    // puts it on the landing spot.
    const land = landingLeaf();
    if (!land) return;
    event.preventDefault();
    setFocused(land, 'program');
    return;
  }
  const at = focused as string;
  if (arrow) {
    // Also keeps the browser from scrolling the page by itself.
    event.preventDefault();
    if (entries.get(at)?.arrow?.(arrow, event)) return;
    const node = entries.get(at)?.node;
    const duration = motionFor(performance.now() - lastKeyMoveAt);
    // Up first reads back what Down read on (focusScroll.ts).
    if (arrow === 'up' && node && readBack(node, duration)) return;
    const next = move(tree, at, arrow, memory);
    if (next) setFocused(next, 'key');
    // Down with nothing further down reads on — not on a held key, whose
    // presses run past the end.
    else if (arrow === 'down' && node && !event.repeat) readOn(node, duration);
    return;
  }
  if (event.key === 'Tab') {
    // Inside a dialog, Tab goes round its own controls only: past its last
    // stop to its first, never out to the page under it.
    const modal = topModal();
    let next = tabMove(tree, modal ?? ROOT, at, event.shiftKey, memory);
    if (!next && modal) {
      const stops = tabStops(tree, modal);
      const stop = event.shiftKey ? stops[stops.length - 1] : stops[0];
      next = stop ? enter(tree, stop, memory) : null;
    }
    if (next) {
      event.preventDefault();
      setFocused(next, 'tab');
    }
    return;
  }
  // Enter: one press, one action — a held OK does not repeat it, and the
  // browser's own click on a focused button does not answer it twice.
  event.preventDefault();
  if (event.repeat) return;
  entries.get(at)?.select?.();
}

let lastPointer = { x: NaN, y: NaN };
let pointerMoved = false;

function countInput(): void {
  inputs++;
  if (pending) pending = null;
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  // Bubble phase on `window`: a control that keeps a key to itself (a card's
  // OK held, a text box's Left) stops it before it gets here.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keydown', countInput, { capture: true, passive: true });
  for (const type of ['pointerdown', 'wheel']) {
    window.addEventListener(type, countInput, { capture: true, passive: true });
  }
  // A pointer that really moved, not a page scrolled under a still one: some
  // engines send a move after every scroll.
  window.addEventListener(
    'pointermove',
    (e) => {
      pointerMoved = e.screenX !== lastPointer.x || e.screenY !== lastPointer.y;
      lastPointer = { x: e.screenX, y: e.screenY };
      if (pointerMoved) countInput();
    },
    { capture: true, passive: true }
  );
  // The DOM focus moved by something else (the browser's own Tab from
  // outside the tree, a touch): the ring follows, moving the page only if
  // it is out of sight.
  window.addEventListener('focusin', (e) => {
    if (!answering()) return;
    const key = (e.target as HTMLElement | null)?.dataset?.navKey;
    if (key && key !== focused && entries.has(key) && allowed(key)) setFocused(key, 'program');
  });
}

// ---- the API for the rest of the app ---------------------------------------

/** Whether this engine answers now (a screen on it is up, no older dialog over it). */
export function navAnswering(): boolean {
  return answering();
}

/** The control holding the ring here, or null. */
export function navFocused(): string | null {
  return active() ? focused : null;
}

/** Whether `key` is registered here and can hold the ring. */
export function navHas(key: string): boolean {
  return entries.has(key) && enter(tree, key, memory) !== null;
}

/** Put the ring on `key` (an area: by its rules). False when it is not here. */
export function navFocus(key: string, how: 'program' | 'pointer' = 'program'): boolean {
  generation++;
  let leaf = entries.has(key) ? enter(tree, key, memory) : null;
  if (!leaf) return false;
  // Never behind an open dialog: into it, by its rules.
  const modal = topModal();
  if (modal && !within(tree, leaf, modal)) leaf = enter(tree, modal, memory) ?? leaf;
  setFocused(leaf, how);
  return true;
}

/**
 * A press just opened a new page of the same screen (the setup pages' Next):
 * its landing is the page's again, as on arrival, until the next press.
 */
export function navRearrive(): void {
  const screen = screens[screens.length - 1];
  if (screen) screen.arrivedAt = inputs;
}

/**
 * Back is returning to `key`, with the page at `scrollTop`: taken by the
 * next screen when the control is there.
 */
export function navExpectReturn(key: string | null, scrollTop?: number): void {
  pending = key ? { key, scrollTop } : null;
}

/** For the navigation checker (navProbe.ts): what is registered, and where the ring is. */
export function navSnapshot(): {
  focused: string | null;
  /** The dialog holding the ring, if one is open: nothing outside it can be reached. */
  modal: string | null;
  nodes: { key: string; parent: string; area?: AreaSpec; node: HTMLElement | null; disabled: boolean }[];
} {
  return {
    focused: active() ? focused : null,
    modal: topModal(),
    nodes: [...entries.values()].map((e) => ({
      key: e.key,
      parent: e.parent,
      area: e.area,
      node: e.node,
      disabled: tree.get(e.key)?.disabled ?? true,
    })),
  };
}

/** A number for a new screen (`FocusScreen`). */
export function newScreenId(): number {
  return ++screenIds;
}

/** A screen on this engine has arrived. */
export function screenArrived(id: number, keys = true): void {
  install();
  screens.push({ id, arrivedAt: inputs, keys });
  scheduleSettle();
}

/**
 * A screen takes the keys (the player's controls brought up) or gives them
 * back (to its own handler: the arrows seek). The ring stays where it was;
 * taking them, the DOM focus follows it.
 */
export function screenKeys(id: number, keys: boolean): void {
  const screen = screens.find((s) => s.id === id);
  if (!screen || screen.keys === keys) return;
  screen.keys = keys;
  const node = focused ? entries.get(focused)?.node : null;
  if (answering() && node?.isConnected) node.focus({ preventScroll: true });
}

/** …and gone. The ring leaves with the screen: the next one lands its own. */
export function screenLeft(id: number): void {
  const index = screens.findIndex((s) => s.id === id);
  if (index >= 0) screens.splice(index, 1);
  landings.delete(id);
  if (!active()) {
    const before = focused;
    focused = null;
    notify(before);
  }
}

// ---- React ---------------------------------------------------------------

/** The area a subtree's controls belong to. */
export const ParentContext = createContext<string>(ROOT);
/** The screen a subtree is in. */
export const ScreenContext = createContext<number | null>(null);

/**
 * Where the screen lands: on arrival, and again while the person has not
 * pressed or moved anything (the data that decides it can come a moment
 * later). A pending Back return wins.
 */
export function useLanding(key: string | null): void {
  const id = useContext(ScreenContext);
  useLayoutEffect(() => {
    if (id === null) return;
    landings.set(id, key);
    scheduleSettle();
  }, [id, key]);
}

/**
 * Takes the ring for `key` once `ready`, only if the control the person had
 * it on has gone (a Connect button that became Disconnect, a question
 * answered): a control still here keeps it — unless the ring was put there by
 * recovery, with nothing pressed since, which this successor outranks. As the
 * change is drawn, so the ring never sits on nothing for a frame.
 */
export function useClaim(key: string, ready: boolean): void {
  const id = useContext(ScreenContext);
  useLayoutEffect(() => {
    if (!ready || id === null) return;
    if (focused !== null && entries.has(focused) && recoveredAt !== inputs) return;
    navFocus(key);
  }, [key, ready, id]);
}

function useKeyState(key: string, on: boolean, inside = false): boolean {
  return useSyncExternalStore(
    (listener) => {
      let set = keyListeners.get(key);
      if (!set) keyListeners.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) keyListeners.delete(key);
      };
    },
    () =>
      on &&
      focused !== null &&
      (inside ? within(tree, focused, key) : focused === key) &&
      active()
  );
}

/** Whether the ring is inside the area `key` (a Continue card while its Remove has it). */
export function useFocusWithin(key: string, on: boolean): boolean {
  return useKeyState(key, on, true);
}

interface LeafOptions {
  /** Registered here at all (the component is on this engine). */
  on: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onHighlight?: () => void;
  /** Arrows it keeps to itself: return true for one it took (the seek bar's Left and Right). */
  onArrow?: (arrow: Arrow, event: KeyboardEvent) => boolean;
}

/**
 * A control. Returns whether it holds the ring, and the props its element
 * takes: its key for the DOM focus to find it, and the pointer.
 */
export function useNavLeaf(
  key: string,
  ref: RefObject<HTMLElement | null>,
  { on, disabled = false, onSelect, onHighlight, onArrow }: LeafOptions
): { focused: boolean; props: Record<string, unknown> } {
  const parent = useContext(ParentContext);
  const callbacks = useRef({ onSelect, onHighlight, onArrow });
  useLayoutEffect(() => {
    callbacks.current = { onSelect, onHighlight, onArrow };
  });

  useLayoutEffect(() => {
    if (!on) return;
    add({
      key,
      parent,
      node: ref.current,
      disabled,
      select: () => callbacks.current.onSelect?.(),
      highlight: () => callbacks.current.onHighlight?.(),
      arrow: (arrow, event) => callbacks.current.onArrow?.(arrow, event) ?? false,
    });
    return () => remove(key);
    // `disabled` is followed below without registering again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, parent, ref]);

  useLayoutEffect(() => {
    const entry = on ? entries.get(key) : undefined;
    if (!entry || entry.disabled === disabled) return;
    entry.disabled = disabled;
    if (disabled && focused === key) scheduleSettle();
  }, [on, key, disabled]);

  const focusedNow = useKeyState(key, on);
  if (!on) return { focused: false, props: {} };
  return {
    focused: focusedNow,
    props: {
      'data-nav-key': key,
      tabIndex: -1,
      // A click puts the ring where it pointed; hovering does not move it
      // (the owner, 2026-10-31): the pointer's own highlight is the CSS
      // `:hover`, and the keys go on from where they or a click left the
      // ring — a pointer passing over a rail no longer changed where Up and
      // Down would land in it.
      onPointerDown: (e: { button: number }) => {
        if (e.button === 0 && answering() && focused !== key && !disabled && allowed(key)) {
          setFocused(key, 'pointer');
        }
      },
    },
  };
}

interface AreaOptions {
  on: boolean;
  spec: AreaSpec;
  /** Nothing to land on (an empty rail): passed over. */
  disabled?: boolean;
  pageTop?: boolean;
  /** A dialog: holds the ring while it is here, and gives it back when it goes. */
  modal?: boolean;
}

/** An area: registers `key` with its rules; its children use `NavParent value={key}`. */
export function useNavArea(
  key: string,
  ref: RefObject<HTMLElement | null>,
  { on, spec, disabled = false, pageTop = false, modal = false }: AreaOptions
): void {
  const parent = useContext(ParentContext);
  useLayoutEffect(() => {
    if (!on) return;
    add({ key, parent, node: ref.current, area: spec, disabled, pageTop, modal });
    return () => remove(key);
    // The rules are followed below without registering again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, parent, ref]);

  const { kind, current, remember, columns, axis, wrap } = spec;
  const hold = spec.hold?.join(',');
  const passOver = spec.passOver?.join(',');
  useLayoutEffect(() => {
    const entry = on ? entries.get(key) : undefined;
    if (!entry) return;
    entry.area = {
      kind,
      current,
      remember,
      columns,
      axis,
      wrap,
      hold: hold ? (hold.split(',') as Arrow[]) : undefined,
      passOver: passOver ? (passOver.split(',') as Arrow[]) : undefined,
    };
    entry.disabled = disabled;
    entry.pageTop = pageTop;
    entry.node = ref.current;
    scheduleSettle();
  }, [on, key, ref, kind, current, remember, columns, axis, wrap, hold, passOver, disabled, pageTop]);
}

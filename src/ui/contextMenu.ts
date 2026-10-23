/**
 * Right-click (owner, 2026-10-18, option 1 of 3). The webview's own menu —
 * Back, Reload, Save as, Print — is a browser's, and Reload restarts the
 * whole interface, mid-film included. So it is off everywhere except in text
 * fields, which keep their Cut, Copy and Paste; marked text gets a small
 * Kinema menu with Copy; anywhere else right-click does nothing.
 *
 * Which text can be marked at all is App.css's (`user-select`): the title
 * page, Settings, the details panel and Needs attention's file names.
 *
 * Plain DOM rather than React: it belongs to no screen, and is installed
 * once, before the first one draws.
 */

const MENU_CLASS = 'text-menu';

let menu: HTMLElement | null = null;

/** Whether the target is somewhere the webview's own text menu belongs. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest('input, textarea, [contenteditable]');
  if (!field) return false;
  if (field instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
      field.type
    );
  }
  return field.tagName === 'TEXTAREA' || (field instanceof HTMLElement && field.isContentEditable);
}

/** The marked text's range, when the click landed on it (or came from the keyboard). */
function markedRange(event: MouseEvent): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (selection.toString().trim() === '') return null;
  const range = selection.getRangeAt(0);
  // The Menu key and Shift+F10 report no pointer position: the selection is what they mean.
  if (event.button !== 2 || (event.clientX === 0 && event.clientY === 0)) return range;
  for (const rect of Array.from(range.getClientRects())) {
    if (
      event.clientX >= rect.left - 2 &&
      event.clientX <= rect.right + 2 &&
      event.clientY >= rect.top - 2 &&
      event.clientY <= rect.bottom + 2
    ) {
      return range;
    }
  }
  return null;
}

function close(): void {
  menu?.remove();
  menu = null;
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
  document.removeEventListener('scroll', close, true);
}

function onPointerDown(event: PointerEvent): void {
  if (menu && event.target instanceof Node && menu.contains(event.target)) return;
  close();
}

/**
 * Any key closes an open menu. Escape closes it and does nothing else — it
 * is Back everywhere else in the app — so this listens on `window` in the
 * capture phase from before the first screen draws: the pages' own Back
 * handlers listen there too, and the first registered runs first.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (!menu) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  close();
}

function copyMarked(): void {
  const text = window.getSelection()?.toString() ?? '';
  // execCommand copies the selection on every webview Kinema runs in, with no
  // permission asked; the async API is the fallback where it is refused.
  let copied: boolean;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  if (!copied && text) void navigator.clipboard?.writeText(text).catch(() => undefined);
  close();
}

function open(x: number, y: number): void {
  close();
  const el = document.createElement('div');
  el.className = MENU_CLASS;
  el.setAttribute('role', 'menu');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.setAttribute('role', 'menuitem');
  copy.textContent = 'Copy';
  // Pressing must not take the selection away before it is copied.
  copy.addEventListener('mousedown', (e) => e.preventDefault());
  copy.addEventListener('click', copyMarked);
  el.appendChild(copy);
  document.body.appendChild(el);
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
  menu = el;
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
}

function onContextMenu(event: MouseEvent): void {
  // A development build keeps the webview's menu on Shift, for Inspect.
  if (import.meta.env.DEV && event.shiftKey) return;
  if (isTextField(event.target)) return;
  event.preventDefault();
  const range = markedRange(event);
  if (!range) {
    close();
    return;
  }
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = range.getBoundingClientRect();
    open(rect.left, rect.bottom + 4);
  } else {
    open(event.clientX, event.clientY);
  }
}

export function installContextMenu(): void {
  document.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown, true);
}

/**
 * A button reachable by pointer *and* by D-pad.
 *
 * Buttons in the browsing UI go through this rather than a bare `<button>`.
 * A control only a mouse can reach is invisible from the couch, and the failure
 * is silent: the button looks and behaves perfectly until the moment someone
 * has a remote in their hand instead of a mouse, which is not when you want to
 * discover it. One component keeps the two input methods from drifting apart.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { noteWidth } from './focus';
import { useNavKey } from './focusGroups';
import { useNavLeaf } from './focusStore';

interface Props {
  children: ReactNode;
  onSelect: () => void;
  /** Merged with the focus class, so callers keep their own styling. */
  className?: string;
  /** Stable key, for directing focus here explicitly. */
  focusKey?: string;
  /**
   * Also removes the button from the focus tree. A control a remote can land on
   * but not activate is a dead end with no way to tell it apart from a bug —
   * the pointer equivalent, a greyed-out button, at least looks disabled.
   */
  disabled?: boolean;
  /** Pointer tooltip. A remote never sees it, so it must never be the only
   *  place a control's meaning is written down. */
  title?: string;
  /** The name read out for a button whose content is an icon. */
  label?: string;
  /** Called when the ring lands here: what a page shows about the control
   *  in hand follows it. */
  onHighlight?: () => void;
  /** It stays under the top bar as the page scrolls (a title page's Back):
   *  the one scroll rule keeps the ring clear of it (focusScroll.ts). */
  stickyTop?: boolean;
}

export default function FocusButton({
  children,
  onSelect,
  className = '',
  focusKey,
  disabled = false,
  title,
  label,
  onHighlight,
  stickyTop = false,
}: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const key = useNavKey(focusKey);
  const { focused, props } = useNavLeaf(key, ref, { on: true, disabled, onSelect, onHighlight });

  // Its label can change while it is highlighted (a version picked), so the
  // width is read again on each render that holds the ring.
  useLayoutEffect(() => {
    if (focused) noteWidth(ref.current);
  });

  return (
    <button
      ref={ref}
      className={`${className} ${focused ? 'focused' : ''}`.trim()}
      disabled={disabled}
      title={title}
      aria-label={label}
      data-sticky-top={stickyTop ? '' : undefined}
      onClick={onSelect}
      onMouseEnter={(e) => noteWidth(e.currentTarget)}
      {...props}
    >
      {children}
    </button>
  );
}

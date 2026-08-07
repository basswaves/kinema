/**
 * A button reachable by pointer *and* by D-pad.
 *
 * Buttons in the browsing UI go through this rather than a bare `<button>`.
 * A control only a mouse can reach is invisible from the couch, and the failure
 * is silent: the button looks and behaves perfectly until the moment someone
 * has a remote in their hand instead of a mouse, which is not when you want to
 * discover it. One component keeps the two input methods from drifting apart.
 */
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, type ReactNode } from 'react';
import { scrollPageToTop } from './focus';

interface Props {
  children: ReactNode;
  onSelect: () => void;
  /** Merged with the focus class, so callers keep their own styling. */
  className?: string;
  /** Stable key, for directing focus here explicitly. */
  focusKey?: string;
  /**
   * What should happen to the scroll position when focus lands here.
   *
   * `nearest` reveals the button if it is off screen and does nothing if it is
   * not. `page-top` is for controls in the top row, where being merely visible
   * is not enough — the page has to go back to the top or the hero stays
   * cropped where the rails left it.
   */
  keepInView?: 'nearest' | 'page-top';
  /**
   * Also removes the button from the focus tree. A control a remote can land on
   * but not activate is a dead end with no way to tell it apart from a bug —
   * the pointer equivalent, a greyed-out button, at least looks disabled.
   */
  disabled?: boolean;
  /** Pointer tooltip. A remote never sees it, so it must never be the only
   *  place a control's meaning is written down. */
  title?: string;
}

export default function FocusButton({
  children,
  onSelect,
  className = '',
  focusKey,
  keepInView,
  disabled = false,
  title,
}: Props) {
  const { ref, focused } = useFocusable<object, HTMLButtonElement>({
    focusKey,
    focusable: !disabled,
    onEnterPress: onSelect,
  });

  useEffect(() => {
    if (!focused || !keepInView) return;
    if (keepInView === 'page-top') scrollPageToTop(ref.current);
    else ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [focused, keepInView, ref]);

  return (
    <button
      ref={ref}
      className={`${className} ${focused ? 'focused' : ''}`.trim()}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

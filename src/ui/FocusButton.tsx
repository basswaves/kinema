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
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { keepOnScreen, noteWidth, scrollPageToTop } from './focus';
import { useNavLeaf, useOnKinema } from './focusStore';

export type KeepInView = 'nearest' | 'page-top';

interface Props {
  children: ReactNode;
  onSelect: () => void;
  /** Merged with the focus class, so callers keep their own styling. */
  className?: string;
  /** Stable key, for directing focus here explicitly. */
  focusKey?: string;
  /**
   * What should happen to the scroll position when focus lands here — on a
   * screen still on the spatial library. Kinema's own engine has one rule
   * for every control (focusScroll.ts) and ignores this.
   *
   * `nearest` reveals the button if it is off screen and does nothing if it is
   * not. `page-top` is for controls in the top row, where being merely visible
   * is not enough — the page has to go back to the top or the hero stays
   * cropped where the rails left it.
   */
  keepInView?: KeepInView;
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
  /** Called when the ring lands here or the pointer moves over it: what a
   *  page shows about the control in hand follows either. */
  onHighlight?: () => void;
}

export default function FocusButton({
  children,
  onSelect,
  className = '',
  focusKey,
  keepInView,
  disabled = false,
  title,
  label,
  onHighlight,
}: Props) {
  // On whichever engine the screen it is drawn in is (focusEngine.tsx).
  const kinema = useOnKinema();
  const { ref, focused: spatialFocused, focusKey: key } = useFocusable<object, HTMLButtonElement>({
    focusKey,
    focusable: !disabled && !kinema,
    onEnterPress: onSelect,
    onFocus: onHighlight,
  });
  const leaf = useNavLeaf(key, ref, { on: kinema, disabled, onSelect, onHighlight });
  const focused = kinema ? leaf.focused : spatialFocused;

  // Its label can change while it is highlighted (a version picked), so the
  // width is read again on each render that holds the ring.
  useLayoutEffect(() => {
    if (focused) noteWidth(ref.current);
  });

  useEffect(() => {
    if (!focused || !keepInView || kinema) return;
    if (keepInView === 'page-top') scrollPageToTop(ref.current);
    else keepOnScreen(ref.current);
  }, [focused, keepInView, ref, kinema]);

  return (
    <button
      ref={ref}
      className={`${className} ${focused ? 'focused' : ''}`.trim()}
      disabled={disabled}
      title={title}
      aria-label={label}
      onClick={onSelect}
      onMouseEnter={(e) => {
        noteWidth(e.currentTarget);
        // On Kinema's engine the pointer moves the ring, which says so itself.
        if (!kinema) onHighlight?.();
      }}
      {...leaf.props}
    >
      {children}
    </button>
  );
}

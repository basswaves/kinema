/**
 * A text input reachable by D-pad.
 *
 * Spatial focus and DOM focus are separate concerns: the first decides where
 * the remote is, the second decides where typed characters land. An input that
 * only ever gets the second is unreachable from the couch, and one that only
 * gets the first shows a ring and swallows every keystroke.
 */
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  type?: 'text' | 'password';
  /**
   * Enter while typing. Handled on the DOM input rather than through
   * `onEnterPress`, which the spatial system only delivers when the input holds
   * *spatial* focus — reaching the field with a mouse would otherwise leave
   * Enter doing nothing.
   */
  onEnter?: () => void;
}

export default function FocusInput({
  value,
  onChange,
  placeholder,
  className = '',
  type = 'text',
  onEnter,
}: Props) {
  const { ref, focused } = useFocusable<object, HTMLInputElement>({});

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    if (focused) {
      // `preventScroll`, because a plain focus() jumps the page to the input
      // at once and the smooth scroll below then has nothing left to do — the
      // inputs lurched while every button around them glided.
      input.focus({ preventScroll: true });
      input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (document.activeElement === input) {
      // Give the caret back when the remote moves on, or this field keeps
      // taking keystrokes — Enter included — while the ring is somewhere else.
      input.blur();
    }
  }, [focused, ref]);

  return (
    <input
      ref={ref}
      type={type}
      className={`${className} ${focused ? 'focused' : ''}`.trim()}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter?.();
      }}
    />
  );
}

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
import { keepOnScreen } from './focus';
import { useTypingFocus } from './typing';

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
  /** A stable key, for landing on this field from elsewhere. */
  focusKey?: string;
}

export default function FocusInput({
  value,
  onChange,
  placeholder,
  className = '',
  type = 'text',
  onEnter,
  focusKey,
}: Props) {
  const { ref, focused } = useFocusable<object, HTMLInputElement>({ focusKey });
  // Typing focus, and the system's keyboard on OK where it has one.
  // It focuses with `preventScroll`, because a plain focus() jumps the page
  // to the input at once and the smooth scroll below then has nothing left
  // to do — the inputs lurched while every button around them glided.
  const enterKey = useTypingFocus(ref, focused);

  useEffect(() => {
    if (focused) keepOnScreen(ref.current, 'nearest');
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
        if (e.key === 'Enter' && !enterKey(e)) onEnter?.();
      }}
    />
  );
}

/**
 * Letters a remote can type with.
 *
 * Search took a physical keyboard: with only a D-pad there was no way to
 * enter a letter, so the search screen was a box that could not be filled.
 * This is the grid every TV app has — arrows to a letter, OK to type it —
 * shown in the TV layout. A keyboard still types into the box as before.
 *
 * Æ, Ø and Å are on it because titles here are named in them; they cost one
 * row, and without them a Norwegian title could not be typed at all.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';

const ROWS = ['abcdefghijklm', 'nopqrstuvwxyz', '1234567890æøå'];

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export default function OnScreenKeyboard({ value, onChange }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="osk" ref={ref} aria-label="On-screen keyboard">
        {ROWS.map((row) => (
          <div className="osk-row" key={row}>
            {[...row].map((ch) => (
              <FocusButton
                key={ch}
                focusKey={`osk:${ch}`}
                className="osk-key"
                keepInView="nearest"
                onSelect={() => onChange(value + ch)}
              >
                {ch}
              </FocusButton>
            ))}
          </div>
        ))}
        <div className="osk-row">
          <FocusButton
            focusKey="osk:space"
            className="osk-key osk-wide"
            keepInView="nearest"
            onSelect={() => onChange(`${value} `)}
          >
            Space
          </FocusButton>
          <FocusButton
            focusKey="osk:delete"
            className="osk-key osk-wide"
            keepInView="nearest"
            label="Delete a letter"
            onSelect={() => onChange(value.slice(0, -1))}
          >
            ⌫ Delete
          </FocusButton>
          <FocusButton
            focusKey="osk:clear"
            className="osk-key osk-wide"
            keepInView="nearest"
            onSelect={() => onChange('')}
          >
            Clear
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

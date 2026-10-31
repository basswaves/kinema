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
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';

const ROWS = ['abcdefghijklm', 'nopqrstuvwxyz', '1234567890æøå'];
const ACROSS = ROWS[0].length;

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** The letters as one grid, the same count across on every row. */
function Letters({ value, onChange }: Props) {
  const { ref, focusKey } = useNavGroup({ kind: 'grid', columns: ACROSS, remember: true });
  return (
    <FocusProvider value={focusKey}>
      <div className="osk-letters" ref={ref}>
        {ROWS.map((row) => (
          <div className="osk-row" key={row}>
            {[...row].map((ch) => (
              <FocusButton
                key={ch}
                focusKey={`osk:${ch}`}
                className="osk-key"
                onSelect={() => onChange(value + ch)}
              >
                {ch}
              </FocusButton>
            ))}
          </div>
        ))}
      </div>
    </FocusProvider>
  );
}

export default function OnScreenKeyboard({ value, onChange }: Props) {
  // Up from the results comes back to the last key used (NAV-MAP, agreed
  // 2026-10-11): the results are only reached through the keys, so there
  // always is one.
  const { ref, focusKey } = useNavGroup({ kind: 'column', remember: true });

  return (
    <FocusProvider value={focusKey}>
      <div className="osk" ref={ref} aria-label="On-screen keyboard">
        <Letters value={value} onChange={onChange} />
        <FocusGroup kind="row" className="osk-row">
          <FocusButton
            focusKey="osk:space"
            className="osk-key osk-wide"
            onSelect={() => onChange(`${value} `)}
          >
            Space
          </FocusButton>
          <FocusButton
            focusKey="osk:delete"
            className="osk-key osk-wide"
            label="Delete a letter"
            onSelect={() => onChange(value.slice(0, -1))}
          >
            ⌫ Delete
          </FocusButton>
          <FocusButton focusKey="osk:clear" className="osk-key osk-wide" onSelect={() => onChange('')}>
            Clear
          </FocusButton>
        </FocusGroup>
      </div>
    </FocusProvider>
  );
}

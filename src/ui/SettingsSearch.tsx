/**
 * Settings' search box (PLAN.md phase 1): a box at the top of the section
 * list, and the matches where the open section would be. OK on a match opens
 * its section and puts the ring on that setting — on the chosen choice of a
 * row, in a field, or on a heading's first control.
 *
 * Mouse, keyboard and remote alike (owner: all three equal): typing into the
 * box shows the matches at once; in the TV layout, OK on the box brings
 * Kinema's own letters up above them, as Search does, and on a system with
 * its own keyboard (Android) OK opens that instead.
 */
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useMemo } from 'react';
import { useCapabilities } from '../capabilities';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import OnScreenKeyboard from './OnScreenKeyboard';
import { searchSettings, type SettingEntry, type SettingMatch } from './settingsIndex';

const SEARCH_BOX_KEY = 'settings-search';
const FIRST_RESULT_KEY = 'settings-search:0';

export function SearchBox({
  query,
  onChange,
  onOpen,
}: {
  query: string;
  onChange: (query: string) => void;
  /** OK on the box: the TV layout's letters come up. */
  onOpen: () => void;
}) {
  return (
    <div className="settings-search-box">
      <FocusInput
        focusKey={SEARCH_BOX_KEY}
        className="settings-input"
        value={query}
        onChange={onChange}
        // With matches, Enter goes to the first; without, it opens the letters.
        onEnter={() => {
          if (!query.trim()) return onOpen();
          // Typing left too: a box clicked into holds the caret without the
          // ring, and would take the next Enter back to itself.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          void setFocus(FIRST_RESULT_KEY);
        }}
        placeholder="Search settings"
      />
    </div>
  );
}

export function SearchResults({
  query,
  onChange,
  letters,
  onPick,
}: {
  query: string;
  onChange: (query: string) => void;
  /** The TV layout: Kinema's own letters above the matches. */
  letters: boolean;
  onPick: (entry: SettingEntry) => void;
}) {
  const can = useCapabilities();
  const matches = useMemo(() => searchSettings(query, can), [query, can]);

  return (
    <section className="settings-section settings-search">
      <h2>Search</h2>
      {letters && <OnScreenKeyboard value={query} onChange={onChange} />}
      {!query.trim() ? (
        <p className="settings-intro">
          Type a setting&rsquo;s name, a word from what it does, or one of its choices.
        </p>
      ) : matches.length === 0 ? (
        <p className="settings-intro">Nothing in Settings matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="settings-search-results">
          {matches.map((m, i) => (
            // By place as well as entry: the spatial library keeps a button's
            // first focus key, so a match that moved up as more was typed
            // would still answer to its old place, and Enter in the box
            // found no first match.
            <li key={`${i}:${m.entry.section}:${m.entry.label}`}>
              <FocusButton
                focusKey={`settings-search:${i}`}
                keepInView="nearest"
                className="settings-search-result"
                onSelect={() => onPick(m.entry)}
              >
                <span>{m.entry.label}</span>
                <span className="muted">{where(m)}</span>
              </FocusButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function where(m: SettingMatch): string {
  return m.value ? `${m.sectionName} · ${m.value}` : m.sectionName;
}

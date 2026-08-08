/**
 * The key list, on screen.
 *
 * Until this existed the control scheme was written down in exactly two places:
 * the README, which nobody reads from a sofa, and two passing sentences buried
 * in Settings help text. That was survivable for the person who wrote the keys
 * and nobody else — and one of them is not optional.
 *
 * **Up is what hands the arrow keys to the player's controls.** Without it a
 * remote cannot reach subtitles, audio tracks, the stats panel or fullscreen at
 * all: the OSD hides itself after a few seconds, so the buttons that would have
 * taught you it exists are not on screen to be found. A user who never guesses
 * Up has a player with no settings.
 *
 * The list is kept in one place rather than beside each handler on purpose. Two
 * lists drift, and the one that drifts is always the documentation.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';

const SHORTCUTS_FOCUS_KEY = 'shortcuts-close';

interface Group {
  heading: string;
  /** `[keys, what it does]`. Keys are split on `+` for rendering. */
  keys: [string[], string][];
  note?: string;
}

const GROUPS: Group[] = [
  {
    heading: 'Getting around',
    keys: [
      [['↑', '↓', '←', '→'], 'Move between things on screen'],
      [['Enter'], 'Choose the highlighted thing'],
      [['Esc'], 'Go back'],
      [['?'], 'Show this list'],
      [['Ctrl', 'Shift', 'T'], 'Switch between desk and TV layout'],
    ],
    note: 'A remote’s Back button works anywhere Esc does.',
  },
  {
    heading: 'While something is playing',
    keys: [
      [['Space'], 'Pause and resume'],
      [['←', '→'], 'Skip back or forward 10 seconds'],
      [['↑'], 'Open the player controls — subtitles, audio, fullscreen'],
      [['Esc'], 'Close what is open, then leave fullscreen, then stop'],
      [['F'], 'Fullscreen'],
      [['N'], 'Next episode'],
      [['P'], 'Previous episode'],
      [['I'], 'Playback details — resolution, codecs, dropped frames'],
    ],
    note: 'Up is the important one. The controls hide themselves while you watch, and Up is what brings them back and lets the arrows reach them.',
  },
];

interface Props {
  onClose: () => void;
}

export default function Shortcuts({ onClose }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true });
  // The overlay covers whatever was focused underneath. Without claiming focus
  // the ring stays on a control the user can no longer see, and the only way
  // out is a key they came here because they did not know.
  useClaimFocus(SHORTCUTS_FOCUS_KEY, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="shortcuts-backdrop" onClick={onClose}>
        <div
          className="shortcuts"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Keyboard and remote controls"
        >
          <h2>Controls</h2>
          {GROUPS.map((group) => (
            <section key={group.heading} className="shortcuts-group">
              <h3>{group.heading}</h3>
              <dl>
                {group.keys.map(([keys, what]) => (
                  <div key={what} className="shortcuts-row">
                    <dt>
                      {keys.map((key, i) => (
                        <span key={key}>
                          {i > 0 && <span className="shortcuts-plus">+</span>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
              {group.note && <p className="muted">{group.note}</p>}
            </section>
          ))}
          <FocusButton
            focusKey={SHORTCUTS_FOCUS_KEY}
            className="btn-primary"
            onSelect={onClose}
          >
            Close
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

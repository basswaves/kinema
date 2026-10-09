/**
 * The key list, on screen.
 *
 * Until this existed the control scheme was written down in exactly two places:
 * the README, which nobody reads from a sofa, and two passing sentences buried
 * in Settings help text. That was survivable for the person who wrote the keys
 * and nobody else.
 *
 * The player's keys follow the streaming-app convention — OK pauses, Left and
 * Right seek, Up or Down bring the controls up — so this list confirms rather
 * than teaches. It used to carry the one key nobody would guess (Up, then the
 * only way to reach subtitles); that mode is gone.
 *
 * The list is kept in one place rather than beside each handler on purpose. Two
 * lists drift, and the one that drifts is always the documentation.
 *
 * Where Kinema is never in a window (Android: always on a TV, `windowed`),
 * the list is the remote's — what is in the hand there — with the keyboard's
 * keys as one line under it, since a keyboard plugged into a box works too.
 * Same keys, same handlers; only the names differ (OK, not Enter).
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
import { useCapabilities } from '../capabilities';

const SHORTCUTS_FOCUS_KEY = 'shortcuts-close';

interface Group {
  heading: string;
  /** `[keys, what it does]`. Keys are split on `+` for rendering. A third
   * `'windowed'` marks a key about the window, left out where there is none. */
  keys: [string[], string, 'windowed'?][];
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
      [['F11'], 'Switch between desk and TV layout (TV is full screen)', 'windowed'],
      [['Ctrl', 'Shift', 'T'], 'The same, another way', 'windowed'],
    ],
    note: 'A remote’s Back button works anywhere Esc does.',
  },
  {
    heading: 'While something is playing',
    keys: [
      [['Enter'], 'Pause and resume (a remote’s OK button)'],
      [['Space'], 'Pause and resume'],
      [['←', '→'], 'Back or forward 10 seconds; hold to go faster'],
      [['↑', '↓'], 'Bring up the controls: seek bar, subtitles, audio'],
      [['Esc'], 'Close what is open, then leave fullscreen, then stop'],
      [['F'], 'Fullscreen (the TV layout is always fullscreen)', 'windowed'],
      [['M'], 'Sound off and on'],
      [['−', '+'], 'Volume down and up'],
      [['N'], 'Next episode'],
      [['P'], 'Previous episode'],
      [['I'], 'Playback details: the output check, resolution, codecs, dropped frames (also at the end of Audio & subtitles)'],
      [['⏯'], 'A remote’s play/pause key pauses and resumes'],
      [['⏪', '⏩'], 'A remote’s rewind and fast-forward jump 30 seconds'],
      [['⏹'], 'A remote’s stop key leaves the player'],
    ],
    note: 'On the controls, the arrows move between them and the seek bar; they step back out of the way after a few seconds.',
  },
];

/** The same keys, named as a remote names them. */
const REMOTE_GROUPS: Group[] = [
  {
    heading: 'Getting around',
    keys: [
      [['↑', '↓', '←', '→'], 'Move between things on screen'],
      [['OK'], 'Choose the highlighted thing'],
      [['Back'], 'Go back'],
    ],
    note: 'The ? at the right of the top bar opens this list.',
  },
  {
    heading: 'While something is playing',
    keys: [
      [['OK'], 'Pause and resume'],
      [['⏯'], 'Pause and resume'],
      [['←', '→'], 'Back or forward 10 seconds; hold to go faster'],
      [['↑', '↓'], 'Bring up the controls: seek bar, subtitles, audio'],
      [['⏪', '⏩'], 'Back or forward 30 seconds'],
      [['Back'], 'Close what is open, then stop'],
      [['⏹'], 'Stop'],
      [['Info'], 'Playback details, where the remote has the key (also at the end of Audio & subtitles)'],
    ],
    note: 'On the controls, the arrows move between them and the seek bar; they step back out of the way after a few seconds.',
  },
  {
    heading: 'With a keyboard',
    keys: [
      [['Enter'], 'OK'],
      [['Esc'], 'Back'],
      [['Space'], 'Pause and resume'],
      [['M'], 'Sound off and on'],
      [['−', '+'], 'Volume down and up'],
      [['N', 'P'], 'Next or previous episode'],
      [['I'], 'Playback details'],
      [['?'], 'Show this list'],
    ],
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
  const windowed = useCapabilities()?.windowed !== false;

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
          {(windowed ? GROUPS : REMOTE_GROUPS).map((group) => (
            <section key={group.heading} className="shortcuts-group">
              <h3>{group.heading}</h3>
              <dl>
                {group.keys
                  .filter(([, , needs]) => !needs || windowed)
                  .map(([keys, what]) => (
                    <div key={what} className="shortcuts-row">
                      <dt>
                        {keys.map((key, i) => (
                          <span key={key}>
                            {i > 0 && windowed && <span className="shortcuts-plus">+</span>}
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
          <FocusButton focusKey={SHORTCUTS_FOCUS_KEY} className="btn-primary" onSelect={onClose}>
            Close
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

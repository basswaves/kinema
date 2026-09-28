/**
 * Settings → Screen: whether Kinema may change the screen's mode to suit a
 * film. Each switch describes the equipment — can this TV show 24 Hz, does it
 * or a video processor upscale better than Kinema, does it want HDR switched
 * — not a taste. The rules are `player/displayMode.ts`; the timing, including
 * "only in fullscreen", is `player/displaySwitch.ts`.
 */
import { userError } from './errors';
import { useCallback, useEffect, useState } from 'react';
import ChoiceRow from './ChoiceRow';
import { setSetting } from '../metadata/api';
import type { ResolutionMode, SwitchSettings } from '../player/displayMode';
import {
  readSwitchSettings,
  SWITCH_HDR_KEY,
  SWITCH_REFRESH_KEY,
  SWITCH_RESOLUTION_KEY,
} from '../player/displaySwitch';

const ON_OFF = [
  { value: 'off' as const, label: 'Off' },
  { value: 'on' as const, label: 'On' },
];

const RESOLUTION_CHOICES: { value: ResolutionMode; label: string }[] = [
  { value: 'off', label: 'Never change it' },
  { value: 'auto', label: 'Auto' },
  { value: 'match', label: 'Match the video' },
];

export default function ScreenSection({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useState<SwitchSettings | null>(null);

  useEffect(() => {
    let live = true;
    void readSwitchSettings().then((s) => live && setSettings(s));
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(
    (key: string, value: string, next: SwitchSettings) => {
      setSettings(next);
      void setSetting(key, value).catch((e) => onError(userError(e)));
    },
    [onError]
  );

  if (!settings) return null;

  return (
    <section className="settings-section">
      <h2>Screen</h2>
      <p className="muted">
        Only while the player fills the screen, and put back when it closes.
      </p>

      <ChoiceRow
        label="Match the refresh rate"
        choices={ON_OFF}
        value={settings.refresh ? 'on' : 'off'}
        onChange={(v) => save(SWITCH_REFRESH_KEY, v, { ...settings, refresh: v === 'on' })}
        note="Switches to 23.976 Hz for a movie, so camera pans stop juddering."
        more={
          <p>
            Movies are 24 frames a second, and most screens run at 60, which cannot divide
            evenly &mdash; so pans judder. With this on, the screen switches to 23.976 Hz (or a
            clean multiple) for a movie and back afterwards, if it offers that at the resolution
            it is using. The screen goes blank for a second or two while it switches, and the
            video waits, paused, until there is a picture again.
          </p>
        }
      />

      <ChoiceRow
        label="Resolution"
        choices={RESOLUTION_CHOICES}
        value={settings.resolution}
        onChange={(v) => save(SWITCH_RESOLUTION_KEY, v, { ...settings, resolution: v })}
        note="Auto switches up only when the desktop is set lower than the screen can show."
        more={
          <p>
            <strong>Auto</strong>: a 4K movie on a 4K TV whose desktop is set to 1080p would
            otherwise be shrunk by Kinema and blown back up by the TV.{' '}
            <strong>Match the video</strong> always uses the video&rsquo;s own resolution, so the
            TV &mdash; or a video processor like a madVR Envy &mdash; does the upscaling.
          </p>
        }
      />

      <ChoiceRow
        label="Turn HDR on for HDR videos"
        choices={ON_OFF}
        value={settings.hdr ? 'on' : 'off'}
        onChange={(v) => save(SWITCH_HDR_KEY, v, { ...settings, hdr: v === 'on' })}
        note="For a screen that can do HDR but is usually left with it off in Windows."
        more={
          <p>
            Kinema switches Windows HDR on for an HDR video and off again afterwards. With this
            off, HDR videos are shown in SDR on such a screen.
          </p>
        }
      />
    </section>
  );
}

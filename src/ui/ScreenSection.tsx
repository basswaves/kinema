/**
 * Settings → Screen: whether Kinema may change the screen's mode to suit a
 * video. Each switch describes the equipment (can this TV show 24 Hz, does it
 * or a video processor upscale better than Kinema, does it want HDR switched),
 * not a taste. The rules are `player/displayMode.ts`; the timing, including
 * "only in fullscreen", is `player/displaySwitch.ts`.
 *
 * The words must match those rules exactly, because they are what someone
 * reads to decide whether to switch this on: any frame rate, not only film's;
 * only modes the screen itself offers; never a lower resolution for a better
 * rate.
 */
import { useCallback, useEffect, useState } from 'react';
import { setSetting } from '../metadata/api';
import { userError } from './errors';
import ChoiceRow from './ChoiceRow';
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
      <p className="settings-intro">
        These only apply while a video plays fullscreen, and the screen is set back when it stops.
        Kinema only uses modes the screen offers, as listed under Your equipment below.
      </p>

      <ChoiceRow
        label="Match the refresh rate"
        choices={ON_OFF}
        value={settings.refresh ? 'on' : 'off'}
        onChange={(v) => save(SWITCH_REFRESH_KEY, v, { ...settings, refresh: v === 'on' })}
        note="Switches the screen to a refresh rate that fits the video's frame rate, so camera pans move smoothly instead of juddering: 23.976 Hz for most movies, for example, or 50 Hz for a show made for European TV."
        hint="Only rates the screen offers at the resolution it is using count, and Kinema never lowers the resolution to get one. The screen goes black for a second or two while it switches, and the video waits."
      />

      <ChoiceRow
        label="Resolution"
        choices={RESOLUTION_CHOICES}
        value={settings.resolution}
        onChange={(v) => save(SWITCH_RESOLUTION_KEY, v, { ...settings, resolution: v })}
        note="Auto raises the resolution only when the desktop is set lower than both the video and the screen, such as a 4K movie on a 4K TV with the desktop at 1080p."
        hint="Match the video always uses the video's own resolution, for a TV or video processor (such as a madVR Envy) that should do the upscaling instead of Kinema."
      />

      <ChoiceRow
        label="Turn HDR on for HDR videos"
        choices={ON_OFF}
        value={settings.hdr ? 'on' : 'off'}
        onChange={(v) => save(SWITCH_HDR_KEY, v, { ...settings, hdr: v === 'on' })}
        note="For a screen that can show HDR but has it switched off in Windows. Kinema turns HDR on for an HDR video and off again afterwards."
        hint="With this off, HDR videos are shown in SDR on such a screen."
      />
    </section>
  );
}

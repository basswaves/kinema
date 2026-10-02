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
 *
 * Refresh matching and HDR each apply to every screen, only the screens
 * listed, or none (`devicePolicy.ts`) — for a PC that is not always at the
 * same screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { setSetting } from '../metadata/api';
import { savePolicy, type DevicePolicy } from '../player/devicePolicy';
import { userError } from './errors';
import ChoiceRow from './ChoiceRow';
import DeviceChoice from './DeviceChoice';
import { hdrOptions, refreshOptions } from './deviceOptions';
import { getEquipment, type Equipment } from '../player/equipment';
import type { ResolutionMode } from '../player/displayMode';
import {
  readSwitchPolicies,
  SWITCH_HDR_KEY,
  SWITCH_REFRESH_KEY,
  SWITCH_RESOLUTION_KEY,
  type SwitchPolicies,
} from '../player/displaySwitch';

const RESOLUTION_CHOICES: { value: ResolutionMode; label: string }[] = [
  { value: 'off', label: 'Never change it' },
  { value: 'auto', label: 'Auto' },
  { value: 'match', label: 'Match the video' },
];

/** `system` is for the wording only: "switched off in Windows". */
export default function ScreenSection({
  onError,
  system,
}: {
  onError: (message: string) => void;
  system: string;
}) {
  const [settings, setSettings] = useState<SwitchPolicies | null>(null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);

  useEffect(() => {
    let live = true;
    void readSwitchPolicies().then((s) => live && setSettings(s));
    void getEquipment()
      .then((e) => live && setEquipment(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(
    (key: string, value: string, next: SwitchPolicies) => {
      setSettings(next);
      void setSetting(key, value).catch((e) => onError(userError(e)));
    },
    [onError]
  );

  const savePolicyOf = useCallback(
    (key: string, p: DevicePolicy, next: SwitchPolicies) => {
      setSettings(next);
      void savePolicy(key, p).catch((e) => onError(userError(e)));
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

      <DeviceChoice
        label="Match the refresh rate"
        allLabel="Every screen"
        policy={settings.refresh}
        devices={refreshOptions(equipment)}
        onChange={(refresh) => savePolicyOf(SWITCH_REFRESH_KEY, refresh, { ...settings, refresh })}
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

      <DeviceChoice
        label="Turn HDR on for HDR videos"
        allLabel="Every screen"
        policy={settings.hdr}
        devices={hdrOptions(equipment)}
        onChange={(hdr) => savePolicyOf(SWITCH_HDR_KEY, hdr, { ...settings, hdr })}
        note={`For a screen that can show HDR but has it switched off in ${system}. Kinema turns HDR on for an HDR video and off again afterwards.`}
        hint="With this off, HDR videos are shown in SDR on such a screen. Only these is for a PC that is not always at the same screen: a screen not on the list is left as it is."
      />
    </section>
  );
}

/**
 * Settings → Screen: whether Kinema may change the screen's mode to suit a
 * film. Each switch describes the equipment — can this TV show 24 Hz, does it
 * or a video processor upscale better than Kinema, does it want HDR switched
 * — not a taste. The rules are `player/displayMode.ts`; the timing, including
 * "only in fullscreen", is `player/displaySwitch.ts`.
 */
import { useCallback, useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import { setSetting } from '../metadata/api';
import type { ResolutionMode, SwitchSettings } from '../player/displayMode';
import {
  readSwitchSettings,
  SWITCH_HDR_KEY,
  SWITCH_REFRESH_KEY,
  SWITCH_RESOLUTION_KEY,
} from '../player/displaySwitch';

const RESOLUTION_ORDER: ResolutionMode[] = ['auto', 'match', 'off'];
const RESOLUTION_LABEL: Record<ResolutionMode, string> = {
  auto: 'Auto — up to the film when the desktop is lower',
  match: "Match content — always the film's own",
  off: 'Off — never change it',
};

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
      void setSetting(key, value).catch((e) => onError(String(e)));
    },
    [onError]
  );

  if (!settings) return null;

  return (
    <section className="settings-section">
      <h2>Screen</h2>
      <p className="muted">
        Kinema can change the screen&rsquo;s mode to suit each film &mdash; only while the player is
        fullscreen, and back again when it closes. The film waits, paused, until the screen is
        showing a picture again; the screen goes blank for a second or two while it switches.
      </p>

      <div className="settings-toggle-row">
        <FocusButton
          keepInView="nearest"
          className={settings.refresh ? 'btn-primary' : 'btn-secondary'}
          onSelect={() =>
            save(SWITCH_REFRESH_KEY, settings.refresh ? 'off' : 'on', {
              ...settings,
              refresh: !settings.refresh,
            })
          }
        >
          Match the refresh rate: {settings.refresh ? 'on' : 'off'}
        </FocusButton>
        <span className="muted">
          Films are 24 frames a second, and most screens run at 60, which cannot divide evenly
          &mdash; so pans judder. With this on, the screen switches to 23.976 Hz (or a clean
          multiple) for a film and back afterwards. Only if the screen offers it at the resolution
          it is using.
        </span>
      </div>

      <div className="settings-toggle-row">
        <FocusButton
          keepInView="nearest"
          className={settings.resolution === 'off' ? 'btn-secondary' : 'btn-primary'}
          onSelect={() => {
            const next =
              RESOLUTION_ORDER[
                (RESOLUTION_ORDER.indexOf(settings.resolution) + 1) % RESOLUTION_ORDER.length
              ] ?? 'auto';
            save(SWITCH_RESOLUTION_KEY, next, { ...settings, resolution: next });
          }}
        >
          Resolution: {RESOLUTION_LABEL[settings.resolution]}
        </FocusButton>
        <span className="muted">
          <strong>Auto</strong> only switches up: a 4K film on a 4K TV whose desktop is set to 1080p
          would otherwise be shrunk by Kinema and blown back up by the TV.{' '}
          <strong>Match content</strong> always uses the film&rsquo;s own resolution, so the TV
          &mdash; or a video processor like a madVR Envy &mdash; does the upscaling. Press to cycle.
        </span>
      </div>

      <div className="settings-toggle-row">
        <FocusButton
          keepInView="nearest"
          className={settings.hdr ? 'btn-primary' : 'btn-secondary'}
          onSelect={() =>
            save(SWITCH_HDR_KEY, settings.hdr ? 'off' : 'on', { ...settings, hdr: !settings.hdr })
          }
        >
          Turn HDR on for HDR films: {settings.hdr ? 'on' : 'off'}
        </FocusButton>
        <span className="muted">
          For a screen that can do HDR but is usually left with it off in Windows. Kinema switches
          Windows HDR on for an HDR film and off again afterwards. With it off, HDR films are shown
          in SDR on such a screen.
        </span>
      </div>
    </section>
  );
}

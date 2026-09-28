/**
 * Settings → Sound: how the film's sound leaves the PC.
 *
 * Every control here describes the equipment, not a taste (CLAUDE.md → "Settings
 * describe the hardware, never taste"): whether the receiver should get the
 * sound directly, which device is the receiver, and — only as an override of
 * what the equipment check found — which formats it takes. Each format
 * defaults to Auto, the detected answer, so the common case is one switch.
 *
 * The rules themselves are in `player/audioOutput.ts`; this only reads and
 * writes the settings it reads, and says in words what they will do with the
 * device that is actually connected.
 */
import { userError } from './errors';
import { useCallback, useEffect, useState } from 'react';
import ChoiceRow from './ChoiceRow';
import { setSetting } from '../metadata/api';
import { getEquipment, type AudioDevice, type Equipment } from '../player/equipment';
import {
  AUDIO_DEVICE_KEY,
  AUDIO_DIRECT_KEY,
  BITSTREAM_CODECS,
  bitstreamKey,
  planAudio,
  readAudioSettings,
  targetDevice,
  type AudioSettings,
  type Override,
} from '../player/audioOutput';


function formatLabel(device: AudioDevice | null, codec: string): string {
  return device?.bitstream.find((b) => b.codec === codec)?.label ?? codec;
}

function detected(device: AudioDevice | null, codec: string): string {
  const result = device?.bitstream.find((b) => b.codec === codec)?.result;
  return result === 'yes' ? 'takes it' : result === 'no' ? 'does not take it' : 'not known';
}

export default function SoundSection({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([readAudioSettings(), getEquipment().catch(() => null)]).then(([s, e]) => {
      if (!live) return;
      setSettings(s);
      setEquipment(e);
    });
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(
    (key: string, value: string, next: AudioSettings) => {
      setSettings(next);
      void setSetting(key, value).catch((e) => onError(userError(e)));
    },
    [onError]
  );

  if (!settings) return null;

  const connected = equipment?.audio.filter((a) => a.connected) ?? [];
  const device = targetDevice(equipment, settings.deviceId);
  const plan = planAudio(settings, device);
  const takesLossless = device?.bitstream.some(
    (b) => (b.codec === 'truehd' || b.codec === 'dts-hd') && b.result === 'yes'
  );

  // Windows' default, then each connected device by name. The empty string
  // is how "Windows default" is stored.
  const deviceChoices = [
    { value: '', label: 'Windows default' },
    ...connected.map((a) => ({ value: a.id, label: a.name })),
  ];

  return (
    <section className="settings-section">
      <h2>Sound</h2>

      <ChoiceRow
        label="Send sound straight to the receiver"
        choices={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
        value={settings.direct ? 'on' : 'off'}
        onChange={(v) => save(AUDIO_DIRECT_KEY, v, { ...settings, direct: v === 'on' })}
        note="On sends Dolby TrueHD, Atmos, DTS-HD and DTS:X to the receiver untouched, as a disc player does."
        more={
          <p>
            <strong>On:</strong> while something plays, Kinema takes the sound device for itself
            and sends the video&rsquo;s own soundtrack to your receiver untouched. Windows&rsquo;
            speaker setup and spatial sound are bypassed, so they do not matter. Other sounds from
            this PC are silent until it stops. <strong>Off:</strong> sound goes through Windows
            like any other program: decoded, mixed to Windows&rsquo; speaker setup, and without
            Atmos or DTS:X.
          </p>
        }
      />

      {device && (
        <p className="muted">
          {settings.direct
            ? plan.spdif.length > 0
              ? `${device.name} gets these untouched: ${plan.spdif
                  .map((c) => formatLabel(device, c))
                  .join(', ')}. Anything else is decoded and sent as ${
                  plan.channels.split(',')[0]
                } sound.`
              : `${device.name} takes no compressed formats, so everything is decoded and sent as ${
                  plan.channels.split(',')[0]
                } sound.`
            : takesLossless
              ? `${device.name} can take the lossless formats untouched. Turn this on to use that.`
              : `Sound goes through Windows to ${device.name}, mixed to ${device.mix_layout}.`}
          {!settings.direct && device.spatial_objects
            ? " Windows spatial sound is on for this device: the receiver may show Atmos, but that is Windows re-wrapping decoded 7.1 — a movie's own Atmos or DTS:X height sound is lost unless this is on."
            : ''}
        </p>
      )}

      <ChoiceRow
        label="Sound device"
        choices={deviceChoices}
        value={settings.deviceId ?? ''}
        onChange={(v) => save(AUDIO_DEVICE_KEY, v, { ...settings, deviceId: v || null })}
        note="Windows default follows whatever Windows is set to; a chosen device that is unplugged falls back to it."
      />

      {settings.direct && (
        <>
          <h3>Formats</h3>
          <p className="muted">
            Auto uses what the receiver told Windows. Force one on only if you know better &mdash;
            a format it cannot take plays as silence or noise.
          </p>
          {BITSTREAM_CODECS.map((codec) => {
            const override: Override = settings.overrides[codec] ?? 'auto';
            return (
              <ChoiceRow
                key={codec}
                label={formatLabel(device, codec)}
                choices={[
                  { value: 'auto', label: `Auto (${detected(device, codec)})` },
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                value={override}
                onChange={(next) =>
                  save(bitstreamKey(codec), next, {
                    ...settings,
                    overrides: { ...settings.overrides, [codec]: next },
                  })
                }
              />
            );
          })}
        </>
      )}
    </section>
  );
}

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
import { useCallback, useEffect, useState } from 'react';
import FocusButton from './FocusButton';
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

const NEXT: Record<Override, Override> = { auto: 'on', on: 'off', off: 'auto' };

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
      void setSetting(key, value).catch((e) => onError(String(e)));
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

  // Cycle: Windows default, then each connected device.
  const cycleDevice = () => {
    const ids = [null, ...connected.map((a) => a.id)];
    const next = ids[(ids.indexOf(settings.deviceId) + 1) % ids.length] ?? null;
    save(AUDIO_DEVICE_KEY, next ?? '', { ...settings, deviceId: next });
  };

  return (
    <section className="settings-section">
      <h2>Sound</h2>

      <div className="settings-toggle-row">
        <FocusButton
          keepInView="nearest"
          className={settings.direct ? 'btn-primary' : 'btn-secondary'}
          onSelect={() =>
            save(AUDIO_DIRECT_KEY, settings.direct ? 'off' : 'on', {
              ...settings,
              direct: !settings.direct,
            })
          }
        >
          Send sound straight to the receiver: {settings.direct ? 'on' : 'off'}
        </FocusButton>
        <span className="muted">
          <strong>On:</strong> while a film plays, Kinema takes the sound device for itself and
          sends the film&rsquo;s own soundtrack &mdash; Dolby TrueHD and Atmos, DTS-HD and DTS:X
          &mdash; to your receiver untouched, the way a disc player does. Windows&rsquo; speaker
          setup and spatial sound are bypassed, so they do not matter. Other sounds from this PC are
          silent until the film stops. <strong>Off:</strong> sound goes through Windows like any
          other program: decoded, mixed to Windows&rsquo; speaker setup, and without Atmos or DTS:X.
        </span>
      </div>

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
            ? " Windows spatial sound is on for this device: the receiver may show Atmos, but that is Windows re-wrapping decoded 7.1 — a film's own Atmos or DTS:X height sound is lost unless this is on."
            : ''}
        </p>
      )}

      <div className="settings-toggle-row">
        <FocusButton keepInView="nearest" className="btn-secondary" onSelect={cycleDevice}>
          Sound device:{' '}
          {settings.deviceId
            ? (connected.find((a) => a.id === settings.deviceId)?.name ?? 'not connected')
            : 'Windows default'}
        </FocusButton>
        <span className="muted">
          Press to cycle through the connected devices. &ldquo;Windows default&rdquo; follows
          whatever Windows is set to; a chosen device that is unplugged falls back to it.
        </span>
      </div>

      {settings.direct && (
        <>
          <h3>Formats</h3>
          <p className="muted">
            Auto uses what the receiver itself told Windows (see Your equipment below). Only change
            one if you know better: a format forced on that the receiver cannot take plays as
            silence or noise.
          </p>
          {BITSTREAM_CODECS.map((codec) => {
            const override = settings.overrides[codec] ?? 'auto';
            return (
              <div className="settings-toggle-row" key={codec}>
                <FocusButton
                  keepInView="nearest"
                  className={override === 'auto' ? 'btn-secondary' : 'btn-primary'}
                  onSelect={() => {
                    const next = NEXT[override];
                    save(bitstreamKey(codec), next, {
                      ...settings,
                      overrides: { ...settings.overrides, [codec]: next },
                    });
                  }}
                >
                  {formatLabel(device, codec)}:{' '}
                  {override === 'auto' ? `Auto (${detected(device, codec)})` : override}
                </FocusButton>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

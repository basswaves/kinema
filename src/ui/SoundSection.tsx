/**
 * Settings → Picture & sound → Sound: how the film's sound leaves the PC.
 *
 * Every control here describes the equipment, not a taste (CONTRIBUTING.md → "Settings
 * describe the hardware, never taste"): whether the receiver should get the
 * sound directly, which device is the receiver, and — only as an override of
 * what the equipment check found — which formats it takes. Each format
 * defaults to Auto, the detected answer, so the common case is one switch.
 *
 * Straight to the receiver applies to every device that takes a film's
 * formats untouched, only the devices listed, or none (`devicePolicy.ts`).
 *
 * The rules themselves are in `player/audioOutput.ts`; this only reads and
 * writes the settings it reads, and says in words what they will do with the
 * device that is actually connected.
 */
import { userError } from './errors';
import { useCallback, useEffect, useState } from 'react';
import ChoiceRow from './ChoiceRow';
import FocusButton from './FocusButton';
import DeviceChoice from './DeviceChoice';
import { soundOptions } from './deviceOptions';
import { savePolicy, type DevicePolicy } from '../player/devicePolicy';
import { setSetting } from '../metadata/api';
import {
  DIALOGUE_KEY,
  LEVELLING_KEY,
  LEVELLINGS,
  readDefaultLevel,
  type Levelling,
  type SoundLevel,
} from '../player/soundLevel';
import { getEquipment, type AudioDevice, type Equipment } from '../player/equipment';
import {
  AUDIO_DEVICE_KEY,
  AUDIO_DIRECT_KEY,
  BITSTREAM_CODECS,
  bitstreamKey,
  goesDirect,
  planAudio,
  readAudioSettings,
  soundDeviceNow,
  targetDevice,
  type SoundDevice,
  type AudioSettings,
  type Override,
} from '../player/audioOutput';
import {
  DELAY_STEP_MS,
  delayLabel,
  describeDelay,
  readDelay,
  saveDelay,
} from '../player/audioDelay';


function formatLabel(device: AudioDevice | null, codec: string): string {
  return device?.bitstream.find((b) => b.codec === codec)?.label ?? codec;
}

function detected(device: AudioDevice | null, codec: string): string {
  const result = device?.bitstream.find((b) => b.codec === codec)?.result;
  return result === 'yes' ? 'takes it' : result === 'no' ? 'does not take it' : 'not known';
}

/** `system` is for the wording only: "through Windows", "through Linux". */
/**
 * Levelling and the dialogue lift, as every title starts (soundLevel.ts);
 * the player's Audio & subtitles panel changes them per title. For the room
 * and the ears listening — night, speech lost under the music — and never on
 * sound that goes to the receiver untouched.
 */
function LevelRows({ onError }: { onError: (message: string) => void }) {
  const [level, setLevel] = useState<SoundLevel | null>(null);
  useEffect(() => {
    void readDefaultLevel().then(setLevel);
  }, []);
  if (!level) return null;
  return (
    <>
      <ChoiceRow
        label="Volume levelling"
        choices={LEVELLINGS.map((l) => ({ value: l.id, label: l.label }))}
        value={level.levelling}
        onChange={(v) => {
          setLevel({ ...level, levelling: v as Levelling });
          void setSetting(LEVELLING_KEY, v).catch((e) => onError(userError(e)));
        }}
        note="Brings quiet scenes up and loud ones down, so the whisper and the explosion are closer — for late at night, or speech that gets lost. Each step evens out more."
        hint="Only on sound Kinema decodes: a track sent to the receiver untouched is never changed. The player's Audio & subtitles panel changes it for one title."
      />
      <ChoiceRow
        label="Dialogue lift"
        choices={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
        value={level.dialogue ? 'on' : 'off'}
        onChange={(v) => {
          setLevel({ ...level, dialogue: v === 'on' });
          void setSetting(DIALOGUE_KEY, v).catch((e) => onError(userError(e)));
        }}
        note="Raises the centre channel, where films put the speech, and lowers the others by as much — clearer voices, no louder overall."
        hint="For surround tracks (5.1, 7.1), which have a centre channel; stereo has none to lift. Not on sound sent to the receiver untouched."
      />
    </>
  );
}

/**
 * The sound delay kept for the device the sound will go to (audioDelay.ts),
 * read again whenever the chosen device changes.
 */
function SoundDelayRow({
  deviceId,
  onError,
}: {
  deviceId: string | null;
  onError: (message: string) => void;
}) {
  const [here, setHere] = useState<{ device: SoundDevice | null; ms: number } | null>(null);

  useEffect(() => {
    let live = true;
    void soundDeviceNow()
      .then(async (device) => ({ device, ms: await readDelay(device?.id ?? null) }))
      .then((next) => {
        if (live) setHere(next);
      })
      .catch((e) => console.warn('settings: sound delay not read', e));
    return () => {
      live = false;
    };
  }, [deviceId]);

  if (!here) return null;
  const change = (ms: number) => {
    void saveDelay(here.device?.id ?? null, ms)
      .then((kept) => setHere({ device: here.device, ms: kept }))
      .catch((e) => onError(userError(e)));
  };

  return (
    <div className="choice-row">
      <div className="choice-label">
        Sound delay{here.device ? ` for ${here.device.name}` : ''}
      </div>
      <div className="choice-options">
        <FocusButton
          className="choice"
          keepInView="nearest"
          label={`Sound ${DELAY_STEP_MS} ms earlier`}
          onSelect={() => change(here.ms - DELAY_STEP_MS)}
        >
          −{DELAY_STEP_MS} ms
        </FocusButton>
        <span className="choice-value">{delayLabel(here.ms)}</span>
        <FocusButton
          className="choice"
          keepInView="nearest"
          label={`Sound ${DELAY_STEP_MS} ms later`}
          onSelect={() => change(here.ms + DELAY_STEP_MS)}
        >
          +{DELAY_STEP_MS} ms
        </FocusButton>
        <FocusButton className="choice" keepInView="nearest" onSelect={() => change(0)}>
          No delay
        </FocusButton>
      </div>
      <p className="choice-note">
        {describeDelay(here.ms)}. A receiver or TV that works on the sound or the picture can put
        them out of step by the same amount on every film: later if the sound comes before the
        lips, earlier if it comes after. Kept for each sound device, and also in the player's Audio
        and subtitles panel (Ctrl + and Ctrl − on a keyboard).
      </p>
    </div>
  );
}

export default function SoundSection({
  onError,
  system,
}: {
  onError: (message: string) => void;
  system: string;
}) {
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

  const saveDirect = useCallback(
    (direct: DevicePolicy, next: AudioSettings) => {
      setSettings(next);
      void savePolicy(AUDIO_DIRECT_KEY, direct).catch((e) => onError(userError(e)));
    },
    [onError]
  );

  if (!settings) return null;

  const connected = equipment?.audio.filter((a) => a.connected) ?? [];
  const device = targetDevice(equipment, settings.deviceId);
  const plan = planAudio(settings, device);
  const direct = goesDirect(settings, device);
  const takesLossless = device?.bitstream.some(
    (b) => (b.codec === 'truehd' || b.codec === 'dts-hd') && b.result === 'yes'
  );

  // The system's default, then each connected device by name. The empty
  // string is how "default" is stored.
  const deviceChoices = [
    { value: '', label: `${system} default` },
    ...connected.map((a) => ({ value: a.id, label: a.name })),
  ];
  // Windows has a mixer setting and spatial sound that stop mattering; on
  // Linux what stops mattering is the desktop's volume.
  const onWindows = system === 'Windows';

  return (
    <section className="settings-section">
      <h2>Sound</h2>

      <DeviceChoice
        label="Send sound straight to the receiver"
        allLabel="Every device that can"
        policy={settings.direct}
        devices={soundOptions(equipment)}
        onChange={(direct) => saveDirect(direct, { ...settings, direct })}
        note={`Straight to the receiver sends the video's own soundtrack to your receiver untouched, as a disc player does, including Dolby TrueHD, Atmos, DTS-HD and DTS:X. Otherwise sound goes through ${system} like any other program, which mixes it to ${system}'s speaker setup and loses Atmos and DTS:X height sound.`}
        hint={`${
          onWindows
            ? "While a video plays straight to the receiver, other sounds from this PC are silent, and Windows' speaker and spatial sound settings make no difference."
            : `While a video plays straight to the receiver, other sounds from this PC are silent, and ${system}'s own volume makes no difference: use Kinema's.`
        } Every device that can means one that takes some of a film's formats untouched; speakers that take none keep working as usual. Only these is for a PC that is not always at the same receiver.`}
      />

      {device && (
        <p className="muted">
          {direct
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
              : `Sound goes through ${system} to ${device.name}${
                  device.mix_layout ? `, mixed to ${device.mix_layout}` : ''
                }.`}
          {!direct && device.spatial_objects
            ? " Windows spatial sound is on for this device. The receiver may show Atmos, but that is Windows re-wrapping decoded 7.1: a movie's own Atmos or DTS:X height sound is lost unless this is on."
            : ''}
        </p>
      )}

      <ChoiceRow
        label="Sound device"
        choices={deviceChoices}
        value={settings.deviceId ?? ''}
        onChange={(v) => save(AUDIO_DEVICE_KEY, v, { ...settings, deviceId: v || null })}
        note={
          onWindows
            ? 'Windows default follows whatever Windows is set to. If a device chosen here is unplugged, Kinema uses the Windows default until it is back.'
            : `${system} default plays wherever ${system} plays; sent straight to the receiver, it is the one device that takes surround formats. If a device chosen here is unplugged, Kinema uses the ${system} default until it is back.`
        }
      />

      <SoundDelayRow deviceId={settings.deviceId} onError={onError} />
      <LevelRows onError={onError} />

      {settings.direct.policy !== 'off' && (
        <>
          <h3>Formats</h3>
          <p className="settings-intro">
            Auto uses what the receiver told {system} it can play. Only force a format on if you
            know better: a format the receiver cannot play comes out as silence or noise.
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

/**
 * How sound leaves the app — step 3 of the native-output plan.
 *
 * Two ways, one switch, and the switch is the user's (see PLAN.md → Native
 * output):
 *
 *  - **Through Windows** (the default). mpv plays in shared mode and Windows
 *    mixes to whatever its speaker setup says. Nothing is passed through
 *    untouched; Atmos and DTS:X objects are lost; a stereo speaker setup folds
 *    7.1 down to two channels. Settings explains all of that rather than
 *    changing Windows behind the user's back.
 *  - **Straight to the receiver**. mpv takes the device exclusively for as long
 *    as a film plays — Windows' own spatial sound and speaker setup are out of
 *    the path, so games keep "Atmos for home theater" the rest of the time —
 *    and passes through every bitstream the device said yes to, as detected by
 *    `equipment.rs`, with a per-format override. Anything not passed through
 *    goes as multichannel PCM, up to what the device takes.
 *
 * Only formats the device accepted *in their own right* go into
 * `--audio-spdif`: mpv relabels a refused bitstream as AC3 and retries, which
 * on a device that takes AC3 but not TrueHD means silence or noise at the
 * receiver (GOTCHAS → "mpv relabels a refused bitstream as AC3").
 */
import { command, getProperty } from 'tauri-plugin-libmpv-api';
import { getSetting } from '../metadata/api';
import { getEquipment, type AudioDevice, type Equipment } from './equipment';
import { readTracks } from './tracks';

/** Setting keys. */
export const AUDIO_DIRECT_KEY = 'audio_direct';
export const AUDIO_DEVICE_KEY = 'audio_device';
export const bitstreamKey = (codec: string) => `audio_bitstream_${codec}`;

export type Override = 'auto' | 'on' | 'off';

export const BITSTREAM_CODECS = ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'] as const;

export interface AudioSettings {
  direct: boolean;
  /** Endpoint id from the equipment check, or null for Windows' default. */
  deviceId: string | null;
  overrides: Partial<Record<string, Override>>;
}

export interface AudioPlan {
  /** mpv's `audio-device`: `auto`, or `wasapi/{…}`. */
  device: string;
  exclusive: boolean;
  /** For `audio-spdif`; empty passes nothing through. */
  spdif: string[];
  /** For `audio-channels`. */
  channels: string;
}

/**
 * mpv names a WASAPI device by the part of the endpoint id after its first
 * dot: `{0.0.0.00000000}.{aaaaaaaa-…}` is `wasapi/{aaaaaaaa-…}` (both forms
 * are in the same mpv.log, "Monitoring changes in device" and "Selecting
 * device").
 */
export function mpvDeviceName(endpointId: string): string {
  const dot = endpointId.indexOf('}.');
  return `wasapi/${dot >= 0 ? endpointId.slice(dot + 2) : endpointId}`;
}

/** The device the sound will go to: the chosen one if present, else Windows' default. */
export function targetDevice(
  equipment: Equipment | null,
  deviceId: string | null
): AudioDevice | null {
  const connected = equipment?.audio.filter((a) => a.connected) ?? [];
  return (
    (deviceId ? connected.find((a) => a.id === deviceId) : undefined) ??
    connected.find((a) => a.is_default) ??
    null
  );
}

/**
 * Layouts to offer mpv when it talks to the device directly. Exclusive mode
 * has no Windows mixer to ask, and mpv's default `auto-safe` then forces
 * stereo — so without this, "straight to the receiver" would quietly be a
 * stereo downmix for everything not passed through.
 */
export function channelsFor(maxChannels: number | null): string {
  if (maxChannels !== null && maxChannels >= 8) return '7.1,5.1(side),5.1,stereo';
  if (maxChannels !== null && maxChannels >= 6) return '5.1(side),5.1,stereo';
  return 'stereo';
}

export function planAudio(settings: AudioSettings, device: AudioDevice | null): AudioPlan {
  const name = settings.deviceId && device?.id === settings.deviceId
    ? mpvDeviceName(device.id)
    : 'auto';
  if (!settings.direct) {
    return { device: name, exclusive: false, spdif: [], channels: 'auto-safe' };
  }
  const spdif = BITSTREAM_CODECS.filter((codec) => {
    const override = settings.overrides[codec] ?? 'auto';
    if (override !== 'auto') return override === 'on';
    return device?.bitstream.some((b) => b.codec === codec && b.result === 'yes') ?? false;
  });
  return {
    device: name,
    exclusive: true,
    spdif,
    channels: channelsFor(device?.max_pcm_channels ?? null),
  };
}

// ---- applying it --------------------------------------------------------------

export async function readAudioSettings(): Promise<AudioSettings> {
  const [direct, deviceId, ...overrides] = await Promise.all([
    getSetting(AUDIO_DIRECT_KEY),
    getSetting(AUDIO_DEVICE_KEY),
    ...BITSTREAM_CODECS.map((codec) => getSetting(bitstreamKey(codec))),
  ]);
  const entries = BITSTREAM_CODECS.map((codec, i) => {
    const value = overrides[i];
    return [codec, value === 'on' || value === 'off' ? value : 'auto'] as const;
  });
  return {
    direct: direct === 'on',
    deviceId: deviceId || null,
    overrides: Object.fromEntries(entries),
  };
}

async function setAll(plan: AudioPlan): Promise<void> {
  await command('set', ['audio-device', plan.device]);
  await command('set', ['audio-exclusive', plan.exclusive ? 'yes' : 'no']);
  await command('set', ['audio-spdif', plan.spdif.join(',')]);
  await command('set', ['audio-channels', plan.channels]);
}

export function describePlan(plan: AudioPlan): string {
  return plan.exclusive
    ? `straight to ${plan.device}, passthrough ${plan.spdif.join(',') || 'none'}, PCM ${plan.channels}`
    : `through Windows (${plan.device}), ${plan.channels}`;
}

let lastApplied = '';

/**
 * Settings + equipment → mpv, before each file. Only when something changed,
 * so an evening of episodes logs one line, not forty.
 *
 * Never applied mid-file: mpv reads these when it opens the audio output,
 * which it does per file — leaving the player sends `stop`, which closes it.
 */
export async function applyAudioPlan(): Promise<AudioPlan> {
  const settings = await readAudioSettings();
  const equipment = await getEquipment().catch(() => null);
  const plan = planAudio(settings, targetDevice(equipment, settings.deviceId));
  const key = JSON.stringify(plan);
  if (key !== lastApplied) {
    await setAll(plan);
    lastApplied = key;
    console.log(`audio: ${describePlan(plan)}`);
  }
  return plan;
}

/**
 * The fallbacks, in order, for when the audio output fails to open — as it
 * did on the test TV with Windows' "Atmos for home theater" on: mpv carried on
 * with no audio at all and nothing on screen said so. First back to Windows'
 * default device through the Windows mixer, then stereo, which is the layout
 * least likely to be refused.
 */
export const FALLBACKS: AudioPlan[] = [
  { device: 'auto', exclusive: false, spdif: [], channels: 'auto-safe' },
  { device: 'auto', exclusive: false, spdif: [], channels: 'stereo' },
];

export async function applyFallback(step: number, trackId: number): Promise<boolean> {
  const plan = FALLBACKS[step];
  if (!plan) return false;
  await setAll(plan);
  // Forget what was applied, so the next file puts the real plan back.
  lastApplied = '';
  // Selecting the track again is what reopens the output with the new
  // settings; mpv dropped it when the first open failed.
  await command('set', ['aid', String(trackId)]);
  console.warn(`audio: output failed to open; falling back to ${describePlan(plan)}`);
  return true;
}

/**
 * The audio track to bring back when a file's sound failed to open, or null
 * when nothing is wrong. Asked a moment after playback (re)starts, since the
 * output opens as the file does.
 *
 * A failed open does not leave the track selected with nowhere to play: mpv
 * prints "Audio: no audio" and *deselects* the track. So the sign is a file
 * that has audio tracks with none selected — which the player never asks for
 * itself, having no "audio off" — or one selected with no output behind it.
 */
export async function silencedAudioTrack(preferred: number | null): Promise<number | null> {
  const audio = (await readTracks().catch(() => [])).filter((t) => t.type === 'audio');
  if (audio.length === 0) return null;
  const selected = audio.find((t) => t.selected);
  if (selected) {
    const ao = await getProperty('current-ao', 'string').catch(() => null);
    return ao ? null : selected.id;
  }
  return (
    audio.find((t) => t.id === preferred) ??
    audio.find((t) => t.default) ??
    audio[0]
  ).id;
}

// ---- the one-time offer ---------------------------------------------------------

/** Set once the offer has been answered either way; it is never made again. */
export const AUDIO_DIRECT_OFFERED_KEY = 'audio_direct_offered';

export interface DirectSoundOffer {
  device: string;
  /** The lossless formats the device said yes to, by name. */
  formats: string[];
}

/**
 * Whether to offer "straight to the receiver" before this film — once, ever,
 * and only where it would make a difference a person can hear: the device
 * takes TrueHD or DTS-HD, which through Windows lose their Atmos and DTS:X.
 * Never when it is already on (2026-09-24: no prompt on every film, and
 * none at all for someone who has already chosen).
 */
export function offerFor(
  settings: AudioSettings,
  alreadyOffered: boolean,
  device: AudioDevice | null
): DirectSoundOffer | null {
  if (settings.direct || alreadyOffered || !device) return null;
  const lossless = device.bitstream.filter(
    (b) => (b.codec === 'truehd' || b.codec === 'dts-hd') && b.result === 'yes'
  );
  if (lossless.length === 0) return null;
  // "Dolby TrueHD", not "Dolby TrueHD (incl. Atmos)": the offer says what the
  // formats carry in a sentence of its own.
  const name = (label: string) => label.replace(/ \(incl\. [^)]*\)$/, '');
  return { device: device.name, formats: lossless.map((b) => name(b.label)) };
}

export async function directSoundOffer(): Promise<DirectSoundOffer | null> {
  const [settings, offered, equipment] = await Promise.all([
    readAudioSettings(),
    getSetting(AUDIO_DIRECT_OFFERED_KEY),
    getEquipment().catch(() => null),
  ]);
  return offerFor(settings, Boolean(offered), targetDevice(equipment, settings.deviceId));
}

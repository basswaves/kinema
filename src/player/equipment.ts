/**
 * What this PC is connected to, as the backend's `equipment.rs` reads it from
 * Windows: every screen, every audio output, and what each can take.
 *
 * Read-only, and nothing in playback acts on it yet. It is the first step of
 * the native-output plan (ROADMAP → "Native output"): passthrough and display
 * switching will be built on these answers rather than on guesses.
 */
import { invoke } from '@tauri-apps/api/core';

export type HdrState = 'unknown' | 'unsupported' | 'off' | 'on';

/** How a device answered "would you take this bitstream untouched?". */
export type Probe = 'yes' | 'no' | 'busy' | 'not_allowed' | 'unknown';

export interface DisplayMode {
  width: number;
  height: number;
  /** As Windows lists it — a whole number, 23 for 23.976. */
  hz: number;
  /** What it means. */
  rate: number;
}

/** Fields every remembered device carries, beside its own. */
export interface SeenFields {
  /** Present at the latest check. */
  connected: boolean;
  /** Unix seconds. */
  first_seen: number;
  last_seen: number;
  /** Never seen before the latest check. */
  new: boolean;
}

export interface Display extends SeenFields {
  /** Stable across launches: Windows' device path for the monitor. */
  id: string;
  name: string;
  gdi_name: string;
  connection: string;
  width: number;
  height: number;
  refresh_num: number;
  refresh_den: number;
  hdr: HdrState;
  peak_nits: number | null;
  full_frame_nits: number | null;
  min_nits: number | null;
  bits_per_color: number | null;
  modes: DisplayMode[];
  notes: string[];
}

export interface BitstreamSupport {
  /** mpv's name for it, as `--audio-spdif` takes it. */
  codec: string;
  label: string;
  result: Probe;
  detail: string | null;
  /** Could not be asked this time; this is the answer from an earlier check. */
  remembered: boolean;
}

export interface AudioDevice extends SeenFields {
  name: string;
  id: string;
  is_default: boolean;
  connection: string;
  mix_channels: number;
  mix_layout: string;
  mix_rate: number;
  max_pcm_channels: number | null;
  /** Windows spatial sound (Atmos / DTS:X for home theater) is on, with this many objects. */
  spatial_objects: number | null;
  bitstream: BitstreamSupport[];
  notes: string[];
}

export interface Equipment {
  gpus: string[];
  /** Connected first, then every one seen before and not connected now. */
  displays: Display[];
  audio: AudioDevice[];
  problems: string[];
  /** Unix seconds. */
  checked_at: number;
}

/** This launch's check, as saved — does not ask the hardware again. */
export const getEquipment = () => invoke<Equipment>('get_equipment');

/** Ask every connected device again and save the answers over the old ones. */
export const checkEquipment = () => invoke<Equipment>('check_equipment');

/** `23.976`, `24`, `59.94`, as a person writes them. */
export function formatRate(rate: number): string {
  return String(Number(rate.toFixed(3)));
}

export function refreshRate(d: Display): number {
  return d.refresh_den > 0 ? d.refresh_num / d.refresh_den : 0;
}

export function hdrLabel(d: Display): string {
  switch (d.hdr) {
    case 'on':
      return d.peak_nits ? `HDR on · ${Math.round(d.peak_nits)} nits peak` : 'HDR on';
    case 'off':
      return 'HDR capable · off in Windows';
    case 'unsupported':
      return 'SDR';
    default:
      return 'HDR unknown';
  }
}

export const PROBE_LABEL: Record<Probe, string> = {
  yes: 'yes',
  no: 'no',
  busy: 'busy',
  not_allowed: 'blocked',
  unknown: '?',
};

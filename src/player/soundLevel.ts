/**
 * Volume levelling and dialogue lift (PLAN phase 2; VENTIC.md row 7).
 *
 * A need, not a taste: at night, or for ears that lose the speech under the
 * music, a film's range is too wide — the whisper too quiet, the explosion
 * too loud. Levelling brings the quiet up and holds the loud down, in four
 * steps (off and three amounts); the dialogue lift raises the centre
 * channel, where films put the speech, and lowers the others by as much.
 * A default in Settings; changed per title from the player's panel.
 *
 * Only on sound Kinema decodes. A track that goes to the receiver untouched
 * (`audio-spdif`) is never altered — the film's own sound is the receiver's
 * to decode — so the filters are left off for it and the panel says why.
 * Built-in ffmpeg filters through mpv's `af` (`dynaudnorm`, `pan`): no new
 * program. Desktop only: on Android Media3 plays the sound.
 */
import { getSetting, setSetting } from '../metadata/api';
import { hasMpv, mpvCommand, readProperty, type Track } from './engine';

export const LEVELLING_KEY = 'sound_levelling';
export const DIALOGUE_KEY = 'dialogue_boost';
/** What was chosen in the player, by title (or by file for a loose video). */
export const SOUND_BY_TITLE_KEY = 'sound_by_title';
/** The titles remembered; the oldest go first, so the setting stays small. */
export const MAX_TITLES = 500;

export type Levelling = 'off' | 'little' | 'more' | 'most';
export const LEVELLINGS: { id: Levelling; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'little', label: 'A little' },
  { id: 'more', label: 'More' },
  { id: 'most', label: 'Most' },
];

export interface SoundLevel {
  levelling: Levelling;
  dialogue: boolean;
}
export const NO_LEVEL: SoundLevel = { levelling: 'off', dialogue: false };

/**
 * `dynaudnorm`: each step lets quiet passages rise further (`m`, the most
 * gain) and follows changes faster (`f` frame ms, `g` frames smoothed — an
 * odd number). The last also compresses (`s`) and aims at a set loudness
 * (`r`), which is what brings the loud down. Only options ffmpeg has had for
 * years: a libmpv built with an older ffmpeg must not refuse the filter.
 */
const LEVELLING_FILTER: Record<Exclude<Levelling, 'off'>, string> = {
  little: 'dynaudnorm=f=500:g=31:p=0.9:m=3',
  more: 'dynaudnorm=f=250:g=21:p=0.9:m=6',
  most: 'dynaudnorm=f=150:g=15:p=0.9:m=10:r=0.3:s=10',
};

/**
 * ffmpeg's channel order for the layouts that carry a centre (mpv names
 * them the same). Others — stereo, mono, an unnamed layout — have no
 * channel to lift, so the lift is not offered for them.
 */
const LAYOUTS: Record<string, string[]> = {
  '3.0': ['FL', 'FR', 'FC'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
  '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
};

/** +3 dB on the centre, −3 dB on the rest: speech 6 dB clearer, no louder overall. */
const LIFT = 1.413;
const LOWER = 0.708;

export const canLiftDialogue = (layout: string | null | undefined) =>
  !!layout && layout in LAYOUTS;

function dialogueFilter(layout: string): string {
  const channels = LAYOUTS[layout];
  return `pan=${layout}|${channels
    .map((c) => `${c}=${c === 'FC' ? LIFT : LOWER}*${c}`)
    .join('|')}`;
}

/**
 * Whether mpv passes this codec to the device untouched, by the same rule as
 * mpv's `audio-spdif`: DTS goes with either `dts` or `dts-hd` listed.
 */
export function passesThrough(codec: string | null | undefined, spdif: string): boolean {
  if (!codec) return false;
  const list = spdif.split(',').map((s) => s.trim());
  if (codec === 'dts' || codec === 'dca') return list.includes('dts') || list.includes('dts-hd');
  return list.includes(codec);
}

/** Why nothing is applied, or null when the level applies as asked. */
export type NotApplied = 'passthrough' | null;

/**
 * mpv's `af` for a level on a track: the lift first (on the film's own
 * channels), then the levelling over the whole. Empty clears it.
 */
export function filterFor(level: SoundLevel, layout: string | null | undefined): string {
  const parts: string[] = [];
  if (level.dialogue && layout && canLiftDialogue(layout)) parts.push(dialogueFilter(layout));
  if (level.levelling !== 'off') parts.push(LEVELLING_FILTER[level.levelling]);
  return parts.length ? `@kinema:lavfi=[${parts.join(',')}]` : '';
}

const isLevelling = (v: unknown): v is Levelling =>
  typeof v === 'string' && LEVELLINGS.some((l) => l.id === v);

type ByTitle = Record<string, SoundLevel>;

export function parseByTitle(value: string | null): ByTitle {
  const out: ByTitle = {};
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        const l = v as Partial<SoundLevel> | null;
        if (l && isLevelling(l.levelling) && typeof l.dialogue === 'boolean')
          out[key] = { levelling: l.levelling, dialogue: l.dialogue };
      }
    }
  } catch {
    // Damaged: the defaults everywhere.
  }
  return out;
}

/** The default from Settings: off, as before this existed. */
export async function readDefaultLevel(): Promise<SoundLevel> {
  const [levelling, dialogue] = await Promise.all([
    getSetting(LEVELLING_KEY).catch(() => null),
    getSetting(DIALOGUE_KEY).catch(() => null),
  ]);
  return { levelling: isLevelling(levelling) ? levelling : 'off', dialogue: dialogue === 'on' };
}

/** This title's own choice, else the default. */
export async function readLevel(titleKey: string | null): Promise<SoundLevel> {
  if (titleKey) {
    const kept = parseByTitle(await getSetting(SOUND_BY_TITLE_KEY).catch(() => null))[titleKey];
    if (kept) return kept;
  }
  return readDefaultLevel();
}

export async function saveLevel(titleKey: string, level: SoundLevel): Promise<void> {
  const all = parseByTitle(await getSetting(SOUND_BY_TITLE_KEY).catch(() => null));
  delete all[titleKey];
  all[titleKey] = level;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TITLES))) delete all[old];
  await setSetting(SOUND_BY_TITLE_KEY, JSON.stringify(all));
}

/** The level in words, for the notice and the details panel. */
export function describeLevel(level: SoundLevel): string {
  const label = LEVELLINGS.find((x) => x.id === level.levelling)?.label.toLowerCase() ?? 'off';
  const levelling = level.levelling === 'off' ? 'no levelling' : `levelling ${label}`;
  return level.dialogue ? `Dialogue lifted, ${levelling}` : `Sound as mixed, ${levelling}`;
}

/**
 * Whether a track listed for passthrough was refused and decoded after all:
 * the device said no, and mpv fell back to PCM (`audio-out-params/format` is
 * not `spdif-*` once the sound is open). Then it is Kinema's sound again,
 * and the level applies; null while the sound is not open yet.
 */
export async function decodedAfterAll(): Promise<boolean | null> {
  const format = await readProperty<string>('audio-out-params/format', 'string');
  return format ? !format.startsWith('spdif-') : null;
}

/** What is on mpv now, for the details panel. */
let applied: { af: string; level: SoundLevel; notApplied: NotApplied } = {
  af: '',
  level: NO_LEVEL,
  notApplied: null,
};
export const appliedLevel = () => applied;

/**
 * Put `level` on the playing track. `audio-spdif` is read from mpv itself,
 * so a fallback that turned passthrough off is followed. A refusal costs
 * only the levelling, said in the log — never the sound.
 */
export async function applyLevel(
  level: SoundLevel,
  track: Pick<Track, 'codec' | 'layout'> | null,
  decoded = false
): Promise<NotApplied> {
  if (!hasMpv()) return null;
  const spdif = decoded ? '' : ((await readProperty<string>('audio-spdif', 'string')) ?? '');
  const notApplied: NotApplied = passesThrough(track?.codec, spdif) ? 'passthrough' : null;
  const af = notApplied ? '' : filterFor(level, track?.layout);
  if (af !== applied.af) {
    try {
      await mpvCommand('set', ['af', af]);
      console.log(
        `audio: ${af ? describeLevel(level).toLowerCase() : 'no filters'}` +
          (notApplied ? ' (sound goes to the receiver untouched)' : '')
      );
    } catch (e) {
      console.warn(`audio: mpv refused af=${af}`, e);
      try {
        await mpvCommand('set', ['af', '']);
      } catch {
        // Nothing more to undo.
      }
      applied = { af: '', level, notApplied };
      return notApplied;
    }
  }
  applied = { af, level, notApplied };
  return notApplied;
}

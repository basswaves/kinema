/**
 * How big subtitles are drawn, and whether a dark box sits behind them.
 *
 * Readability, not taste (owner, round 5): the right size depends on how far
 * the person sits from the screen and how well they see, and a box behind the
 * lines is for eyes that lose white text on a bright picture. Neither is
 * something mpv can know, so they are asked — and kept **per screen**, like
 * the other settings that describe equipment (`devicePolicy.ts`): a desk
 * monitor at arm's length and a TV across a room want different sizes.
 *
 * What each reaches (said in the setting's description):
 *  - text subtitles (SRT, WebVTT, plain ASS) take the size and the box;
 *  - subtitles with their own styling (typeset ASS) keep their look, scaled;
 *  - picture subtitles (Blu-ray PGS, DVD) are drawn pictures: scaled only.
 * The film's own tracks, forced subtitles and OpenSubtitles files are all
 * drawn by the same mpv, so all of them follow. Desktop only: on Android
 * Media3 draws its own captions (Media3Plugin.kt), which this does not reach.
 */
import { getSetting, setSetting } from '../metadata/api';
import { hasMpv, mpvCommand, readProperty } from './engine';

export type SubSize = 'small' | 'normal' | 'large' | 'larger';

/** The steps, smallest first, with mpv's `sub-scale` for each. */
export const SUB_SIZES: { id: SubSize; label: string; scale: number }[] = [
  { id: 'small', label: 'Small', scale: 0.8 },
  { id: 'normal', label: 'Normal', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.3 },
  { id: 'larger', label: 'Larger', scale: 1.6 },
];

export interface SubStyle {
  size: SubSize;
  /** A dark box behind the lines. */
  box: boolean;
}

export const DEFAULT_STYLE: SubStyle = { size: 'normal', box: false };

/** Where the styles live: one JSON object, keyed by the screen's stable id. */
export const SUB_STYLE_KEY = 'subtitle_style';
/**
 * The key for a screen with no stable id — the equipment check has not seen
 * it, or there is none. One shared entry: unsure is "the same as before".
 */
export const UNKNOWN_SCREEN = '*';

/** The box: black, three quarters solid, so the picture still shows round it. */
const BOX_COLOR = '#C0000000';

type Styles = Record<string, SubStyle>;

const isSize = (v: unknown): v is SubSize => SUB_SIZES.some((s) => s.id === v);

/** The stored styles; anything damaged is left out, which is the default. */
export function parseStyles(value: string | null): Styles {
  const out: Styles = {};
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const { size, box } = v as { size?: unknown; box?: unknown };
        out[key] = { size: isSize(size) ? size : 'normal', box: box === true };
      }
    }
  } catch {
    // Damaged: every screen at the default.
  }
  return out;
}

export const styleFor = (styles: Styles, screenId: string | null): SubStyle =>
  styles[screenId ?? UNKNOWN_SCREEN] ?? DEFAULT_STYLE;

export async function readSubStyle(screenId: string | null): Promise<SubStyle> {
  return styleFor(parseStyles(await getSetting(SUB_STYLE_KEY).catch(() => null)), screenId);
}

export async function saveSubStyle(screenId: string | null, style: SubStyle): Promise<void> {
  const styles = parseStyles(await getSetting(SUB_STYLE_KEY).catch(() => null));
  styles[screenId ?? UNKNOWN_SCREEN] = style;
  await setSetting(SUB_STYLE_KEY, JSON.stringify(styles));
}

/** The next size up, round to the smallest after the largest — one button. */
export function nextSize(size: SubSize): SubSize {
  const at = SUB_SIZES.findIndex((s) => s.id === size);
  return SUB_SIZES[(at + 1) % SUB_SIZES.length].id;
}

export const sizeLabel = (size: SubSize) =>
  SUB_SIZES.find((s) => s.id === size)?.label ?? 'Normal';

/** What mpv had before Kinema drew a box, put back when it is turned off. */
export interface PlainSubs {
  borderStyle: string;
  backColor: string;
  borderColor: string;
}

/**
 * mpv's options for a style, in the order they are set. The box is mpv
 * 0.38's `background-box`, coloured by `sub-back-color`; `fallback` is the
 * box an older mpv (Ubuntu 24.04 has 0.37) draws instead — libass's opaque
 * box, coloured by the outline's colour. Off puts back what mpv had, since
 * the defaults differ between versions.
 */
export function mpvStyleOptions(
  style: SubStyle,
  plain: PlainSubs,
  fallback = false
): [string, string][] {
  const scale = SUB_SIZES.find((s) => s.id === style.size)?.scale ?? 1;
  if (!style.box) {
    return [
      ['sub-scale', String(scale)],
      ['sub-border-style', plain.borderStyle],
      ['sub-back-color', plain.backColor],
      ['sub-border-color', plain.borderColor],
    ];
  }
  return fallback
    ? [
        ['sub-scale', String(scale)],
        ['sub-border-style', 'opaque-box'],
        ['sub-border-color', BOX_COLOR],
      ]
    : [
        ['sub-scale', String(scale)],
        ['sub-border-style', 'background-box'],
        ['sub-back-color', BOX_COLOR],
      ];
}

/** What mpv had before Kinema changed it, read once per run. */
let plain: PlainSubs | null = null;

async function set(name: string, value: string): Promise<boolean> {
  try {
    await mpvCommand('set', [name, value]);
    return true;
  } catch (e) {
    console.warn(`subtitles: mpv refused ${name}=${value}`, e);
    return false;
  }
}

/**
 * Draw subtitles in this style from now on. Each option on its own: an mpv
 * that refuses `background-box` gets the older box instead, and one that
 * refuses that too costs only the box, said in the log — never the film.
 */
export async function applySubStyle(style: SubStyle): Promise<void> {
  if (!hasMpv()) return;
  if (!plain) {
    const [borderStyle, backColor, borderColor] = await Promise.all([
      readProperty<string>('sub-border-style', 'string'),
      readProperty<string>('sub-back-color', 'string'),
      readProperty<string>('sub-border-color', 'string'),
    ]);
    plain = {
      borderStyle: borderStyle || 'outline-and-shadow',
      backColor: backColor || '#00000000',
      borderColor: borderColor || '#FF000000',
    };
  }
  let refused = false;
  for (const [name, value] of mpvStyleOptions(style, plain)) {
    if (!(await set(name, value)) && value === 'background-box') refused = true;
  }
  if (refused) {
    for (const [name, value] of mpvStyleOptions(style, plain, true)) await set(name, value);
  }
}

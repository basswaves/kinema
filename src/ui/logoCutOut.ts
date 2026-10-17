/**
 * Studio logos with their lettering cut out of a solid plate.
 *
 * The badges show every studio logo in white (`.media-badge-logo` in ui.css),
 * which turns every pixel that is not see-through white. That is right for
 * most logos — lettering or a mark on nothing — and wrong for a logo whose
 * name is light lettering on a solid plate: the plate and its lettering became
 * one white block, the name gone (owner, 2026-10-09). For those, the lettering
 * is cut out of the white instead, the way the logo itself reads.
 *
 * Deliberately narrow: only near-white lettering on a clearly darker plate,
 * the two clearly apart. A shaded mark has a range of greys rather than two
 * colours, and cutting its lighter half out broke it into pieces; anything not
 * plainly a plate keeps the plain white it had, so no logo looks worse.
 *
 * One more case, separate and safe: a logo with nothing see-through at all (a
 * dark rectangle with the name on it). Whitened it is a featureless white
 * block whatever its lettering, so nothing is lost by taking the plate away
 * instead: what differs from the plate shows in white, the plate itself
 * disappears (`plateBrightness`, `removePlate`).
 *
 * And one more: a light outline with a dark plate inside it, and the
 * lettering in the light colour too — the Warner Bros. shield, gold on blue.
 * Whitened, outline, plate and letters are one white shield. Here the light
 * part is the logo and the plate is only its ground, so the light part shows
 * in white and the plate goes see-through, as the logo's own one-colour
 * version does (`enclosedPlateSplit`, `keepLight`). What makes it safe is that
 * the plate is *enclosed*: it never touches the logo's see-through
 * surroundings. Dark lettering on nothing touches them everywhere, so a logo
 * whose dark part is its name can never lose it this way.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** Bins for the brightness histogram. */
const BINS = 64;
/** A pixel at least this opaque is part of the logo. */
const SOLID = 128;
/** How cleanly the logo splits into two brightnesses (Otsu's measure, 0–1). */
const TWO_TONE = 0.85;
/** The lighter part must be near white: lettering, not a second colour. */
const LETTERING = 0.85;
/** And clearly brighter than the plate. */
const CONTRAST = 0.5;
/** The lettering is a part of the logo, not most of it or a speck. */
const SHARE_MIN = 0.05;
const SHARE_MAX = 0.7;
/** Softens the cut over this much brightness either side of the split. */
const FEATHER = 0.1;

const luminance = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** How a logo's solid pixels split into two brightnesses (Otsu), or null. */
function twoTones(
  pixels: Uint8ClampedArray
): { separation: number; dark: number; light: number; share: number } | null {
  const hist = new Array<number>(BINS).fill(0);
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < SOLID) continue;
    const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    hist[Math.min(BINS - 1, Math.floor(l * BINS))]++;
    n++;
  }
  if (n < 50) return null;

  const total = hist.reduce((sum, h, i) => sum + (i + 0.5) * h, 0);
  const mean = total / n;
  const variance = hist.reduce((sum, h, i) => sum + h * (i + 0.5 - mean) ** 2, 0) / n;
  if (variance === 0) return null;

  // Otsu: the split that leaves the two sides most apart.
  let best = { between: 0, dark: 0, light: 0, share: 0 };
  let below = 0;
  let belowSum = 0;
  for (let t = 0; t < BINS - 1; t++) {
    below += hist[t];
    belowSum += (t + 0.5) * hist[t];
    if (below === 0 || below === n) continue;
    const dark = belowSum / below;
    const light = (total - belowSum) / (n - below);
    const w = below / n;
    const between = w * (1 - w) * (dark - light) ** 2;
    if (between > best.between) {
      best = { between, dark: dark / BINS, light: light / BINS, share: 1 - w };
    }
  }
  const { between, dark, light, share } = best;
  return { separation: between / variance, dark, light, share };
}

/**
 * The brightness above which a pixel is lettering to cut out, or null when the
 * logo is not light lettering on a plate. `pixels` is RGBA, as a canvas gives.
 */
export function letteringSplit(pixels: Uint8ClampedArray): number | null {
  const tones = twoTones(pixels);
  if (!tones) return null;
  const { separation, dark, light, share } = tones;
  const plate =
    separation >= TWO_TONE &&
    light >= LETTERING &&
    light - dark >= CONTRAST &&
    share >= SHARE_MIN &&
    share <= SHARE_MAX;
  // Cut halfway between the two, not at the histogram's split, which can sit
  // right against the plate's colour when nothing lies between them.
  return plate ? (dark + light) / 2 : null;
}

/**
 * A logo this much of which is solid has nothing see-through to speak of.
 * 0.98 missed a white plate with black lettering at 0.978, its edge softened
 * to see-through (Weed Road Pictures); of the library's 443 studio logos,
 * none other lies between 0.962 and 0.98.
 */
const OPAQUE_SHARE = 0.97;
/** The plate is the biggest area of one brightness: at least this much. */
const PLATE_SHARE = 0.3;
/** A difference from the plate's brightness below this is still the plate… */
const PLATE_NOISE = 0.12;
/** …and from this much above it, the mark is shown in full. */
const PLATE_FULL = 0.37;

/**
 * The plate's brightness (0–1) for a logo that is solid all over and has one
 * plain colour behind its marks, or null for every other logo. `pixels` is RGBA.
 */
export function plateBrightness(pixels: Uint8ClampedArray): number | null {
  const hist = new Array<number>(BINS).fill(0);
  let n = 0;
  let solid = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    n++;
    if (pixels[i + 3] < 250) continue;
    solid++;
    const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    hist[Math.min(BINS - 1, Math.floor(l * BINS))]++;
  }
  if (n < 50 || solid / n < OPAQUE_SHARE) return null;
  let mode = 0;
  for (let i = 1; i < BINS; i++) if (hist[i] > hist[mode]) mode = i;
  return hist[mode] / solid >= PLATE_SHARE ? (mode + 0.5) / BINS : null;
}

/** The logo in white with its plate see-through, in place. */
export function removePlate(pixels: Uint8ClampedArray, plate: number): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    const shown = Math.min(1, Math.max(0, (Math.abs(l - plate) - PLATE_NOISE) / (PLATE_FULL - PLATE_NOISE)));
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = Math.round(pixels[i + 3] * shown);
  }
}

/** The logo in white with its lettering see-through, in place. */
export function cutOut(pixels: Uint8ClampedArray, split: number): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    const cut = Math.min(1, Math.max(0, (l - (split - FEATHER)) / (2 * FEATHER)));
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = Math.round(pixels[i + 3] * (1 - cut));
  }
}

/**
 * The most of a plate's pixels that may touch the see-through surroundings
 * and still count as enclosed: anti-aliasing, not an open edge. The Warner
 * Bros. shield measures 0; of 40 other real studio logos, the lowest was 0.019.
 */
const ENCLOSED = 0.005;

/**
 * The brightness that splits a light outline from the dark plate it encloses,
 * or null for every other logo. `pixels` is RGBA, `width` the logo's width.
 */
export function enclosedPlateSplit(pixels: Uint8ClampedArray, width: number): number | null {
  const tones = twoTones(pixels);
  if (!tones) return null;
  const { separation, dark, light, share } = tones;
  if (
    separation < TWO_TONE ||
    light - dark < CONTRAST ||
    share < PLATE_SHARE ||
    share > 1 - PLATE_SHARE
  ) {
    return null;
  }
  const split = (dark + light) / 2;
  const height = Math.floor(pixels.length / 4 / width);
  const solidAt = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && pixels[(y * width + x) * 4 + 3] >= SOLID;
  let plate = 0;
  let touching = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] < SOLID || luminance(pixels[i], pixels[i + 1], pixels[i + 2]) >= split) {
        continue;
      }
      plate++;
      if (!solidAt(x - 1, y) || !solidAt(x + 1, y) || !solidAt(x, y - 1) || !solidAt(x, y + 1)) {
        touching++;
      }
    }
  }
  return plate > 0 && touching / plate <= ENCLOSED ? split : null;
}

/** The logo's light part in white with the plate see-through, in place. */
export function keepLight(pixels: Uint8ClampedArray, split: number): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    const kept = Math.min(1, Math.max(0, (l - (split - FEATHER)) / (2 * FEATHER)));
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = Math.round(pixels[i + 3] * kept);
  }
}

/** One look per logo, for as long as Kinema runs. */
const looked = new Map<string, Promise<string | null>>();

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Both the cached copy (Tauri's asset protocol) and TMDB's answer with
    // Access-Control-Allow-Origin, so the pixels can be read.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`logo did not load: ${src}`));
    img.src = src;
  });
}

async function lookAt(sources: string[]): Promise<string | null> {
  for (const src of sources) {
    try {
      const img = await load(src);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0) return null;
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      const split = letteringSplit(data.data);
      const enclosed = split === null ? enclosedPlateSplit(data.data, canvas.width) : null;
      if (split !== null) {
        cutOut(data.data, split);
      } else if (enclosed !== null) {
        keepLight(data.data, enclosed);
      } else {
        const plate = plateBrightness(data.data);
        if (plate === null) return null;
        removePlate(data.data, plate);
      }
      context.putImageData(data, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      // Not loaded, or not readable: the next source, then plain white.
      console.warn('studio logo:', e);
    }
  }
  return null;
}

/**
 * The logo with its lettering cut out, once it has been looked at — or null
 * while looking, and for every logo that is not a plate, which then stays as
 * it was.
 */
export function useLetteringCutOut(local: string | null, remote: string | null): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    const sources = [local ? convertFileSrc(local) : null, remote].filter(
      (s): s is string => Boolean(s)
    );
    if (sources.length === 0) return;
    const key = sources.join('\n');
    let answer = looked.get(key);
    if (!answer) {
      answer = lookAt(sources);
      looked.set(key, answer);
    }
    let current = true;
    void answer.then((url) => {
      if (current) setImage(url);
    });
    return () => {
      current = false;
    };
  }, [local, remote]);
  return image;
}

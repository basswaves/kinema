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

/**
 * The brightness above which a pixel is lettering to cut out, or null when the
 * logo is not light lettering on a plate. `pixels` is RGBA, as a canvas gives.
 */
export function letteringSplit(pixels: Uint8ClampedArray): number | null {
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
  const plate =
    between / variance >= TWO_TONE &&
    light >= LETTERING &&
    light - dark >= CONTRAST &&
    share >= SHARE_MIN &&
    share <= SHARE_MAX;
  // Cut halfway between the two, not at the histogram's split, which can sit
  // right against the plate's colour when nothing lies between them.
  return plate ? (dark + light) / 2 : null;
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
      if (split === null) return null;
      cutOut(data.data, split);
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

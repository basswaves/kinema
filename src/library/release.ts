/**
 * Where a file came from, as its name says: a UHD Blu-ray remux, a web
 * download from Netflix, a DVD rip, a whole disc image.
 *
 * This is the **one** badge taken from a name rather than from the file. What
 * a file holds — resolution, HDR, Dolby Vision, the audio format — is read
 * from the file itself (`probe.rs`), and a name claiming "DV" or "Atmos" is
 * never believed. But nothing inside a video says whether it was remuxed from
 * a disc or re-encoded from a stream; only the release name does. Auro-3D is
 * the other exception: it hides inside ordinary PCM, where no player on
 * Windows can see it, so the name is all there is.
 *
 * guessit reads the names — the same parser the scan uses, so "BluRay",
 * "Blu-ray", "BDRip" and "BD" all mean one thing here as they do there. A few
 * patterns it does not know are added below. The names are read in order, the
 * file's own first and then the folders above it, because a season pack keeps
 * its release name on the folder: `Show.S01.1080p.BluRay-GRP/Season 1/E01.mkv`.
 */
import { rawGuess } from './parse';

export interface Release {
  /** guessit's name for the source: `Ultra HD Blu-ray`, `Blu-ray`, `Web`… */
  source: string | null;
  /** The disc's own streams, untouched, in a new container. */
  remux: boolean;
  /** Re-encoded from a stream rather than downloaded as sent (WEBRip). */
  rip: boolean;
  /** A whole disc as one file (`.iso`). */
  disc: boolean;
  /** The streaming service a web release came from, as guessit names it. */
  service: string | null;
  /** Cuts and versions: `Director's Cut`, `Extended`, `IMAX Enhanced`… */
  editions: string[];
  auro3d: boolean;
}

/** guessit's answer for one name. Injected so tests can run without it. */
export type Guesser = (name: string) => Record<string, unknown>;

/** A tag guessit may give as one string or a list of them. */
function list(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

// Patterns guessit does not know. Bounded by the separators release names use,
// so a word inside a title cannot match.
const EDGE = String.raw`(?:^|[\s._\-\[\]()])`;
const END = String.raw`(?=$|[\s._\-\[\]()])`;
/** `BDRemux`, `UHD-Remux`: guessit misses the joined forms. */
const JOINED_REMUX = new RegExp(`${EDGE}(?:bd|uhd|bluray)-?remux${END}`, 'i');
const UHD = new RegExp(`${EDGE}(?:uhd|2160p|4k)${END}`, 'i');
const AURO_3D = new RegExp(`${EDGE}auro-?3d${END}`, 'i');
/** guessit reads "IMAX.Enhanced" as the IMAX edition and drops the rest. */
const IMAX_ENHANCED = new RegExp(`${EDGE}imax[\\s._-]?enhanced${END}`, 'i');

/**
 * Read a file's release from its name and the folders above it.
 *
 * `names` is the file's own name first, then its folder, then that folder's
 * folder — never the library folder itself, which is "Movies", not a release.
 */
export function readRelease(
  names: string[],
  extension: string,
  guess: Guesser = rawGuess
): Release {
  const release: Release = {
    source: null,
    remux: false,
    rip: false,
    disc: extension.toLowerCase() === 'iso',
    service: null,
    editions: [],
    auro3d: false,
  };

  for (const name of names) {
    const raw = guess(name);
    const other = list(raw.other);

    // The source and how it was treated come from the same name, the first
    // that says anything about it: a folder saying "BluRay.REMUX" must not be
    // paired with a file name saying "WEBRip".
    if (release.source === null) {
      const joinedRemux = JOINED_REMUX.test(name);
      const source = list(raw.source)[0] ?? null;
      if (source !== null) {
        release.source = source;
        release.remux = other.includes('Remux') || joinedRemux;
        release.rip = other.includes('Rip');
      } else if (joinedRemux) {
        release.source = UHD.test(name) ? 'Ultra HD Blu-ray' : 'Blu-ray';
        release.remux = true;
      }
    }

    release.service ??= list(raw.streaming_service)[0] ?? null;

    const editions = [...list(raw.edition), ...other.filter((o) => o === 'Open Matte')];
    for (let edition of editions) {
      if (edition === 'IMAX' && IMAX_ENHANCED.test(name)) edition = 'IMAX Enhanced';
      if (!release.editions.includes(edition)) release.editions.push(edition);
    }

    if (AURO_3D.test(name)) release.auro3d = true;
  }

  return release;
}

/** guessit's names for disc sources, as a badge says them. */
const DISC_SOURCES: Record<string, string> = {
  'Ultra HD Blu-ray': 'UHD Blu-ray',
  'Blu-ray': 'Blu-ray',
  'HD-DVD': 'HD DVD',
  DVD: 'DVD',
};

/** guessit's names for the rest, where the badge says it differently. */
const OTHER_SOURCES: Record<string, string> = {
  'Ultra HDTV': 'UHDTV',
  'Digital TV': 'TV',
  Camera: 'Cam',
};

/**
 * The source as one badge: `UHD Blu-ray remux`, `Blu-ray encode`,
 * `WEB-DL · Netflix`, `DVD disc`. `null` when the name says nothing.
 *
 * A disc source not remuxed and not a disc image has been re-encoded, whether
 * or not the name says "Rip": "BluRay.x265" is an encode of a Blu-ray.
 */
export function sourceLabel(release: Release): string | null {
  const { source } = release;
  if (source === null) return release.disc ? 'Disc image' : null;

  const disc = DISC_SOURCES[source];
  if (disc) {
    if (release.disc) return `${disc} disc`;
    return release.remux ? `${disc} remux` : `${disc} encode`;
  }

  if (source === 'Web') {
    const kind = release.rip ? 'WEBRip' : 'WEB-DL';
    return release.service ? `${kind} · ${release.service}` : kind;
  }

  return OTHER_SOURCES[source] ?? source;
}

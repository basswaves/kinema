/**
 * Reading mpv's chapter list.
 *
 * Same rule as `tracks.ts`: never `getProperty('chapter-list', 'node')`. The
 * node format deserialises a nested array-of-maps across the FFI boundary and
 * takes the whole process down with STATUS_ACCESS_VIOLATION — silently, from
 * JS. Every field is available as a flat indexed scalar, which is safe.
 */
import { readProperty } from './property';

export interface Chapter {
  /** Seconds from the start of the file. */
  time: number;
  title: string | null;
}

/** The file's chapters in order, or an empty list when it has none. */
export async function readChapters(): Promise<Chapter[]> {
  const count = (await readProperty<number>('chapters', 'int64')) ?? 0;

  // All at once, in index order — see `readTracks` for why.
  const read = async (i: number): Promise<Chapter | null> => {
    const [time, title] = await Promise.all([
      readProperty<number>(`chapter-list/${i}/time`, 'double'),
      readProperty<string>(`chapter-list/${i}/title`, 'string'),
    ]);
    // A chapter with no start time is not usable for anything here. Its title
    // may still be missing, which is ordinary — most remuxes number chapters
    // rather than naming them.
    if (time === null || Number.isNaN(time)) return null;
    return { time, title };
  };

  const chapters = await Promise.all(Array.from({ length: count }, (_, i) => read(i)));
  return chapters.filter((c): c is Chapter => c !== null);
}

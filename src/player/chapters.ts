/**
 * Reading mpv's chapter list.
 *
 * Same rule as `tracks.ts`: never `getProperty('chapter-list', 'node')`. The
 * node format deserialises a nested array-of-maps across the FFI boundary and
 * takes the whole process down with STATUS_ACCESS_VIOLATION — silently, from
 * JS. Every field is available as a flat indexed scalar, which is safe.
 */
import { getProperty } from 'tauri-plugin-libmpv-api';

export interface Chapter {
  /** Seconds from the start of the file. */
  time: number;
  title: string | null;
}

async function safeGet<T>(name: string, format: 'string' | 'int64' | 'double'): Promise<T | null> {
  try {
    return (await getProperty(name, format)) as T | null;
  } catch {
    return null;
  }
}

/** The file's chapters in order, or an empty list when it has none. */
export async function readChapters(): Promise<Chapter[]> {
  const count = (await safeGet<number>('chapters', 'int64')) ?? 0;
  const chapters: Chapter[] = [];

  for (let i = 0; i < count; i++) {
    const time = await safeGet<number>(`chapter-list/${i}/time`, 'double');
    // A chapter with no start time is not usable for anything here. Its title
    // may still be missing, which is ordinary — most remuxes number chapters
    // rather than naming them.
    if (time === null || Number.isNaN(time)) continue;
    chapters.push({
      time,
      title: await safeGet<string>(`chapter-list/${i}/title`, 'string'),
    });
  }

  return chapters;
}

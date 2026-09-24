/**
 * Read one mpv property as a flat scalar, or null when it is unavailable.
 *
 * Shared by the track list, the chapter list and the stats panel, which each
 * used to carry their own copy. Scalars only, on purpose: the `node` format is
 * the one that takes the process down (docs/GOTCHAS.md).
 */
import { getProperty } from 'tauri-plugin-libmpv-api';

export type ScalarFormat = 'string' | 'int64' | 'double' | 'flag';

export async function readProperty<T>(name: string, format: ScalarFormat): Promise<T | null> {
  try {
    return ((await getProperty(name, format)) ?? null) as T | null;
  } catch {
    return null;
  }
}

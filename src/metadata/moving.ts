/**
 * Moving to a new computer — the typed side of `src-tauri/src/moving.rs`.
 * One file holds the history, resume points, hand-made matches, playlists,
 * My list and the settings that describe the person; never a sign-in, a key
 * or this computer's devices. Taking it in sends nothing to SIMKL or Trakt.
 */
import { invoke } from '@tauri-apps/api/core';
import { applyMatch, loadProviderKeys, type Provider } from './match';

export interface MoveReport {
  history: number;
  chosen: number;
  hand_applied: number;
  hand_waiting: number;
  playlists: number;
  settings: number;
}

interface ReadyMatch {
  file_ids: number[];
  file_name: string;
  size_bytes: number;
  kind: string;
  provider: string;
  provider_id: string;
  reason: string;
}

/** Write the file; answers how many history rows it holds. */
export const exportMove = (path: string) => invoke<number>('export_move', { path });

export const importMove = (path: string) => invoke<MoveReport>('import_move', { path });

/**
 * Matches made by hand on the other computer whose files are here now: each
 * is fetched and stored as the person chose it there. Run after a move and
 * after every scan, so files added later still get theirs. Returns how many.
 */
export async function applyMovedMatches(): Promise<number> {
  const ready = await invoke<ReadyMatch[]>('moved_matches_ready');
  if (ready.length === 0) return 0;
  const keys = await loadProviderKeys();
  let applied = 0;
  for (const m of ready) {
    try {
      await applyMatch(
        m.file_ids.map((id) => ({ id })),
        m.provider as Provider,
        m.provider_id,
        m.kind === 'series',
        keys,
        1,
        m.reason
      );
      applied++;
      await invoke('moved_match_done', { fileName: m.file_name, sizeBytes: m.size_bytes });
    } catch {
      // Kept waiting: no key yet, or offline. The next scan tries again.
    }
  }
  return applied;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What taking the file in did, in a sentence. */
export function moveWords(r: MoveReport): string {
  const parts = [
    `${n(r.history, 'watched or begun film or episode', 'watched or begun films and episodes')}`,
    `${n(r.playlists, 'playlist', 'playlists')}`,
    `${n(r.settings, 'setting', 'settings')}`,
  ];
  if (r.chosen > 0) parts.push(`${r.chosen} from My list, chosen versions and posters`);
  if (r.hand_applied > 0) parts.push(`${n(r.hand_applied, 'file', 'files')} set aside by hand`);
  let words = `Taken in: ${parts.join(', ')}.`;
  if (r.hand_waiting > 0) {
    words += ` ${n(r.hand_waiting, 'match made by hand waits', 'matches made by hand wait')} for ${
      r.hand_waiting === 1 ? 'its file' : 'their files'
    } to be found by a scan.`;
  }
  return `${words} Sign in to SIMKL or Trakt again here; nothing is sent twice.`;
}

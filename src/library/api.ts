/** Typed wrappers around the Rust library commands. */
import { invoke } from '@tauri-apps/api/core';

export type LibraryKind = 'movies' | 'tv';

export interface LibraryRoot {
  id: number;
  path: string;
  kind: LibraryKind;
  file_count: number;
}

export interface MediaFile {
  id: number;
  path: string;
  parent_dir: string;
  file_name: string;
  size_bytes: number;
  missing: boolean;
  match_status: string;
  parsed_title: string | null;
  parsed_year: number | null;
  parsed_season: number | null;
  parsed_episode: number | null;
  parsed_kind: string | null;
  parsed_from: string | null;
  title_id: number | null;
  match_confidence: number | null;
  match_reason: string | null;
  matched_title: string | null;
  episode_name: string | null;
}

export interface ScanReport {
  roots_scanned: number;
  files_seen: number;
  files_added: number;
  files_updated: number;
  files_unchanged: number;
  files_missing: number;
  errors: string[];
  duration_ms: number;
}

export interface LibraryStats {
  total: number;
  unparsed: number;
  parsed: number;
  missing: number;
  total_bytes: number;
}

export interface ParseResultPayload {
  id: number;
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  kind: string | null;
  from: string | null;
  raw_json: string | null;
}

export const addLibraryRoot = (path: string, kind: LibraryKind) =>
  invoke<number>('add_library_root', { path, kind });

export const removeLibraryRoot = (id: number) => invoke<void>('remove_library_root', { id });

export const listLibraryRoots = () => invoke<LibraryRoot[]>('list_library_roots');

export const scanLibrary = () => invoke<ScanReport>('scan_library');

export const listUnparsed = (limit: number) => invoke<MediaFile[]>('list_unparsed', { limit });

/** Settings keys and defaults for running the user's own Skiptro install. */
export const SKIPTRO_PATH_KEY = 'skiptro_path';
export const SKIPTRO_SCAN_ARGS_KEY = 'skiptro_scan_args';
export const SKIPTRO_EXPORT_ARGS_KEY = 'skiptro_export_args';
/** Where Skiptro's own database lives, when it is not in the usual place. */
export const SKIPTRO_DB_PATH_KEY = 'skiptro_db_path';
export const DEFAULT_SKIPTRO_SCAN_ARGS = 'scan {dir}';
/**
 * Empty on purpose: no export step, so no sidecars.
 *
 * The app reads Skiptro's own database now, which is where the detections were
 * all along. Exporting only wrote a redundant `.skiptro.json` next to every
 * episode. Anyone who wants them — to feed another player from the same scan —
 * types `export {dir}` back into the field.
 */
export const DEFAULT_SKIPTRO_EXPORT_ARGS = '';

/** Setting key: `'off'` stops the app asking TheIntroDB anything. */
export const INTRODB_ENABLED_KEY = 'introdb_enabled';

export interface DetectStepReport {
  step: string;
  exit_code: number | null;
  tail: string[];
}

export interface DetectReport {
  ok: boolean;
  steps: DetectStepReport[];
}

/** One line of Skiptro's output, as it arrives. */
export interface DetectProgress {
  step: string;
  line: string;
}

/**
 * Run the user's own Skiptro over a library root.
 *
 * Detection only, by default: the app reads Skiptro's database directly, so
 * the export step is empty unless the sidecars are wanted for something else.
 */
export const detectIntros = (rootPath: string) =>
  invoke<DetectReport>('detect_intros', { rootPath });

export const listMediaFiles = (limit: number) => invoke<MediaFile[]>('list_media_files', { limit });

export const saveParseResults = (results: ParseResultPayload[]) =>
  invoke<number>('save_parse_results', { results });

export const resetParse = () => invoke<number>('reset_parse');

export const libraryStats = () => invoke<LibraryStats>('library_stats');

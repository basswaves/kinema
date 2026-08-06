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

export const listMediaFiles = (limit: number) => invoke<MediaFile[]>('list_media_files', { limit });

export const saveParseResults = (results: ParseResultPayload[]) =>
  invoke<number>('save_parse_results', { results });

export const resetParse = () => invoke<number>('reset_parse');

export const libraryStats = () => invoke<LibraryStats>('library_stats');

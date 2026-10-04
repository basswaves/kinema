/**
 * Choosing a library folder, on every system.
 *
 * Where the system has a folder picker of its own (Windows, Linux) that is
 * what opens. Where it has none — Android, whose TV boxes often lack one, and
 * whose picker would answer in its document system rather than with a folder
 * Kinema can read by path — Kinema shows the folders itself
 * (`FolderBrowser.tsx`): the drives Android has mounted, a USB drive or the
 * device's own storage, then the folders inside, chosen with a remote.
 *
 * Every caller asks the same way, `chooseFolder`, and gets a path or null.
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSyncExternalStore } from 'react';
import { capabilitiesNow } from '../capabilities';

/** A drive Android has mounted (StoragePlugin.kt). */
export interface Place {
  path: string;
  /** Android's own name for it: "SanDisk USB drive", "Internal shared storage". */
  name: string;
  /** A USB drive or a card, rather than the device's own storage. */
  removable: boolean;
}

/** What is in a folder (places.rs). */
export interface Listing {
  folders: string[];
  /** Videos directly inside it. */
  videos: number;
}

/**
 * What Kinema may read (StoragePlugin.kt). `read` covers the films;
 * `allFiles` the subtitles and .nfo files beside them, from Android 11 —
 * `off` where the device can grant it, `unavailable` where it cannot, and
 * `not-needed` where `read` already covers every file.
 */
export interface Access {
  read: 'granted' | 'prompt';
  allFiles: 'granted' | 'off' | 'unavailable' | 'not-needed';
}

export const storagePlaces = (): Promise<Place[]> =>
  invoke<{ places: Place[] }>('plugin:storage|places').then((r) => r.places);
export const storageAccess = (): Promise<Access> => invoke<Access>('plugin:storage|access');
export const requestStorageAccess = (): Promise<Access> =>
  invoke<Access>('plugin:storage|request_access');
export const allowAllFiles = (): Promise<Access> => invoke<Access>('plugin:storage|allow_all_files');
export const listFolders = (path: string): Promise<Listing> =>
  invoke<Listing>('list_folders', { path });

/** A question the folder browser is answering: what for, and who waits. */
export interface FolderRequest {
  /** What the folder is for, in the heading: "movies", "TV". */
  what: string;
  answer: (path: string | null) => void;
}

let request: FolderRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * A folder, or null if none was chosen. Kinema's own browser only where the
 * system answers that it has no picker: a system that gave no answer keeps
 * the picker every desktop has always had.
 */
export async function chooseFolder(what: string): Promise<string | null> {
  if (capabilitiesNow()?.folder_picker !== false) {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === 'string' ? selected : null;
  }
  // A second request while one is open replaces it, answering the first
  // with nothing: one browser on screen, one caller waiting.
  request?.answer(null);
  return new Promise((resolve) => {
    request = {
      what,
      answer: (path) => {
        request = null;
        emit();
        resolve(path);
      },
    };
    emit();
  });
}

/** The open question, for the one place that shows the browser (App.tsx). */
export function useFolderRequest(): FolderRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request
  );
}

/**
 * Signs Kinema in to a network server it opens itself (netshare.rs), for
 * this session: `server` as an address names it (`nas`, or `nas:4450` off
 * SMB's own port), an empty `user` is a guest.
 */
export const signInShare = (server: string, user: string, password: string) =>
  invoke<void>('sign_in_share', { server, user, password });

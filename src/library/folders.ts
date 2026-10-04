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

/** A drive Android has mounted (StoragePlugin.kt), or a share on a server. */
export interface Place {
  path: string;
  /** Android's own name for it: "SanDisk USB drive", "Internal shared storage". */
  name: string;
  /** A USB drive or a card, rather than the device's own storage. */
  removable: boolean;
  /** For a share Kinema opens itself (`smb://…`): the server it is on. */
  server?: Server;
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

/** A network server Kinema keeps a sign-in for (share_logins.rs). */
export interface ShareLogin {
  server: string;
  user: string;
}

/**
 * Signs in to a network server Kinema opens itself (`nas`, or `nas:4450` off
 * SMB's own port) and keeps the sign-in if the server accepts it — locked
 * with the device's key store. Rejects with words for people when it does
 * not. `kept` is false where the sign-in could not be
 * locked, and lasts until Kinema closes.
 */
export const saveShareLogin = (server: string, user: string, password: string) =>
  invoke<{ kept: boolean }>('save_share_login', { server, user, password });
export const forgetShareLogin = (server: string) =>
  invoke<void>('forget_share_login', { server });
export const shareLogins = () => invoke<ShareLogin[]>('share_logins');

/** A file server that announced itself on the network (NetworkPlugin.kt). */
export interface Server {
  name: string;
  /** Its address, which is what Kinema connects to. */
  host: string;
}

/** The file servers that announce themselves; takes a few seconds. */
export const findServers = (): Promise<Server[]> =>
  invoke<{ servers: Server[] }>('plugin:network|find_servers').then((r) => r.servers);

/** Whether a file server answers at an address; rejects in words if not. */
export const checkServer = (server: string) => invoke<void>('check_server', { server });

/** A server's shares; rejects in words if it cannot say (netshare.rs). */
export const listShares = (server: string) => invoke<string[]>('list_shares', { server });

/**
 * Installing ffmpeg with one press (Windows, `installs_ffmpeg`): the state of
 * the one install, shared by the three places that offer it — the extras
 * setup page, Home's ffmpeg notice and Settings — so a press in one is seen
 * in the others, and a second press anywhere cannot start a second install.
 *
 * Kinema downloads nothing itself: the press asks Windows' own package
 * manager, winget, to install Gyan's ffmpeg build (ffmpeg_install.rs). The
 * words beside the button say exactly that before anyone presses it, because
 * pressing it is the person agreeing ("Kinema never lies").
 *
 * After a successful install the three stages that need ffmpeg run at once
 * in the background (pipeline.ts `runFfmpegPasses`), rather than at the next
 * start.
 */
import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  FFMPEG_PATH_KEY,
  installFfmpeg,
  type FfmpegInstallProgress,
  type FfmpegInstallReport,
} from '../library/api';
import { runFfmpegPasses } from '../library/pipeline';
import { getSetting } from '../metadata/api';
import { userError } from './errors';

/** What will happen, said before the press. The size is Gyan's Essentials zip (9.0.1: 111 MB). */
export const FFMPEG_INSTALL_WORDS =
  'Kinema can install it for you with Windows’ own app installer (winget): the Windows build ' +
  'from gyan.dev that ffmpeg’s own site points to, a download of about 110 MB. It stays ' +
  'installed if Kinema is ever removed, as other programs may use it.';

export const FFMPEG_DOWNLOAD_URL = 'https://ffmpeg.org/download.html';

export interface FfmpegInstallState {
  running: boolean;
  /** The install's latest step, in plain words, while it runs. */
  line: string | null;
  /** How the last install ended; null before one. */
  report: FfmpegInstallReport | null;
  /** Kinema refused or could not ask (a film playing, one already running). */
  error: string | null;
}

let state: FfmpegInstallState = { running: false, line: null, report: null, error: null };
const listeners = new Set<() => void>();

function set(next: FfmpegInstallState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useFfmpegInstall(): FfmpegInstallState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state
  );
}

/** Whether the install ended with an ffmpeg Kinema can run. */
export function ffmpegInstalled(report: FfmpegInstallReport | null): boolean {
  return (
    report !== null &&
    (report.outcome === 'installed' || report.outcome === 'already_installed') &&
    report.ffmpeg.available
  );
}

/** Start the install, unless one is running. Resolves when it has ended. */
export async function startFfmpegInstall(): Promise<void> {
  if (state.running) return;
  set({ running: true, line: 'Starting', report: null, error: null });
  const off = listen<FfmpegInstallProgress>('ffmpeg-install-progress', (event) => {
    if (state.running) set({ ...state, line: event.payload.line });
  });
  try {
    const configured = ((await getSetting(FFMPEG_PATH_KEY)) ?? '').trim();
    const report = await installFfmpeg(configured);
    set({ running: false, line: null, report, error: null });
    if (ffmpegInstalled(report)) void runFfmpegPasses();
  } catch (e) {
    set({ running: false, line: null, report: null, error: userError(e) });
  } finally {
    void off.then((stop) => stop());
  }
}

/**
 * Send a report (report.rs): the logs and the equipment check in one zip in
 * Downloads, shown in the file manager, then the bug-report form in the
 * browser. Kinema sends nothing itself; the user attaches the file.
 * Desktop only — Android has Share the log.
 */
import { invoke } from '@tauri-apps/api/core';
import { openLink } from './links';

export const BUG_REPORT_FORM = 'https://github.com/Basswaves/kinema/issues/new?template=bug_report.yml';

/** Said before the press: what goes in, and what does not happen. */
export const REPORT_WORDS =
  'Send a report packs Kinema’s logs from this session and the last (app.log, mpv.log) and the ' +
  'equipment check (screens, sound devices, graphics card) into one zip in your Downloads ' +
  'folder. Your home folder’s name is replaced by ~; film and folder names stay, as they are ' +
  'often the bug. Kinema sends nothing: the bug-report form opens in your browser, and you ' +
  'attach the file there.';

export interface Report {
  path: string;
  files: string[];
}

/** Pack the zip, then open the form. The form opens even if packing failed. */
export async function sendReport(): Promise<Report> {
  try {
    return await invoke<Report>('make_report');
  } finally {
    void openLink(BUG_REPORT_FORM);
  }
}

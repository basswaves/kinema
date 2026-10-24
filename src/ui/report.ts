/**
 * Send a report (report.rs): the logs and the equipment check in one zip in
 * Downloads. Kinema sends nothing itself; the user attaches the file to the
 * bug-report form. The press only saves the zip and says where it is — the
 * form and the file manager open on their own presses, because the browser
 * opening at once covered the note saying which file to attach (owner,
 * 2026-10-24). Desktop only — Android has Share the log.
 */
import { invoke } from '@tauri-apps/api/core';
import { openLink } from './links';

export const BUG_REPORT_FORM = 'https://github.com/Basswaves/kinema/issues/new?template=bug_report.yml';

/** Said before the press: what goes in, and what does not happen. */
export const REPORT_WORDS =
  'Send a report packs Kinema’s logs from this session and the last (app.log, mpv.log) and the ' +
  'equipment check (screens, sound devices, graphics card) into one zip in your Downloads ' +
  'folder. Your home folder’s name is replaced by ~; film and folder names stay, as they are ' +
  'often the bug. Kinema sends nothing: it says where the file is, then you open the ' +
  'bug-report form and attach the file there.';

export interface Report {
  path: string;
  files: string[];
}

/** Pack and save the zip. Opens nothing. */
export function makeReport(): Promise<Report> {
  return invoke<Report>('make_report');
}

/** Select the saved zip in the file manager. */
export function showReport(path: string): Promise<void> {
  return invoke('show_report', { path });
}

export function openReportForm(): Promise<void> {
  return openLink(BUG_REPORT_FORM);
}

/** The file's name and the folder it is in, as the file manager shows them. */
export function splitReportPath(path: string): { name: string; folder: string } {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return at < 0 ? { name: path, folder: '' } : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/** What is said once the zip is saved: which file, where, and what to do with it. */
export function reportSaved(made: Report): string {
  const { name, folder } = splitReportPath(made.path);
  return (
    `Saved ${name} in ${folder || 'Kinema’s data folder'} (${made.files.join(', ')}). ` +
    'Open the report form, describe what happened, and attach this file to it.'
  );
}

/** Send a report says which file to attach, and opens nothing by itself. */
import { describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) =>
    command === 'make_report'
      ? { path: 'C:\\Users\\you\\Downloads\\kinema-report-1.zip', files: ['app.log', 'mpv.log'] }
      : null
  ),
}));
vi.mock('./links', () => ({ openLink: vi.fn(async (url: string) => void opened.push(url)) }));

const { makeReport, reportSaved, splitReportPath } = await import('./report');

describe('Send a report', () => {
  it('saves the zip without opening the form', async () => {
    const made = await makeReport();
    expect(made.path).toMatch(/kinema-report-1\.zip$/);
    expect(opened).toEqual([]);
  });

  it('names the file and its folder, and says to attach it', () => {
    const said = reportSaved({
      path: 'C:\\Users\\you\\Downloads\\kinema-report-1.zip',
      files: ['app.log', 'mpv.log'],
    });
    expect(said).toMatch(/^Saved kinema-report-1\.zip in C:\\Users\\you\\Downloads \(app\.log, mpv\.log\)/);
    expect(said).toMatch(/attach this file/);
  });

  it('splits a Linux path too', () => {
    expect(splitReportPath('/home/you/Downloads/r.zip')).toEqual({
      name: 'r.zip',
      folder: '/home/you/Downloads',
    });
  });
});

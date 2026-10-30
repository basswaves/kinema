import { describe, expect, it } from 'vitest';
import { reportWords, type ImportReport } from './importWatched';

const report = (over: Partial<ImportReport>): ImportReport => ({
  read: 0,
  watched: 0,
  resume: 0,
  kept: 0,
  not_in_library: [],
  unclear: [],
  queued: 0,
  ...over,
});

describe('reportWords', () => {
  it('says when nothing was there', () => {
    expect(reportWords(report({}))).toBe('Nothing watched or begun was found there.');
  });

  it('counts what was taken and what was left alone', () => {
    const words = reportWords(
      report({ read: 4, watched: 1, resume: 2, not_in_library: ['A (1999)'], unclear: [] })
    );
    expect(words).toContain('1 film or episode marked watched');
    expect(words).toContain('2 resume points taken');
    expect(words).toContain('1 could not be matched exactly');
  });

  it('mentions SIMKL only when something was queued for it', () => {
    expect(reportWords(report({ read: 1, watched: 1 }))).not.toContain('SIMKL');
    expect(reportWords(report({ read: 1, watched: 1, queued: 1 }))).toContain('SIMKL once');
  });
});

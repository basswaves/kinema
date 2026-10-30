import { describe, expect, it } from 'vitest';
import { creditLines, fileInfoRows, secondsLeft, showStatusLine, todayString } from './aboutTitle';
import type { About } from './api';
import type { FileFacts } from './badges';

const none: About = {
  directors: [],
  writers: [],
  collection_name: null,
  collection: [],
  show_status: null,
  next_air_date: null,
  next_air_season: null,
  next_air_episode: null,
};

describe('the credits line', () => {
  it('says nothing for a title with no TMDB credits', () => {
    expect(creditLines(none, 'movie')).toEqual([]);
  });

  it('names a film’s directors and writers, and a show’s creators', () => {
    expect(creditLines({ ...none, directors: ['A'], writers: ['B', 'C', 'D'] }, 'movie')).toEqual([
      'Directed by A',
      'Written by B, C and D',
    ]);
    expect(creditLines({ ...none, directors: ['E', 'F'] }, 'series')).toEqual(['Created by E and F']);
  });
});

describe('a show’s state', () => {
  const today = '2026-10-30';

  it('names the next season or episode while its date is ahead', () => {
    const next = { ...none, show_status: 'Returning Series', next_air_date: '2026-11-12' };
    expect(showStatusLine({ ...next, next_air_season: 3, next_air_episode: 1 }, today)).toMatch(
      /^Season 3 airs .*2026/
    );
    expect(showStatusLine({ ...next, next_air_season: 2, next_air_episode: 5 }, today)).toMatch(
      /^S2 E5 airs /
    );
  });

  it('does not show a date that has passed', () => {
    const passed = { ...none, show_status: 'Returning Series', next_air_date: '2026-10-01' };
    expect(showStatusLine({ ...passed, next_air_season: 3, next_air_episode: 1 }, today)).toBe(
      'Returning series'
    );
  });

  it('says ended or cancelled, and nothing when TMDB said nothing', () => {
    expect(showStatusLine({ ...none, show_status: 'Ended' }, today)).toBe('Ended');
    expect(showStatusLine({ ...none, show_status: 'Canceled' }, today)).toBe('Cancelled');
    expect(showStatusLine(none, today)).toBeNull();
  });

  it('writes today as TMDB does', () => {
    expect(todayString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('what is left to watch', () => {
  it('is the runtime, less the resume point or share', () => {
    expect(secondsLeft(100, null, null)).toBe(6000);
    expect(secondsLeft(100, 1000, null)).toBe(5000);
    expect(secondsLeft(100, null, 0.25)).toBe(4500);
    expect(secondsLeft(null, 10, null)).toBeNull();
  });
});

describe('the file’s details', () => {
  const facts: FileFacts = {
    details: {
      container: 'matroska,webm',
      duration_secs: 6000,
      bit_rate: 24_500_000,
      video: null,
      audio: [
        { language: 'eng' },
        { language: 'en' },
        { language: 'nor' },
      ] as never,
      subtitles: [{ language: null }] as never,
    },
    picture_aspect: null,
    picture_aspect_alt: null,
    file_name: 'Film (2001).mkv',
    parent_dir: 'D:/Films/Film (2001)',
    extension: 'mkv',
    root_path: 'D:/Films',
    size_bytes: 3 * 1024 ** 3,
  };

  it('lists name, folder, size, container, bitrate and languages once each', () => {
    expect(fileInfoRows(facts)).toEqual([
      { heading: 'File', value: 'Film (2001).mkv' },
      { heading: 'Folder', value: 'D:/Films/Film (2001)' },
      { heading: 'Size', value: '3.0 GB' },
      { heading: 'Container', value: 'Matroska (MKV)' },
      { heading: 'Bitrate', value: '24.5 Mb/s' },
      { heading: 'Audio', value: 'English, Norwegian' },
    ]);
  });

  it('without a probe still names the file and its kind', () => {
    expect(fileInfoRows({ ...facts, details: null, size_bytes: undefined })).toEqual([
      { heading: 'File', value: 'Film (2001).mkv' },
      { heading: 'Folder', value: 'D:/Films/Film (2001)' },
      { heading: 'Container', value: 'MKV' },
    ]);
  });
});

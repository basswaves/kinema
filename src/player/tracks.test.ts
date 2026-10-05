import { describe, expect, it } from 'vitest';
import { canonicalLang, languageName, sameLanguage } from './language';
import type { Track } from './engine';
import { describeTrack, findTrackByLang } from './tracks';

const track = (fields: Partial<Track>): Track => ({
  id: 1,
  type: 'audio',
  selected: false,
  forced: false,
  external: false,
  default: false,
  ...fields,
});

describe('language codes', () => {
  it('reduces every spelling of a language to one', () => {
    expect(canonicalLang('eng')).toBe('en');
    expect(canonicalLang('ger')).toBe('de');
    expect(canonicalLang('deu')).toBe('de');
    expect(canonicalLang('nb-NO')).toBe('no');
    expect(canonicalLang('nob')).toBe('no');
    expect(canonicalLang('nor')).toBe('no');
  });

  it('treats "no language" tags as unknown', () => {
    expect(canonicalLang('und')).toBeNull();
    expect(canonicalLang('qaa')).toBeNull();
    expect(canonicalLang('')).toBeNull();
    expect(canonicalLang(undefined)).toBeNull();
  });

  it('names languages in English', () => {
    expect(languageName('eng')).toBe('English');
    expect(languageName('nor')).toBe('Norwegian');
    expect(sameLanguage('nob', 'nor')).toBe(true);
    expect(sameLanguage('eng', 'nor')).toBe(false);
  });
});

describe('describeTrack', () => {
  it('reads like a disc box for audio', () => {
    expect(
      describeTrack(track({ lang: 'eng', codec: 'truehd', channels: 8, profile: 'Dolby TrueHD + Dolby Atmos' }))
    ).toBe('English · 7.1 · Dolby TrueHD Atmos');
    expect(describeTrack(track({ lang: 'eng', codec: 'dts', channels: 8, profile: 'DTS-HD MA' }))).toBe(
      'English · 7.1 · DTS-HD Master Audio'
    );
    expect(describeTrack(track({ lang: 'nor', codec: 'aac', channels: 2 }))).toBe(
      'Norwegian · Stereo · AAC'
    );
  });

  it('reads the same from what Media3 says (Android): two-letter languages, its DTS and Atmos', () => {
    expect(
      describeTrack(track({ lang: 'en', codec: 'eac3', channels: 6, profile: 'Dolby Digital Plus + Dolby Atmos' }))
    ).toBe('English · 5.1 · Dolby Digital Plus Atmos');
    expect(describeTrack(track({ lang: 'nb', codec: 'dts', channels: 6, profile: 'DTS-HD' }))).toBe(
      'Norwegian · 5.1 · DTS-HD'
    );
  });

  it('keeps a title that says something new, and drops one that repeats the line', () => {
    expect(
      describeTrack(track({ lang: 'eng', codec: 'ac3', channels: 2, title: 'Commentary with the director' }))
    ).toBe('English · Stereo · Dolby Digital · Commentary with the director');
    expect(describeTrack(track({ lang: 'eng', codec: 'ac3', channels: 6, title: 'English DD 5.1' }))).toBe(
      'English · 5.1 · Dolby Digital'
    );
  });

  it('marks forced and SDH subtitles, without the codec', () => {
    expect(describeTrack(track({ type: 'sub', lang: 'nor', codec: 'hdmv_pgs_subtitle', forced: true }))).toBe(
      'Norwegian · Forced'
    );
    expect(describeTrack(track({ type: 'sub', lang: 'eng', codec: 'subrip', title: 'English SDH' }))).toBe(
      'English · SDH'
    );
    expect(describeTrack(track({ type: 'sub', codec: 'subrip', external: true }))).toBe('separate file');
  });
});

describe('findTrackByLang', () => {
  it('finds a Norwegian track whatever it is tagged', () => {
    const tracks = [track({ id: 1, type: 'sub', lang: 'eng' }), track({ id: 2, type: 'sub', lang: 'nor' })];
    expect(findTrackByLang(tracks, 'sub', 'nb-NO')?.id).toBe(2);
    expect(findTrackByLang(tracks, 'sub', 'nob')?.id).toBe(2);
  });
});

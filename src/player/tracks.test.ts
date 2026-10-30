import { describe, expect, it } from 'vitest';
import { canonicalLang, languageName, sameLanguage } from './language';
import type { Track } from './engine';
import {
  describeTrack,
  describeTracks,
  findTrackByLang,
  languageFromFileName,
  secondChoices,
  secondTrackFor,
} from './tracks';

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

  it('marks forced and SDH subtitles, and ends on the format word', () => {
    expect(describeTrack(track({ type: 'sub', lang: 'nor', codec: 'hdmv_pgs_subtitle', forced: true }))).toBe(
      'Norwegian · Forced · PGS'
    );
    expect(describeTrack(track({ type: 'sub', lang: 'eng', codec: 'subrip', title: 'English SDH' }))).toBe(
      'English · SDH · SRT'
    );
    expect(describeTrack(track({ type: 'sub', codec: 'dvd_subtitle', lang: 'fre' }))).toBe('French · VobSub');
    expect(describeTrack(track({ type: 'sub', codec: 'webvtt', lang: 'eng' }))).toBe('English · WebVTT');
    expect(describeTrack(track({ type: 'sub', codec: 'ass', lang: 'jpn', title: 'Signs & songs' }))).toBe(
      'Japanese · Signs & songs · ASS'
    );
    expect(describeTrack(track({ type: 'sub', codec: 'subrip', external: true }))).toBe('separate file · SRT');
  });

  it("says a separate file's language from mpv, else its name's tag, else its name", () => {
    const file = (name: string, fields: Partial<Track> = {}) =>
      describeTrack(
        track({ type: 'sub', codec: 'subrip', external: true, title: name, externalFilename: `C:/films/${name}`, ...fields })
      );
    expect(file('Film.en.srt', { lang: 'en' })).toBe('English · separate file · SRT');
    expect(file('Film.English.srt')).toBe('English · separate file · SRT');
    expect(file('Film.no.forced.srt', { forced: true })).toBe('Norwegian · Forced · separate file · SRT');
    expect(file('Film.Deutsch.srt')).toBe('German · separate file · SRT');
    // Nothing that reads as a language: the name, never a guess.
    expect(file('Some.Film.2010.1080p.srt')).toBe('Some.Film.2010.1080p.srt · separate file · SRT');
    expect(file('Film.GRP.srt')).toBe('Film.GRP.srt · separate file · SRT');
  });

  it('reads only the last dotted tag of a name as its language', () => {
    expect(languageFromFileName('Film.eng.sdh.srt')).toBe('eng');
    expect(languageFromFileName('Film.pt-BR.srt')).toBe('pt-br');
    expect(languageFromFileName('The.Italian.Job.srt')).toBeNull();
    expect(languageFromFileName('English.srt')).toBeNull();
  });
});

describe('findTrackByLang', () => {
  it('finds a Norwegian track whatever it is tagged', () => {
    const tracks = [track({ id: 1, type: 'sub', lang: 'eng' }), track({ id: 2, type: 'sub', lang: 'nor' })];
    expect(findTrackByLang(tracks, 'sub', 'nb-NO')?.id).toBe(2);
    expect(findTrackByLang(tracks, 'sub', 'nob')?.id).toBe(2);
  });
});

describe('describeTracks', () => {
  it('tells alike tracks apart by what the file holds', () => {
    const lines = describeTracks([
      track({ id: 1, type: 'sub', lang: 'ger', codec: 'hdmv_pgs_subtitle' }),
      track({ id: 2, type: 'sub', lang: 'ger', codec: 'subrip' }),
      track({ id: 3, type: 'sub', lang: 'ita', codec: 'hdmv_pgs_subtitle' }),
      track({ id: 4, type: 'sub', lang: 'ita', codec: 'hdmv_pgs_subtitle' }),
      track({ id: 5, type: 'sub', lang: 'eng', codec: 'subrip' }),
    ]);
    expect(lines.get(1)).toBe('German · PGS');
    expect(lines.get(2)).toBe('German · SRT');
    expect(lines.get(3)).toBe('Italian · PGS · track 3');
    expect(lines.get(4)).toBe('Italian · PGS · track 4');
    expect(lines.get(5)).toBe('English · SRT');
    // A format with no word of its own still says what kind it is.
    const odd = describeTracks([
      track({ id: 1, type: 'sub', lang: 'ger', codec: 'xsub' }),
      track({ id: 2, type: 'sub', lang: 'ger', codec: 'text' }),
    ]);
    expect(odd.get(1)).toBe('German · picture subtitles');
  });
});

describe('second subtitles', () => {
  const subs = [
    track({ id: 1, type: 'sub', lang: 'eng', codec: 'subrip' }),
    track({ id: 2, type: 'sub', lang: 'nor', codec: 'hdmv_pgs_subtitle' }),
    track({ id: 3, type: 'sub', lang: 'nor', codec: 'subrip' }),
    track({ id: 1, type: 'audio', lang: 'eng' }),
  ];

  it('offers text tracks other than the first, never pictures or sound', () => {
    expect(secondChoices(subs, 1).map((t) => t.id)).toEqual([3]);
    expect(secondChoices(subs, null).map((t) => t.id)).toEqual([1, 3]);
  });

  it('finds the remembered language among them, or none', () => {
    expect(secondTrackFor(subs, 'no', 1)?.id).toBe(3);
    expect(secondTrackFor(subs, 'en', 1)).toBeNull();
    expect(secondTrackFor(subs, null, 1)).toBeNull();
  });
});

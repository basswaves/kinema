import { describe, expect, it } from 'vitest';
import { coverageNote, describeOffer, searchLanguages, subtitleTitle, type Offer } from './onlineSubtitles';

describe('searchLanguages', () => {
  it('offers the wanted language, then the spoken one, then English, once each', () => {
    expect(searchLanguages('nb-NO', 'eng')).toEqual(['no', 'en']);
    expect(searchLanguages('no', 'jpn')).toEqual(['no', 'ja', 'en']);
    expect(searchLanguages('en', 'eng')).toEqual(['en']);
  });

  it('skips what is not a language', () => {
    expect(searchLanguages(null, 'und')).toEqual(['en']);
  });
});

describe('describeOffer', () => {
  const offer: Offer = {
    file_id: 1,
    language: 'no',
    release: 'Example.Release.1080p',
    downloads: 10,
    matches_file: true,
    hearing_impaired: true,
    forced: false,
    translated: false,
    trusted: true,
  };

  it('says the language, whether it fits this file, and the release', () => {
    expect(describeOffer(offer)).toBe(
      'Norwegian · timed for this file · SDH — Example.Release.1080p'
    );
  });

  it('warns about machine translation and a missing release name', () => {
    const machine = { ...offer, matches_file: false, hearing_impaired: false, translated: true, release: '' };
    expect(describeOffer(machine)).toBe('Norwegian · machine translated — no release name');
  });
});

describe('subtitleTitle', () => {
  it('names the source, and the release cut to fit', () => {
    expect(subtitleTitle(false)).toBe('OpenSubtitles');
    expect(subtitleTitle(true, 'Short.Name')).toBe('Forced · OpenSubtitles · Short.Name');
    expect(subtitleTitle(false, 'A.Very.Long.Release.Name.2019.1080p.BluRay.x264')).toBe(
      'OpenSubtitles · A.Very.Long.Release.Name.2019.1…'
    );
  });
});

describe('coverageNote', () => {
  const span = (last: number) => ({ cues: 900, first_secs: 30, last_secs: last });
  it('says nothing when the subtitles cover the film, or nothing is known', () => {
    expect(coverageNote(span(6600), 7200)).toBeNull();
    expect(coverageNote(span(7300), 7200)).toBeNull();
    expect(coverageNote(null, 7200)).toBeNull();
    expect(coverageNote(span(100), null)).toBeNull();
    expect(coverageNote(span(100), 300)).toBeNull();
  });
  it('says when they stop far short, or run past the end', () => {
    expect(coverageNote(span(3600), 7200)).toBe(
      "They end at 1:00:00 of this file's 2:00:00: likely made for another cut, or one part of it."
    );
    expect(coverageNote(span(7500), 7200)).toBe(
      'They run to 2:05:00, past the end of this file (2:00:00): likely timed for another cut.'
    );
  });
});

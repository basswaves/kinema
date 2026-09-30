import { describe, expect, it } from 'vitest';
import { describeOffer, searchLanguages, subtitleTitle, type Offer } from './onlineSubtitles';

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

import { describe, expect, it } from 'vitest';
import { chooseTracks } from './trackChoice';
import type { Track } from './engine';

const t = (id: number, type: string, lang: string | undefined, extra: Partial<Track> = {}): Track => ({
  id,
  type,
  lang,
  selected: false,
  forced: false,
  external: false,
  default: false,
  ...extra,
});

/** An English film with Norwegian and English subtitles and a forced Norwegian track. */
const film = [
  t(1, 'audio', 'eng', { selected: true }),
  t(2, 'audio', 'nor'),
  t(3, 'sub', 'eng'),
  t(4, 'sub', 'nor'),
  t(5, 'sub', 'nor', { forced: true }),
];

const norwegian = { audio: 'original', subs: 'foreign:no', forced: true };

describe('chooseTracks', () => {
  it('shows Norwegian subtitles under English audio by default', () => {
    expect(chooseTracks(film, null, norwegian)).toEqual({ aid: null, sid: 4, subVisible: true });
  });

  it('shows only the forced track when the audio is already Norwegian', () => {
    const choice = chooseTracks(film, null, { audio: 'nb-NO', subs: 'foreign:no', forced: true });
    expect(choice).toEqual({ aid: 2, sid: 5, subVisible: true });
  });

  it('shows none when the audio is Norwegian and there is no forced track', () => {
    const tracks = film.filter((x) => x.id !== 5);
    expect(chooseTracks(tracks, null, { audio: 'nor', subs: 'foreign:no', forced: true })).toEqual({
      aid: 2,
      sid: null,
      subVisible: false,
    });
  });

  it('leaves the file alone when it has nothing in the wanted language', () => {
    const tracks = [t(1, 'audio', 'jpn', { selected: true }), t(2, 'sub', 'eng')];
    expect(chooseTracks(tracks, null, norwegian)).toEqual({ aid: null, sid: null, subVisible: null });
  });

  it('turns subtitles off, or always on, as set', () => {
    expect(chooseTracks(film, null, { audio: 'original', subs: 'off', forced: true }).subVisible).toBe(false);
    const always = chooseTracks(film, null, { audio: 'nor', subs: 'always:en', forced: true });
    expect(always).toEqual({ aid: 2, sid: 3, subVisible: true });
  });

  it('lets a choice made in the title win over the defaults', () => {
    const prefs = { audio_lang: 'eng', sub_lang: null, sub_enabled: false, chosen: true };
    expect(chooseTracks(film, prefs, norwegian)).toEqual({ aid: 1, sid: null, subVisible: false });
  });

  it('applies the defaults when nothing was chosen, even if a prefs row came back', () => {
    const empty = { audio_lang: null, sub_lang: null, sub_enabled: true, chosen: false };
    expect(chooseTracks(film, empty, norwegian).sid).toBe(4);
  });

  /**
   * Decided 2026-09-30: subtitles off means no full subtitles, not missing
   * the scene in another language. The forced track for the language being
   * spoken shows, as on a disc — the owner watches exactly this way.
   */
  it('shows the forced track for the spoken language with subtitles off', () => {
    const english = [
      t(1, 'audio', 'eng', { selected: true }),
      t(2, 'sub', 'eng'),
      t(3, 'sub', 'eng', { forced: true }),
      t(4, 'sub', 'nor', { forced: true }),
    ];
    const off = { audio: 'original', subs: 'off', forced: true };
    expect(chooseTracks(english, null, off)).toEqual({ aid: null, sid: 3, subVisible: true });
    // …and when subtitles were switched off in the title itself.
    const prefs = { audio_lang: 'eng', sub_lang: null, sub_enabled: false, chosen: true };
    expect(chooseTracks(english, prefs, off)).toEqual({ aid: 1, sid: 3, subVisible: true });
  });

  it('shows no forced track when forced subtitles are switched off', () => {
    const english = [t(1, 'audio', 'eng', { selected: true }), t(2, 'sub', 'eng', { forced: true })];
    const off = { audio: 'original', subs: 'off', forced: false };
    expect(chooseTracks(english, null, off)).toEqual({ aid: null, sid: null, subVisible: false });
    expect(
      chooseTracks(film, null, { audio: 'nb-NO', subs: 'foreign:no', forced: false }).sid
    ).toBeNull();
  });

  /** Untagged audio: nothing says which language is spoken, so no guess. */
  it('shows no forced track when the spoken language is unknown', () => {
    const untagged = [
      t(1, 'audio', undefined, { selected: true }),
      t(2, 'sub', 'eng', { forced: true }),
    ];
    const off = { audio: 'original', subs: 'off', forced: true };
    expect(chooseTracks(untagged, null, off).sid).toBeNull();
  });
});

describe('audio description and SDH, as the person needs them', () => {
  /** English with an audio description (flag and title), and plain and SDH subtitles. */
  const described = [
    t(1, 'audio', 'eng', { selected: true }),
    t(2, 'audio', 'eng', { title: 'English AD' }),
    t(3, 'audio', 'nor'),
    t(4, 'audio', 'nor', { visualImpaired: true }),
    t(5, 'sub', 'eng'),
    t(6, 'sub', 'eng', { hearingImpaired: true }),
  ];
  const english = { audio: 'original', subs: 'always:en', forced: true };

  it('leaves the description and SDH alone when not asked', () => {
    expect(chooseTracks(described, null, english)).toEqual({ aid: null, sid: 5, subVisible: true });
  });

  it('chooses the description in the file’s own language, and SDH, when asked', () => {
    expect(chooseTracks(described, null, { ...english, description: true, sdh: true })).toEqual({
      aid: 2,
      sid: 6,
      subVisible: true,
    });
  });

  it('in a chosen language, and in a title’s own choice', () => {
    const want = { ...english, audio: 'no', description: true };
    expect(chooseTracks(described, null, want).aid).toBe(4);
    const prefs = { chosen: true, audio_lang: 'nor', sub_lang: 'eng', sub_enabled: true };
    expect(chooseTracks(described, prefs as never, want).aid).toBe(4);
  });

  it('moves off a description the file opens with when it is not wanted', () => {
    const opensDescribed = described.map((x) => ({ ...x, selected: x.id === 2 }));
    expect(chooseTracks(opensDescribed, null, english).aid).toBe(1);
  });

  it('keeps the file’s track when there is no description to choose', () => {
    const plain = described.filter((x) => x.id !== 2 && x.id !== 4);
    expect(chooseTracks(plain, null, { ...english, description: true }).aid).toBeNull();
  });
});

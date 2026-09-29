import { describe, expect, it } from 'vitest';
import {
  aspectLabel,
  audioBadge,
  buildBadges,
  channelLabel,
  dolbyVisionLabel,
  frameRateLabel,
  bitrateLabel,
  releaseNames,
  studioBadge,
  resolutionLabel,
  type AudioTrack,
  type FileFacts,
  type VideoDetails,
} from './badges';
import type { Release } from '../library/release';

function track(codec: string, profile: string | null, layout: string, extra: Partial<AudioTrack> = {}): AudioTrack {
  return {
    codec,
    profile,
    channels: null,
    layout,
    language: 'eng',
    title: null,
    default: false,
    commentary: false,
    ...extra,
  };
}

const VIDEO_4K: VideoDetails = {
  stream_index: 0,
  codec: 'hevc',
  profile: 'Main 10',
  width: 3840,
  height: 2160,
  bit_depth: 10,
  frame_rate: 24000 / 1001,
  interlaced: false,
  aspect_ratio: 16 / 9,
  transfer: 'pq',
  hdr10_plus: false,
  dolby_vision: { profile: 7, level: 6, compatibility: 6, enhancement_layer: 'FEL' },
  mastering_peak_nits: 1000,
  max_cll: 739,
  max_fall: 331,
};

function facts(extra: Partial<FileFacts> = {}): FileFacts {
  return {
    details: {
      container: 'matroska,webm',
      duration_secs: 8000,
      bit_rate: 58_400_000,
      video: VIDEO_4K,
      audio: [
        track('truehd', 'Dolby TrueHD + Dolby Atmos', '7.1', { default: true }),
        track('dts', 'DTS-HD MA', '7.1'),
        track('ac3', null, '5.1(side)', { commentary: true }),
      ],
      subtitles: [
        { codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'SDH', default: false, forced: false, hearing_impaired: false },
        { codec: 'hdmv_pgs_subtitle', language: 'nor', title: null, default: false, forced: false, hearing_impaired: false },
      ],
    },
    picture_aspect: 2.4,
    picture_aspect_alt: null,
    file_name: 'A.Film.2019.2160p.UHD.BluRay.REMUX.mkv',
    parent_dir: 'D:\\Media\\Movies\\A Film (2019)',
    extension: 'mkv',
    root_path: 'D:\\Media\\Movies',
    ...extra,
  };
}

const REMUX: Release = {
  source: 'Ultra HD Blu-ray',
  remux: true,
  rip: false,
  disc: false,
  service: null,
  editions: [],
  auro3d: false,
};

describe('buildBadges', () => {
  it('describes a 4K Dolby Vision remux as a Kodi skin would', () => {
    const rows = buildBadges(facts(), REMUX);
    const flat = Object.fromEntries(
      rows.map((row) => [row.heading, row.badges.map((b) => `${b.label}: ${b.value}`)])
    );
    expect(flat).toEqual({
      Picture: [
        'Resolution: 4K UHD',
        'Dolby Vision: Profile 7 · FEL',
        'HDR: HDR10 · 1000 nits',
        'Video: HEVC 10-bit',
        'Frame rate: 23.976',
        'Aspect: 2.39:1',
      ],
      // The commentary track is not a sound format of the film.
      Sound: ['Dolby TrueHD: Atmos · 7.1', 'DTS-HD MA: 7.1'],
      File: ['Source: UHD Blu-ray remux', 'Subtitles: 2 · SDH', 'Bitrate: 58 Mb/s'],
    });
  });

  it('shows the file’s own ratio until the picture is measured', () => {
    const [picture] = buildBadges(facts({ picture_aspect: null }), null);
    expect(picture.badges.find((b) => b.label === 'Aspect')?.value).toBe('1.78:1');
  });

  it('shows both shapes of a film that opens up for IMAX scenes', () => {
    const [picture] = buildBadges(facts({ picture_aspect: 2.39, picture_aspect_alt: 1.9 }), null);
    expect(picture.badges[picture.badges.length - 1]).toEqual({ label: 'Variable aspect', value: '2.39:1 · 1.90:1' });
  });

  /** Without ffprobe there is still a name to read. */
  it('shows only what the name says when the file has not been read', () => {
    const rows = buildBadges(facts({ details: null }), { ...REMUX, auro3d: true, editions: ['Extended'] });
    expect(rows.map((r) => r.heading)).toEqual(['Sound', 'File']);
    expect(rows[0].badges).toEqual([{ label: 'Immersive', value: 'Auro-3D' }]);
    expect(rows[1].badges).toEqual([
      { label: 'Source', value: 'UHD Blu-ray remux' },
      { label: 'Edition', value: 'Extended' },
    ]);
  });

  it('shows nothing at all for a file nothing is known about', () => {
    expect(buildBadges(facts({ details: null }), null)).toEqual([]);
  });

  it('says HDR10+ and HLG, and nothing for SDR', () => {
    const hdr = (video: Partial<VideoDetails>) =>
      buildBadges(facts({ details: { ...facts().details!, video: { ...VIDEO_4K, dolby_vision: null, ...video } } }), null)[0]
        .badges.find((b) => b.label === 'HDR')?.value;
    expect(hdr({ hdr10_plus: true })).toBe('HDR10+ · 1000 nits');
    expect(hdr({ transfer: 'hlg', mastering_peak_nits: null })).toBe('HLG');
    expect(hdr({ transfer: 'sdr' })).toBeUndefined();
  });

  it('lists each sound format once, however many languages carry it', () => {
    const details = {
      ...facts().details!,
      audio: [
        track('eac3', 'Dolby Digital Plus + Dolby Atmos', '5.1(side)', { language: 'eng' }),
        track('eac3', 'Dolby Digital Plus + Dolby Atmos', '5.1(side)', { language: 'ger' }),
        track('aac', 'LC', 'stereo', { title: "Director's commentary" }),
      ],
    };
    const sound = buildBadges(facts({ details }), null).find((r) => r.heading === 'Sound');
    expect(sound?.badges).toEqual([{ label: 'Dolby Digital+', value: 'Atmos · 5.1' }]);
  });
});

describe('audioBadge', () => {
  it.each([
    [track('truehd', 'Dolby TrueHD + Dolby Atmos', '7.1'), 'Dolby TrueHD', 'Atmos · 7.1'],
    [track('truehd', null, '5.1'), 'Dolby TrueHD', '5.1'],
    [track('eac3', 'Dolby Digital Plus + Dolby Atmos', '5.1(side)'), 'Dolby Digital+', 'Atmos · 5.1'],
    [track('dts', 'DTS-HD MA + DTS:X', '7.1'), 'DTS-HD MA', 'DTS:X · 7.1'],
    [track('dts', 'DTS-HD MA + DTS:X IMAX', '7.1'), 'DTS-HD MA', 'DTS:X IMAX · 7.1'],
    [track('dts', 'DTS-HD HRA', '7.1'), 'DTS-HD HRA', '7.1'],
    [track('dts', null, '5.1(side)'), 'DTS', '5.1'],
    [track('ac3', null, 'stereo'), 'Dolby Digital', '2.0'],
    [track('pcm_s24le', null, '5.1'), 'PCM', '5.1'],
    [track('flac', null, 'mono'), 'FLAC', '1.0'],
  ])('%#: %s', (t, label, value) => {
    expect(audioBadge(t)).toEqual({ label, value });
  });
});

describe('labels', () => {
  it('names resolutions by width first', () => {
    expect(resolutionLabel(3840, 1600, false)).toBe('4K UHD');
    expect(resolutionLabel(1920, 800, false)).toBe('1080p');
    expect(resolutionLabel(1920, 1080, true)).toBe('1080i');
    expect(resolutionLabel(1280, 536, false)).toBe('720p');
    expect(resolutionLabel(720, 576, true)).toBe('576i');
  });

  it('names frame rates as the industry does', () => {
    expect(frameRateLabel(24000 / 1001)).toBe('23.976');
    expect(frameRateLabel(30000 / 1001)).toBe('29.97');
    expect(frameRateLabel(60000 / 1001)).toBe('59.94');
    expect(frameRateLabel(25)).toBe('25');
    expect(frameRateLabel(12.5)).toBe('12.5');
  });

  it('names aspect ratios as films are described', () => {
    expect(aspectLabel(2.4)).toBe('2.39:1');
    expect(aspectLabel(16 / 9)).toBe('1.78:1');
    expect(aspectLabel(1.896)).toBe('1.90:1');
    expect(aspectLabel(2.1)).toBe('2.10:1');
  });

  it('names Dolby Vision profiles and their layers', () => {
    expect(dolbyVisionLabel({ profile: 7, level: 6, compatibility: 6, enhancement_layer: 'MEL' })).toBe(
      'Profile 7 · MEL'
    );
    expect(dolbyVisionLabel({ profile: 8, level: 6, compatibility: 1, enhancement_layer: null })).toBe(
      'Profile 8.1'
    );
    expect(dolbyVisionLabel({ profile: 8, level: 6, compatibility: 4, enhancement_layer: null })).toBe(
      'Profile 8.4'
    );
    expect(dolbyVisionLabel({ profile: 5, level: 6, compatibility: 0, enhancement_layer: null })).toBe(
      'Profile 5'
    );
    // Profile 7 with an unreadable RPU: the profile, and nothing guessed.
    expect(dolbyVisionLabel({ profile: 7, level: 6, compatibility: 6, enhancement_layer: null })).toBe(
      'Profile 7'
    );
  });

  it('reads odd channel layouts by their count', () => {
    expect(channelLabel({ layout: '5.1(side)', channels: 6 })).toBe('5.1');
    expect(channelLabel({ layout: 'hexagonal', channels: 6 })).toBe('6 ch');
    expect(channelLabel({ layout: null, channels: null })).toBeNull();
  });
});

describe('releaseNames', () => {
  it('climbs to the library folder and no further', () => {
    expect(
      releaseNames({
        file_name: 'E01.mkv',
        parent_dir: 'D:\\TV\\Show.S01.1080p.BluRay-GRP\\Season 1',
        root_path: 'D:\\TV',
      })
    ).toEqual(['E01.mkv', 'Season 1', 'Show.S01.1080p.BluRay-GRP']);
    expect(
      releaseNames({ file_name: 'A.Film.mkv', parent_dir: 'D:\\Movies', root_path: 'D:\\Movies\\' })
    ).toEqual(['A.Film.mkv']);
  });

  it('stops at two folders however deep the file is', () => {
    expect(
      releaseNames({ file_name: 'f.mkv', parent_dir: 'D:/TV/a/b/c/d', root_path: 'D:/TV' })
    ).toEqual(['f.mkv', 'd', 'c']);
  });
});

describe('studioBadge', () => {
  const studio = (name: string, logo: boolean) => ({
    name,
    logo_url: logo ? `https://example.test/${name}.png` : null,
    logo_path: null,
  });

  it('draws the studios that have logos, up to three', () => {
    const badge = studioBadge('movie', [
      studio('A', true),
      studio('B', false),
      studio('C', true),
      studio('D', true),
      studio('E', true),
    ]);
    expect(badge?.label).toBe('Studio');
    expect(badge?.logos?.map((s) => s.name)).toEqual(['A', 'C', 'D']);
    expect(badge?.value).toBe('A · C · D');
  });

  it('names them when none has a logo, and calls a series’ its network', () => {
    expect(studioBadge('series', [studio('A Network', false)])).toEqual({
      label: 'Network',
      value: 'A Network',
    });
    expect(studioBadge('movie', [])).toBeNull();
  });

  /** A title's studio shows even before — or without — its file's details. */
  it('joins the file row, even with nothing read from the file', () => {
    const rows = buildBadges(null, null, { label: 'Studio', value: 'A' });
    expect(rows).toEqual([{ heading: 'File', badges: [{ label: 'Studio', value: 'A' }] }]);
  });
});

describe('bitrateLabel', () => {
  /** 2.2 and 1.6 Mb/s are different encodes; both used to read "2 Mb/s". */
  it('keeps a decimal below ten', () => {
    expect(bitrateLabel(2_213_000)).toBe('2.2 Mb/s');
    expect(bitrateLabel(1_560_000)).toBe('1.6 Mb/s');
    expect(bitrateLabel(8_600_000)).toBe('8.6 Mb/s');
    expect(bitrateLabel(9_990_000)).toBe('10.0 Mb/s');
    expect(bitrateLabel(26_511_880)).toBe('27 Mb/s');
  });
});

describe('the folder rule', () => {
  /** A film kept in another film's folder is not that film's release. */
  it('does not read a folder another title’s files are in', () => {
    expect(
      releaseNames({
        file_name: 'A.Film.2014.mp4',
        parent_dir: 'D:\\Movies\\Another.Film.2006.2160p.UHD.BluRay.REMUX',
        root_path: 'D:\\Movies',
        folder_shared: true,
      })
    ).toEqual(['A.Film.2014.mp4']);
  });
});

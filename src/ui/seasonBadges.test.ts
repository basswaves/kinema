import { describe, expect, it } from 'vitest';
import { buildSeasonBadges, type SeasonFile } from './seasonBadges';
import type { AudioTrack, FileFacts, VideoDetails } from './badges';
import type { Release } from '../library/release';

const VIDEO: VideoDetails = {
  stream_index: 0,
  codec: 'h264',
  profile: 'High',
  width: 1920,
  height: 1080,
  bit_depth: 8,
  frame_rate: 24000 / 1001,
  interlaced: false,
  aspect_ratio: 16 / 9,
  transfer: 'sdr',
  hdr10_plus: false,
  dolby_vision: null,
  mastering_peak_nits: null,
  max_cll: null,
  max_fall: null,
};

const DDP: AudioTrack = {
  codec: 'eac3',
  profile: null,
  channels: 6,
  layout: '5.1(side)',
  language: 'eng',
  title: null,
  default: true,
  commentary: false,
};

const release = (source: string, service: string | null, rip = true): Release => ({
  source,
  remux: false,
  rip,
  disc: false,
  service,
  editions: [],
  auro3d: false,
});

/** One episode: 1080p AVC web release by default, overridable. */
function episode(
  fileId: number,
  video: Partial<VideoDetails> = {},
  extra: { bitRate?: number; release?: Release; audio?: AudioTrack[]; subtitles?: number } = {}
): SeasonFile {
  const facts: FileFacts = {
    details: {
      container: 'matroska,webm',
      duration_secs: 1800,
      bit_rate: extra.bitRate ?? 8_600_000,
      video: { ...VIDEO, ...video },
      audio: extra.audio ?? [DDP],
      subtitles: Array.from({ length: extra.subtitles ?? 1 }, () => ({
        codec: 'subrip',
        language: 'eng',
        title: null,
        default: false,
        forced: false,
        hearing_impaired: false,
      })),
    },
    picture_aspect: 16 / 9,
    picture_aspect_alt: null,
    file_name: `E${fileId}.mkv`,
    parent_dir: 'D:\\TV\\A Show\\Season 5',
    extension: 'mkv',
    root_path: 'D:\\TV',
  };
  return { fileId, facts, release: extra.release ?? release('Web', 'HBO Max') };
}

const flat = (rows: ReturnType<typeof buildSeasonBadges>['rows']) =>
  Object.fromEntries(rows.map((r) => [r.heading, r.badges.map((b) => `${b.label}: ${b.value}`)]));

describe('buildSeasonBadges', () => {
  /** A season all alike reads like a film's page, and adds nothing to its rows. */
  it('sums up a season that is all alike, with no episode chips', () => {
    const season = buildSeasonBadges([episode(1), episode(2), episode(3)], null);
    expect(flat(season.rows)).toEqual({
      Picture: ['Resolution: 1080p', 'Video: AVC 8-bit', 'Frame rate: 23.976', 'Aspect: 1.78:1'],
      Sound: ['Dolby Digital+: 5.1'],
      File: ['Source: WEBRip · HBO Max', 'Subtitles: 1', 'Bitrate: 8.6 Mb/s'],
    });
    expect(season.exceptions.size).toBe(0);
  });

  /** The real library's case: one season from two services, bitrates apart. */
  it('lists every source a season came from, and the bitrate as a range', () => {
    const season = buildSeasonBadges(
      [
        episode(1, {}, { release: release('Web', 'Amazon Prime') }),
        episode(2, {}, { bitRate: 10_100_000 }),
        episode(3, {}, { release: release('Web', 'Amazon Prime') }),
      ],
      null
    );
    const file = flat(season.rows).File;
    expect(file).toContain('Source · varies: WEBRip · Amazon Prime / WEBRip · HBO Max');
    expect(file).toContain('Bitrate: 8.6–10 Mb/s');
    // The odd one out says so in its row; the usual ones do not.
    expect(season.exceptions.get(2)).toEqual(['WEBRip · HBO Max']);
    expect(season.exceptions.has(1)).toBe(false);
  });

  it('marks the one episode that is not like its season', () => {
    const season = buildSeasonBadges(
      [episode(1), episode(2, { width: 1280, height: 720 }), episode(3), episode(4)],
      null
    );
    expect(flat(season.rows).Picture[0]).toBe('Resolution · varies: 1080p / 720p');
    expect(season.exceptions.get(2)).toEqual(['720p']);
    expect([...season.exceptions.keys()]).toEqual([2]);
  });

  /** An HDR season with one SDR episode: the SDR one says so. */
  it('names an SDR episode in an HDR season', () => {
    const hdr = { transfer: 'pq' as const, bit_depth: 10, codec: 'hevc' };
    const season = buildSeasonBadges(
      [episode(1, hdr), episode(2, hdr), episode(3, { codec: 'hevc', bit_depth: 10 })],
      null
    );
    expect(flat(season.rows).Picture).toContain('HDR · 2 of 3: HDR10');
    expect(season.exceptions.get(3)).toEqual(['SDR']);
  });

  it('counts a sound format only some episodes have, and names the odd one', () => {
    const stereo: AudioTrack = { ...DDP, codec: 'aac', profile: 'LC', layout: 'stereo', channels: 2 };
    const season = buildSeasonBadges(
      [episode(1), episode(2), episode(3, {}, { audio: [stereo] })],
      null
    );
    expect(flat(season.rows).Sound).toEqual(['Dolby Digital+ · 2 of 3: 5.1', 'AAC · 1 of 3: 2.0']);
    expect(season.exceptions.get(3)).toEqual(['AAC 2.0']);
  });

  it('gives subtitle counts as a range, and keeps the show’s network', () => {
    const season = buildSeasonBadges(
      [episode(1, {}, { subtitles: 2 }), episode(2, {}, { subtitles: 5 })],
      { label: 'Network', value: 'A Network' }
    );
    const file = flat(season.rows).File;
    expect(file).toContain('Subtitles: 2–5');
    expect(file[file.length - 1]).toBe('Network: A Network');
  });

  /** One file cannot differ from itself. */
  it('gives a one-episode season no chips', () => {
    const season = buildSeasonBadges([episode(1, { width: 1280, height: 720 })], null);
    expect(season.exceptions.size).toBe(0);
    expect(flat(season.rows).Picture[0]).toBe('Resolution: 720p');
  });
});

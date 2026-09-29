/**
 * What the source badge says for a release name — against the real guessit,
 * because what matters is what the parser actually makes of these names.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser } from './parse';
import { readRelease, sourceLabel } from './release';

beforeAll(async () => {
  await initParser();
});

/** The badge for a file name, and optionally the folders above it. */
function label(fileName: string, ...folders: string[]): string | null {
  const extension = fileName.split('.').pop() ?? '';
  return sourceLabel(readRelease([fileName, ...folders], extension));
}

describe('sourceLabel', () => {
  it.each([
    ['A Film 2019 2160p UHD BluRay REMUX HDR10 HEVC TrueHD 7.1 Atmos-GRP.mkv', 'UHD Blu-ray remux'],
    ['A.Film.2019.2160p.BluRay.REMUX.DV.HDR10Plus.HEVC.TrueHD.7.1.Atmos-GRP.mkv', 'UHD Blu-ray remux'],
    ['A Film 2019 1080p BluRay REMUX AVC DTS-HD MA 5.1-GRP.mkv', 'Blu-ray remux'],
    ['A.Film.2019.1080p.BluRay.Remux.AVC.LPCM.2.0-GRP.mkv', 'Blu-ray remux'],
    ['A.Film.2019.UHD.BDRemux.2160p-GRP.mkv', 'UHD Blu-ray remux'],
    ['A.Film.2019.1080p.BDRemux-GRP.mkv', 'Blu-ray remux'],
    ['A.Film.2019.1080p.BluRay.x264-GRP.mkv', 'Blu-ray encode'],
    ['A.Film.2019.1080p.BDRip.x264-GRP.mkv', 'Blu-ray encode'],
    ['A.Film.2019.Extended.Edition.2160p.UHD.BluRay.x265-GRP.mkv', 'UHD Blu-ray encode'],
    ['A.Film.2019.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265-GRP.mkv', 'WEB-DL'],
    ['A.Film.2019.1080p.WEB.H264-GRP.mkv', 'WEB-DL'],
    ['A.Film.2019.1080p.NF.WEB-DL.DDP5.1.H.264-GRP.mkv', 'WEB-DL · Netflix'],
    ['A.Film.2019.1080p.AMZN.WEBRip.DDP5.1.x264-GRP.mkv', 'WEBRip · Amazon Prime'],
    ['A.Film.2019.720p.HDTV.x264-GRP.mkv', 'HDTV'],
    ['A.Film.2019.DVDRip.XviD-GRP.avi', 'DVD encode'],
    ['A.Film.2019.PAL.DVD9.iso', 'DVD disc'],
    ['A.Film.2019.COMPLETE.UHD.BLURAY-GRP.iso', 'UHD Blu-ray disc'],
    ['A Film (2019).iso', 'Disc image'],
  ])('%s → %s', (name, expected) => {
    expect(label(name)).toBe(expected);
  });

  it('says nothing for a name that says nothing', () => {
    expect(label('A Film (2019).mkv')).toBeNull();
  });
});

describe('readRelease', () => {
  /** A season pack keeps its release name on the folder, not the episodes. */
  it('reads a season pack from its folder', () => {
    expect(
      label('Example Show S01 - S01E01 - E01 GRP.mp4', 'Season 1', 'Example.Show.S01.1080p.BluRay.x265-GRP')
    ).toBe('Blu-ray encode');
    expect(label('S01E01.mkv', 'Example.Show.S01.2160p.NF.WEB-DL.DDP5.1.HDR.HEVC-GRP')).toBe(
      'WEB-DL · Netflix'
    );
  });

  /** The file's own name is the more specific, and speaks first. */
  it('prefers the file name to its folder', () => {
    expect(label('A.Film.2019.1080p.WEBRip.x264-GRP.mkv', 'A.Film.2019.1080p.BluRay.REMUX-GRP')).toBe(
      'WEBRip'
    );
  });

  /** "Remux" belongs to the name that named the source, not to any name. */
  it('never pairs one name’s source with another’s remux', () => {
    expect(label('A.Film.2019.1080p.WEB-DL-GRP.mkv', 'Remux')).toBe('WEB-DL');
  });

  it('finds Auro-3D, which guessit does not know', () => {
    const release = readRelease(['A.Film.2019.2160p.UHD.BluRay.Auro3D.DTS-HD.MA.7.1-GRP.mkv'], 'mkv');
    expect(release.auro3d).toBe(true);
    expect(readRelease(['A.Film.2019.Auro-3D.mkv'], 'mkv').auro3d).toBe(true);
    expect(readRelease(['Aurora.3D.2019.mkv'], 'mkv').auro3d).toBe(false);
  });

  it('keeps editions, and tells IMAX Enhanced from the IMAX cut', () => {
    expect(readRelease(['A.Film.2019.Directors.Cut.1080p.BluRay.x264-GRP.mkv'], 'mkv').editions).toEqual([
      "Director's Cut",
    ]);
    expect(
      readRelease(['A.Film.2019.IMAX.Enhanced.2160p.WEB-DL.DTS-HD.MA.5.1-GRP.mkv'], 'mkv').editions
    ).toEqual(['IMAX Enhanced']);
    expect(readRelease(['A.Film.2019.IMAX.2160p.WEB-DL-GRP.mkv'], 'mkv').editions).toEqual(['IMAX']);
    expect(readRelease(['A.Film.2019.Open.Matte.1080p.WEB-DL.mkv'], 'mkv').editions).toEqual([
      'Open Matte',
    ]);
  });

  /** The same edition on the file and its folder is one edition. */
  it('does not repeat an edition named twice', () => {
    expect(
      readRelease(['A.Film.2019.Extended.mkv', 'A.Film.2019.Extended.1080p.BluRay-GRP'], 'mkv').editions
    ).toEqual(['Extended']);
  });

  /** What the file holds is the file's to say, never the name's. */
  it('reads nothing about picture or sound', () => {
    const release = readRelease(
      ['A.Film.2019.2160p.BluRay.REMUX.DV.HDR10Plus.HEVC.TrueHD.7.1.Atmos-GRP.mkv'],
      'mkv'
    );
    expect(Object.keys(release).sort()).toEqual(
      ['auro3d', 'disc', 'editions', 'remux', 'rip', 'service', 'source'].sort()
    );
  });
});

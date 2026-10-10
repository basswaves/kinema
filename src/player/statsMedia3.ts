/**
 * The details panel (`i`) where Media3 plays (Android): what Media3 itself
 * says it is doing — the decoder it opened, the frames it showed and dropped,
 * what became of the sound, the screen's mode — in its own groups.
 *
 * Never mpv's rows filled in from Media3 (PORTING.md, rule 5): render passes,
 * scalers, tone mapping and the output check describe mpv's pipeline, which
 * is not there. What the two have in common is said the same way — the
 * resolution, the bitrate, and the cadence, the panel's headline on every
 * system (stats.ts).
 */
import { playerFacts, type PlayerFacts } from './engine';
import { bitrate, describeCadence, num, resolution, resolutionClass, type StatGroup } from './stats';

const DASH = '—';

function hdrName(video: NonNullable<PlayerFacts['video']>): string {
  if (video.dolbyVision) return 'Dolby Vision';
  // Profile 7 with no decoder for it here: its HDR10 picture, said as such.
  if (video.dolbyVisionBaseLayer) return 'HDR10 (PQ) — Dolby Vision layer not applied';
  switch (video.transfer) {
    case 'pq':
      return 'HDR10 (PQ)';
    case 'hlg':
      return 'HLG';
    case 'sdr':
      return 'SDR';
    default:
      // A file that says nothing of its colours is shown as SDR.
      return 'SDR, not tagged in the file';
  }
}

/** The HDR kind the film asks of the screen, by Android's names; null for SDR. */
function hdrNeeded(video: NonNullable<PlayerFacts['video']>): string | null {
  if (video.dolbyVision) return 'Dolby Vision';
  if (video.transfer === 'pq') return 'HDR10';
  if (video.transfer === 'hlg') return 'HLG';
  return null;
}

/**
 * What becomes of an HDR film on this screen, in Android's own words: the
 * screen's HDR kinds are what Android says, not what the TV could do. A box
 * that read its TV while the TV was off said none, and drew HDR films in
 * ordinary colour all evening while this row said the TV was switched
 * (2026-10-05).
 */
function hdrOnScreen(
  video: NonNullable<PlayerFacts['video']>,
  screenHdr: string[] | undefined
): { note?: string; warn?: boolean } {
  const needed = hdrNeeded(video);
  if (!needed || !screenHdr) return {};
  if (screenHdr.includes(needed)) return { note: `the screen takes ${needed}, Android says` };
  if (needed === 'Dolby Vision' && screenHdr.includes('HDR10')) {
    return { note: 'the screen takes HDR10 but not Dolby Vision, Android says' };
  }
  const takes = screenHdr.length === 0 ? 'no HDR' : `${screenHdr.join(' and ')}, not ${needed}`;
  return {
    note: `Android says the screen takes ${takes}, so the picture is turned into ordinary colour (SDR)`,
    warn: true,
  };
}

/**
 * The cadence, from the rate Android is given — which, where it is given only
 * one mode, may not be the rate the TV gets, and is said to be that.
 */
function cadenceFrom(fps: number | null, screen: PlayerFacts['screen']) {
  const row = describeCadence(fps, screen.rate);
  if (screen.modes !== 1 || row.value === DASH) return row;
  const from = 'worked out from the rate Android is given';
  return { ...row, note: row.note ? `${row.note}; ${from}` : from };
}

/** The panel's groups from Media3's facts; pure, for the tests. */
export function media3Groups(facts: PlayerFacts): StatGroup[] {
  const { video, frames, audio, screen } = facts;
  const groups: StatGroup[] = [];

  if (video) {
    groups.push({
      heading: 'Source',
      rows: [
        {
          label: 'Resolution',
          value: resolution(video.width, video.height),
          note: resolutionClass(video.width, video.height),
        },
        { label: 'Video', value: video.described, note: video.codecs ?? undefined },
        {
          label: 'Frame rate',
          value: num(video.fps, 3, ' fps'),
          // Media3's Matroska reader has none to give; Kinema then works it
          // out from the frames' times, and says so.
          note:
            video.fps === null
              ? 'not read from this file'
              : video.fpsMeasured
                ? "worked out from the frames' times"
                : undefined,
        },
        { label: 'Video bitrate', value: bitrate(video.bitrate) },
        { label: 'Dynamic range', value: hdrName(video), ...hdrOnScreen(video, screen.hdr) },
      ],
    });
  }

  const shown = frames ? frames.rendered : null;
  groups.push({
    heading: 'Decoding',
    rows: [
      {
        label: 'Video decoder',
        value: video?.decoder ?? DASH,
        note:
          video?.hardware === true
            ? "the device's own video hardware"
            : video?.hardware === false
              ? 'in software, on the processor'
              : undefined,
        warn: video?.hardware === false,
      },
      {
        label: 'Frames',
        value: frames ? `${shown} shown · ${frames.dropped} dropped` : DASH,
        note:
          frames && frames.skipped > 0 ? `${frames.skipped} skipped to catch up after a stall` : undefined,
        warn: (frames?.dropped ?? 0) > 0,
      },
      {
        label: 'Buffered',
        value: facts.bufferedSeconds === undefined ? DASH : `${facts.bufferedSeconds.toFixed(1)} s ahead`,
      },
    ],
  });

  groups.push({
    heading: 'Display',
    rows: [
      {
        label: 'Screen mode',
        value: `${resolution(screen.width, screen.height)} @ ${num(screen.rate, 3, ' Hz')}`,
        // With one mode the device may send the TV more than it tells
        // Android: the old box sent 3840×2160 while Android had 1920×1080.
        note:
          screen.modes === 1
            ? "the only mode Android is given; the device itself decides what the TV gets, which can be more"
            : 'as Android reports it',
      },
      ...(screen.hdr
        ? [
            {
              label: 'Screen HDR',
              value: screen.hdr.length > 0 ? screen.hdr.join(' · ') : 'none',
              note: 'as Android reports it',
            },
          ]
        : []),
      cadenceFrom(video?.fps ?? null, screen),
    ],
  });

  groups.push({
    heading: 'Sound',
    rows: audio
      ? [
          { label: 'Format', value: audio.name },
          {
            label: 'Path',
            value: audio.way === 'untouched' ? 'sent on untouched' : 'decoded on this device',
            note:
              audio.way === 'untouched'
                ? 'for the TV or receiver to decode; its volume is the one that counts'
                : (audio.decoder ?? undefined),
          },
          {
            label: 'Sample rate',
            value: audio.sampleRate ? `${(audio.sampleRate / 1000).toFixed(1)} kHz` : DASH,
          },
        ]
      : [{ label: 'Format', value: 'none', note: 'no sound track this device can play' }],
  });

  return groups;
}

export async function readMedia3Stats(): Promise<StatGroup[]> {
  return media3Groups(await playerFacts());
}

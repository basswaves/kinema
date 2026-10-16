/**
 * "Two things need ffmpeg": the notice on Home, and the line on a title's page.
 *
 * ffmpeg is a program Kinema does not include (it ships nothing and downloads
 * nothing itself) — on Windows a press asks winget to install it
 * (FfmpegInstall.tsx) — and two of its best features quietly depend on it:
 * the picture and sound details on a title's page, and Kinema's own intro and
 * credits detection. Without it both are simply absent, and nothing anywhere
 * says why. Settings has always said so, but only to someone who went looking.
 *
 * Like the equipment notice it is one quiet line in the flow of Home, and "OK"
 * is for good: someone who does not want the extras is not asked again.
 *
 * Where Kinema cannot run programs at all (Android, `runs_programs`), ffmpeg
 * is never missing: there is nothing anyone could install, so nothing says so.
 */
import { useEffect, useState } from 'react';
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { ffmpegStatus, FFMPEG_PATH_KEY } from '../library/api';
import { getSetting, setSetting } from '../metadata/api';

export const FFMPEG_NOTICE_DISMISSED_KEY = 'ffmpeg_notice_dismissed';

/** Whether Home should say so: ffmpeg cannot be found, and it was not waved away. */
export function ffmpegNoticeWanted(available: boolean, dismissed: boolean): boolean {
  return !available && !dismissed;
}

/** Whether the configured ffmpeg cannot be run. A failed check is not "missing". */
export async function ffmpegMissing(): Promise<boolean> {
  await loadCapabilities();
  if (!capabilitiesNow()?.runs_programs) return false;
  const configured = ((await getSetting(FFMPEG_PATH_KEY)) ?? '').trim();
  const status = await ffmpegStatus(configured);
  return !status.available;
}

export async function readFfmpegNotice(): Promise<boolean> {
  const dismissed = await getSetting(FFMPEG_NOTICE_DISMISSED_KEY).catch(() => null);
  return ffmpegNoticeWanted(!(await ffmpegMissing()), Boolean(dismissed));
}

/**
 * For a title's page: whether to say why its picture and sound details are
 * missing. Asked each time a page opens (one quick `-version`), so installing
 * ffmpeg takes effect without restarting Kinema.
 */
export function useFfmpegMissing(): boolean {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    ffmpegMissing()
      .then((m) => live && setMissing(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return missing;
}

export const dismissFfmpegNotice = () => setSetting(FFMPEG_NOTICE_DISMISSED_KEY, 'yes');

const VIDEO_FORMATS: Record<string, string> = { hevc: 'HEVC', h264: 'H.264' };
const SOUND_FORMATS: Record<string, string> = {
  eac3: 'E-AC-3',
  ac3: 'AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
};

function list(words: string[]): string {
  return words.length < 2
    ? words.join('')
    : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * What an ffmpeg that runs but cannot decode some formats costs, in words
 * (`ffmpeg_lacks`, ffmpeg.rs) — or null when it lacks nothing Kinema uses.
 *
 * Each consequence is what the code does with such a file: the picture
 * measurement and the black-frame search decode video (aspect.rs, ffmpeg.rs
 * `black_periods`), HDR10+ and Dolby Vision's extra layer are read from
 * decoded frames (probe.rs), and listening decodes the first sound track
 * (analyse.rs). The rest of a title's page comes from the file's headers.
 */
export function ffmpegLacksWords(lacks: string[]): string | null {
  const video = lacks.map((f) => VIDEO_FORMATS[f]).filter(Boolean);
  const sound = lacks.map((f) => SOUND_FORMATS[f]).filter(Boolean);
  if (video.length === 0 && sound.length === 0) return null;
  const formats = [
    ...(video.length > 0 ? [`${list(video)} video`] : []),
    ...(sound.length > 0 ? [`${list(sound)} sound`] : []),
  ];
  const costs = [
    ...(video.length > 0
      ? [
          `for ${list(video)} video, the picture shape is not measured, end credits are not found by their black frames, and HDR10+ and Dolby Vision’s extra layer are not shown`,
        ]
      : []),
    ...(sound.length > 0
      ? [
          `for files whose first sound track is ${list(sound)}, intros and credits are not found by listening`,
        ]
      : []),
  ];
  return (
    `This ffmpeg cannot decode ${formats.join(' or ')} — some systems’ own builds leave them ` +
    `out, Fedora’s ffmpeg-free among them. So ${costs.join('; and ')}. Everything else ` +
    `works. A full build of ffmpeg has them (on Fedora, from RPM Fusion).`
  );
}

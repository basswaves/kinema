/**
 * "Two things need ffmpeg": the notice on Home, and the line on a title's page.
 *
 * ffmpeg is the one program Kinema will not install for you (it ships nothing
 * and downloads nothing), and two of its best features quietly depend on it:
 * the picture and sound details on a title's page, and Kinema's own intro and
 * credits detection. Without it both are simply absent, and nothing anywhere
 * says why. Settings has always said so, but only to someone who went looking.
 *
 * Like the equipment notice it is one quiet line in the flow of Home, and "OK"
 * is for good: someone who does not want the extras is not asked again.
 */
import { useEffect, useState } from 'react';
import { ffmpegStatus, FFMPEG_PATH_KEY } from '../library/api';
import { getSetting, setSetting } from '../metadata/api';

export const FFMPEG_NOTICE_DISMISSED_KEY = 'ffmpeg_notice_dismissed';

/** Whether Home should say so: ffmpeg cannot be found, and it was not waved away. */
export function ffmpegNoticeWanted(available: boolean, dismissed: boolean): boolean {
  return !available && !dismissed;
}

/** Whether the configured ffmpeg cannot be run. A failed check is not "missing". */
export async function ffmpegMissing(): Promise<boolean> {
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

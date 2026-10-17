/**
 * The sound output going away mid-film — an AV receiver switched off, a USB
 * headset pulled out (TV-FEEL.md, P3). Without this the film plays on with
 * the sound going nowhere, or to whatever the system picked instead, and
 * whoever comes back to the sofa has missed part of it.
 *
 * Only what mpv itself reports, read back every couple of seconds while a
 * film plays (scalar properties; never the node format, docs/GOTCHAS.md):
 *
 *  - **the device left the list**: the device the sound was sent to was in
 *    mpv's `audio-device-list` and is not any more (Windows lists only devices
 *    that are there; a receiver that powers its HDMI input down takes its
 *    endpoint with it);
 *  - **the output closed**: mpv had an audio output (`current-ao`) and has none
 *    now, read twice a moment apart so a track change's reopen does not count.
 *
 * Either one pauses the film and says so. Whether a given receiver does
 * either when it goes to standby depends on the receiver — many pass HDMI
 * through and nothing changes at all — so when neither happens, nothing
 * happens: the film plays as before (CLAUDE.md, "leave it, play the film").
 * Each change in the list is logged, so app.log shows what a receiver did.
 */
import { readProperty } from './engine';

/** What mpv reports about the sound at one moment. */
export interface SoundSnapshot {
  /** mpv's names for the devices it lists, or null if it would not say. */
  devices: string[] | null;
  /** mpv's audio output driver while one is open (`wasapi`), else null. */
  ao: string | null;
}

export type SoundLoss = 'device' | 'output';

/**
 * Whether the sound went away between `before` and `now`. `watched` is mpv's
 * name for the device the sound was sent to, when Kinema knows it. A device
 * that was never seen in the list does not count as gone: a name that does
 * not match mpv's spelling must never pause a film.
 */
export function soundLost(
  watched: string | null,
  before: SoundSnapshot,
  now: SoundSnapshot
): SoundLoss | null {
  if (
    watched &&
    before.devices?.includes(watched) &&
    now.devices !== null &&
    !now.devices.includes(watched)
  ) {
    return 'device';
  }
  if (before.ao && !now.ao) return 'output';
  return null;
}

/** mpv's sound devices and output, now. */
export async function readSound(): Promise<SoundSnapshot> {
  const [count, ao] = await Promise.all([
    readProperty<number>('audio-device-list/count', 'int64'),
    readProperty<string>('current-ao', 'string'),
  ]);
  let devices: string[] | null = null;
  if (count !== null) {
    const names = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        readProperty<string>(`audio-device-list/${i}/name`, 'string')
      )
    );
    // A name that could not be read makes the whole list unreliable.
    devices = names.every((n) => n !== null) ? (names as string[]) : null;
  }
  return { devices, ao: ao || null };
}

const PAUSED_FOR_IT = 'went away, so the film is paused. Press Play to go on.';

/** What the player says when it paused for this. */
export function soundLostNotice(deviceName: string | null): string {
  const what = deviceName ? `The sound device (${deviceName})` : 'The sound output';
  return `${what} ${PAUSED_FOR_IT}`;
}

/** Whether `notice` is that one: it stays up for as long as the film is paused. */
export const isSoundLostNotice = (notice: string) => notice.endsWith(PAUSED_FOR_IT);

/**
 * A show's chosen version carries to the episodes either side (versions.ts):
 * where the next or previous episode is here more than once, the file is the
 * one with the same words as the show's last choice — else the best fit for
 * the screen, as the title page's Play would pick — never whichever file the
 * library happened to list first.
 */
import { pickVersion, readVersions, titleVersions, versionChoice } from '../library/versions';
import type { EpisodeRef } from './api';
import { screenCanShow } from './displaySwitch';

export async function inChosenVersion(
  ref: EpisodeRef | null,
  titleId: number | null
): Promise<EpisodeRef | null> {
  // A video in a folder or a playlist item is played as it is.
  if (!ref || ref.video || ref.target || titleId === null) return ref;
  try {
    const files = (await titleVersions(titleId)).filter(
      (f) => f.season === ref.season && f.episode === ref.episode
    );
    if (files.length < 2) return ref;
    const [named, choice, screen] = await Promise.all([
      readVersions(files),
      versionChoice(titleId).catch(() => null),
      screenCanShow().catch(() => null),
    ]);
    const v = pickVersion(named, choice, screen);
    return v ? { ...ref, file_id: v.file_id, path: v.path } : ref;
  } catch (e) {
    console.warn('versions of the next episode unreadable', e);
    return ref;
  }
}

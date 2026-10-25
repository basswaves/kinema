/**
 * A title page's versions (versions.ts): the films or episodes here more than
 * once, the choice made last time, and what the screen can show — and, for
 * the film or episode Play means, its versions named and the one picked.
 */
import { useEffect, useState } from 'react';
import { screenCanShow } from '../player/displaySwitch';
import {
  groupVersions,
  pickVersion,
  readVersions,
  titleVersions,
  versionChoice,
  type ScreenCan,
  type Version,
  type VersionChoice,
  type VersionFile,
} from '../library/versions';

export interface TitleVersions {
  groups: Map<string, VersionFile[]>;
  choice: VersionChoice | null;
  setChoice: (choice: VersionChoice) => void;
  screen: ScreenCan | null;
}

/** Read again when `reload` changes (the page's detail, after a scan or a toggle). */
export function useTitleVersions(titleId: number, reload: unknown): TitleVersions {
  const [groups, setGroups] = useState<Map<string, VersionFile[]>>(new Map());
  const [choice, setChoice] = useState<VersionChoice | null>(null);
  const [screen, setScreen] = useState<ScreenCan | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      titleVersions(titleId).catch(() => [] as VersionFile[]),
      versionChoice(titleId).catch(() => null),
    ]).then(async ([files, chosen]) => {
      const found = groupVersions(files);
      // The screen only matters where there is something to choose between.
      const can = found.size > 0 ? await screenCanShow() : null;
      if (!live) return;
      setGroups(found);
      setChoice(chosen);
      setScreen(can);
    });
    return () => {
      live = false;
    };
  }, [titleId, reload]);
  return { groups, choice, setChoice, screen };
}

/** One film's or episode's versions, named, and the one Play means. */
export function useChosenVersion(
  files: VersionFile[] | undefined,
  choice: VersionChoice | null,
  screen: ScreenCan | null
): { versions: Version[]; chosen: Version | null } {
  const [versions, setVersions] = useState<Version[]>([]);
  const ids = files?.map((f) => f.file_id).join(',') ?? '';
  useEffect(() => {
    // Fewer than two files: nothing to read; `shown` below is then empty.
    if (!files || files.length < 2) return;
    let live = true;
    void readVersions(files).then((named) => live && setVersions(named));
    return () => {
      live = false;
    };
    // The ids stand for the files: a new array with the same files is the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const shown = versions.filter((v) => files?.some((f) => f.file_id === v.file_id));
  return { versions: shown, chosen: pickVersion(shown, choice, screen) };
}

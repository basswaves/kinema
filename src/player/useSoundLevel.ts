import { useCallback, useEffect, useState } from 'react';
import type { PlaybackTarget } from './api';
import { hasMpv, type Track } from './engine';
import {
  applyLevel,
  canLiftDialogue,
  describeLevel,
  readLevel,
  saveLevel,
  type NotApplied,
  type SoundLevel,
} from './soundLevel';

/**
 * The player's side of levelling and the dialogue lift (soundLevel.ts): this
 * title's level, put on whenever the playing track changes — a track that
 * goes to the receiver untouched gets none — and changed from the panel,
 * kept for the title and said in a notice.
 */
export function useSoundLevel({
  target,
  tracks,
  aid,
  say,
}: {
  target: PlaybackTarget;
  tracks: Track[];
  aid: number | null;
  say: (text: string) => void;
}) {
  const titleKey = target.titleId !== null ? `title:${target.titleId}` : `file:${target.path}`;
  const [level, setLevel] = useState<SoundLevel | null>(null);
  const [notApplied, setNotApplied] = useState<NotApplied>(null);

  useEffect(() => {
    if (!hasMpv()) return;
    let live = true;
    void readLevel(titleKey).then((l) => {
      if (live) setLevel(l);
    });
    return () => {
      live = false;
    };
  }, [titleKey]);

  const playing = tracks.find((t) => t.type === 'audio' && t.id === aid);
  const codec = playing?.codec;
  const layout = playing?.layout;

  useEffect(() => {
    if (!level || aid === null || !hasMpv()) return;
    let live = true;
    void applyLevel(level, { codec, layout })
      .then((n) => {
        if (live) setNotApplied(n);
      })
      .catch((e) => console.warn('audio: levelling not applied', e));
    return () => {
      live = false;
    };
  }, [level, aid, codec, layout]);

  const changeLevel = useCallback(
    (next: SoundLevel) => {
      setLevel(next);
      say(`${describeLevel(next)}, for this title`);
      void saveLevel(titleKey, next).catch((e) => console.warn('audio: levelling not kept', e));
    },
    [titleKey, say]
  );

  return { level, notApplied, canLift: canLiftDialogue(layout), changeLevel };
}

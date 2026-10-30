import { useCallback, useEffect, useState } from 'react';
import type { PlaybackTarget } from './api';
import { hasMpv, type Track } from './engine';
import {
  applyLevel,
  canLiftDialogue,
  decodedAfterAll,
  describeLevel,
  readLevel,
  saveLevel,
  type NotApplied,
  type SoundLevel,
} from './soundLevel';

/** Long enough for mpv to have opened the sound, or given up on passthrough. */
const PASSTHROUGH_CHECK_MS = 3000;

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
    let check = 0;
    void applyLevel(level, { codec, layout })
      .then((n) => {
        if (!live) return;
        setNotApplied(n);
        // Listed for passthrough is not passed through: a device that says
        // no gets decoded sound, and then the level is Kinema's to apply.
        if (n === 'passthrough') {
          check = window.setTimeout(() => {
            void decodedAfterAll().then(async (decoded) => {
              if (!live || !decoded) return;
              setNotApplied(await applyLevel(level, { codec, layout }, true));
            });
          }, PASSTHROUGH_CHECK_MS);
        }
      })
      .catch((e) => console.warn('audio: levelling not applied', e));
    return () => {
      live = false;
      window.clearTimeout(check);
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

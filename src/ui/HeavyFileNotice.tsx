/**
 * The line under Play when a file is far heavier than Android says this
 * device's video chip is made for (`heavyFile.ts` has the rule and the
 * reason). Only where Media3 plays; on a desktop nothing is asked or shown.
 *
 * Not focusable, like the badges beside it: it is read, never pressed, and
 * Play still works.
 */
import { useEffect, useState } from 'react';
import { useCapabilities } from '../capabilities';
import { decoderLimits } from '../player/engine';
import { fileFacts, releaseNames } from './badges';
import { heavyFileNotice, type DecoderLimits } from './heavyFile';

/** Asked of Android once: a device's decoders do not change while it runs. */
let limitsAsked: Promise<DecoderLimits | null> | null = null;
function limits(): Promise<DecoderLimits | null> {
  limitsAsked ??= decoderLimits().catch((e) => {
    console.warn('decoder limits: Android did not say', e);
    return null;
  });
  return limitsAsked;
}

interface Props {
  /** The file Play would start. */
  fileId: number | null;
  /** The title's (or the episode's) runtime, for a file not yet read for its length. */
  runtimeMins: number | null;
  what: 'film' | 'episode';
}

/** What was worked out, and for which file — so another file's line is never shown. */
interface Said {
  fileId: number;
  text: string | null;
}

export default function HeavyFileNotice({ fileId, runtimeMins, what }: Props) {
  const android = useCapabilities()?.engine === 'media3';
  const [said, setSaid] = useState<Said | null>(null);

  useEffect(() => {
    if (!android || fileId === null) return;
    let live = true;
    Promise.all([fileFacts(fileId), limits()])
      .then(([facts, found]) => {
        if (!live || !facts) return;
        const video = facts.details?.video;
        const text = heavyFileNotice(
          {
            sizeBytes: facts.size_bytes,
            // The file's own length when it has been read; else the title's.
            durationSecs: facts.details?.duration_secs ?? (runtimeMins ? runtimeMins * 60 : null),
            codec: video?.codec,
            width: video?.width,
            names: releaseNames(facts),
            what,
          },
          found
        );
        setSaid({ fileId, text });
      })
      .catch((e) => console.warn('heavy file check failed', e));
    return () => {
      live = false;
    };
  }, [android, fileId, runtimeMins, what]);

  if (!android || said === null || said.fileId !== fileId || !said.text) return null;
  return <p className="heavy-file-note">{said.text}</p>;
}

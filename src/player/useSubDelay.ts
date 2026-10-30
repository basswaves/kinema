import { useCallback, useState } from 'react';
import { hasMpv } from './engine';
import { appliedSubDelay, changeSubDelay, describeSubDelay } from './subDelay';

/**
 * The player's side of subtitle timing (subDelay.ts): the amount the panel
 * shows, and a step from the keys or the panel, said in a notice. Read from
 * what was last applied at every render, so a new file shows its own.
 */
export function useSubDelay(say: (text: string) => void) {
  const [, setChanged] = useState(0);

  const changeTiming = useCallback(
    (delta: number, reset = false) => {
      if (!hasMpv()) return;
      void changeSubDelay(delta, reset)
        .then((ms) => {
          setChanged((n) => n + 1);
          say(`${describeSubDelay(ms)}, for this file`);
        })
        .catch((e) => console.warn('subtitles: timing not kept', e));
    },
    [say]
  );

  return { subDelayMs: appliedSubDelay().ms, changeTiming };
}

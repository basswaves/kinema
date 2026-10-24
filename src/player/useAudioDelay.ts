import { useCallback, useState } from 'react';
import { hasMpv } from './engine';
import { appliedDelay, changeAudioDelay, describeDelay } from './audioDelay';

/**
 * The player's side of the sound delay (audioDelay.ts): the amount the panel
 * shows, and a step from the keys or the panel, said in a notice. The amount
 * is read from what was last applied at every render, so a new file on
 * another device shows its own.
 */
export function useAudioDelay(say: (text: string) => void) {
  const [, setChanged] = useState(0);

  const changeDelay = useCallback(
    (delta: number, reset = false) => {
      if (!hasMpv()) return;
      void changeAudioDelay(delta, reset)
        .then((ms) => {
          setChanged((n) => n + 1);
          say(`${describeDelay(ms)} for this device`);
        })
        .catch((e) => console.warn('audio: delay not kept', e));
    },
    [say]
  );

  return { delayMs: appliedDelay().ms, changeDelay };
}

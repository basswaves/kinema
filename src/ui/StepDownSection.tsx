/**
 * Settings → Advanced → Picture steps given up: what the player gave up to
 * keep up on a graphics card that fell behind (player/stepDown.ts), and a
 * line that forgets it. A reset, not a choice of quality: Kinema still picks
 * every rendering option itself, and steps down again only if frames drop.
 *
 * Only where mpv draws the picture; Media3 has no steps.
 */
import { useCallback, useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import { STEPS, forgetStepDown, rememberedStepDowns, type StepState } from '../player/stepDown';

/** What is remembered, one line per graphics card; empty when nothing is. */
export function stepDownWords(memory: Record<string, StepState>): string[] {
  return Object.entries(memory).map(
    ([device, s]) =>
      `Given up on ${device}: ${STEPS.slice(0, s.level)
        .map((step) => step.label)
        .join('; ')}.`
  );
}

/** What the reset did, plainly. */
export function forgotWords(devices: number): string {
  return devices === 0
    ? 'Nothing was remembered, so nothing changed.'
    : `Forgot what was given up on ${devices === 1 ? 'one graphics card' : `${devices} graphics cards`}. The next film plays with the full picture, and steps down again only if the card drops frames.`;
}

export default function StepDownSection() {
  const can = useCapabilities();
  const [memory, setMemory] = useState<Record<string, StepState> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mpv = can?.engine === 'mpv';

  const read = useCallback(() => {
    rememberedStepDowns()
      .then(setMemory)
      .catch((e: unknown) => setError(userError(e)));
  }, []);
  useEffect(() => {
    if (mpv) read();
  }, [mpv, read]);
  if (!mpv) return null;

  const words = memory ? stepDownWords(memory) : [];
  return (
    <section className="settings-section">
      <h2>Picture steps given up</h2>
      <p className="settings-intro">
        When a graphics card drops frames, the player gives up the cheapest part of the picture
        first and remembers it for that card. After a few films that play clean it tries one step
        back by itself.
      </p>
      {memory !== null && words.length === 0 && (
        <p className="settings-hint">Nothing is given up: every film gets the full picture.</p>
      )}
      {words.map((line) => (
        <p key={line} className="settings-hint">
          {line}
        </p>
      ))}
      <FocusButton
        className="btn-secondary"
        onSelect={() =>
          void (async () => {
            setError(null);
            try {
              setNote(forgotWords(await forgetStepDown()));
              read();
            } catch (e) {
              setError(userError(e));
            }
          })()
        }
      >
        Forget the steps given up
      </FocusButton>
      {note && <p className="settings-ok">{note}</p>}
      {error && <p className="settings-warn">{error}</p>}
    </section>
  );
}

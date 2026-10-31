/**
 * Choose a title's poster (T20): the picture beside its files, if there is
 * one, and TMDB's posters for it, asked for when this opens. The choice is
 * the person's, kept by the title's ids over every refresh (metadata.rs
 * `poster_choice`); nothing is written beside the files.
 *
 * A menu like the Version list: the ring stays in it, Back closes it and the
 * ring goes back to the button that opened it (focusStore.ts does both). The posters are one row that
 * scrolls, never a wrapped grid a remote could not reach the second line of.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusGroup } from './focusGroups';
import { navFocus } from './focusStore';
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import Art from './Art';
import { sizedPoster } from './poster';
import { posterChoices, type PosterChoice, type PosterChoices } from '../library/posters';

const choiceKey = (index: number) => `poster-choice:${index}`;

interface Props {
  titleId: number;
  name: string;
  onChosen: () => void;
  onClose: () => void;
}

export default function PosterDialog({ titleId, name, onChosen, onClose }: Props) {
  const { ref, focusKey } = useFocusGroup('menu');
  const [found, setFound] = useState<PosterChoices | null>(null);
  const choices = found?.choices ?? null;

  useEffect(() => {
    let cancelled = false;
    void posterChoices(titleId, (next) => !cancelled && setFound(next)).catch((e) =>
      console.warn('posters not listed', e)
    );
    return () => {
      cancelled = true;
    };
  }, [titleId]);

  // Onto the poster shown now, once the list is drawn (it comes after
  // Cancel, which holds the ring meanwhile) — once.
  const current = choices ? Math.max(0, choices.findIndex((c) => c.current)) : -1;
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (current < 0 || landed.current) return;
    landed.current = navFocus(choiceKey(current));
  }, [current]);

  const close = onClose;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const choose = useCallback(
    async (choice: PosterChoice) => {
      try {
        await choice.choose();
        onChosen();
      } catch (e) {
        console.warn('poster choice not kept', e);
      }
      close();
    },
    [onChosen, close]
  );

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={close}>
        <div
          className="leave posters"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Poster"
        >
          <h2>Poster</h2>
          <p className="muted">
            The picture {name} shows everywhere in Kinema. Kept when its details are fetched again.
          </p>
          {(found === null || found.asking) && <p className="muted">Asking TMDB for its posters…</p>}
          {found?.note && <p className="muted">{found.note}</p>}
          {choices && choices.length > 0 && (
            <FocusGroup kind="row" className="poster-choices" current={choiceKey(current)}>
              {choices.map((choice, i) => (
                <FocusButton
                  key={choice.id}
                  focusKey={choiceKey(i)}
                  className={`poster-choice ${choice.current ? 'version-current' : ''}`}
                  keepInView="nearest"
                  label={`${choice.words}${choice.current ? ', the one shown now' : ''}`}
                  onSelect={() => void choose(choice)}
                >
                  <Art
                    className="poster-choice-art"
                    local={choice.local}
                    remote={choice.remote ? sizedPoster(choice.remote, 'w500') : null}
                    lazy
                    fallback={<div className="poster-choice-art" />}
                  />
                  <span className="poster-choice-words">
                    {choice.current ? '✓ ' : ''}
                    {choice.words}
                  </span>
                </FocusButton>
              ))}
            </FocusGroup>
          )}
          <FocusButton className="leave-choice" onSelect={close}>
            Cancel
          </FocusButton>
        </div>
      </div>
    </FocusProvider>
  );
}

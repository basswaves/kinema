/**
 * Play something's answer (somethingPick.ts): what it picked — poster, name,
 * one line why — with Play and Another, before anything plays. A pick is a
 * suggestion; starting a film nobody chose would be a surprise.
 *
 * A menu like the leave dialog: focus never leaves it, Back closes it and the
 * ring goes back to where it was.
 */
import { useCallback, useEffect, useState } from 'react';
import { FocusProvider } from './FocusGroup';
import { useFocusGroup } from './focusGroups';
import FocusButton from './FocusButton';
import Art from './Art';
import DrawnPoster from './DrawnPoster';
import { sizedPoster } from './poster';
import type { Title } from './api';
import { episodeRefName, firstUnwatchedEpisode, type ContinueItem } from '../player/api';
import { candidates, pick, remember, whyLine, type Pool } from './somethingPick';

const PLAY_KEY = 'something-play';

interface Props {
  pool: Pool;
  resumable: ContinueItem[];
  onPlay: (title: Title) => void;
  onClose: () => void;
}

function code(season: number | null, episode: number | null, name: string | null): string | null {
  if (season === null || episode === null) return null;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return name ? `S${s}E${e} · ${name}` : `S${s}E${e}`;
}

export default function PlaySomething({ pool, resumable, onPlay, onClose }: Props) {
  const { ref, focusKey } = useFocusGroup('menu', { current: PLAY_KEY });

  const draw = useCallback(() => {
    const resuming = new Set(
      resumable.filter((item) => item.kind !== 'video').map((item) => item.title_id)
    );
    const picked = pick(candidates(pool.titles, resuming));
    if (picked) remember(picked);
    return picked;
  }, [pool, resumable]);
  // The first pick as the dialog opens (remembering it twice in a strict
  // development render is harmless: `remember` keeps one of each).
  const [choice, setChoice] = useState<Title | null>(draw);
  /** A show's next episode as asked, for the title it was asked for. */
  const [asked, setAsked] = useState<{ id: number; next: string | null } | null>(null);
  const resumeOf = useCallback(
    (id: number) => resumable.find((item) => item.kind !== 'video' && item.title_id === id),
    [resumable]
  );
  const another = useCallback(() => {
    setChoice(draw());
  }, [draw]);

  // A show says which episode would play, as its own page does: the one
  // stopped part-way, else the first not watched.
  const resumeItem = choice ? resumeOf(choice.id) : undefined;
  const askFor = choice?.kind === 'series' && !resumeItem ? choice.id : null;
  useEffect(() => {
    if (askFor === null) return;
    let live = true;
    void firstUnwatchedEpisode(askFor)
      .then((ep) => live && setAsked({ id: askFor, next: ep ? episodeRefName(ep) : null }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [askFor]);
  const next = resumeItem
    ? code(resumeItem.season, resumeItem.episode, resumeItem.episode_name)
    : asked && asked.id === askFor
      ? asked.next
      : null;

  // Closed without playing, the ring goes back where it was (a dialog does
  // by itself, focusStore.ts); Another leaves the ring on Another.
  const cancel = useCallback(() => onClose(), [onClose]);

  // Capture phase, as the leave dialog: Browse's Back must not see this press.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancel]);

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={cancel}>
        <div
          className="leave something"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Play something"
        >
          <h2>Play something</h2>
          {choice ? (
            <div className="something-pick">
              <div className="something-poster">
                <Art
                  local={choice.poster_path}
                  remote={sizedPoster(choice.poster_url, 'w500')}
                  fallback={<DrawnPoster title={choice.title} year={choice.year} />}
                />
              </div>
              <div className="something-name">
                {choice.title}
                {choice.year ? <span className="muted"> ({choice.year})</span> : null}
              </div>
              <p className="something-why muted">
                {whyLine(choice, Boolean(resumeItem) || choice.progress !== null, next, pool.from)}
              </p>
            </div>
          ) : (
            <p className="muted">
              {pool.from
                ? `Everything in ${pool.from} has been watched.`
                : 'Everything here has been watched.'}
            </p>
          )}
          <div className="leave-choices">
            {choice && (
              <FocusButton
                focusKey={PLAY_KEY}
                className="leave-choice"
                onSelect={() => {
                  onClose();
                  onPlay(choice);
                }}
              >
                ▶ Play
              </FocusButton>
            )}
            {choice && (
              <FocusButton className="leave-choice" onSelect={another}>
                Another
              </FocusButton>
            )}
            <FocusButton
              focusKey={choice ? undefined : PLAY_KEY}
              className="leave-choice leave-cancel"
              onSelect={cancel}
            >
              {choice ? 'Not now' : 'OK'}
            </FocusButton>
          </div>
        </div>
      </div>
    </FocusProvider>
  );
}

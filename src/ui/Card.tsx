/**
 * A poster card. Focusable via the spatial navigation system so the same
 * component serves mouse and D-pad without a separate TV variant — building
 * two card components would guarantee they drift apart.
 */
import { getCurrentFocusKey, navigateByDirection } from '@noriginmedia/norigin-spatial-navigation';
import { memo, useEffect } from 'react';
import { FocusProvider } from './FocusGroup';
import { useFocusLeaf } from './focusGroups';
import Art from './Art';
import DrawnPoster from './DrawnPoster';
import type { Title } from './api';
import { posterState, sizedPoster } from './poster';
import { currentFocusKey, keepOnScreen, recoverFocusSoon } from './focus';
import { isMyListKey, toggleMyList, useOnMyList } from '../library/myList';
import { HOLD_MS, NO_RELEASE_MS, isMenuKey, openCardMenu } from './cardMenuStore';

interface Props {
  title: Title;
  onSelect: (title: Title) => void;
  /**
   * Stable across remounts, so Back can put focus back on this card. Unique per
   * place the card appears: the same title sits in several rails at once.
   */
  focusKey?: string;
  /** A line under the title saying why it is here — "with …" in search. */
  note?: string | null;
  /** On My list's own rail: taking it off takes the card away too. */
  goesWhenUnlisted?: boolean;
}

/**
 * Memoised: a rail redraws itself every time focus enters or leaves it, and
 * its thirty cards have no reason to follow. Their props are stable — the
 * title rows are the ones already on screen when a reload brought back the
 * same data (keepSame.ts) and `onSelect` is one function for the whole shell.
 */
export default memo(function Card({ title, onSelect, focusKey: key, note, goesWhenUnlisted }: Props) {
  const { ref, focused, focusKey, kinema, navProps } = useFocusLeaf({
    focusKey: key,
    onSelect: () => onSelect(title),
    extraProps: { titleId: title.id },
  });

  const state = posterState(title);
  const listed = useOnMyList(title.id);

  // Keep the focused card on screen when navigating by remote (Kinema's own
  // engine has its one rule for that, focusScroll.ts).
  useEffect(() => {
    if (focused && !kinema) {
      keepOnScreen(ref.current);
    }
  }, [focused, kinema, ref]);

  // L puts the focused card on My list or takes it off. Only the focused
  // card listens, so one press is one card. A remote has no letters: the
  // title's page has the button, and a menu on cards is round 6's.
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isMyListKey(e)) return;
      e.preventDefault();
      // On Kinema's engine the ring goes to the card sliding into its place
      // by itself when this one goes (focusModel.ts, `recover`).
      if (goesWhenUnlisted && listed && !kinema) {
        // The ring moves on to the card beside it first, while this one is
        // still there to measure from; the last card takes the rail with it.
        const here = getCurrentFocusKey();
        navigateByDirection('right', {});
        if (getCurrentFocusKey() === here) navigateByDirection('left', {});
        if (getCurrentFocusKey() === here) recoverFocusSoon();
      }
      void toggleMyList(title.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, title.id, goesWhenUnlisted, listed, kinema]);

  // OK chooses on its release, so that OK held can be the card's menu
  // (cardMenuStore.ts); the Menu key opens it at once. Ahead of the spatial
  // library (capture phase), which would open the page on the key going down.
  useEffect(() => {
    if (!focused) return;
    let downAt = 0;
    let fallback = 0;
    const settle = (menu: boolean) => {
      window.clearTimeout(fallback);
      downAt = 0;
      if (menu) openCardMenu(title, focusKey, 'held');
      else onSelect(title);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isMenuKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        openCardMenu(title, focusKey);
        return;
      }
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey) return;
      // Every Enter, repeats included: one let through would reach the menu
      // this hold just opened, before it is ready to refuse it.
      e.preventDefault();
      e.stopPropagation();
      if (!downAt) {
        if (e.repeat) return; // the tail of a hold already decided
        downAt = performance.now();
        // No release and no repeats: a remote that cannot hold; a press.
        fallback = window.setTimeout(() => downAt && settle(false), NO_RELEASE_MS);
      } else if (performance.now() - downAt >= HOLD_MS) {
        settle(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !downAt) return;
      e.stopPropagation();
      settle(performance.now() - downAt >= HOLD_MS);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.clearTimeout(fallback);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [focused, title, focusKey, onSelect]);

  return (
    <FocusProvider value={focusKey}>
      <div
        ref={ref}
        className={`card ${focused ? 'focused' : ''}`}
        onClick={() => onSelect(title)}
        onContextMenu={(e) => {
          e.preventDefault();
          // A pointer's menu gives the ring back where it was (cardMenuStore.ts).
          openCardMenu(title, currentFocusKey(), 'pointer');
        }}
        role="button"
        tabIndex={0}
        {...navProps}
      >
        <div className="card-art">
          <Art
            local={title.poster_path}
            remote={sizedPoster(title.poster_url, 'w500')}
            lazy
            fallback={<DrawnPoster title={title.title} year={title.year} />}
          />
          {state.badge && <span className="card-badge">{state.badge}</span>}
          {/* For a pointer: the menu the remote opens by holding OK. Not a
              focus stop — a control on a card is unreachable by arrows
              (docs/GOTCHAS.md); the card itself is the remote's way in. */}
          <span
            className="card-more"
            role="button"
            aria-label={`More for ${title.title}`}
            title="More"
            onClick={(e) => {
              e.stopPropagation();
              openCardMenu(title, currentFocusKey(), 'pointer');
            }}
          >
            ⋯
          </span>
          {listed && <span className="card-listed" aria-label="On My list" title="On My list" />}
          {state.watched && (
            <span className="card-watched" aria-label="Watched">
              ✓
            </span>
          )}
          {state.progress !== null && (
            <span className="card-progress" aria-hidden="true">
              <span style={{ width: `${state.progress * 100}%` }} />
            </span>
          )}
        </div>
        <div className="card-title">{title.title}</div>
        <div className="card-meta">
          {title.year ?? ''}
          {title.rating ? ` · ★ ${title.rating.toFixed(1)}` : ''}
        </div>
        {note && <div className="card-note">{note}</div>}
      </div>
    </FocusProvider>
  );
});

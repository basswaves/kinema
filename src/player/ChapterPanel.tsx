/**
 * The file's chapters, as a list in the player (PLAN phase 2): the one
 * playing marked, OK jumps to the one under the ring. Only when the file has
 * chapters to choose between — the bar has no button otherwise. Pictures of
 * each scene come with the seek preview, later.
 */
import FocusButton from '../ui/FocusButton';
import { FocusProvider } from '../ui/FocusGroup';
import { useFocusGroup } from '../ui/focusGroups';
import { formatTime } from '../ui/format';
import type { Chapter } from './engine';
import { chapterAt, chapterName } from './chapters';

/** The panel: a dialog on the focus engine, which lands on the chapter playing. */
export const CHAPTER_PANEL_KEY = 'player-chapter-panel';
const chapterKey = (index: number) => `player-chapter-${index}`;

/**
 * A component of its own for the reason TrackPanel is: `useFocusable` reads
 * the focus context of the component it is called in.
 */
export default function ChapterPanel({
  chapters,
  timePos,
  onJump,
  onClose,
}: {
  chapters: Chapter[];
  timePos: number;
  onJump: (chapter: Chapter) => void;
  onClose: () => void;
}) {
  const current = chapterAt(chapters, timePos);
  // A closed menu, as Audio & subtitles is (docs/GOTCHAS.md): the ring stays
  // in the list, Back closes it, and it opens on the chapter playing.
  const { ref, focusKey } = useFocusGroup<HTMLElement>('menu', {
    focusKey: CHAPTER_PANEL_KEY,
    current: chapterKey(Math.max(0, current)),
  });

  return (
    <FocusProvider value={focusKey}>
      <aside className="track-panel chapter-panel" ref={ref} aria-label="Chapters">
        <div className="track-panel-head">
          <span>Chapters</span>
          <FocusButton onSelect={onClose}>close</FocusButton>
        </div>
        {chapters.map((chapter, i) => (
          <FocusButton
            key={i}
            focusKey={chapterKey(i)}
            className={`track-option chapter-option ${i === current ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onJump(chapter)}
          >
            <span className="chapter-time">{formatTime(chapter.time)}</span>
            {chapterName(chapter, i)}
          </FocusButton>
        ))}
      </aside>
    </FocusProvider>
  );
}

/** The file's chapters, for the chapter list (ChapterPanel). */
import type { Chapter } from './engine';

/** The chapter `time` is in: the last one to have started. -1 before the first. */
export function chapterAt(chapters: Chapter[], time: number): number {
  let at = -1;
  chapters.forEach((c, i) => {
    // Half a second short still counts: a jump lands on the keyframe before.
    if (c.time <= time + 0.5) at = i;
  });
  return at;
}

/** A chapter's name: its own, or its number where the file only numbers them. */
export const chapterName = (chapter: Chapter, index: number) =>
  chapter.title?.trim() || `Chapter ${index + 1}`;

/**
 * The sections of Settings, by what someone wants rather than by service
 * (owner, 2026-10-23: "Fewer service names in the way", option A). A
 * service's name is on the row or card that uses it, one level down: SIMKL
 * and Trakt under Keep track of what I watch, OpenSubtitles under Language &
 * subtitles, TheIntroDB, IntroDB and Skiptro under Skipping intros, TMDB and
 * OMDb under Posters & ratings.
 *
 * Its own file because more than Settings reads it: the Privacy page's Go to
 * buttons (whatLeaves.json names a section by id, checked by its test) and
 * the search box's index (settingsIndex.ts).
 */
export type SectionId =
  | 'library'
  | 'playback'
  | 'picture'
  | 'subtitles'
  | 'intros'
  | 'tracking'
  | 'ratings'
  | 'privacy'
  | 'advanced';

/** The list down the side, in the order someone setting up would need them. */
export const SECTIONS: [SectionId, string][] = [
  ['library', 'Library'],
  ['playback', 'Playback'],
  ['picture', 'Picture & sound'],
  ['subtitles', 'Language & subtitles'],
  ['intros', 'Skipping intros'],
  ['tracking', 'Keep track of what I watch'],
  ['ratings', 'Posters & ratings'],
  // What leaves your computer: every service, what it sends, what stops it.
  ['privacy', 'Privacy'],
  ['advanced', 'Advanced'],
];

export const SECTION_NAMES: Record<SectionId, string> = Object.fromEntries(SECTIONS) as Record<
  SectionId,
  string
>;

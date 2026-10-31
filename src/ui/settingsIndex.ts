/**
 * What Settings' search box looks through (PLAN.md phase 1, "Search box in
 * Settings"): every setting by its name, the words that say what it does, and
 * the choices it offers, with the section it is in.
 *
 * Written out rather than read from the screen, because only the open
 * section is drawn: the others are not there to read. The cost is drift, so
 * `settingsIndex.test.ts` checks that every `find` text is still written in
 * the Settings code, and the e2e flows jump to a few of them for real.
 *
 * `find` is the text the jump looks for on the open section — a row's label,
 * a heading, a field's name, or a logo's name — when it is not `label`
 * itself. `when` leaves out what this system does not have (capabilities.ts),
 * so a search never offers a setting the section will not show.
 */
import type { Capabilities } from '../capabilities';
import { SECTION_NAMES, type SectionId } from './settingsSections';

export interface SettingEntry {
  section: SectionId;
  /** As the result says it. */
  label: string;
  /** The text on the section to land on, when not `label`. */
  find?: string;
  /** Other words someone might search for it by. */
  about?: string;
  /** Its choices, as their buttons say them. */
  values?: string[];
  when?: (can: Capabilities) => boolean;
}

const programs = (can: Capabilities) => can.runs_programs;

export const SETTINGS_INDEX: SettingEntry[] = [
  // Library
  {
    section: 'library',
    label: 'Folders',
    about: 'add movies folder TV folder videos folder scan now remove where my films are library',
  },
  {
    section: 'library',
    label: 'Saved network logins',
    about: 'network drive share password user name forget NAS',
    when: (can) => can.network_shares,
  },
  {
    section: 'library',
    label: 'Needs attention',
    about: 'review wrong match fix match identify unidentified',
  },
  { section: 'library', label: 'Run setup again', find: 'Setup', about: 'first run setup pages' },

  // Playback
  {
    section: 'playback',
    label: 'Where Kinema is used',
    about: 'TV mode desk window full screen F11 bigger text',
    values: ['At a desk', 'On a TV'],
    when: (can) => can.windowed,
  },
  {
    section: 'playback',
    label: 'Look',
    about: 'light slow device blur shadows animation performance',
    values: ['Auto', 'Full', 'Light'],
  },
  {
    section: 'playback',
    label: 'High contrast',
    about: 'accessibility low vision eyesight readable text contrast outline focus',
    values: ['Off', 'On'],
  },
  {
    section: 'playback',
    label: 'Still watching?',
    about: 'autoplay next episode binge stop ask sleep fell asleep',
    values: ['Off', 'On'],
  },
  {
    section: 'playback',
    label: 'Frame timing',
    about: 'stutter smooth video sync judder',
    values: ['Match the sound', 'Match the screen'],
  },
  {
    section: 'playback',
    label: 'Opening videos',
    about: 'default player open with File Explorer file manager app menu',
    when: (can) => can.offers_player,
  },

  // Picture & sound
  {
    section: 'picture',
    label: 'Match the refresh rate',
    about: 'screen Hz 23.976 24p judder display mode switching',
    when: (can) => can.display_switching,
  },
  {
    section: 'picture',
    label: 'Resolution',
    about: 'screen 4K 1080p display mode switching',
    when: (can) => can.display_switching,
  },
  {
    section: 'picture',
    label: 'Turn HDR on for HDR videos',
    about: 'screen HDR10 Dolby Vision high dynamic range',
    when: (can) => can.display_switching,
  },
  {
    section: 'picture',
    label: 'Send sound straight to the receiver',
    about: 'passthrough bitstream AV receiver Dolby Atmos DTS TrueHD amplifier',
    when: (can) => can.equipment_detection && can.audio_direct,
  },
  {
    section: 'picture',
    label: 'Sound device',
    about: 'audio output speakers HDMI',
    when: (can) => can.equipment_detection && can.audio_direct,
  },
  {
    section: 'picture',
    label: 'Sound delay',
    about: 'audio delay lip sync out of step late early milliseconds receiver',
    when: (can) => can.equipment_detection && can.audio_direct,
  },
  {
    section: 'picture',
    label: 'Volume levelling',
    about: 'loudness normalise night mode quiet loud explosions whisper compress dynamic range',
    when: (can) => can.equipment_detection && can.audio_direct,
  },
  {
    section: 'picture',
    label: 'Dialogue lift',
    about: 'dialogue boost speech clear voices centre center channel hard to hear',
    when: (can) => can.equipment_detection && can.audio_direct,
  },
  {
    section: 'picture',
    label: 'Match the screen to the film',
    about: 'refresh rate resolution display',
    when: (can) => can.system_output,
  },
  {
    section: 'picture',
    label: 'Your equipment',
    about: 'TV receiver screens sound what Kinema found',
    when: (can) => can.equipment_detection,
  },

  // Language & subtitles
  {
    section: 'subtitles',
    label: 'Audio language',
    about: 'spoken language dub original sound track',
  },
  { section: 'subtitles', label: 'Subtitles', about: 'captions language text' },
  {
    section: 'subtitles',
    label: 'Forced subtitles',
    about: 'foreign parts signs alien language',
    values: ['Show them', 'Off'],
  },
  {
    section: 'subtitles',
    label: 'Audio description',
    about: 'accessibility blind low vision narrator described visually impaired AD',
    values: ['Off', 'When the file has it'],
  },
  {
    section: 'subtitles',
    label: 'Subtitles for the deaf and hard of hearing',
    about: 'accessibility SDH CC closed captions hearing impaired deaf',
    values: ['Plain ones first', 'These first'],
  },
  {
    section: 'subtitles',
    label: 'Subtitle size',
    about: 'bigger larger text read far away eyesight font scale',
    values: ['Small', 'Normal', 'Large', 'Larger'],
    when: (can) => can.engine !== 'media3',
  },
  {
    section: 'subtitles',
    label: 'Dark box behind subtitles',
    about: 'background black box contrast readable bright picture',
    values: ['Off', 'On'],
    when: (can) => can.engine !== 'media3',
  },
  {
    section: 'subtitles',
    label: 'Find forced subtitles online',
    find: 'When a file has no forced subtitles, find them online',
    about: 'OpenSubtitles download automatically',
  },
  {
    section: 'subtitles',
    label: 'OpenSubtitles',
    about: 'subtitles online sign in account user name password downloads a day',
  },

  // Skipping intros
  {
    section: 'intros',
    label: 'Intros and credits',
    about: 'skip intro skip button automatically end credits recap',
    values: ['Show a Skip button', 'Skip them'],
  },
  {
    section: 'intros',
    label: 'When the end credits are not known, offer the next episode',
    about: 'up next next episode credits seconds before',
    values: ['At the end'],
  },
  {
    section: 'intros',
    label: 'Detect intros and credits',
    about: 'listen theme tune analysis after each scan',
    values: ['After each scan', 'Only when I press Detect'],
    when: programs,
  },
  {
    section: 'intros',
    label: 'Where ffmpeg is',
    about: 'ffmpeg path install program picture and sound details',
    when: programs,
  },
  {
    section: 'intros',
    label: 'Look up TheIntroDB',
    about: 'times shared by other viewers intro database online',
    values: ['On', 'Off'],
  },
  {
    section: 'intros',
    label: 'Look up IntroDB',
    about: 'times shared by other viewers scene after the credits online',
    values: ['On', 'Off'],
  },
  {
    section: 'intros',
    label: 'Skiptro',
    find: 'An optional program',
    about: 'optional program finds intros command',
    when: programs,
  },
  {
    section: 'intros',
    label: 'Detect now',
    about: 'detect intros TV folders stop detecting',
    when: programs,
  },

  // Keep track of what I watch
  {
    section: 'tracking',
    label: 'SIMKL',
    about: 'watch history connect account scrobble',
  },
  {
    section: 'tracking',
    label: 'Trakt',
    about: 'watch history connect account scrobble',
  },
  {
    section: 'tracking',
    label: 'Continue where you stopped on another device',
    about: 'Trakt resume position sync',
  },
  {
    section: 'tracking',
    label: 'Bring in what you watched elsewhere',
    about: 'import watched history resume points Kodi Jellyfin Emby Plex Trakt export',
  },

  // Posters & ratings
  {
    section: 'ratings',
    label: 'TMDB key',
    find: 'Posters and ratings',
    about: 'posters descriptions artwork backdrops cast API key The Movie Database',
  },
  {
    section: 'ratings',
    label: 'OMDb key',
    about: 'Rotten Tomatoes scores ratings API key',
  },
  { section: 'ratings', label: 'IMDb ratings', find: 'Posters and ratings', about: 'score' },

  // Privacy
  {
    section: 'privacy',
    label: 'What leaves your computer',
    about: 'privacy data sent services internet hosts',
  },

  // Advanced
  {
    section: 'advanced',
    label: 'Look for new versions',
    about: 'updates new version GitHub',
    values: ['On', 'Off'],
  },
  {
    section: 'advanced',
    label: 'Clear artwork cache',
    find: 'Storage',
    about: 'storage posters images disk space',
  },
  {
    section: 'advanced',
    label: 'Sharing with other media apps',
    about: 'nfo Kodi MediaElch tinyMediaManager write',
  },
  {
    section: 'advanced',
    label: 'Move to a new computer',
    about: 'export import library file watch history settings playlists transfer migrate',
    when: (can) => can.folder_picker,
  },
  {
    section: 'advanced',
    label: 'Safety copies',
    about: 'backup restore copy of the library',
  },
  {
    section: 'advanced',
    label: 'Send a report',
    find: 'Developer tools',
    about: 'bug report logs zip problem',
    when: (can) => can.opens_folders,
  },
  {
    section: 'advanced',
    label: 'Developer tools',
    about: 'log folder share the log debug',
  },
];

/** Lower case, accents off, so "æ" still matches and "Tomatoes" finds "tomatoes". */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export interface SettingMatch {
  entry: SettingEntry;
  /** The section's name, as the list says it. */
  sectionName: string;
  /** The choice the query named, when it was a choice rather than the setting. */
  value?: string;
}

/**
 * The settings `query` names, best first: every word of it has to be found
 * somewhere in the entry; a name that holds them all comes before a
 * description or a choice that does.
 */
export function searchSettings(query: string, can: Capabilities | null): SettingMatch[] {
  const words = plain(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const has = (text: string) => words.every((w) => plain(text).includes(w));

  const scored: { match: SettingMatch; score: number; order: number }[] = [];
  SETTINGS_INDEX.forEach((entry, order) => {
    if (can && entry.when && !entry.when(can)) return;
    const sectionName = SECTION_NAMES[entry.section];
    const value = entry.values?.find(has);
    // What the section says on screen counts as the name too (S3: "find
    // them online", read off the screen, found nothing).
    const names = entry.find ? [entry.label, entry.find] : [entry.label];
    const everything = [...names, entry.about ?? '', sectionName, ...(entry.values ?? [])].join(' ');
    let score: number;
    if (names.some((n) => plain(n).startsWith(plain(query).trim()))) score = 4;
    else if (names.some(has)) score = 3;
    else if (value) score = 2;
    else if (has(everything)) score = 1;
    else return;
    scored.push({ match: { entry, sectionName, value: score === 2 ? value : undefined }, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.match);
}

import { describe, expect, it } from 'vitest';
import type { Capabilities } from '../capabilities';
import { searchSettings, SETTINGS_INDEX } from './settingsIndex';
import { SECTIONS } from './settingsSections';

/** The Settings code: the screen and the sections it draws from other files. */
const code = Object.values(
  import.meta.glob(['./*.tsx'], { query: '?raw', import: 'default', eager: true })
).join('\n');

const desktop = {
  windowed: true,
  network_shares: false,
  offers_player: true,
  display_switching: true,
  equipment_detection: true,
  audio_direct: true,
  system_output: false,
  runs_programs: true,
  opens_folders: true,
} as Capabilities;

describe('Settings search', () => {
  it('finds every entry on the screen it names', () => {
    // An entry whose words left the code can only land on its section's top.
    const missing = SETTINGS_INDEX.filter((e) => !code.includes(e.find ?? e.label)).map(
      (e) => e.find ?? e.label
    );
    expect(missing, 'renamed in Settings? update settingsIndex.ts').toEqual([]);
    const sections = new Set(SECTIONS.map(([id]) => id));
    for (const e of SETTINGS_INDEX) expect(sections.has(e.section), e.label).toBe(true);
  });

  it('finds a setting by the words its section shows for it', () => {
    // Typed as read off the screen: every entry, by its visible text.
    const all = { ...desktop, network_shares: true, system_output: true } as Capabilities;
    const lost = SETTINGS_INDEX.filter(
      (e) => !searchSettings(e.find ?? e.label, all).some((m) => m.entry === e)
    ).map((e) => e.find ?? e.label);
    expect(lost).toEqual([]);
    expect(searchSettings('find them online', desktop)[0]?.entry.label).toBe(
      'Find forced subtitles online'
    );
  });

  it('puts a name before a description', () => {
    const found = searchSettings('subtitles', desktop).map((m) => m.entry.label);
    expect(found[0]).toBe('Subtitles');
    expect(found).toContain('Forced subtitles');
    expect(found).toContain('OpenSubtitles');
  });

  it('needs every word, in any order, ignoring case and accents', () => {
    expect(searchSettings('ROTTEN tomatoes', desktop).map((m) => m.entry.label)).toEqual([
      'OMDb key',
    ]);
    expect(searchSettings('séND rePORT', desktop).map((m) => m.entry.label)).toEqual([
      'Send a report',
    ]);
    expect(searchSettings('nothing like this', desktop)).toEqual([]);
    expect(searchSettings('   ', desktop)).toEqual([]);
  });

  it('says which choice matched', () => {
    const [first] = searchSettings('skip them', desktop);
    expect(first.entry.label).toBe('Intros and credits');
    expect(first.value).toBe('Skip them');
    expect(first.sectionName).toBe('Skipping intros');
  });

  it('leaves out what this system does not have', () => {
    const android = { ...desktop, runs_programs: false, display_switching: false } as Capabilities;
    expect(searchSettings('ffmpeg', desktop).map((m) => m.entry.label)).toContain('Where ffmpeg is');
    expect(searchSettings('ffmpeg', android)).toEqual([]);
    expect(searchSettings('refresh rate', android).map((m) => m.entry.label)).not.toContain(
      'Match the refresh rate'
    );
  });
});

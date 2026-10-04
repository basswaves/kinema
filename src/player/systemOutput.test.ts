import { describe, expect, it } from 'vitest';
import { chooseTarget, type Screen } from './displayMode';
import {
  audioFallbackNotice,
  lastSoundNote,
  matchNote,
  matchOn,
  pictureNote,
  soundNote,
  switchSettings,
  type SystemOutput,
} from './systemOutput';

const out = (o: Partial<SystemOutput>): SystemOutput => ({
  hdr: [],
  sound: [],
  modes: 4,
  lastSound: null,
  ...o,
});

describe('the one switch', () => {
  it('is on unless switched off', () => {
    expect(matchOn(null)).toBe(true);
    expect(matchOn('on')).toBe(true);
    expect(matchOn('off')).toBe(false);
  });

  it('matches the rate and only raises the resolution, never HDR', () => {
    expect(switchSettings(true)).toEqual({ refresh: true, resolution: 'auto', hdr: false });
    expect(switchSettings(false)).toEqual({ refresh: false, resolution: 'off', hdr: false });
  });

  // A box at 4K 60 Hz with 23.976 Hz on offer, and a 1080p film at 23.976.
  const tv: Screen = {
    gdi_name: 'display 0',
    width: 3840,
    height: 2160,
    hz: 60,
    rate: 60,
    hdr: 'unknown',
    modes: [
      { width: 3840, height: 2160, hz: 60, rate: 60 },
      { width: 3840, height: 2160, hz: 23, rate: 23.976 },
      { width: 1920, height: 1080, hz: 60, rate: 60 },
      { width: 1920, height: 1080, hz: 23, rate: 23.976 },
    ],
  };
  const film = { width: 1920, height: 1080, fps: 23.976, hdr: true };

  it('on: the film’s rate at the resolution the box is set to', () => {
    expect(chooseTarget(tv, film, switchSettings(true))).toEqual({
      width: 3840,
      height: 2160,
      hz: 23,
      rate: 23.976,
      hdr: null,
    });
  });

  it('off: nothing changes, HDR film or not', () => {
    expect(chooseTarget(tv, film, switchSettings(false))).toBeNull();
  });

  it('a screen with one mode is never switched', () => {
    const one = { ...tv, modes: [tv.modes[0]] };
    expect(chooseTarget(one, film, switchSettings(true))).toBeNull();
    expect(matchNote(out({ modes: 1 }))).toContain('only one screen mode');
    expect(matchNote(out({ modes: 4 }))).toBeNull();
  });
});

describe('what Settings says', () => {
  it('names the HDR kinds the screen shows, or says it has none', () => {
    expect(pictureNote(out({ hdr: ['HDR10', 'HLG'] }), 'Android')).toContain('HDR10 and HLG');
    expect(pictureNote(out({ hdr: [] }), 'Android')).toContain('shown in SDR');
    expect(pictureNote(null, 'Android')).toContain('by itself');
  });

  it('says what Android reports, never more', () => {
    const two = soundNote(out({ sound: ['Dolby Digital', 'DTS'] }), 'Android');
    expect(two).toContain('takes Dolby Digital and DTS untouched');
    expect(two).toContain("device's own sound settings can still decide otherwise");
    expect(soundNote(out({ sound: [] }), 'Android')).toContain('played through Android');
    expect(soundNote(null, 'Android')).toContain('played through Android');
  });

  it('says what happened to the last film’s sound, once there was one', () => {
    expect(lastSoundNote(out({}))).toBeNull();
    expect(lastSoundNote(null)).toBeNull();
    expect(
      lastSoundNote(out({ lastSound: { format: 'Dolby Digital Plus with Atmos 5.1', way: 'untouched' } }))
    ).toBe('Last film: its Dolby Digital Plus with Atmos 5.1 sound went to the TV or receiver untouched.');
    expect(lastSoundNote(out({ lastSound: { format: 'DTS-HD 5.1', way: 'decoded' } }))).toContain(
      'turned into ordinary sound on this device'
    );
    expect(lastSoundNote(out({ lastSound: { format: 'DTS-HD 5.1', way: 'none' } }))).toContain(
      'played without sound'
    );
  });

  it('leaves the one mode to the device’s own settings, with no number', () => {
    const one = matchNote(out({ modes: 1 }));
    expect(one).toContain("device's own display settings");
    expect(one).not.toMatch(/\d/);
  });

  it('words the sound’s fallbacks', () => {
    expect(audioFallbackNotice(1, 'DTS-HD MA 5.1', 'DTS-HD MA 5.1', 'Android')).toBe(
      "This film's sound (DTS-HD MA 5.1) could not be sent on untouched, so Android is playing it instead."
    );
    expect(audioFallbackNotice(1, 'DTS-HD MA 5.1', 'AC3 5.1', 'Android')).toContain(
      'its other sound track (AC3 5.1) is playing instead'
    );
    expect(audioFallbackNotice(2, '', null, 'Android')).toContain('without sound');
  });
});

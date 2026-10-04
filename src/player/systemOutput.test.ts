import { describe, expect, it } from 'vitest';
import { chooseTarget, type Screen } from './displayMode';
import {
  audioFallbackNotice,
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
  surround: null,
  modes: 4,
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
    expect(matchNote(out({ modes: 1 }))).toContain('only one mode');
    expect(matchNote(out({ modes: 4 }))).toBeNull();
  });
});

describe('what Settings says', () => {
  it('names the HDR kinds the screen shows, or says it has none', () => {
    expect(pictureNote(out({ hdr: ['HDR10', 'HLG'] }), 'Android')).toContain('HDR10 and HLG');
    expect(pictureNote(out({ hdr: [] }), 'Android')).toContain('shown in SDR');
    expect(pictureNote(null, 'Android')).toContain('by itself');
  });

  it('says where to change a system that never passes surround through', () => {
    const never = soundNote(out({ surround: 'never', sound: ['DTS'] }), 'Android');
    expect(never).toContain('never to pass surround sound through');
    expect(never).toContain("Android's display and sound settings");
  });

  it('lists what goes through untouched', () => {
    expect(soundNote(out({ sound: ['Dolby Digital', 'DTS'] }), 'Android')).toContain(
      'Dolby Digital and DTS go to the TV or receiver untouched'
    );
    expect(soundNote(out({ sound: [] }), 'Android')).toContain('played through Android');
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

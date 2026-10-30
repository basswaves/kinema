import { describe, expect, it } from 'vitest';
import {
  canLiftDialogue,
  describeLevel,
  filterFor,
  parseByTitle,
  passesThrough,
} from './soundLevel';

describe('passesThrough', () => {
  it('follows audio-spdif, DTS with either of its names', () => {
    expect(passesThrough('truehd', 'ac3,eac3,truehd')).toBe(true);
    expect(passesThrough('truehd', 'ac3,eac3')).toBe(false);
    expect(passesThrough('dts', 'dts-hd')).toBe(true);
    expect(passesThrough('dca', 'dts')).toBe(true);
    expect(passesThrough('aac', 'ac3,eac3,dts,dts-hd,truehd')).toBe(false);
    expect(passesThrough('ac3', '')).toBe(false);
    expect(passesThrough(undefined, 'ac3')).toBe(false);
  });
});

describe('filterFor', () => {
  it('is empty when nothing is asked', () => {
    expect(filterFor({ levelling: 'off', dialogue: false }, '5.1')).toBe('');
  });

  it('levels with dynaudnorm, stronger each step', () => {
    const little = filterFor({ levelling: 'little', dialogue: false }, 'stereo');
    const most = filterFor({ levelling: 'most', dialogue: false }, 'stereo');
    expect(little).toBe('@kinema:lavfi=[dynaudnorm=f=500:g=31:p=0.9:m=3]');
    expect(most).toContain('m=10');
  });

  it('lifts the centre and lowers the rest, in the layout’s own order', () => {
    expect(filterFor({ levelling: 'off', dialogue: true }, '5.1(side)')).toBe(
      '@kinema:lavfi=[pan=5.1(side)|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|SL=0.708*SL|SR=0.708*SR]'
    );
  });

  it('lifts before it levels', () => {
    const af = filterFor({ levelling: 'more', dialogue: true }, '7.1');
    expect(af.indexOf('pan=')).toBeLessThan(af.indexOf('dynaudnorm'));
  });

  it('has no lift for a layout without a centre', () => {
    expect(canLiftDialogue('stereo')).toBe(false);
    expect(canLiftDialogue(undefined)).toBe(false);
    expect(filterFor({ levelling: 'off', dialogue: true }, 'stereo')).toBe('');
  });
});

describe('parseByTitle', () => {
  it('keeps what is whole and drops the rest', () => {
    expect(
      parseByTitle(
        JSON.stringify({
          'title:1': { levelling: 'more', dialogue: true },
          'title:2': { levelling: 'loud', dialogue: true },
          'title:3': 'x',
        })
      )
    ).toEqual({ 'title:1': { levelling: 'more', dialogue: true } });
    expect(parseByTitle('{')).toEqual({});
    expect(parseByTitle(null)).toEqual({});
  });
});

describe('describeLevel', () => {
  it('says both halves', () => {
    expect(describeLevel({ levelling: 'off', dialogue: false })).toBe('Sound as mixed, no levelling');
    expect(describeLevel({ levelling: 'most', dialogue: true })).toBe(
      'Dialogue lifted, levelling most'
    );
  });
});

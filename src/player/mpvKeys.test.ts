import { describe, expect, it } from 'vitest';
import { keyCommand, keyFromValue, KEY_PROPERTY, MPV_KEYS } from './mpvKeys';

/** The two values `cycle-values` alternates between for one binding. */
function values(command: string): string[] {
  const [verb, property, ...rest] = command.split(' ');
  expect(verb).toBe('cycle-values');
  expect(property).toBe(KEY_PROPERTY);
  return rest;
}

describe('keys through mpv', () => {
  it('turns both values of each binding back into the key Kinema knows', () => {
    MPV_KEYS.forEach(([, dom], index) => {
      const [first, second] = values(keyCommand(index));
      expect(keyFromValue(first)).toBe(dom);
      expect(keyFromValue(second)).toBe(dom);
    });
  });

  it('changes on every press, the same key twice included', () => {
    MPV_KEYS.forEach((_, index) => {
      const [first, second] = values(keyCommand(index));
      expect(first).not.toBe(second);
    });
  });

  it('never repeats a value across keys', () => {
    const all = MPV_KEYS.flatMap((_, index) => values(keyCommand(index)));
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers the remote: arrows, OK, Back and the media keys', () => {
    const keys = new Set(MPV_KEYS.map(([, dom]) => dom));
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape',
      'Backspace', 'BrowserBack', ' ', 'MediaPlayPause']) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it('ignores anything else', () => {
    for (const v of [null, undefined, '', 'x', '9', '9c', '999a', '-1a', 3]) {
      expect(keyFromValue(v)).toBeNull();
    }
  });

  it('never needs quoting in the command', () => {
    MPV_KEYS.forEach((_, index) => expect(keyCommand(index)).not.toMatch(/["']/));
  });
});

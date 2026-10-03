import { describe, expect, it } from 'vitest';
import { newEvents, parseMouse } from './mpvMouse';

describe('the mouse through mpv', () => {
  it('reads the script’s lines, quoted as user-data comes back or not', () => {
    const raw = '7 down 100 200 5000;8 up 101 200 5080';
    const expected = [
      { seq: 7, kind: 'down', x: 100, y: 200, time: 5000 },
      { seq: 8, kind: 'up', x: 101, y: 200, time: 5080 },
    ];
    expect(parseMouse(raw)).toEqual(expected);
    expect(parseMouse(JSON.stringify(raw))).toEqual(expected);
  });

  it('reads every kind the script writes', () => {
    const kinds = ['move', 'down', 'up', 'wheel-up', 'wheel-down', 'leave'];
    const raw = kinds.map((k, i) => `${i + 1} ${k} 1 2 3`).join(';');
    expect(parseMouse(raw).map((e) => e.kind)).toEqual(kinds);
  });

  it('skips what is not an event, and takes nothing from nothing', () => {
    expect(parseMouse('1 click 1 2 3;2 move x 2 3;;3 move 4 5 6')).toEqual([
      { seq: 3, kind: 'move', x: 4, y: 5, time: 6 },
    ]);
    expect(parseMouse(null)).toEqual([]);
    expect(parseMouse('"not closed')).toEqual([]);
    expect(parseMouse('')).toEqual([]);
  });

  it('keeps a quick click whole: both halves arrive in one value', () => {
    const seen = parseMouse('4 move 10 10 1;5 down 10 10 2;6 up 10 10 3');
    expect(newEvents(seen, 4).map((e) => e.kind)).toEqual(['down', 'up']);
    expect(newEvents(seen, 6)).toEqual([]);
  });

  it('takes everything from a script started again, whose numbers begin anew', () => {
    const seen = parseMouse('1 move 10 10 1;2 down 10 10 2');
    expect(newEvents(seen, 40)).toEqual(seen);
  });
});

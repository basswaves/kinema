import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { kind: string }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((_cmd: string, args: { kind: string }) => {
    sent.push(args);
    return Promise.resolve();
  }),
}));
vi.mock('./engine', () => ({ mpvSet: vi.fn(() => Promise.resolve()) }));
vi.mock('./overlay', () => ({ pageFromVideo: (x: number, y: number) => ({ x, y }) }));

import { handMouseEventsToPage } from './pageMouse';
import type { MouseEvent } from './mpvMouse';

const ev = (seq: number, kind: MouseEvent['kind'] = 'move'): MouseEvent => ({ seq, kind, x: seq, y: 0, time: seq });

describe('handMouseEventsToPage', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('two listeners offering the same report: each event reaches the page once', () => {
    const report = [ev(1), ev(2, 'down'), ev(3, 'up')];
    handMouseEventsToPage(report);
    handMouseEventsToPage(report);
    expect(sent.map((s) => s.kind)).toEqual(['move', 'down', 'up']);
  });

  it('a later report hands only what is new, whoever offers it first', () => {
    handMouseEventsToPage([ev(2, 'down'), ev(3, 'up'), ev(4)]);
    handMouseEventsToPage([ev(3, 'up'), ev(4), ev(5, 'down')]);
    expect(sent.map((s) => s.kind)).toEqual(['move', 'down']);
  });

  it('a script started again (numbers below the last) is all new', () => {
    handMouseEventsToPage([ev(1, 'down'), ev(2, 'up')]);
    expect(sent.map((s) => s.kind)).toEqual(['down', 'up']);
  });
});

/**
 * The player's per-file rules, each one a failure that once reached a real
 * screen. See docs/GOTCHAS.md, libmpv section, for the stories behind them.
 */
import { describe, expect, it } from 'vitest';
import { initialSession, reduce, samePath, type Event, type Session } from './session';

const A = 'C:\\tv\\Show.S01E01.mkv';
const B = 'C:\\tv\\Show.S01E02.mkv';

function run(state: Session, ...events: Event[]): Session {
  return events.reduce(reduce, state);
}

/** A session for A that is open at 100 s of 1400. */
function openOn(path = A): Session {
  return run(
    initialSession(path),
    { type: 'file-loaded' },
    { type: 'opened', path, timePos: 100, duration: 1400, resumedFrom: null }
  );
}

describe('opening a file', () => {
  it('ignores position pushes until the file is open', () => {
    // mpv keeps reporting the outgoing file while loadfile is in flight.
    const s = run(
      initialSession(B),
      { type: 'time-pos', value: 1390 },
      { type: 'duration', value: 1400 },
      { type: 'file-loaded' },
      { type: 'time-pos', value: 1391 }
    );
    expect(s.timePos).toBeNull();
    expect(s.duration).toBeNull();
    expect(s.open).toBe(false);
  });

  it('takes the position it read, then follows pushes', () => {
    const s = run(openOn(), { type: 'time-pos', value: 101 });
    expect(s.open).toBe(true);
    expect(s.timePos).toBe(101);
    expect(s.duration).toBe(1400);
  });

  it('is not opened by a late file-loaded from the outgoing file', () => {
    // The new target's reset happened; then the previous file's events land.
    const s = run(
      initialSession(B),
      { type: 'file-loaded' },
      { type: 'opened', path: A, timePos: 1390, duration: 1400, resumedFrom: null }
    );
    expect(s.open).toBe(false);
    expect(s.timePos).toBeNull();

    // B's own events still open it.
    const t = run(s, { type: 'opened', path: B, timePos: 0, duration: 1500, resumedFrom: null });
    expect(t.open).toBe(true);
    expect(t.duration).toBe(1500);
  });

  it('does not open without file-loaded first', () => {
    const s = run(initialSession(A), {
      type: 'opened',
      path: A,
      timePos: 0,
      duration: 1400,
      resumedFrom: null,
    });
    expect(s.open).toBe(false);
  });

  it('records where it resumed from, until the toast has shown', () => {
    const s = run(
      initialSession(A),
      { type: 'file-loaded' },
      { type: 'opened', path: A, timePos: 311, duration: 1400, resumedFrom: 311 }
    );
    expect(s.resumedFrom).toBe(311);
    expect(run(s, { type: 'resume-shown' }).resumedFrom).toBeNull();
  });
});

describe('the black cover', () => {
  it('comes off on this file’s first frame, not the previous file’s', () => {
    const before = run(initialSession(B), { type: 'playback-restart' });
    expect(before.frameShown).toBe(false);
    const after = run(before, { type: 'file-loaded' }, { type: 'playback-restart' });
    expect(after.frameShown).toBe(true);
  });

  it('never outstays its timeout', () => {
    expect(run(initialSession(A), { type: 'cover-timeout' }).frameShown).toBe(true);
  });
});

describe('the end of a file', () => {
  it('ends once, however many times mpv says so', () => {
    const s = run(openOn(), { type: 'eof' });
    expect(s.ended).toBe(true);
    // Same object back: nothing changed, so no effect re-runs.
    expect(reduce(s, { type: 'eof' })).toBe(s);
    expect(reduce(s, { type: 'end-early' })).toBe(s);
  });

  it('ignores the outgoing file ending during a change of episode', () => {
    const s = run(initialSession(B), { type: 'file-loaded' }, { type: 'eof' });
    expect(s.ended).toBe(false);
  });

  it('skipping the credits is the same end', () => {
    expect(run(openOn(), { type: 'end-early' }).ended).toBe(true);
  });
});

describe('a new target', () => {
  it('forgets everything about the previous file', () => {
    const s = run(
      openOn(),
      { type: 'playback-restart' },
      { type: 'eof' },
      { type: 'error', message: 'x' },
      { type: 'load', path: B }
    );
    expect(s).toMatchObject({
      path: B,
      loaded: false,
      open: false,
      frameShown: false,
      timePos: null,
      duration: null,
      ended: false,
      error: null,
    });
    expect(s.seq).toBe(1);
  });

  it('keeps the pause state, which belongs to mpv', () => {
    const s = run(openOn(), { type: 'pause', value: true }, { type: 'load', path: B });
    expect(s.paused).toBe(true);
  });
});

describe('the seek bar', () => {
  it('holds the dragged position against pushes until released', () => {
    const s = run(openOn(), { type: 'scrub-start' }, { type: 'scrub', timePos: 700 });
    expect(run(s, { type: 'time-pos', value: 101 }).timePos).toBe(700);
    expect(run(s, { type: 'scrub-end' }, { type: 'time-pos', value: 702 }).timePos).toBe(702);
  });
});

describe('samePath', () => {
  it('compares Windows paths the way Windows does', () => {
    expect(samePath('c:/TV/show.s01e01.mkv', A)).toBe(true);
    expect(samePath(B, A)).toBe(false);
  });

  it('gives an unreadable path the benefit of the doubt', () => {
    expect(samePath(null, A)).toBe(true);
  });
});

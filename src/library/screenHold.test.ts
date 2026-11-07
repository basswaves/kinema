import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let held: { on: boolean; forMs: number }[] = [];
let engine = 'media3';
let total = 0;
let settings: Record<string, string> = {};
let statsFail = false;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'capabilities') return { engine };
    if (command === 'library_stats') {
      if (statsFail) throw new Error('no answer');
      return { total };
    }
    if (command === 'get_setting') return settings[args.key as string] ?? null;
    if (command === 'set_setting') {
      settings[args.key as string] = args.value as string;
      return null;
    }
    if (command === 'plugin:media3|hold_screen') {
      held.push({ on: args.on as boolean, forMs: args.forMs as number });
    }
    return null;
  }),
}));

async function fresh() {
  vi.resetModules();
  held = [];
  const hold = await import('./screenHold');
  const playback = await import('./playback');
  return { hold, playback };
}
const asked = () => held.map((h) => h.on);

beforeEach(() => {
  vi.useFakeTimers();
  engine = 'media3';
  total = 0;
  settings = {};
  statsFail = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the screen during a first scan', () => {
  it('stays on while an empty library has its first scan, and lets go at the end', async () => {
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    expect(asked()).toEqual([true]);
    expect(held[0].forMs).toBe(hold.LEASE_MS);
    expect(settings[hold.FIRST_SCAN_KEY]).toBe('running');
    await hold.firstScanFinished();
    hold.letScreenGo();
    expect(asked()).toEqual([true, false]);
    expect(settings[hold.FIRST_SCAN_KEY]).toBe('');
  });

  it('a later scan changes nothing', async () => {
    total = 12;
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    hold.scanMovedOn();
    await hold.firstScanFinished();
    hold.letScreenGo();
    expect(held).toEqual([]);
    expect(settings).toEqual({});
  });

  it('a first scan that was cut short is still a first scan, with files by then', async () => {
    total = 12;
    settings.first_scan = 'running';
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    expect(asked()).toEqual([true]);
  });

  it('a failed one lets go and stays to be finished', async () => {
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    hold.letScreenGo();
    expect(asked()).toEqual([true, false]);
    expect(settings[hold.FIRST_SCAN_KEY]).toBe('running');
  });

  it('is renewed as the work moves on, and not on every step', async () => {
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    hold.scanMovedOn();
    hold.scanMovedOn();
    expect(asked()).toEqual([true]);
    await vi.advanceTimersByTimeAsync(hold.RENEW_MS);
    hold.scanMovedOn();
    expect(asked()).toEqual([true, true]);
  });

  it('a film lets go while it is open, so a paused one cannot hold a TV awake', async () => {
    const { hold, playback } = await fresh();
    await hold.holdScreenIfFirstScan();
    playback.setPlaybackActive(true);
    expect(asked()).toEqual([true, false]);
    hold.scanMovedOn();
    expect(asked()).toEqual([true, false]);
    playback.setPlaybackActive(false);
    expect(asked()).toEqual([true, false, true]);
  });

  it('after the scan a film coming and going asks nothing', async () => {
    const { hold, playback } = await fresh();
    await hold.holdScreenIfFirstScan();
    hold.letScreenGo();
    playback.setPlaybackActive(true);
    playback.setPlaybackActive(false);
    expect(asked()).toEqual([true, false]);
  });

  it('when it cannot tell, it does not hold', async () => {
    statsFail = true;
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    expect(held).toEqual([]);
  });

  it('a desktop never hears of it', async () => {
    engine = 'mpv';
    const { hold } = await fresh();
    await hold.holdScreenIfFirstScan();
    hold.scanMovedOn();
    hold.letScreenGo();
    expect(held).toEqual([]);
    expect(settings).toEqual({});
  });
});

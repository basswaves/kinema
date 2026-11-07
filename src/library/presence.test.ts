import { afterEach, describe, expect, it, vi } from 'vitest';

const told: { command: string; args?: unknown }[] = [];
let inFront = true;
let hear: ((event: { behind: boolean }) => void) | null = null;
let engine = 'media3';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    told.push({ command, args });
    if (command === 'capabilities') return { engine };
    if (command === 'plugin:media3|in_front') return { inFront };
    return null;
  }),
  addPluginListener: vi.fn(async (_plugin: string, _event: string, handle: typeof hear) => {
    hear = handle;
    return { unregister: async () => undefined };
  }),
}));
vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
vi.stubGlobal('window', new EventTarget());

async function fresh() {
  vi.resetModules();
  told.length = 0;
  hear = null;
  const presence = await import('./presence');
  const playback = await import('./playback');
  await presence.watchPresence();
  return playback;
}

afterEach(() => {
  inFront = true;
  engine = 'media3';
});

describe('Kinema on the screen or behind another app', () => {
  it('holds the library back while behind, and tells the native side', async () => {
    const { isBehindScreen } = await fresh();
    hear?.({ behind: true });
    expect(isBehindScreen()).toBe(true);
    expect(told).toContainEqual({ command: 'set_behind', args: { on: true } });
    hear?.({ behind: false });
    expect(isBehindScreen()).toBe(false);
    expect(told).toContainEqual({ command: 'set_behind', args: { on: false } });
  });

  it('a page started while Kinema is behind waits too', async () => {
    inFront = false;
    const { isBehindScreen } = await fresh();
    expect(isBehindScreen()).toBe(true);
  });

  it('a key proves it is in front, whatever was heard last', async () => {
    const { isBehindScreen } = await fresh();
    hear?.({ behind: true });
    window.dispatchEvent(new Event('keydown'));
    expect(isBehindScreen()).toBe(false);
  });

  it('a desktop never hears of it', async () => {
    engine = 'mpv';
    const { isBehindScreen } = await fresh();
    expect(hear).toBeNull();
    expect(isBehindScreen()).toBe(false);
    expect(told.map((t) => t.command)).toEqual(['capabilities']);
  });
});

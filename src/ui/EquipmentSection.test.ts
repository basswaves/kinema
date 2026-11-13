import { describe, expect, it } from 'vitest';
import { awayDevices } from './EquipmentSection';

const dev = (id: string, name: string, connected: boolean, last_seen: number) => ({
  id,
  name,
  connected,
  last_seen,
});

describe('awayDevices', () => {
  it('leaves out an old id whose name is connected now', () => {
    const audio = [dev('a', 'Screen audio', true, 9), dev('b', 'Screen audio', false, 5)];
    expect(awayDevices([], audio)).toEqual([]);
  });
  it('keeps a device that really is away, newest first', () => {
    const audio = [dev('a', 'Old', false, 1), dev('b', 'Here', true, 9), dev('c', 'Older', false, 0)];
    const screens = [dev('d', 'Screen', false, 5)];
    expect(awayDevices(screens, audio).map((d) => d.id)).toEqual(['d', 'a', 'c']);
  });
});

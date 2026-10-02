import { describe, expect, it } from 'vitest';
import type { Display, Equipment } from './equipment';
import { screenIdOf, switchSettingsFor, type SwitchPolicies } from './displaySwitch';

const display = (id: string, gdi_name: string, connected = true) =>
  ({ id, gdi_name, connected }) as Display;

const kit = (displays: Display[]) => ({ displays }) as Equipment;

describe('which screen the settings are for', () => {
  it('finds the screen by the name the system gives it now', () => {
    const equipment = kit([display('old-tv', 'HDMI-1', false), display('tv', 'HDMI-1'), display('desk', 'DP-1')]);
    expect(screenIdOf(equipment, 'HDMI-1')).toBe('tv');
    expect(screenIdOf(equipment, 'DP-1')).toBe('desk');
  });

  it('knows no screen plugged in since the check', () => {
    expect(screenIdOf(kit([display('tv', 'HDMI-1')]), 'HDMI-2')).toBeNull();
    expect(screenIdOf(null, 'HDMI-1')).toBeNull();
  });

  it('turns the stored answers into this screen’s settings', () => {
    const p: SwitchPolicies = {
      refresh: { policy: 'these', devices: ['tv'] },
      resolution: 'auto',
      hdr: { policy: 'all', devices: [] },
    };
    expect(switchSettingsFor(p, 'tv')).toEqual({ refresh: true, resolution: 'auto', hdr: true });
    expect(switchSettingsFor(p, 'desk')).toEqual({ refresh: false, resolution: 'auto', hdr: true });
    // A screen Kinema cannot name is left alone by "only these".
    expect(switchSettingsFor(p, null).refresh).toBe(false);
  });
});

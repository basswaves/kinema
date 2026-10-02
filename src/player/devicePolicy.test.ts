import { describe, expect, it } from 'vitest';
import { covers, parsePolicy, withDevice } from './devicePolicy';

describe('device policies', () => {
  it('reads what earlier versions stored: on is every device, anything else off', () => {
    expect(parsePolicy('on', null)).toEqual({ policy: 'all', devices: [] });
    expect(parsePolicy('off', null).policy).toBe('off');
    expect(parsePolicy(null, null).policy).toBe('off');
    expect(parsePolicy('yes', null).policy).toBe('off');
  });

  it('only these covers the listed devices and nothing else', () => {
    const p = parsePolicy('these', JSON.stringify(['tv', 'receiver']));
    expect(covers(p, 'tv')).toBe(true);
    expect(covers(p, 'laptop-panel')).toBe(false);
    expect(covers(p, null)).toBe(false);
  });

  it('every device covers even one it cannot name; off covers none', () => {
    expect(covers(parsePolicy('on', null), null)).toBe(true);
    expect(covers(parsePolicy('off', JSON.stringify(['tv'])), 'tv')).toBe(false);
  });

  it('a damaged list covers nothing rather than everything', () => {
    const p = parsePolicy('these', '{not json');
    expect(p.devices).toEqual([]);
    expect(covers(p, 'tv')).toBe(false);
    expect(parsePolicy('these', JSON.stringify([1, 'tv'])).devices).toEqual(['tv']);
  });

  it('adding a device turns off into only these, and leaves every device alone', () => {
    expect(withDevice(parsePolicy('off', null), 'tv')).toEqual({ policy: 'these', devices: ['tv'] });
    expect(withDevice(parsePolicy('on', null), 'tv').policy).toBe('all');
    const once = withDevice(withDevice(parsePolicy('these', null), 'tv'), 'tv');
    expect(once.devices).toEqual(['tv']);
  });
});

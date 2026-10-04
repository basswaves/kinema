import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError } from './errors';
import { count, endsAtLabel } from './format';

const system = vi.hoisted(() => ({ name: null as string | null }));
vi.mock('../capabilities', () => ({
  capabilitiesNow: () => (system.name ? { system: system.name } : null),
}));

describe('describeError', () => {
  afterEach(() => {
    system.name = null;
  });

  it('names a missing path without the Windows error number', () => {
    expect(describeError('The system cannot find the path specified. (os error 3)')).toMatch(
      /isn’t there/
    );
  });

  it('tells an unreachable network drive apart from a missing file', () => {
    expect(describeError('The network path was not found. (os error 53)')).toMatch(/network drive/);
  });

  it('reads Linux errors by their words, not the numbers Windows uses for other things', () => {
    // Linux's 5 is a failed read; on Windows 5 is "access denied".
    expect(describeError('Input/output error (os error 5)')).toMatch(/did not answer/);
    expect(describeError('Permission denied (os error 13)')).toMatch(/refused access/);
    expect(describeError('No such file or directory (os error 2)')).toMatch(/isn’t there/);
    expect(describeError('No route to host (os error 113)')).toMatch(/network drive/);
    // Windows, in another language: the number is what is matched.
    expect(describeError('Ingen tilgang. (os error 5)')).toMatch(/refused access/);
  });

  it('says which system refused access, in its own words', () => {
    // Not known yet: Windows, as everything was first written for it.
    expect(describeError('Ingen tilgang. (os error 5)')).toMatch(/^Windows .*File Explorer/);
    system.name = 'Linux';
    expect(describeError('Permission denied (os error 13)')).toMatch(/^Linux .*file manager/);
    // Android runs a Linux too, but its apps have permissions, not accounts.
    system.name = 'Android';
    const android = describeError('Permission denied (os error 13)');
    expect(android).toMatch(/^Android refused access/);
    expect(android).not.toMatch(/Windows|File Explorer|account/);
  });

  it('reads an HTTP status', () => {
    expect(describeError(new Error('TMDB /search/movie failed: HTTP 401'))).toMatch(/TMDB key/);
    expect(describeError(new Error('TVmaze search failed: HTTP 503'))).toMatch(/its end/);
  });

  it('recognises a connection failure', () => {
    expect(describeError('error sending request for url (https://api.tvmaze.com/)')).toMatch(
      /internet/
    );
  });

  it('shows anything it does not recognise as it is, minus the prefix', () => {
    expect(describeError(new Error('Error: the moon is made of cheese'))).toBe(
      'the moon is made of cheese'
    );
    expect(describeError('')).toBe('Something went wrong.');
  });
});

describe('count', () => {
  it('uses the singular for one and the plural otherwise', () => {
    expect(count(1, 'file')).toBe('1 file');
    expect(count(0, 'file')).toBe('0 files');
    expect(count(3, 'episode')).toBe('3 episodes');
    expect(count(2, 'library', 'libraries')).toBe('2 libraries');
  });
});

describe('endsAtLabel', () => {
  it('adds what is left to the clock', () => {
    const now = new Date(2026, 8, 28, 21, 0, 0).getTime();
    const label = endsAtLabel(600, 600 + 100 * 60, now);
    // In the viewer's own clock format, so either "22:40" or "10:40 PM" —
    // GitHub's runners are set to US English, this PC to 24 hours.
    expect(label).toMatch(/^(22|10).40/);
  });

  it('says nothing until the length is known', () => {
    expect(endsAtLabel(null, 3600, 0)).toBeNull();
    expect(endsAtLabel(10, null, 0)).toBeNull();
  });
});

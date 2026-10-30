import { describe, expect, it } from 'vitest';
import { sourceKind, waitWords } from './buffering';

describe('waiting words', () => {
  it('names what the film waits on, from its path', () => {
    expect(sourceKind(String.raw`\\nas\films\a.mkv`)).toBe('share');
    expect(sourceKind(String.raw`\films\a.mkv`)).toBe('drive');
    expect(sourceKind('smb://nas/films/a.mkv')).toBe('share');
    expect(sourceKind('https://example.org/a.mkv')).toBe('stream');
    expect(sourceKind(String.raw`D:\films\a.mkv`)).toBe('drive');
    expect(sourceKind('/media/films/a.mkv')).toBe('drive');
  });

  it('says how far the refill is only when mpv said it', () => {
    expect(waitWords(String.raw`\\nas\a.mkv`, 40)).toBe(
      'Waiting for the network share to send more of the film — 40 %'
    );
    expect(waitWords(String.raw`D:\a.mkv`, null)).toBe('Waiting for the drive to read more of the film');
  });
});

import { describe, expect, it } from 'vitest';
import { ffmpegNoticeWanted } from './ffmpegNotice';

describe('ffmpegNoticeWanted', () => {
  it('speaks up only when ffmpeg is missing and was not waved away', () => {
    expect(ffmpegNoticeWanted(false, false)).toBe(true);
    expect(ffmpegNoticeWanted(true, false)).toBe(false);
    expect(ffmpegNoticeWanted(false, true)).toBe(false);
    expect(ffmpegNoticeWanted(true, true)).toBe(false);
  });
});

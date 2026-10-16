import { describe, expect, it } from 'vitest';
import { ffmpegLacksWords, ffmpegNoticeWanted } from './ffmpegNotice';

describe('ffmpegNoticeWanted', () => {
  it('speaks up only when ffmpeg is missing and was not waved away', () => {
    expect(ffmpegNoticeWanted(false, false)).toBe(true);
    expect(ffmpegNoticeWanted(true, false)).toBe(false);
    expect(ffmpegNoticeWanted(false, true)).toBe(false);
    expect(ffmpegNoticeWanted(true, true)).toBe(false);
  });
});

describe('ffmpegLacksWords', () => {
  it('says nothing for a build that lacks nothing Kinema uses', () => {
    expect(ffmpegLacksWords([])).toBeNull();
    expect(ffmpegLacksWords(['something-else'])).toBeNull();
  });

  it("names Fedora's ffmpeg-free gaps and what each one costs", () => {
    const words = ffmpegLacksWords(['hevc', 'eac3']) ?? '';
    expect(words).toContain('cannot decode HEVC video or E-AC-3 sound');
    expect(words).toContain('for HEVC video, the picture shape is not measured');
    expect(words).toContain('first sound track is E-AC-3, intros and credits are not found');
  });

  it('only says the costs that follow from what is missing', () => {
    const sound = ffmpegLacksWords(['dts', 'truehd']) ?? '';
    expect(sound).toContain('DTS or TrueHD sound');
    expect(sound).not.toContain('picture shape');
    const video = ffmpegLacksWords(['hevc', 'h264']) ?? '';
    expect(video).toContain('HEVC or H.264 video');
    expect(video).not.toContain('listening');
  });
});

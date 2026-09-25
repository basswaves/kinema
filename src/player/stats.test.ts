import { describe, expect, it } from 'vitest';
import { describeAudioPath, describeDolbyVision, describeHdr, type HdrFacts } from './stats';

const hdr10: HdrFacts = {
  sourceGamma: 'pq',
  targetGamma: 'pq',
  sourcePeak: 4000,
  targetPeak: 4000,
  toneMapping: 'bt.2390',
  computePeak: true,
};

describe('describeHdr', () => {
  it('calls HDR out at the source peak passthrough', () => {
    const row = describeHdr(hdr10);
    expect(row.value).toMatch(/^passthrough/);
    expect(row.warn).toBeFalsy();
  });

  it("calls HDR out at a lower peak what it is — the test TV, before hint mode source", () => {
    const row = describeHdr({ ...hdr10, targetPeak: 1499 });
    expect(row.value).toBe('HDR out, compressed · 4000 → 1499 nits');
    expect(row.warn).toBe(true);
  });

  it('calls SDR out tone mapping', () => {
    const row = describeHdr({ ...hdr10, targetGamma: 'srgb', targetPeak: 203 });
    expect(row.value).toMatch(/^tone mapped to SDR \(srgb\)/);
  });

  it('says it does not know rather than guessing, when mpv has not answered', () => {
    // The old bug: a missing answer was reported as "tone mapping".
    const row = describeHdr({ ...hdr10, targetGamma: null });
    expect(row.value).toMatch(/did not report/);
    expect(row.value).not.toMatch(/tone/);
  });

  it('treats an untagged peak as passthrough when the output is HDR', () => {
    expect(describeHdr({ ...hdr10, sourcePeak: 0, targetPeak: 1000 }).value).toMatch(
      /^passthrough/
    );
  });

  it('has nothing to say about an SDR source', () => {
    expect(describeHdr({ ...hdr10, sourceGamma: 'bt.1886' }).value).toMatch(/^SDR source/);
  });
});

describe('describeAudioPath', () => {
  it('calls a bitstream untouched', () => {
    expect(describeAudioPath('spdif-truehd', true).value).toBe(
      'untouched bitstream (truehd) → receiver'
    );
  });
  it('tells direct PCM from the Windows mixer', () => {
    expect(describeAudioPath('s32', true).value).toBe('decoded · straight to the device');
    expect(describeAudioPath('float', false).value).toBe('decoded · through the Windows mixer');
  });
});

describe('describeDolbyVision', () => {
  it('names what each profile becomes', () => {
    expect(describeDolbyVision(5)?.value).toBe('profile 5 → converted to HDR10');
    expect(describeDolbyVision(7)?.value).toBe('profile 7 → HDR10 base layer');
    expect(describeDolbyVision(8)?.value).toBe('profile 8 → HDR10 base layer');
  });
  it('stays out of the way for everything else', () => {
    expect(describeDolbyVision(null)).toBeNull();
    expect(describeDolbyVision(0)).toBeNull();
  });
});

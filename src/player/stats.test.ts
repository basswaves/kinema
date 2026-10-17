import { describe, expect, it } from 'vitest';
import {
  describeAudioPath,
  describeDolbyVision,
  describeHdr,
  hwdecNote,
  parseRenderPasses,
  type HdrFacts,
} from './stats';

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
    expect(row.note).not.toMatch(/graphics driver/);
    // On Linux the driver is one more possible cause.
    const linux = describeHdr({ ...hdr10, targetGamma: 'gamma2.2', targetPeak: 203 }, 'Linux');
    expect(linux.note).toMatch(/graphics driver offers no HDR output/);
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
  it('names Linux’s sound server on Linux', () => {
    expect(describeAudioPath('float', false, 'Linux').value).toBe(
      'decoded · through the Linux sound server'
    );
    expect(describeAudioPath('s32', true, 'Linux').note).toBe('the Linux sound server bypassed');
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

describe('hwdecNote', () => {
  it('calls no decoder, and no answer, software decoding', () => {
    expect(hwdecNote('no')).toBe('software decoding');
    expect(hwdecNote(null)).toBe('software decoding');
  });

  it('says a copy-back decoder copies frames back, and is still hardware', () => {
    expect(hwdecNote('d3d11va-copy')).toMatch(/graphics card.*copied back/);
    expect(hwdecNote('d3d11va-copy')).not.toMatch(/software/);
  });

  it('has nothing to add for a direct decoder', () => {
    expect(hwdecNote('d3d11va')).toBeUndefined();
    expect(hwdecNote('vaapi')).toBeUndefined();
  });
});

describe('parseRenderPasses', () => {
  /** The shape this build's libmpv answers `vo-passes` with, read as a string. */
  const pass = (desc: string, avg: number, peak: number) => ({
    desc,
    last: avg,
    avg,
    peak,
    count: 2,
    samples: [avg, avg],
  });

  it('lists the passes of the last fresh frame, not the redraws', () => {
    const json = JSON.stringify({
      fresh: [pass('color decoding', 8761, 14336), pass('upload frame', 2_500_000, 3_000_000)],
      redraw: [pass('frame mixing (1 frame)', 0, 0)],
    });
    expect(parseRenderPasses(json)).toEqual([
      { label: 'color decoding', value: '8.8 µs', note: 'peak 14.3 µs' },
      { label: 'upload frame', value: '2.50 ms', note: 'peak 3.00 ms' },
    ]);
  });

  it('caps a long chain and says how many more ran', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => pass(`pass ${i}`, 1000, 1000));
    const rows = parseRenderPasses(JSON.stringify({ fresh, redraw: [] }));
    expect(rows).toHaveLength(25);
    expect(rows[24].label).toBe('… and 6 more');
  });

  it('gives nothing for no answer, no passes or something else', () => {
    expect(parseRenderPasses(null)).toEqual([]);
    expect(parseRenderPasses('')).toEqual([]);
    expect(parseRenderPasses('{"fresh":[],"redraw":[]}')).toEqual([]);
    expect(parseRenderPasses('- color decoding: last 8us')).toEqual([]);
  });
});

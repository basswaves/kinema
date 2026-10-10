import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LibraryRoot, MediaFile } from './api';
import { initParser } from './parse';
import { lastParseError } from './parse';
import { resetParseWorker } from './parseClient';
import { parseBatchForLibrary } from './pipeline';

function episode(n: number): MediaFile {
  const parentDir = 'D:/TV/Show Name/Season 1';
  const fileName = `Show.Name.S01E${String(n).padStart(2, '0')}.1080p.mkv`;
  return {
    id: n,
    path: `${parentDir}/${fileName}`,
    parent_dir: parentDir,
    file_name: fileName,
    size_bytes: 1,
    missing: false,
    match_status: 'unparsed',
    parsed_title: null,
    parsed_year: null,
    parsed_season: null,
    parsed_episode: null,
    parsed_kind: null,
    parsed_from: null,
    title_id: null,
    match_confidence: null,
    match_reason: null,
    matched_title: null,
    episode_name: null,
  };
}

const roots: LibraryRoot[] = [{ id: 1, path: 'D:/TV', kind: 'tv', file_count: 0 }];

beforeAll(async () => {
  await initParser();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetParseWorker();
});

describe('parseBatchForLibrary', () => {
  it('parses every file as the library it is in', async () => {
    const parsed = await parseBatchForLibrary([episode(1), episode(2)], roots);
    expect(parsed.map((p) => [p.id, p.kind, p.episode])).toEqual([
      [1, 'episode', 1],
      [2, 'episode', 2],
    ]);
  });

  it('gives the page a turn while a slow device works through a batch', async () => {
    // An old Android box: a tenth of a second a name by the clock.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    const order: string[] = [];
    // A key press waiting for the page, as the remote's would.
    setTimeout(() => order.push('key handled'), 0);
    const batch = Array.from({ length: 20 }, (_, i) => episode(i + 1));
    await parseBatchForLibrary(batch, roots).then(() => order.push('batch parsed'));
    expect(order).toEqual(['key handled', 'batch parsed']);
  });
});

describe('the parse worker', () => {
  /** A stand-in worker that answers every batch the way `parse.worker.ts` would. */
  class AnsweringWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(request: { id: number; files: MediaFile[] }) {
      const payloads = request.files.map((f) => ({ id: f.id, title: 'from the worker' }));
      queueMicrotask(() =>
        this.onmessage?.({
          data: { id: request.id, payloads, parseError: 'worker saw a bad name' },
        } as MessageEvent)
      );
    }
    terminate() {}
  }

  it('does the parsing when there is one, and passes on what the parser reported', async () => {
    vi.stubGlobal('Worker', AnsweringWorker);
    const parsed = await parseBatchForLibrary([episode(1), episode(2)], roots);
    expect(parsed.map((p) => p.title)).toEqual(['from the worker', 'from the worker']);
    expect(lastParseError).toBe('worker saw a bad name');
  });

  it('leaves the parsing to the page when the worker cannot be made', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('no module workers here');
        }
      }
    );
    const parsed = await parseBatchForLibrary([episode(1)], roots);
    expect(parsed.map((p) => [p.kind, p.episode])).toEqual([['episode', 1]]);
  });

  it('leaves the parsing to the page when the worker dies mid-batch', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        onerror: (() => void) | null = null;
        onmessage = null;
        onmessageerror = null;
        postMessage() {
          queueMicrotask(() => this.onerror?.());
        }
        terminate() {}
      }
    );
    const parsed = await parseBatchForLibrary([episode(1)], roots);
    expect(parsed.map((p) => [p.kind, p.episode])).toEqual([['episode', 1]]);
  });
});

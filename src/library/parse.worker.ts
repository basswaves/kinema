/**
 * The parse stage's own thread.
 *
 * guessit takes about a tenth of a second a name on an old Android box, and
 * even sliced into turns (`parseBatchForLibrary`) the page spends most of a
 * first scan busy with it. Here the same functions run where the page is not,
 * so the remote and the animations keep their frames. guessit is loaded in
 * here, on the first batch, and never reaches the page's own bundle path.
 *
 * Nothing but `parse.ts` is imported: the Tauri bindings do not exist in a
 * worker, and the answer must be exactly what the page would have computed.
 */
import type { LibraryRoot, MediaFile, ParseResultPayload } from './api';
import { clearParseError, initParser, lastParseError, parseForLibrary } from './parse';

export interface ParseRequest {
  id: number;
  files: MediaFile[];
  roots: LibraryRoot[];
}

export type ParseReply =
  | { id: number; payloads: ParseResultPayload[]; parseError: string | null }
  | { id: number; failure: string };

self.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, files, roots } = event.data;
  void (async () => {
    let reply: ParseReply;
    try {
      await initParser();
      clearParseError();
      const payloads = files.map((file) => parseForLibrary(file, roots));
      reply = { id, payloads, parseError: lastParseError };
    } catch (e) {
      reply = { id, failure: e instanceof Error ? e.message : String(e) };
    }
    self.postMessage(reply);
  })();
});

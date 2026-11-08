/**
 * "Worth a look" (round 8 L3, `worth_a_look.rs`): files the scorer matched
 * under older rules that the current rules read differently, or whose tie was
 * settled by being better known with no year in the file. Listed once in Needs
 * attention; nothing is changed until a person chooses.
 *
 * Rust writes down which files to check at the first start of a new rules
 * version. This reads them again with today's parser, in the background and a
 * batch at a time, and hands back what differs. No network: only the names.
 */
import { invoke } from '@tauri-apps/api/core';
import type { LibraryRoot, MediaFile, ParseResultPayload } from './api';
import { literalTitle, MATCH_THRESHOLD, normaliseTitle, scoreCandidate } from '../metadata/score';

/** Why a file is worth a look; stored as JSON, said by `whyWords`. */
export type Why =
  | { kind: 'title'; was: string; now: string | null }
  | { kind: 'year'; was: number | null; now: number | null }
  | { kind: 'type'; now: 'episode' | 'movie' }
  | { kind: 'tie' };

export interface WorthALookEntry {
  file_id: number;
  path: string;
  file_name: string;
  title_id: number;
  title: string;
  year: number | null;
  kind: string;
  why: string;
}

/** A file to read again, and the year of the title it is linked to. */
export type WorthTodo = MediaFile & { title_year: number | null };

export const worthALookNext = (limit: number) =>
  invoke<WorthTodo[]>('worth_a_look_next', { limit });
export const worthALookSave = (done: number[], found: { file_id: number; why: string }[]) =>
  invoke<number>('worth_a_look_save', { done, found });
export const listWorthALook = () => invoke<WorthALookEntry[]>('worth_a_look_list');
export const keepAsItIs = (fileIds: number[]) =>
  invoke<number>('worth_a_look_keep', { fileIds });

const same = (a: string, b: string) => normaliseTitle(a) === normaliseTitle(b);

/**
 * Whether today's reading would still take the title the file is linked to,
 * scored as the matcher scores a candidate. The linked title's own name, and
 * the other name it was matched by when the stored reason names one
 * (`also "…"`). A file read differently only because an older parser wrote
 * its name another way, and still linked right, is not listed.
 */
function stillTakes(file: WorthTodo, fresh: ParseResultPayload): boolean {
  if (!file.matched_title || !fresh.title) return false;
  const also = /\(also "(.*?)"\)/.exec(file.match_reason ?? '');
  const { confidence } = scoreCandidate(
    {
      providerId: '',
      title: file.matched_title,
      year: file.title_year,
      altTitles: also ? [also[1]] : undefined,
    },
    { parsedTitle: fresh.title, parsedYear: fresh.year }
  );
  return confidence >= MATCH_THRESHOLD;
}

/**
 * Why a file matched by score under older rules is worth a look, or null.
 *
 * Read differently: today's parser gives another title, year or kind than was
 * stored when it was matched, *and* that reading would not take the linked
 * title. Or its tie was settled by popularity with no year, against a title of
 * the same name — what the new tie rule (DECISIONS "Ties") may now ask about.
 *
 * Only what can change which title a file is. A season or episode number read
 * differently is not listed; linking the file to another title would not
 * change it.
 */
export function compareParse(file: WorthTodo, fresh: ParseResultPayload): Why | null {
  const was = file.parsed_title;
  const titleChanged = Boolean(was) && (!fresh.title || !same(was ?? '', fresh.title));
  const yearChanged = (file.parsed_year ?? null) !== (fresh.year ?? null);
  const kindChanged = Boolean(file.parsed_kind && fresh.kind && file.parsed_kind !== fresh.kind);
  if ((titleChanged || yearChanged || kindChanged) && !stillTakes(file, fresh)) {
    if (titleChanged) return { kind: 'title', was: was ?? '', now: fresh.title };
    if (yearChanged) return { kind: 'year', was: file.parsed_year, now: fresh.year };
    return { kind: 'type', now: fresh.kind === 'episode' ? 'episode' : 'movie' };
  }
  // A tie the new rule settles the same way is not listed: against an entry
  // of another name ("The Heat" is not a second "Heat") popularity still
  // decides. Against one of the same name it decides only when that one is
  // a stub, which the stored reason cannot tell, so it is listed.
  const tie = /; tie vs "(.*)" broken by popularity/.exec(file.match_reason ?? '');
  if (
    !file.parsed_year &&
    tie &&
    file.matched_title &&
    literalTitle(tie[1]) === literalTitle(file.matched_title)
  ) {
    return { kind: 'tie' };
  }
  return null;
}

/** The words after the title in "the file's own name says …". */
function addedWords(was: string, now: string): string | null {
  const w = normaliseTitle(was);
  const n = normaliseTitle(now);
  if (!w || !n.startsWith(`${w} `)) return null;
  // The same words off the name as it is written, so "Part II" keeps its case.
  const words = now.trim().split(/\s+/);
  const keep = n.slice(w.length).trim().split(/\s+/).length;
  return words.slice(-keep).join(' ');
}

/** One plain sentence: why this file is in the list. */
export function whyWords(raw: string, linkedTo: string): string {
  let why: Why;
  try {
    why = JSON.parse(raw) as Why;
  } catch {
    return 'Kinema reads this file differently since an update.';
  }
  switch (why.kind) {
    case 'title': {
      if (!why.now) {
        return `Read again, Kinema finds no title in the file's name; it was read as “${why.was}”.`;
      }
      const added = addedWords(why.was, why.now);
      if (added) {
        return `The file's own name says ${added}, which Kinema did not read before. It is linked to “${linkedTo}”.`;
      }
      return `Read again, the name says “${why.now}”, not “${why.was}”. It is linked to “${linkedTo}”.`;
    }
    case 'year':
      if (why.now === null) {
        return `Read again, the file gives no year; it was read as ${why.was}.`;
      }
      if (why.was === null) return `Read again, the file's name says ${why.now}; no year was read before.`;
      return `Read again, the file's name says ${why.now}, not ${why.was}.`;
    case 'type':
      return why.now === 'episode'
        ? 'Read again, the name looks like an episode of a series, not a film.'
        : 'Read again, the name looks like a film, not an episode of a series.';
    case 'tie':
      return `More than one title has this name and the file gives no year. Kinema chose the best known, “${linkedTo}”, which is not always the one meant.`;
  }
}

/** The files of one title that are there for one reason. */
export interface WorthGroup {
  key: string;
  titleId: number;
  title: string;
  year: number | null;
  isSeries: boolean;
  why: string;
  files: WorthALookEntry[];
}

export function groupWorth(entries: WorthALookEntry[]): WorthGroup[] {
  const groups = new Map<string, WorthGroup>();
  for (const e of entries) {
    const key = `${e.title_id}:${e.why}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        titleId: e.title_id,
        title: e.title,
        year: e.year,
        isSeries: e.kind === 'series',
        why: e.why,
        files: [],
      };
      groups.set(key, g);
    }
    g.files.push(e);
  }
  return [...groups.values()];
}

/** A row's own key, so the ring can be put on it. */
export const worthRowKey = (group: WorthGroup) => `worth-row:${group.key}`;

/** How many files are read again at once. */
const BATCH = 500;

let running: Promise<number> | null = null;

/**
 * Read again what the start-up listed, until nothing is left. Returns how many
 * entries were stored. Safe to call more than once; a second call joins the
 * first. `parse` is the scan's own (worker, giving way to a film playing).
 */
export function runWorthALook(
  roots: LibraryRoot[],
  parse: (files: MediaFile[], roots: LibraryRoot[]) => Promise<ParseResultPayload[]>
): Promise<number> {
  running ??= (async () => {
    let stored = 0;
    try {
      for (;;) {
        const batch = await worthALookNext(BATCH);
        if (batch.length === 0) break;
        const fresh = await parse(batch, roots);
        // The parser stopped part way (Kinema left the screen): what was not
        // read stays on the list for next time.
        const byId = new Map(fresh.map((p) => [p.id, p]));
        const done: number[] = [];
        const found: { file_id: number; why: string }[] = [];
        for (const file of batch) {
          const payload = byId.get(file.id);
          if (!payload) continue;
          done.push(file.id);
          const why = compareParse(file, payload);
          if (why) found.push({ file_id: file.id, why: JSON.stringify(why) });
        }
        if (done.length === 0) break;
        stored += await worthALookSave(done, found);
      }
      if (stored > 0) console.info(`worth a look: ${stored} matched file(s) listed`);
      return stored;
    } finally {
      running = null;
    }
  })();
  return running;
}

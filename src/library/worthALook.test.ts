/**
 * Worth a look: what today's parser reads differently from what the old rules
 * stored, with the real guessit-js, and the sentence each entry says.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseForLibrary } from './parse';
import type { LibraryRoot } from './api';
import { compareParse, whyWords, type Why, type WorthTodo } from './worthALook';

const roots: LibraryRoot[] = [{ id: 1, path: 'D:/Movies', kind: 'movies' } as LibraryRoot];

/** A file as an older version left it: matched by score, with what it read then. */
function matched(
  path: string,
  stored: { title: string; year: number | null },
  reason = 'title 100%, year exact',
  linked: { title: string; year: number | null } = { title: 'Back to the Future', year: 1985 }
): WorthTodo {
  const cut = path.lastIndexOf('/');
  return {
    id: 1,
    path,
    parent_dir: path.slice(0, cut),
    file_name: path.slice(cut + 1),
    size_bytes: 1,
    missing: false,
    match_status: 'matched',
    parsed_title: stored.title,
    parsed_year: stored.year,
    parsed_season: null,
    parsed_episode: null,
    parsed_kind: 'movie',
    parsed_from: 'parent',
    title_id: 1,
    match_confidence: 1,
    match_reason: reason,
    matched_title: linked.title,
    episode_name: null,
    title_year: linked.year,
  };
}

const check = (file: WorthTodo) => {
  if (file.parsed_title === 'Dune') file.matched_title = 'Dune';
  return compareParse(file, parseForLibrary(file, roots));
};

beforeAll(async () => {
  await initParser();
});

describe('reading a matched file again', () => {
  it('lists the trilogy parts the old rules read as the first film', () => {
    const old = { title: 'Back to the Future', year: 1985 };
    const dir = 'D:/Movies/Back to the Future (1985)';
    const two = check(matched(`${dir}/Back to the Future Part II.mkv`, old));
    const three = check(matched(`${dir}/Back to the Future Part III.mkv`, old));
    expect(two).toMatchObject({ kind: 'title', was: 'Back to the Future' });
    expect(three).toMatchObject({ kind: 'title', was: 'Back to the Future' });
    expect(whyWords(JSON.stringify(two), 'Back to the Future')).toBe(
      'The file\'s own name says Part 2, which Kinema did not read before. It is linked to “Back to the Future”.'
    );
    // The first film itself reads as it did: not listed.
    expect(check(matched(`${dir}/Back to the Future (1985).mkv`, old))).toBeNull();
  });

  it('lists a tie settled by popularity with no year, and not one with a year', () => {
    const tie = 'title 100%, no candidate year; tie vs "Dune" broken by popularity';
    const dune = check(matched('D:/Movies/Dune.mkv', { title: 'Dune', year: null }, tie));
    expect(dune).toEqual({ kind: 'tie' });
    expect(whyWords(JSON.stringify(dune), 'Dune')).toMatch(/gives no year.*“Dune”, which is not always/);
    // Against a title of another name the new rule settles it the same way.
    const other = 'title 100%; tie vs "Dune: Part One" broken by popularity';
    expect(check(matched('D:/Movies/Dune.mkv', { title: 'Dune', year: null }, other))).toBeNull();
    expect(
      check(matched('D:/Movies/Dune (2021).mkv', { title: 'Dune', year: 2021 }, tie))
    ).toBeNull();
    // Votes with a year still settle a tie under the new rules.
    expect(
      check(matched('D:/Movies/Dune.mkv', { title: 'Dune', year: null }, 'title 100%; tie vs "Dune" broken by votes'))
    ).toBeNull();
  });

  it('does not list a file an older parser read another way that is still linked right', () => {
    const name = 'The.Godfather.Part.II.1974.1080p.BluRay.x264-GRP.mkv';
    const file = matched(
      `D:/Movies/${name}`,
      { title: 'The Godfather', year: 1974 },
      'title 100%, year exact',
      { title: 'The Godfather Part II', year: 1974 }
    );
    expect(check(file)).toBeNull();
    // Linked to the first part, the same reading is worth a look.
    file.matched_title = 'The Godfather';
    file.title_year = 1972;
    expect(check(file)).toMatchObject({ kind: 'title' });
  });

  it('does not list a name that only differs in spelling', () => {
    expect(check(matched('D:/Movies/Heat (1995)/Heat.1995.mkv', { title: 'heat', year: 1995 }))).toBeNull();
  });

  it('says a year read differently', () => {
    const why: Why = { kind: 'year', was: 1985, now: null };
    expect(whyWords(JSON.stringify(why), 'X')).toBe('Read again, the file gives no year; it was read as 1985.');
    expect(whyWords(JSON.stringify({ kind: 'year', was: 1985, now: 1989 }), 'X')).toBe(
      "Read again, the file's name says 1989, not 1985."
    );
  });
});

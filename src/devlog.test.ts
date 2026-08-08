/**
 * Keys must not reach the log file.
 *
 * `app.log` is the file every bug report asks people to attach, and TMDB takes
 * its key as a query parameter — so one logged request URL is a key handed to
 * whoever reads the issue. This is the whole reason the redaction exists, and a
 * regex is exactly the sort of thing that quietly stops matching.
 */
import { describe, expect, it } from 'vitest';
import { redact } from './devlog';

describe('redact', () => {
  it('removes a TMDB key from a request URL', () => {
    const line = 'https://api.themoviedb.org/3/search/movie?api_key=abc123&query=Heat';
    expect(redact(line)).toBe(
      'https://api.themoviedb.org/3/search/movie?api_key=REDACTED&query=Heat'
    );
  });

  it('removes an OMDb key, which spells the parameter differently', () => {
    expect(redact('https://www.omdbapi.com/?apikey=deadbeef&s=Heat')).toContain('apikey=REDACTED');
  });

  it('does not care about case', () => {
    expect(redact('?API_KEY=Secret123')).toBe('?API_KEY=REDACTED');
  });

  it('handles a key at the very end of a line, with nothing after it', () => {
    expect(redact('GET /3/movie/550?api_key=SECRET')).toBe('GET /3/movie/550?api_key=REDACTED');
  });

  it('removes every key when a line carries more than one', () => {
    const out = redact('first ?api_key=one& second ?apikey=two&');
    expect(out).not.toContain('one');
    expect(out).not.toContain('two');
  });

  it('leaves ordinary log lines alone', () => {
    const line = 'startup scan failed: could not read D:\\Media\\TV Shows';
    expect(redact(line)).toBe(line);
  });

  /** `query=` is not a secret, and mangling it would make logs harder to read. */
  it('does not touch unrelated query parameters', () => {
    expect(redact('?query=Heat&year=1995')).toBe('?query=Heat&year=1995');
  });
});

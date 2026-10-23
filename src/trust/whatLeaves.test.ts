/**
 * "What leaves your computer" stays true (notes/CLAUDE.md, CONTRIBUTING).
 *
 * Every host named in the code — Rust, TypeScript, Kotlin, the capability and
 * Tauri config — must be on the page (whatLeaves.json), as a service Kinema
 * talks to or as a link that opens in the browser, or be here in NOT_CONTACTED
 * with the reason it is never contacted. A new service fails this test until
 * the page says what it sends, when, and what stops it.
 */
import { describe, expect, it } from 'vitest';
import page from './whatLeaves.json';

/** Named in the code but never contacted by Kinema or opened for the user. */
const NOT_CONTACTED: Record<string, string> = {
  localhost: 'the app’s own pages',
  'asset.localhost': 'the app’s own files',
  'ipc.localhost': 'the app talking to itself',
  '127.0.0.1': 'the player streaming from Kinema on this device',
  'schema.tauri.app': 'the config file’s schema, read by editors',
  'www.w3.org': 'the SVG namespace',
  'com.kinema.app': 'the app’s own identifier, not a host',
  'www.imdb.com': 'IMDb’s credit line, text only',
  'theintrodb.org': 'TheIntroDB’s credit line, text only',
  'themoviedb.org': 'read out of NFO files to find a TMDB number',
  'thetvdb.com': 'read out of NFO files to find a TheTVDB number',
};

const SOURCES = {
  ...import.meta.glob(
    [
      '/src/**/*.{ts,tsx}',
      '!/src/**/*.test.{ts,tsx}',
      '!/src/dev/**',
      '/src-tauri/src/**/*.rs',
      '/src-tauri/gen/android/app/src/main/**/*.kt',
      '/src-tauri/capabilities/*.json',
      '/src-tauri/tauri.conf.json',
      '/index.html',
    ],
    { query: '?raw', import: 'default', eager: true }
  ),
} as Record<string, string>;

/**
 * A Rust file without its `#[cfg(test)] mod … { … }` blocks. Only modules:
 * a `#[cfg(test)]` helper sits among real code, which still has to be read.
 */
export function withoutTestModules(text: string): string {
  const start = /#\[cfg\(test\)\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+\w+\s*\{/g;
  let out = '';
  let from = 0;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    out += text.slice(from, m.index);
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    from = i;
    start.lastIndex = i;
  }
  return out + text.slice(from);
}

/** Hosts named in one file: in URLs, and as a bare quoted host name. */
export function hostsIn(path: string, text: string): string[] {
  // A Rust file's own tests are not the app; anything after them may be.
  const body = path.endsWith('.rs') ? withoutTestModules(text) : text;
  const found: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) found.push(m[1]);
    for (const m of line.matchAll(/["'`]((?:[a-z0-9-]+\.)+(?:com|org|net|tv|app|io|dev))["'`/]/gi))
      found.push(m[1]);
  }
  return found.map((h) => h.toLowerCase());
}

describe('What leaves your computer', () => {
  it('reads the sources it checks', () => {
    const paths = Object.keys(SOURCES);
    expect(paths.some((p) => p.endsWith('/providers.ts'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/trakt.rs'))).toBe(true);
    expect(paths.some((p) => p.endsWith('default.json'))).toBe(true);
  });

  it('names every host the code contacts', () => {
    const listed = new Set([
      ...page.services.flatMap((s) => s.hosts),
      ...page.links.hosts.map((l) => l.host),
      ...Object.keys(NOT_CONTACTED),
    ]);
    const missing: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      for (const host of hostsIn(path, text)) {
        if (!listed.has(host)) missing.push(`${host} (${path})`);
      }
    }
    expect(missing, 'add these to src/trust/whatLeaves.json').toEqual([]);
  });

  it('says what each service sends, when, and what stops it', () => {
    for (const s of page.services) {
      expect(s.sends && s.when && s.stop, s.id).toBeTruthy();
    }
    expect(new Set(page.services.map((s) => s.id)).size).toBe(page.services.length);
  });

  it('finds a host in a URL and a bare one, and skips comments and Rust tests', () => {
    const rust = [
      'const A: &str = "https://api.example.com/v1";',
      'const B: &str = "host.example.org";',
      '// "https://commented.example.com"',
      '#[cfg(test)]',
      'fn helper() -> &str { "https://helper.example.com" }',
      '#[cfg(test)]',
      'mod tests {',
      '    fn t() { let _ = "https://test.example.com"; }',
      '}',
      'const D: &str = "https://after.example.net";',
    ].join('\n');
    expect(hostsIn('x.rs', rust)).toEqual([
      'api.example.com',
      'host.example.org',
      'helper.example.com',
      'after.example.net',
    ]);
  });
});

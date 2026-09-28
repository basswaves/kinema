/**
 * What an error means to the person looking at the screen.
 *
 * Errors reach the UI as whatever the layer below produced — a Rust
 * `to_string()`, a Windows `(os error 3)`, an HTTP status — and printing that
 * verbatim put "error sending request for url (…)" in front of someone who
 * wanted to know whether the NAS is asleep. The raw text is not lost: `userError`
 * writes it to `app.log`, which is where a bug report gets it from anyway.
 *
 * The rules match on the text because that is all there is to match on. Anything
 * no rule recognises is shown as it is, minus a leading `Error:` — an honest
 * technical sentence beats a vague friendly one that hides what happened.
 */

const RULES: [RegExp, string][] = [
  [
    /os error 53\b|os error 67\b|network (path|name) (was not found|cannot be found)/i,
    'The network drive can’t be reached. Check that it is switched on and connected.',
  ],
  [
    /os error [23]\b|cannot find the (file|path)|no such file/i,
    'A file or folder Kinema needed isn’t there. If it is on a network drive or USB disk, check that it is connected.',
  ],
  [
    /os error 5\b|access is denied|permission denied/i,
    'Windows refused access. Check that the folder can be opened in File Explorer, then try again.',
  ],
  [/database is locked|database table is locked/i, 'Kinema was busy. Try again in a moment.'],
  [
    /HTTP 401\b|invalid api key/i,
    'The TMDB key was not accepted. Check it in Settings.',
  ],
  [/HTTP 429\b/, 'The online service asked Kinema to slow down. Try again in a minute.'],
  [/HTTP 5\d\d\b/, 'The online service had a problem at its end. Try again later.'],
  [
    /error sending request|dns error|timed out|connection (refused|reset|closed)|failed to fetch/i,
    'Couldn’t reach the internet. Check the connection and try again.',
  ],
];

/** The raw text of anything thrown. */
export function rawError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

/** A sentence for the screen. Pure, so it can be tested. */
export function describeError(e: unknown): string {
  const raw = rawError(e).trim();
  for (const [pattern, message] of RULES) {
    if (pattern.test(raw)) return message;
  }
  return raw.replace(/^error:\s*/i, '') || 'Something went wrong.';
}

/**
 * `describeError`, with the original written to the log first — the one place
 * a person who needs the technical detail will look for it.
 */
export function userError(e: unknown): string {
  console.warn('shown to the user:', rawError(e));
  return describeError(e);
}

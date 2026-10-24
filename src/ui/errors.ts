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

/**
 * Windows' error numbers are matched as numbers because its messages come in
 * the user's language ("Ingen tilgang. (os error 5)"). Linux's messages are
 * English and its numbers mean other things — its 5 is a failed read, not
 * "access denied" — so Linux is matched by text, and before the Windows
 * numbers it would otherwise fall into.
 */
import { capabilitiesNow } from '../capabilities';

/**
 * Access refused, said in the words of the system that refused it. Android is
 * a Linux underneath, but there it is the app's permissions that decide, not
 * an account's, and there is no file manager to try the folder in.
 */
function refusedAccess(): string {
  switch (capabilitiesNow()?.system) {
    case 'Linux':
      return 'Linux refused access. Check that your account can open the folder in the file manager, then try again.';
    case 'Android':
      return 'Android refused access. Check that Kinema is allowed to read files and media in Android’s settings for apps, then try again.';
    default:
      return 'Windows refused access. Check that the folder can be opened in File Explorer, then try again.';
  }
}

/**
 * A request that got no answer, said with the host it was sent to. It used to
 * say "the internet" for every one of them, which is false whenever the
 * internet works and one service does not get through.
 */
function noAnswer(raw: string): string {
  const host = /for url \(https?:\/\/([^/:)\s]+)/i.exec(raw)?.[1];
  return host
    ? `Couldn’t reach ${host}. Check the connection and try again.`
    : 'Couldn’t reach the service. Check the connection and try again.';
}

/**
 * A network drive's refusal, which arrives as the SMB library's status line —
 * "Server returned an error message with status: Bad Network Name
 * (0xc00000cc)" — in front of a person who typed a folder's path on a laptop
 * (a tester, 2026-10-24). The codes are Windows' NTSTATUS values, the same on
 * every NAS. The server and the shared folder come from the address in front.
 */
export function smbWords(raw: string): string {
  const code = /status: [^(]*\(0x([0-9a-f]{8})\)/i.exec(raw)?.[1].toLowerCase() ?? '';
  const where = /smb:\/\/([^/\\\s:]+)(?:\/([^/\\:]+))?/i.exec(raw);
  const server =
    where?.[1] ?? /(?:could not ask|could not reach) (\S+?)[: ]/i.exec(raw)?.[1] ?? /^(\S+) needs a sign-in/.exec(raw)?.[1] ?? 'The network drive';
  const share = where?.[2];
  switch (code) {
    case 'c00000cc': // BAD_NETWORK_NAME
      return share
        ? `${server} has no shared folder called “${share}”. Pick one of the folders it shares, or share the folder on ${server} first.`
        : `${server} has no shared folder by that name. Share the folder on ${server} first.`;
    case 'c000006d': // LOGON_FAILURE
      return `${server} did not accept that user name and password.`;
    case 'c0000022': // ACCESS_DENIED
      return `${server} let Kinema in, but that user may not read this folder. On ${server}, give the user permission to read the shared folder.`;
    case 'c000006e': // ACCOUNT_RESTRICTION: most often a user with no password
      return `${server} does not let that user sign in over the network — most often because the user has no password. Give it one on ${server}, or use another user.`;
    case 'c0000072': // ACCOUNT_DISABLED
      return `That user is switched off on ${server}. Use another user, or switch it on there.`;
    case 'c0000234': // ACCOUNT_LOCKED_OUT
      return `That user is locked on ${server} after too many wrong passwords. Wait a while, or unlock it there.`;
    case 'c0000071': // PASSWORD_EXPIRED
    case 'c0000224': // PASSWORD_MUST_CHANGE
      return `That user’s password on ${server} has to be changed first. Change it there, then sign in again.`;
    case 'c000015b': // LOGON_TYPE_NOT_GRANTED
      return `${server} does not let that user sign in from the network. Use another user, or allow it there.`;
    case 'c000000f': // NO_SUCH_FILE
    case 'c0000034': // OBJECT_NAME_NOT_FOUND
    case 'c000003a': // OBJECT_PATH_NOT_FOUND
      return `That folder or file is not on ${server} any more. It may have been moved or renamed.`;
    case 'c0000043': // SHARING_VIOLATION
      return `Another program on ${server} has that file open. Try again in a moment.`;
    case 'c00000c9': // NETWORK_NAME_DELETED
    case 'c0000203': // USER_SESSION_DELETED
    case 'c000035c': // NETWORK_SESSION_EXPIRED
      return `${server} closed the connection. Try again.`;
    default:
      return `${server} refused with an error Kinema has no words for yet (code ${code ? `0x${code}` : 'unknown'}). Try again, or send a report.`;
  }
}

const RULES: [RegExp, string | ((raw: string) => string)][] = [
  [/(?:message status|with status): [^(]*\(0x[0-9a-f]{8}\)/i, smbWords],
  [
    /input\/output error|stale file handle/i,
    'The disk or network drive did not answer. Check that it is connected, then try again.',
  ],
  [
    /os error 53\b|os error 67\b|network (path|name) (was not found|cannot be found)|no route to host|host is down/i,
    'The network drive can’t be reached. Check that it is switched on and connected.',
  ],
  [
    /os error [23]\b|cannot find the (file|path)|no such file/i,
    'A file or folder Kinema needed isn’t there. If it is on a network drive or USB disk, check that it is connected.',
  ],
  [
    /os error 5\b|access is denied|permission denied/i,
    refusedAccess,
  ],
  [/database is locked|database table is locked/i, 'Kinema was busy. Try again in a moment.'],
  [
    /HTTP 401\b|invalid api key/i,
    'The TMDB key was not accepted. Check it in Settings → Posters & ratings.',
  ],
  // wikidata.ts, after waiting it out: before the HTTP rules, which the
  // message can also contain.
  [
    /Wikimedia is busy/,
    'Wikipedia is busy right now. Kinema tries again on the next scan, or try again in a minute.',
  ],
  [/HTTP 429\b/, 'The online service asked Kinema to slow down. Try again in a minute.'],
  [/HTTP 5\d\d\b/, 'The online service had a problem at its end. Try again later.'],
  [
    /error sending request|dns error|timed out|connection (refused|reset|closed)|failed to fetch/i,
    noAnswer,
  ],
];

/**
 * `text` with every web address cut at its `?`. A failed request's error
 * names its whole URL, keys included (TMDB's built-in one was on a tester's
 * screen); the host and path are what tell anyone anything.
 */
export function withoutQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?)"']+)\?[^\s)"']*/g, '$1');
}

/** The raw text of anything thrown. */
export function rawError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

/** A sentence for the screen. Pure, so it can be tested. */
export function describeError(e: unknown): string {
  const raw = rawError(e).trim();
  for (const [pattern, message] of RULES) {
    if (pattern.test(raw)) return typeof message === 'string' ? message : message(raw);
  }
  return withoutQueries(raw.replace(/^error:\s*/i, '')) || 'Something went wrong.';
}

/**
 * `describeError`, with the original written to the log first — the one place
 * a person who needs the technical detail will look for it.
 */
export function userError(e: unknown): string {
  console.warn('shown to the user:', withoutQueries(rawError(e)));
  return describeError(e);
}

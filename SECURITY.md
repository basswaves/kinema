# Security policy

## What Kinema's attack surface actually is

Worth stating up front, because it is unusually small:

- **No server, no daemon, no network listener.** Nothing accepts a connection.
- **No accounts, no telemetry, no analytics.** Nothing is sent anywhere about
  what you watch — unless you connect SIMKL yourself, in Settings → Playback.
  Then the films and episodes you finish, and when, are sent to your SIMKL
  account (`src-tauri/src/simkl.rs`), and nothing else is. Disconnecting ends
  it and tells SIMKL to end the sign-in.
- **Outbound requests only, to seven services for metadata** — TMDB, TVmaze,
  OMDb, Wikidata (with Wikipedia), TheIntroDB, IntroDB and IMDb's ratings
  file — **and
  one to GitHub** per launch, asking for the latest
  release's version number (`src-tauri/src/updates.rs`; Settings → Advanced
  turns it off). No program is downloaded; the one file is IMDb's public
  ratings table, fetched weekly at most, read as it arrives, and not kept
  (`src-tauri/src/imdb.rs`). The frontend's list is enforced in
  `src-tauri/capabilities/default.json` for the HTTP plugin; the four made
  from Rust are TheIntroDB, IntroDB, IMDb and GitHub.
- **Your API keys stay local.** TMDB and OMDb keys you enter are stored in
  the SQLite database in your app data folder, and sent only to the service they
  belong to. So is SIMKL's sign-in, when you connect it: SIMKL's own tokens,
  never your password, which you type only on SIMKL's page. Released builds carry one key of Kinema's own, for TMDB, added at
  build time from a repository secret; no key is committed. That key is not a
  secret from anyone holding the app — any key a program sends can be read out
  of it — and gives access to nothing but TMDB's public, read-only data.
- **Media files are read, never modified** — with one explicit exception you
  have to press: NFO export writes `.nfo` sidecars beside your videos.

The parts most worth scrutiny are the ones that cross a trust boundary: the
external process invocation in `src-tauri/src/detect.rs` (Skiptro and ffmpeg,
launched with user-editable argument templates), the XML parsing in
`src-tauri/src/nfo.rs`, and the HTTP clients in `src/metadata/providers.ts`,
`src-tauri/src/introdb.rs`, `src-tauri/src/introdb_app.rs` and
`src-tauri/src/simkl.rs` (which holds a user's SIMKL tokens).

## Reporting a vulnerability

Please **do not open a public issue** for anything exploitable.

Use GitHub's [private vulnerability
reporting](https://github.com/Basswaves/kinema/security/advisories/new) on this
repository. That opens a channel visible only to the maintainer.

Include what you would put in a bug report — what you did, what happened, and
the relevant part of `app.log` — plus what an attacker would gain.

### What to expect

This is a single-maintainer hobby project, not a funded one. There is no
guaranteed response time and no bug bounty. Reports will be read and taken
seriously, and you will be credited in the fix unless you would rather not be.

## Supported versions

The latest release, and `master`. There are no backports.

## Things that are not vulnerabilities

- **SmartScreen warns on the downloaded executable.** It is not code-signed.
  This is expected and documented in the README; verify the SHA-256 published
  with the release instead.
- **API keys are readable in the local database.** They are stored in plain text
  in your own app data folder, deliberately — anything reversible on the same
  machine would be obfuscation, not encryption. Treat the database as being as
  sensitive as the keys in it.
- **The app reads a Skiptro database and runs a Skiptro binary you configured.**
  Pointing it at a hostile executable is not an escalation; you supplied the
  path.

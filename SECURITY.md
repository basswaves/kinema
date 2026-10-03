# Security policy

## What Kinema's attack surface actually is

Worth stating up front, because it is unusually small:

- **No server, no daemon, no network listener.** Nothing accepts a connection.
- **No accounts, no telemetry, no analytics.** Nothing is sent anywhere about
  what you watch — unless you connect SIMKL or Trakt yourself, in Settings →
  Accounts. Then the films and episodes you finish, and when, are sent to that
  account (`src-tauri/src/simkl.rs`, `src-tauri/src/trakt.rs`), and nothing
  else is; for Trakt, Kinema also reads which films and episodes the account
  has already watched, once, so as not to send them twice. Disconnecting ends
  it and asks the service to end the sign-in.
- **Outbound requests only, to seven services for metadata** — TMDB, TVmaze,
  OMDb, Wikidata (with Wikipedia), TheIntroDB, IntroDB and IMDb's ratings
  file — **one to GitHub** per launch, asking for the latest
  release's version number (`src-tauri/src/updates.rs`; Settings → Advanced
  turns it off), **and three only when you use them**: SIMKL and Trakt once
  connected, and OpenSubtitles when you ask for subtitles or switch on forced
  subtitles. No program is downloaded; the files fetched are IMDb's public
  ratings table, fetched weekly at most, read as it arrives, and not kept
  (`src-tauri/src/imdb.rs`), and subtitle text from OpenSubtitles. The
  frontend's list is enforced in `src-tauri/capabilities/default.json` for the
  HTTP plugin; the ones made from Rust are TheIntroDB, IntroDB, IMDb, GitHub,
  SIMKL, Trakt and OpenSubtitles.
- **One password is kept, if you give it: OpenSubtitles'.** OpenSubtitles
  has no way to approve an app from a phone, and its sign-in lasts a day, so
  to sign in again Kinema keeps the password — on Windows encrypted with
  DPAPI to your Windows user, so only you on that PC can read it back, even
  from Kinema's safety copies. On Linux it is kept as it is, in Kinema's
  database, as Kodi and Jellyfin keep theirs; Kinema's data folder is made
  readable by your account only. It is sent only to OpenSubtitles
  (`src-tauri/src/opensubtitles.rs`). Without an account, nothing is kept.
- **Your API keys stay local.** TMDB and OMDb keys you enter are stored in
  the SQLite database in your app data folder, and sent only to the service they
  belong to. So are SIMKL's and Trakt's sign-ins, when you connect them: the
  service's own tokens, never your password, which you type only on the
  service's page. Released builds carry keys of Kinema's own — for TMDB, and
  the SIMKL and Trakt app IDs with Trakt's client secret — added at build time
  from repository secrets; none is committed. They are not secret from anyone
  holding the app — any key a program sends can be read out of it — and none
  gives access to anyone's account: that needs the person's own approval.
- **Media files are read, never modified** — with one explicit exception you
  have to press: NFO export writes `.nfo` sidecars beside your videos.
- **On Linux, Kinema also talks to the desktop it runs on** — over D-Bus and
  Wayland, on the same machine only — to read and switch the screen's mode
  (GNOME, Cinnamon, KDE Plasma's `kscreen-doctor`, the wlroots protocol), to
  borrow the receiver's sound device for a film, and to ask logind for sleep
  or shut down (`src-tauri/src/desktop.rs`, `audio_reserve.rs`, `power.rs`).

The parts most worth scrutiny are the ones that cross a trust boundary: the
external process invocation in `src-tauri/src/detect.rs` (Skiptro and ffmpeg,
launched with user-editable argument templates), the XML parsing in
`src-tauri/src/nfo.rs`, and the HTTP clients in `src/metadata/providers.ts`,
`src-tauri/src/introdb.rs`, `src-tauri/src/introdb_app.rs` and
`src-tauri/src/simkl.rs` and `src-tauri/src/trakt.rs` (which hold a user's
tokens), and `src-tauri/src/opensubtitles.rs` (which keeps a password and
reads the first and last 64 KiB of a video to match subtitles to it).

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

- **SmartScreen warns on the downloaded executable** (Windows). It is not code-signed.
  This is expected and documented in the README; verify the SHA-256 published
  with the release instead.
- **API keys are readable in the local database.** They are stored in plain text
  in your own app data folder, deliberately — anything reversible on the same
  machine would be obfuscation, not encryption. Treat the database as being as
  sensitive as the keys in it.
- **The app reads a Skiptro database and runs a Skiptro binary you configured.**
  Pointing it at a hostile executable is not an escalation; you supplied the
  path.

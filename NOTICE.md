# Notices and attribution

Kinema itself is MIT licensed — see [LICENSE](LICENSE). This file covers the
third-party software it links against, the binaries it invokes but does not
ship, and the metadata services it reads.

Nothing here is a third-party binary committed to this repository. The only
native library the app needs is fetched by a documented command at build time,
and everything else is either a normal package dependency or a tool the user
installs themselves.

---

## Native playback library — mpv / libmpv

The player is [libmpv](https://mpv.io). It is **not** in this repository and
**not** built from here. `npx tauri-plugin-libmpv-api setup-lib` downloads a
prebuilt **LGPL** configuration of `libmpv-2.dll` from
[zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild), together with
the plugin's own `libmpv-wrapper.dll`, into `src-tauri/lib/`.

Two consequences worth stating plainly:

- The library is **loaded dynamically at runtime** and is not statically linked,
  so linking against it does not impose copyleft obligations on Kinema's own
  MIT-licensed source.
- Because the release ZIP redistributes that unmodified LGPL binary, the LGPL's
  relinking condition applies to it. It is satisfied by construction: the DLL
  sits beside the executable and **may be replaced with any compatible build of
  libmpv** without rebuilding Kinema. Source for the library is available from
  the mpv project and from the build repository linked above.

If you build a GPL configuration of mpv into a distribution of this app
instead, that distribution becomes subject to the GPL. The default path does
not do this.

## Audio fingerprinting — rusty-chromaprint

[`rusty-chromaprint`](https://crates.io/crates/rusty-chromaprint) (MIT), a pure
Rust implementation with no C library. It is what makes intro and credits
detection possible inside the app rather than as another installed tool.

## Filename parsing — guessit-js

[`guessit-js`](https://www.npmjs.com/package/guessit-js) is **LGPL-3.0**. It is
used unmodified, as a library, through its published interface.

## Everything else

The remaining Rust crates and npm packages are permissively licensed (MIT,
Apache-2.0, BSD). `src-tauri/Cargo.lock` and `package-lock.json` are the
authoritative list.

---

## Tools invoked but never shipped

Kinema ships no third-party executables, downloads none, and depends on none
being present. Each of these is optional, is found at a path the user chooses,
and its absence degrades one feature rather than breaking the app.

### ffmpeg

Used by `src-tauri/src/analyse.rs` to decode short windows of audio and to run
`blackdetect` on the credits boundary. Not bundled, not downloaded; the path is
configurable in Settings and defaults to whatever is on `PATH`. Without it, the
app's own intro/credits detection is skipped and every other marker source
carries on. ffmpeg is licensed under the LGPL or GPL depending on how the build
you install was configured — that is between you and your ffmpeg.

### Skiptro

Optional intro detection. Kinema can run a copy **you installed yourself**, at a
path you chose, with the command lines editable in Settings, and can read its
database at `%APPDATA%\Skiptro\skiptro.db`. Nothing from Skiptro is included
here.

---

## Metadata services

### TMDB

This product uses the TMDB API but is **not endorsed or certified by TMDB**.

Data and images from [The Movie Database](https://www.themoviedb.org), used
non-commercially under [TMDB's terms of use](https://www.themoviedb.org/api-terms-of-use).
Released builds carry an API key of Kinema's own, added at build time and not
in this repository; a key a user enters in Settings is used instead and stays
in the local database in app data. As the terms require, nothing from TMDB is
kept longer than six months: older titles and images are fetched again
(`TMDB_MAX_AGE_SECS` in `src-tauri/src/metadata.rs`).

`public/tmdb.svg` is TMDB's own logo, unmodified, taken from their
[logo and attribution page](https://www.themoviedb.org/about/logos-attribution)
and included so the required attribution renders without a network request. The
logo is TMDB's property and is used solely to attribute them, not as a mark of
this project.

### TVmaze

TV metadata from [TVmaze](https://www.tvmaze.com), used through their free
public API under their
[licensing terms](https://www.tvmaze.com/api#licensing), which require
attribution and permit non-commercial use. Requests are rate-limited in
`src/metadata/providers.ts` to respect their published limit. No key required.

### OMDb

Optional, with a user-supplied key stored locally, subject to OMDb's terms:
a movie fallback, and the source of Rotten Tomatoes scores. OMDb's data is
licensed [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) and
is credited in Settings. There is deliberately no key of Kinema's own: its free
keys allow 1,000 lookups a day, and Kinema spends at most 500 of the user's on
scores, one per title a month (`src/metadata/scores.ts`).

### Wikidata and Wikipedia

The movie fallback when no TMDB key can be used (`src/metadata/wikidata.ts`).
Film data from [Wikidata](https://www.wikidata.org), which is dedicated to the
public domain under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
Descriptions are the opening of the film's article on
[English Wikipedia](https://en.wikipedia.org), under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and are
credited where they are shown and in Settings. Requests follow Wikimedia's API
etiquette: one at a time, with an identifying `Api-User-Agent`, backing off on
`maxlag`. No key required, and no pictures are taken from either.

### TheIntroDB

Intro and credits segment times from [TheIntroDB](https://theintrodb.org),
community-contributed. Reads are unauthenticated. The terms are honoured in code
rather than only in documentation — see the module header of
`src-tauri/src/introdb.rs`:

- **One episode at a time, when it is played.** The library is never bulk
  fetched; a sweep of every episode is the shape of request their licence exists
  to prohibit.
- **The cache expires** after 30 days, so a local copy never drifts towards
  being a second copy of their database, and community corrections reach users.
- **Attribution is shown in Settings**, beside the switch that enables it.

Accuracy and coverage vary, as with any community database.

### IntroDB

Intro, recap, credits and post-credits segment times from
[IntroDB](https://introdb.app) — a separate service from TheIntroDB, despite the
name. Intro data provided by IntroDB (introdb.app). Reads are unauthenticated,
by IMDb id, and nothing is submitted. Their terms allow use in media players and
forbid bulk downloading; as with TheIntroDB, this is honoured in code — see the
module header of `src-tauri/src/introdb_app.rs`:

- **One film or episode at a time, when it is played.** Never the library in
  bulk.
- **The cache expires** after 30 days, as TheIntroDB's does.
- **Attribution is shown in Settings**, in the words they ask for, beside the
  switch that enables it.

### SIMKL

Only when a user connects their own [SIMKL](https://simkl.com) account: the
films and episodes they finish are added to its history through SIMKL's API,
under SIMKL's [terms](https://simkl.com/about/policies/terms/) and API rules.
Nothing is read back and no SIMKL data is shown, beyond the account's name in
Settings. Released builds carry Kinema's own SIMKL app ID, added at build time.

`public/simkl.svg` is SIMKL's brand mark, unmodified, as published in SIMKL's
API documentation for apps to show; their API rules ask that SIMKL is named and
its mark visible. It is drawn white on Kinema's dark settings, which the same
documentation provides for (the one-colour mark recoloured by CSS). The mark is
SIMKL's property and is used solely to identify their service.

### OpenSubtitles

Subtitles from [OpenSubtitles.com](https://www.opensubtitles.com), through its
REST API with Kinema's own app key, only when asked for in the player or when
the user has switched on fetching forced subtitles. A file is identified to it
by its title's ids and OpenSubtitles' file hash (the size and the first and
last 64 KiB). What is fetched is stored in Kinema's app data. Attribution is
shown in Settings.

### Trakt

Only when a user connects their own [Trakt](https://trakt.tv) account: the
films and episodes they finish are added to its history through Trakt's API,
under Trakt's API terms, and — once, at connect — the account's watched films
and episodes are read so nothing is sent twice. Nothing else is read back, and
no Trakt data is shown beyond the account's name in Settings. Kinema is not
endorsed by or affiliated with Trakt. Released builds carry Kinema's own Trakt
app, added at build time.

`public/trakt.svg` is Trakt's full logo for dark backgrounds, one of the
approved versions on Trakt's [branding page](https://app.trakt.tv/branding),
exactly as that page's download gives it. It is shown as their guidelines
require: unaltered, with clear space round it, and only to name their service —
not as part of Kinema's own mark or to suggest Trakt endorses it.

### IMDb

Information courtesy of IMDb (https://www.imdb.com). Used with permission.

Ratings and vote counts from IMDb's
[non-commercial datasets](https://data.imdb.com/non-commercial-datasets/),
used for personal and non-commercial purposes under IMDb's
[terms for them](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX).
As those terms require, only the published file is used — imdb.com itself is
never read — and no copy of it is kept: each copy of Kinema fetches
`title.ratings.tsv.gz` for itself, weekly at most, and keeps only the rows for
titles in its own library (`src-tauri/src/imdb.rs`). The credit above is shown
in Settings.

---

## Prior art

### Jellyfin intro-skipper

The audio-fingerprint method behind `src-tauri/src/analyse.rs` is the one
[Jellyfin's intro-skipper](https://github.com/intro-skipper/intro-skipper) uses,
reimplemented from scratch.

**Its code is GPL-3.0 C# and none of it is present here.** What transferred is
its *published operating values* — intro searched in the first 25% of an episode
or the first 10 minutes, whichever is smaller; intro 15 s to 2 minutes; credits
under about 4 minutes. Those are facts about how television is cut, not
expression.

What could not transfer is the layer below: the score threshold for a
fingerprint match and the clustering tolerance are calibrated against the
fingerprints Jellyfin's ffmpeg emits, and `rusty-chromaprint` produces a
different fingerprint on a different scale. Those constants were set here by
measurement, not by copying.

### NFO sidecars

The `.nfo` format read and written by `src-tauri/src/nfo.rs` is the de facto
interop format used by Kodi, MediaElch and tinyMediaManager. It is a convention,
not a specification, and no code from any of those projects is used.

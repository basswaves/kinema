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

Data and images from [The Movie Database](https://www.themoviedb.org). Kinema
does not ship an API key; each user supplies their own in Settings, and it is
stored only in the local database in app data. Use of the API is subject to
[TMDB's terms of use](https://www.themoviedb.org/api-terms-of-use).

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

Optional movie fallback from [OMDb](https://www.omdbapi.com). User-supplied key,
stored locally, subject to OMDb's terms.

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

# Changelog

Notable changes, newest first. Follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic
versioning](https://semver.org/), with the usual caveat that a `0.x` release
makes no stability promises.

## [Unreleased]

### Fixed

- **A part-downloaded episode no longer stays "watched" once it finishes.** An
  incomplete MKV plays — the container streams happily from a partial file —
  reports a wrong duration, reaches its short end and was marked complete. That
  flag survived the rest of the file arriving, so the episode silently dropped
  out of Continue Watching and was never offered again. Watch state is now
  cleared when a file's **size** changes, never merely its timestamp: an mtime
  moves when files are copied between drives or a NAS touches them, and
  clearing on that would let moving a library wipe every tick in it.
- **A file replaced since the last scan no longer keeps the old file's intro and
  credits markers.** The cache key covered every source but not the video.
- **A season that is still downloading is no longer re-analysed on every
  launch.** One growing file made the whole season stale, and analysis has to
  compare episodes against each other — so it re-read the lot each time, for an
  answer about to be discarded. The automatic pass now waits for files to stop
  changing and says how many it is waiting for; the Detect button still runs
  immediately.

### Changed

- **Intros and credits are now detected automatically.** A season dropped into a
  watched folder used to appear in the library immediately and then play with no
  Skip button, because both local detectors only ever ran from a button in
  Settings — the one screen you do not visit before you know something is wrong.
  Every scan that finds new episodes now goes on to detect their markers.
  Skiptro runs whenever it is installed and something new arrived; the built-in
  ffmpeg analysis runs unless it is switched off, under **Settings → Intro and
  credits markers → Built in**, since it is the slow one. Neither can fail a
  scan: a Skiptro that is not installed says nothing, one that has gone missing
  says so under the scan summary, and everything else carries on.
- ffmpeg now runs at below-normal priority, so an analysis triggered by a scan
  cannot compete with an episode being played at the same time.
- Settings no longer describes TheIntroDB as "asked once per episode", which
  read as though the app would ask *you* something and left at least one user
  waiting for a dialog that does not exist. It is a background lookup and always
  was.
- **Renamed from "Personal Netflix" to Kinema.** The bundle identifier changed
  with it, so the app now stores its library in
  `%APPDATA%\com.kinema.app\`. Anyone upgrading from a pre-release build must
  rename the old `com.personalnetflix.app` folder, or the library will look
  empty.

### Added

- **A first-run panel.** An empty library now offers the two things it needs —
  a folder and a TMDB key — as controls, with a link to where a free key comes
  from, instead of a sentence pointing at Settings.
- **A controls overlay**, on `?`, on a button in the top bar and on one in the
  player. It documents the control scheme for the first time inside the app,
  including that **Up** is what lets a remote reach subtitles, audio tracks,
  the stats panel and fullscreen at all.
- MIT licence, and a `NOTICE.md` covering libmpv (LGPL), guessit-js (LGPL-3),
  TMDB and TVmaze attribution, TheIntroDB's terms, and the provenance of the
  intro-detection method.
- TMDB and TVmaze attribution in Settings, with TMDB's logo, as their terms
  require.
- A README written for someone who has never seen the project, plus
  `CONTRIBUTING.md`, `SECURITY.md` and a code of conduct.

### Changed

- **Settings is written for the person using it**, not the person who built it.
  The frame-timing help was one paragraph containing *24p judder, 3:2 cadence,
  resampling, bitstream passthrough, TrueHD, DTS:X, AVR* and *PCM*, and
  documented a feature that does not exist; it is now two sentences saying what
  to try. `SMB`, `overscan`, `10-foot`, `sidecar`, `PATH`, `ffprobe` and `NFO`
  are gone or explained. **Skip intros** is now **Skip intros and credits**,
  which is what it always did.
- **Skiptro is explained and linked.** It was named in three places and never
  once described, and the section now opens by saying most people can skip it.
- Items in **Needs attention** lead with a plain sentence about what to do; the
  scorer's own wording is kept underneath for anyone who wants it.
- **Provider keys moved from sixth of eight sections in Settings to second**,
  and they now save themselves as you type. The old **Save keys** button was
  the only control on the page that did not apply on change, so typing a key
  and navigating away lost it.
- Both key fields are masked. This screen is routinely on a television.
- The design documents moved to `docs/`, and `HANDOVER.md` became
  `docs/ROADMAP.md`.
- Continuous integration on Windows: type-check, lint, frontend build and Rust
  tests on every push.
- A release workflow producing a portable ZIP with a published SHA-256.

### Removed

- `src/spike/PlayerSpike.tsx`, the Phase 0 mpv harness, and its styles. It had
  been unreachable from the UI for a long time. `docs/ROADMAP.md` says how to
  get it back from git history if you have an HDR display and want it.

### Fixed

- **Settings claimed detection results were "written next to your video
  files".** That stopped being true when sidecar export was turned off, and it
  is the wrong thing to be wrong about for anyone watching what lands on a NAS.
- The Tauri bundler is switched off. It had been configured to install the
  native playback libraries into a `lib/` subfolder, which produces an app that
  installs and launches normally and then fails the moment you press Play, with
  nothing written to either log. No installer was ever shipped from it.
- Removed a dead entry allowing requests to `api.mdblist.com`, which nothing had
  called since that provider was dropped.

## [0.1.0] — unreleased

First public release.

# Changelog

Notable changes, newest first. Follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic
versioning](https://semver.org/), with the usual caveat that a `0.x` release
makes no stability promises.

## [Unreleased]

### Changed

- **Renamed from "Personal Netflix" to Kinema.** The bundle identifier changed
  with it, so the app now stores its library in
  `%APPDATA%\com.kinema.app\`. Anyone upgrading from a pre-release build must
  rename the old `com.personalnetflix.app` folder, or the library will look
  empty.

### Added

- MIT licence, and a `NOTICE.md` covering libmpv (LGPL), guessit-js (LGPL-3),
  TMDB and TVmaze attribution, TheIntroDB's terms, and the provenance of the
  intro-detection method.
- TMDB and TVmaze attribution in Settings, as their terms require.
- Continuous integration on Windows: type-check, lint, frontend build and Rust
  tests on every push.
- A release workflow producing a portable ZIP with a published SHA-256.

### Fixed

- The Tauri bundler is switched off. It had been configured to install the
  native playback libraries into a `lib/` subfolder, which produces an app that
  installs and launches normally and then fails the moment you press Play, with
  nothing written to either log. No installer was ever shipped from it.
- Removed a dead entry allowing requests to `api.mdblist.com`, which nothing had
  called since that provider was dropped.

## [0.1.0] — unreleased

First public release.

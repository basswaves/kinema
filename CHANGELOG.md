# Changelog

Notable changes, newest first. Follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic
versioning](https://semver.org/), with the usual caveat that a `0.x` release
makes no stability promises.

## [Unreleased]

## [0.3.1] — 2026-09-25

Small follow-ups to 0.3.0's native output.

### Added

- **Dolby Vision is named.** The stats panel (`i`) shows the profile and what
  Kinema does with it — profile 5 converted to HDR10 with its own metadata,
  profiles 7 and 8 shown as their HDR10 layer — and the Output check says why
  Dolby Vision itself is not sent: Windows has no way to send it to a TV.

### Changed

- **Better advice for 8-bit HDR.** When the graphics driver is sending 8 bits
  at a refresh rate the cable could carry more, the Output check now also says
  to set the driver's output colour format to YCbCr 4:2:2 first if only 8 bits
  are offered — some drivers offer 10 or 12 bits at 4K only then.

## [0.3.0] — 2026-09-25

Native output: whatever the PC is connected to, the film reaches it the way it
was mastered — HDR as mastered, surround untouched to the receiver, the screen
at the film's own frame rate — and where that cannot happen, Kinema says why and
what would fix it.

### Upgrading

- **No library upgrade this time.** Everything new is a setting, and every
  setting starts where 0.2.0 behaved — except that HDR now reaches an HDR screen
  as mastered, and an SDR screen now gets Kinema's own tone mapping (see below).
- **Worth a look after updating:** Settings → **Screen** and **Sound**, and
  **Your equipment** to see what Kinema found.

### Added

- **Settings → Your equipment.** What Windows reports about every screen and
  sound device: resolution and refresh, HDR support, the modes a screen offers
  for films, which surround formats a receiver takes untouched, how many
  channels it takes directly, and whether Windows spatial sound is on. Checked
  at every launch and remembered per device, so a receiver that is on standby at
  launch keeps its last answers; the same account is written to `app.log`.
- **Send sound straight to the receiver** (Settings → Sound, off by default).
  While a film plays, Kinema takes the sound device for itself and passes Dolby
  TrueHD and Atmos, DTS-HD Master Audio and DTS:X, Dolby Digital (Plus) and DTS
  to the receiver untouched — only the formats the receiver said it takes, each
  overridable. Everything else goes as multichannel PCM up to what the device
  takes. Windows' speaker setup and spatial sound are bypassed while a film
  plays and untouched otherwise, so games keep "Dolby Atmos for home theater".
  The first film played on a setup that can use it offers this once.
- **A choice of sound device** in Settings → Sound.
- **Settings → Screen: match the screen to the film,** in fullscreen only.
  *Match the refresh rate* (off by default) switches to 23.976 Hz, 24, 25, 50
  or a clean multiple for each film, so pans stop juddering. *Resolution*
  (Auto by default) switches up when the desktop is set lower than the film;
  *Match content* hands the TV — or a video processor — the film at its own
  size. *Turn HDR on for HDR films* (off by default) switches Windows HDR on and
  back. The film waits, paused, until the picture is back, and the screen is
  put back on leaving fullscreen, leaving the player, closing Kinema, and at the
  next launch after a crash.
- **Output check** at the top of the stats panel (`i`): picture size, HDR,
  motion, colour depth and sound — each either native, or what is holding it
  back and how to fix it, including the HDMI link's bit depth and whether the
  cable or the graphics driver is the limit.

### Changed

- **HDR reaches an HDR screen as mastered.** mpv used to adapt the picture to
  the peak brightness Windows reports for the screen — often a round figure —
  and send that; the film's own HDR10 metadata now goes to the screen, which
  tone maps it, as with a disc player.
- **An SDR screen gets Kinema's tone mapping.** mpv used to send HDR even to a
  screen with HDR off and let Windows convert it; before each film Kinema now
  asks whether the screen showing it has HDR on, and sends HDR only if so.
- **Logs keep five sessions** instead of two.

### Fixed

- **A film no longer plays silently when Windows refuses the sound** (for
  example with a half-configured Windows spatial sound): Kinema falls back to
  the Windows mixer, then to stereo, and says so on screen.
- **The stats panel's HDR row reported tone mapping for every HDR file** — it
  read a property mpv does not have. It now says passthrough, compressed, or
  tone mapped to SDR, as it happened.

### Known limitations

- **Dolby Vision** is sent as HDR10: Windows has no way to send a Dolby Vision
  signal to a TV. Profile 7/8 play their HDR10 layer; profile 5 is converted.
- **With sound through Windows, Atmos and DTS:X height sound is lost,** even
  when Windows' "Atmos for home theater" makes the receiver show Atmos — that is
  Windows re-wrapping decoded 7.1. Only *Send sound straight to the receiver*
  keeps it.
- **Kinema cannot change the HDMI link's bit depth.** Where the Output check
  says the graphics driver is sending 8 bits, the setting is in the driver's own
  control panel.

## [0.2.0] — 2026-09-24

The result of a full review of the code, the logs and a real library — mostly
things that looked right and quietly did not happen, and the structure that let
them.

### Upgrading

- **Your library is upgraded automatically on first launch** (database version
  9 → 13), and a copy is made first, in `%APPDATA%\com.kinema.app\backups\`.
  The three most recent copies are kept.
- **Your watch history carries over**, and now belongs to the episode rather
  than to the file — see below.

### Added

- **Watch history follows the episode, not the file.** Moving or renaming a
  file, replacing it with a better copy, removing a folder and adding it back,
  or re-matching a show no longer loses what you have watched. Two copies of
  one episode are watched — or un-watched — together.
- **Detection can be stopped.** In Settings, **Detect** becomes **Stop
  detecting** while it runs, and **Scan now** becomes **Stop detection** during
  the scan's own detection. Seasons already finished are kept. Closing Kinema
  now stops a running Skiptro too; Windows used to leave it scanning, unseen,
  after the window had gone.
- **A remote's transport keys work in the player:** Play/Pause, Play, Pause,
  Stop (leaves the player), fast-forward and rewind (30 s), and the Back key
  many remotes send.
- **Settings → Developer tools → Open log folder.** Both logs now live in
  `%APPDATA%\com.kinema.app\logs\`, and the previous session's are kept
  beside them.

### Changed

- **Skip intro is offered from 0:00** whenever an intro is known, and stays
  until the intro ends — through a cold open too, where pressing it jumps to
  the end of the intro. It no longer disappears after ten seconds, and seeking
  back into the intro brings it back. Automatic mode still waits for the intro
  itself.
- **Skiptro's intro is used where Skiptro is sure of it** (confidence 0.8 and
  up). Measured on a real library, every large disagreement with Kinema's own
  analysis was one Skiptro had scored 0.70 or less; there, the analysis answers.
- **An episode counts as watched once its credits start**, not only at 94% —
  long end credits no longer leave a finished episode in Continue Watching.
- **A guessed credits start** (the last minute of a file) only ever offers Up
  next. It never skips by itself, in automatic mode either.
- **Remove in Continue Watching sticks** until you watch that show again, works
  on "Next episode" cards, and can be reached with a remote.
- **A match the matcher refused is not asked again at every launch** — only
  when you add or change a TMDB or OMDb key, the one thing that can change the
  answer.
- **Unlinking a wrong match holds it for you** in Needs attention, instead of
  the next scan matching it straight back.
- **Episodes named only `S01E01.mkv`** take the show's name from the folder
  above, and a file that still has no name goes to Needs attention instead of
  vanishing from the library.
- **Faster:** a show's episodes come from TMDB twenty seasons to a request, a
  file's audio, subtitle and chapter lists are read at once rather than one
  value at a time, and work that touches a network drive no longer freezes the
  window while the drive wakes up.
- **Nothing runs twice at once.** A second scan or detection is refused with a
  sentence saying why; a second artwork download waits its turn.
- **The player's controls open on Play**, and closing Audio & subtitles or
  Stats returns the focus ring to the button that opened it.
- **Settings works with a held remote key:** the focus ring scrolls into view,
  text fields let go of the cursor when you move on, and holding a key no
  longer sends focus the wrong way.
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

### Fixed

- **The window no longer shows the desktop through it** in the moment between
  pressing Play and the picture arriving.
- **A resumed episode opens at its position** instead of playing its opening
  first and then jumping.
- **The Skip button could be missing for a whole episode** if the episode
  loaded at the wrong instant after launch.
- **The remote could go dead** after launch and after leaving the player.
- **The detail page lists each episode once**, shows files for episodes the
  provider does not list, and treats a double-episode file (`S01E01E02`) as
  both of its episodes — for Up next too.
- **A download still being written is not marked watched.**
- **Touching a file no longer undoes its match.** A changed date or size used
  to send it back through the matcher, undoing matches made by hand.
- **Pressing Next twice while an episode was loading** could take the wrong
  episode's position for the new one.
- An NFO file's bare `<id>` is no longer read as a TMDB id.
- Titles with no trailer are no longer looked up again at every launch.
- TVmaze's rate limit is respected, and a "too many requests" reply is waited
  out instead of landing the show in Needs attention.
- Logos and cast photos found during a scan are downloaded in that scan, not
  the next.
- The built-in analysis only believes an intro heard in at least two *other*
  episodes; one episode matching twice used to count as both.
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

### Security

- **The window has a content security policy:** it runs only Kinema's own
  code. Anything the policy refuses is written to `app.log`.

## [0.1.0] — 2026-08-08

First public release.

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

- **Renamed from "Personal Netflix" to Kinema.** The bundle identifier changed
  with it, so the app now stores its library in
  `%APPDATA%\com.kinema.app\`. Anyone upgrading from a pre-release build must
  rename the old `com.personalnetflix.app` folder, or the library will look
  empty.
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

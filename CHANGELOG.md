# Changelog

Notable changes, newest first. Follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic
versioning](https://semver.org/), with the usual caveat that a `0.x` release
makes no stability promises.

## [Unreleased]

### Added

- **Skip recap.** "Previously on…" gets a button of its own, from TheIntroDB
  or IntroDB. When a recap comes before the intro, that is two presses: Skip
  recap, then Skip intro. Automatic skipping skips recaps too.
- **The scene after the credits.** Where a film has one, Skip takes you
  straight to it instead of the credits running out — always as a button, even
  with automatic skipping on.
- **SIMKL.** Connect your SIMKL account in Settings → Accounts — a code on
  screen and a QR code for your phone — and each film and episode you finish
  in Kinema is added to it, as is everything you had already watched, once.
  It only adds: nothing comes back from SIMKL, and marking something unwatched
  in Kinema leaves SIMKL alone. Anything finished while SIMKL cannot be reached
  waits and goes later.
- **IntroDB**, a second collection of intro, recap and credits times shared by
  viewers, used where TheIntroDB has nothing. On by default, with its own
  switch in Settings → Intro & credits; only which film or episode it is gets
  sent. It is a different service from TheIntroDB.

- **F11** switches between the desk and TV layouts, as Ctrl+Shift+T does —
  the TV layout is Kinema's full-screen mode.

### Changed

- **Scrollbars** are a thin dark bar that fits the app instead of Windows'
  grey one, and there is none in the TV layout, where the page follows the
  remote.

### Fixed

- Switching TheIntroDB off did not take its times away from an episode that
  had already been played; they stayed until something else about the episode
  changed. Now switching either service off takes effect at the next play.
  The skip cache is rebuilt once as a result, so each episode's times are
  asked for again the next time it is played.

## [0.5.1] — 2026-09-29

This release is about what happens when something goes wrong. Your library is
kept safe and can be put back, a crash leaves a trace, and Kinema says when a
feature is missing a program. No library upgrade: 0.5.0
libraries open as they are.

### Added

- **Safety copies of the library.** Once a week Kinema keeps a copy of
  everything in it that cannot be rebuilt by scanning: what you have watched,
  where you stopped, the matches you corrected by hand, your settings. The last
  four are kept, apart from the copy made before each upgrade. Settings,
  Advanced lists them and puts one back: Restore closes Kinema, and the copy is
  swapped in as it starts again. What it replaces is kept too, so a restore can
  be undone. If the library cannot be opened at all, the message now says where
  the copies are.
- **Kinema says when ffmpeg is missing.** The picture and sound details on a
  title's page and Kinema's own intro detection both need it, and without it
  they were simply absent. Home now says so once (Not now is for good), a
  title's page says why its details are missing, and Settings has a link to
  ffmpeg's download page beside the field for its location.

### Changed

- **A screen that fails to draw shows a message** with Try again, Open the log
  folder and Close Kinema. It used to leave the window empty, and because the
  window is transparent, an empty window showed the desktop.
- **A crash on any thread is written to `app.log`**, with where it happened.
  In the released app it used to leave no trace.
- **Starting Kinema a second time brings the running one forward** instead of
  opening another window that would fight the first for the screen and the
  sound device.

## [0.5.0] — 2026-09-29

A title's page now says what its file really holds, with badges down to the
Dolby Vision profile and the measured aspect ratio, and scores from IMDb,
TMDB and, with an OMDb key of your own, Rotten Tomatoes. Kinema carries its
own TMDB key, so setting up is picking your folders. **The library is
upgraded on first start**; a safety copy is made first (in app data, under
`backups`), and 0.4.x cannot open the upgraded library.

### Added

- **Kinema has its own TMDB key.** Movies are identified, with posters and
  descriptions, without registering for anything. A key of your own in
  Settings is still used instead when there is one.
- **If TMDB ever stops accepting that key,** Kinema stops asking with it,
  says so on Home, and takes you to the field for a key of your own. The
  first release with a key re-checks movies that were waiting for one.
- **Movies are identified without any TMDB key,** through Wikidata: title,
  year, running time, genres, cast, and the opening of the film's Wikipedia
  article as its description — everything but posters and backdrops. It is
  the fallback when TMDB cannot be asked, and once it can again, those films
  move to TMDB by the id Wikidata holds for them and get their pictures, with
  their watch history untouched.
- **A title's page says what the file holds**, in three rows of badges under
  its buttons. Picture: resolution, Dolby Vision profile — with FEL or MEL for
  profile 7 — HDR10, HDR10+ or HLG with the mastering brightness, codec and
  bit depth, frame rate, and the aspect ratio measured from the picture
  itself, so a 2.39:1 film with black bars in a 16:9 file says 2.39:1, and one
  with IMAX scenes says both. Sound: each format, with Atmos and DTS:X told
  apart. File: where it came from (UHD Blu-ray remux, WEB-DL from Netflix…,
  read from the release name), edition, subtitles and bitrate. For a series,
  the badges describe the season on screen and follow the season tabs: where
  its episodes differ they show every version, and an episode unlike the rest
  of its season says so in the list ("720p"). The picture and sound badges
  need ffmpeg; each file is read once, when it is scanned.
- **The US age rating** (R, PG-13, TV-MA) beside the year, and **the studios
  or TV network** as logos among the badges, from TMDB. Titles already in
  the library get them on the next scan.
- **IMDb's rating** beside TMDB's, each score in its source's own colour, from
  the ratings file IMDb publishes for personal use. No key and no account;
  Kinema fetches it at most once a week and keeps only your library's titles.
- **Rotten Tomatoes' Tomatometer**, when you have entered an OMDb key of your
  own. Each title is looked up once a month, using at most half of a free
  key's daily allowance.
- **Close, sleep or shut down from the sofa.** In TV mode, Back on Home now
  offers Close Kinema, Put the PC to sleep and Shut down the PC. At a desk
  nothing changes.

### Changed

- **Setting up is one step: pick your folders.** The first-run panel no
  longer asks for a TMDB key. (A build from source, which has no key of its
  own, still asks.)
- **TMDB's data is kept for six months at most,** as their terms ask. Older
  titles, with their episodes and cast, are fetched again a few per scan,
  and older posters and backdrops downloaded again a few hundred per pass —
  the old picture stays on screen until the new one has arrived.
- **Settings says everything on screen.** Each setting says what it does and,
  in quieter type below, when to choose otherwise; "More about this" is gone.
  One Detect button covers every TV folder, and Skiptro's command fields
  appear only once Skiptro is set up.
- **At a desk, Kinema grows with the window**, up to the TV layout's size on a
  maximised large monitor. TV mode is unchanged.
- **Pausing brings up the controls with the ring on Play/Pause**, so the next
  OK plays again. Down from the seek bar goes to Play/Pause.
- **Plainer wording throughout**: full stops and commas where there were
  dashes, and an episode reads "Show · S01E04".

### Fixed

- **A key or path typed just before leaving Settings is kept.** Fields there
  save themselves a moment after the last keystroke, and pressing Back
  within that moment used to drop the change.

- **The volume says "Receiver" from the first frame.** With the sound going
  straight to a receiver, it read "100" until the controls were next
  brought up — they are often already up while a film opens, before its
  sound has started.
- **The volume bar works with a mouse.** It used to close as the pointer
  crossed the gap to it; now it can be reached, clicked and dragged. Clicking
  the volume control mutes without also pausing the film.
- **The last things on a page can be reached by remote.** Moving to the last
  control now scrolls the page to the bottom, so the notes under the last
  setting and the credits at the foot of Settings come into view.
- **The Library buttons in Settings are spaced again**, so Right from Add
  movies folder reaches Add TV folder instead of skipping to Scan now.
- **"Nothing new" from intro detection is said once**, not once per TV folder.

## [0.4.0] — 2026-09-28

A pass over everything a new user meets, after an outside-eye review. No
library upgrade: 0.3.x libraries open as they are. TV mode now fills the
screen; switch to "At a desk" in Settings → Playback, or press
Ctrl+Shift+T, for a window.

### Changed

- **The remote in the player works like a streaming app.** OK pauses and
  resumes; Left/Right seek, faster the longer they are held; Up or Down bring
  up the controls, where the seek bar can now be reached. The controls step
  aside by themselves.
- **A redesigned player bar**, with icons, the episode's name, "Ends at", and
  a **volume control** (M to mute, − and + to change it; it says so when the
  receiver has the volume).
- **TV mode fills the screen** — library and player — so display switching
  works from the sofa without finding a Fullscreen button.
- **Back goes back** to where you came from — search results, a grid, the page
  a film was started from — with the thing you picked still highlighted.
- **Settings has sections** (Library, Playback, Picture & sound, Intro &
  credits, Advanced), every option shows its choices side by side, and each
  has one line of explanation with the rest behind "More about this".
- **Home changes daily** and repeats itself less; genre rows wait until the
  library is big enough for them.
- **Track names are readable**: "English · 7.1 · Dolby TrueHD Atmos",
  "Norwegian · Forced", "English · SDH".
- **A show's page opens on the season you are in**, Specials last, with a
  quiet watched tick per episode and **Mark season watched**.
- **Movies**, not films, throughout; counts read "1 file", "3 files"; error
  messages say what happened in words.

### Added

- **Watched ticks and progress bars on posters**, and how many episodes are
  left of a show you have started.
- **Default audio and subtitle languages** in Settings → Playback. Subtitles
  default to Windows' language when the audio is in another one.
- **Start over** on the "Resumed from" notice, and **Resume / Play from start**
  on a title's page.
- **Search from a remote**, with an on-screen keyboard in the TV layout, and
  search by actor, genre or year as well as title.
- **Sorting and "Unwatched only"** in every grid, and **Movies** and **TV shows**
  in the top bar.
- **Home says when videos need identifying**, with a button straight to the
  review queue.
- **Home says when your equipment can do better** than it is set to — a
  receiver that takes Atmos and DTS:X, a TV with a 24p mode, HDR switched off —
  with one press to turn it on.
- **A notice when a newer Kinema is out**, from one request to GitHub per launch
  (Settings → Advanced turns it off). Nothing is downloaded.

### Removed

- The question about sending sound to the receiver that interrupted the first
  film. The notice on Home replaces it.

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

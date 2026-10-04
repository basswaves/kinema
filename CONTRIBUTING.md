# Contributing

Patches, bug reports and "I could not work out what this does" are all welcome.
This file is what you need before writing code.

## Read this first

**[docs/GOTCHAS.md](docs/GOTCHAS.md) is required reading before touching the
player or D-pad navigation.** Every entry in it cost a real debugging round, and
nearly all of them describe a failure that produces *no error at all*. It is the
single most useful file in this repository.

| File | What it is |
|---|---|
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | Traps in libmpv, Tauri, SQLite, spatial navigation and quick-xml |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, data flow, and the design decisions worth preserving |
| [docs/HISTORY.md](docs/HISTORY.md) | How it was built, and *why each decision went the way it did* |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is next, what is not planned, and where help is wanted — a good place to start |

## Building

On Linux, see [Checking Linux from Windows](#checking-linux-from-windows)
below: the packages and steps there are the same on a Linux machine, run
directly rather than through `scripts\wsl.ps1`.

On Windows 11: Node 20+, Rust with the MSVC toolchain, and Microsoft C++ Build
Tools.

```bash
npm install
```

Fetch the native playback libraries — ~95 MB, never committed, see
[NOTICE.md](NOTICE.md):

```bash
npx tauri-plugin-libmpv-api setup-lib
```

Then:

```bash
npm run tauri dev
```

`ffmpeg` on `PATH` is optional; without it the app's own intro/credits detection
and the reading of each file's picture and sound format are skipped, and
everything else works.

Released builds carry Kinema's own TMDB key, added at build time from a
repository secret and never committed. A build from source has none, and
behaves as if its user had not entered one: paste your own free
[TMDB key](https://www.themoviedb.org/settings/api) in Settings, or put
`VITE_TMDB_API_KEY=…` in a `.env.local` (ignored by git) to build one in.

The app icon is drawn once, in `src-tauri/icons/icon.svg`;
`android-foreground.svg` is the same mark with the room Android's crop needs.
After changing either, remake every size, Android's included, with:

```bash
npx tauri icon src-tauri/icons/icons.json
```

It also writes an `ios/` folder, which Kinema has no use for: delete it. The
Android TV banner (`res/drawable-xhdpi/banner.png`, 320×180) is not made by
that command: its drawing is `src-tauri/icons/banner.svg`, exported to that
PNG by hand. Its lettering is Segoe UI Semibold, named rather than included,
so export it on Windows.

## Verifying

Both of these, before saying something is done:

```bash
npm run check
```

```bash
npm run build
```

`check` is `tsc --noEmit`, `eslint .` and `vitest run`. It **never runs the
bundler** — a tree that passes `check` while `build` is broken is a real state
this project has been in for months, which is why they are separate.

Run the tests alone, or watch them while you work:

```bash
npm test
```

The frontend tests cover pure logic only: match scoring, skip-marker
resolution, log redaction. There are no component or rendering tests, and the
reason is worth knowing before you add one — the failures this codebase
actually produces are focus-tree and mpv-lifecycle problems, and a jsdom test
cannot see either. **Testing D-pad navigation means using a D-pad**, not
mounting a component. See the two failure modes below.

### Checking Linux from Windows

Kinema ships for Linux too, and a change that breaks it should be caught
before it is pushed. With Ubuntu 24.04 in WSL, once:

```bash
sudo apt install build-essential curl file pkg-config libssl-dev libxdo-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev libmpv-dev
```

then Node 20 (from NodeSource — **not** Ubuntu's, and not Windows' own, which
WSL otherwise finds first) and Rust with clippy (rustup). After that, from
PowerShell in the project root:

```powershell
scripts\wsl.ps1 'npm run check'
scripts\wsl.ps1 'cargo test --manifest-path src-tauri/Cargo.toml'
scripts\wsl.ps1 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings'
```

It builds a copy of your working tree, uncommitted changes included, inside
the distribution — never edit that copy. The traps behind that design are in
GOTCHAS ("Linux, and building it from Windows").

To run the app itself there (WSLg shows its window on the Windows desktop),
build it with `scripts\wsl.ps1 'npm run tauri build -- --no-bundle'` and give
it the libmpv plugin's wrapper, built from its source rather than downloaded:
`scripts\wsl.ps1 'bash scripts/build-mpv-wrapper.sh'` builds the pinned
version into `src-tauri/lib/libmpv-wrapper.so`, to be copied to
`src-tauri/target/release/lib/libmpv-wrapper.so` in the copy. libmpv itself
is Ubuntu's (`libmpv-dev` above). `scripts/selftest.sh` then runs a plan the
way `selftest.ps1` does on Windows, on a copy of a library you put in the
plan's `data/` folder; with `GDK_BACKEND=x11` it photographs Kinema's window,
and only that.

On Linux mpv plays in a window of its own, and the player's controls reach
the screen as a picture mpv draws; which window is on top and which has the
keyboard is the desktop's decision, and WSLg's own cannot show it. So
`scripts/nested-selftest.sh <plan> kwin|gnome|sway "<seconds>:<key> …"` runs the
plan inside a real KDE, GNOME or Sway desktop nested as one window, sends it real
key presses and photographs that window alone — the check for anything
touching the Linux player (packages it needs are listed at its top).

`scripts/headless-selftest.sh <plan>` runs a plan in a Sway with no window
at all, photographed from inside: nothing the person at the computer types
or does with the mouse can reach it. The mouse there comes from the plan, as
`mpv` actions with mpv's own input commands (`mouse X Y`, `keydown
MBTN_LEFT`, `keyup MBTN_LEFT`, `keypress WHEEL_DOWN`), which reach the page
the way a real mouse on mpv's window does — the check for the mouse in the
Linux player. Never drive the shared pointer with `xdotool` for a check: in
WSLg it is the same pointer the person is using, and every move of theirs
shifts the test's clicks.

Screen switching on Linux asks the desktop (`desktop.rs`). The ignored tests
`switches_a_desktops_screen_and_puts_it_back` and, for Plasma,
`reads_and_applies_through_kscreen_doctor` run against a nested GNOME Shell
or KWin (`cargo test -- --ignored` inside `dbus-run-session` with the
nested desktop's `WAYLAND_DISPLAY`, and `XDG_CURRENT_DESKTOP=KDE` for KWin,
which also needs `libkf5screen-bin` and `qtwayland5` on Ubuntu 24.04).
Cinnamon is asked through `mutter.rs` under Muffin's name; the same ignored
test runs against `muffin --x11 --replace` on Xorg's dummy driver with a
few TV modelines in its config (Xvfb's one mode has no rate; GOTCHAS,
"Cinnamon answers GNOME's questions under its own name"). A
nested KWin offers one mode only, so a real Plasma mode change and HDR need
a real Plasma 6 session. Sway, Hyprland and the other wlroots desktops are
asked through their shared protocol (`wlroots.rs`); its ignored test
`reads_and_reapplies_through_the_protocol` runs inside a nested Sway (`sway`
on Ubuntu 24.04, `WLR_BACKENDS=x11`, as `nested-selftest.sh sway` starts it),
whose one output has no modes to choose — a real mode change, Sway's HDR
(1.12 and later) and Hyprland need a real session.

`scripts\wsl.ps1 'bash scripts/package-linux.sh'` builds what a release
carries for Linux — `.deb`, `.rpm` and a `.tar.gz` folder — into
`dist-linux/` in the copy, with the wrapper built from its pinned source
(`scripts/build-mpv-wrapper.sh`). `sudo apt install ./dist-linux/<the .deb>`
inside the distribution, then `KINEMA_EXE=/usr/bin/kinema` in front of
either self-test script, checks the installed program.

The interface itself is checked in both browser engines, keyboard only,
against `dev:mock`: WebKit (Linux's) and Edge (the same Chromium as WebView2,
already on Windows). Once, `npx playwright install webkit`; then:

```bash
npm run test:ui
```

The tests are in `e2e/`. They press keys the way a remote does — and wait as
a person would, since two presses 25 ms apart are one (GOTCHAS), and a prompt
is read before it is answered. `e2e/player.e2e.ts` covers everything a sofa
does in the player; a change there should leave all of it passing.

CI runs all of this on every push — Windows, and Linux for x86 and ARM, with
the WebKit tests on x86 Linux — so checking here is about finding out before
pushing, not instead of it.

### The Android test bench

Android is under way. `scripts/android-bench.sh` runs Google's Android TV
emulator with no window — in WSL too, where `/dev/kvm` is available — and
drives it from inside Android: the remote's buttons, typing, mouse clicks and
the wheel, touches, photos of the screen and the system log. Nothing reaches
the real keyboard or mouse. There are two TVs: `tv` (Android TV 16) and `tv9`
(Android TV 9, the oldest Kinema aims at). What it needs, and every command,
are at the top of the script. Once, after unpacking Android's command-line
tools:

```bash
scripts\wsl.ps1 'bash scripts/android-bench.sh setup'
```

`setup` asks you to accept Google's SDK licences before it downloads. Then
Kinema itself, on the TV:

```bash
scripts\wsl.ps1 'bash scripts/android-bench.sh start && bash scripts/android-bench.sh build && bash scripts/android-bench.sh launch --fresh'
```

The Android project is `src-tauri/gen/android` (generated once by
`tauri android init`, kept in the repository, edited by hand where
`MainActivity.kt` says why). The same commands drive a phone or a box with
network debugging on, through `KINEMA_ANDROID_SERIAL`. The emulator has no
HDMI, so HDR, Dolby Vision and passthrough to a receiver need real hardware.
A drive to choose folders from, as a USB drive would be, is made inside the
emulator with `bash scripts/android-bench.sh adb shell sm set-virtual-disk
true`, then `sm list-disks` and `sm partition <disk> public`; `adb push`
puts files on it. Many boxes run a 32-bit Android: `build armv7` for those.

### Running the UI without the native app

```bash
npm run dev:mock
```

Serves the real UI at `http://localhost:1420` against a small fixed library
(`src/dev/mockBackend.ts`) and a fake mpv (`src/dev/fakeMpv.ts`) that answers
the same commands and sends the same events as the real one, with a clock
instead of a picture. Use it to drive browsing and the player's controls
keyboard-only in an ordinary browser. From DevTools:

- `__fakeMpv.speed = 20` — play twenty times faster
- `__fakeMpv.position = 1335` — jump somewhere, as a seek from outside would
- `__fakeMpv.commands` — every command the player sent
- `__fakeMpv.currentAo = null` — the sound output will not open, so the
  player's fallbacks and their notices can be driven
- `__kinemaMock.playback` — the resume and watched rows it has written

It is a fixture, not a second backend: Rust's rules are tested in Rust. None
of it is bundled into a production build.

### Checking the real player without watching it

```powershell
.\scripts\selftest.ps1 -Plan C:\tmp\run1\plan.json
```

Runs the release build (`npx tauri build --no-bundle` first) with the real
mpv through a scripted session: it plays the plan's file muted, presses keys
or seeks at the times the plan gives, and writes `report.json` — a timeline
of mpv's events and of what was on screen (Skip button, Up next, errors, the
clock) — then exits. Screenshots of the first seconds are saved beside it.

It never writes to the real library: the app runs on a snapshot copy in
`<plan folder>\data`, and skips the startup scan and automatic detection.
The plan format is documented at the top of the script.

For Rust changes:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

CI runs clippy with warnings as errors, so a new warning fails the build.

`cargo build` fails while the app is running — stop it first.

`react-hooks/exhaustive-deps` is set to **error** on purpose. It caught
stale-closure bugs that produced silently wrong behaviour rather than crashes.

There is no formatter config. If you run Prettier, use
`--single-quote --print-width 100 --trailing-comma es5 --end-of-line auto`, then
check `git diff -w` to confirm you have not reformatted the whole file.

## Two failure modes this codebase specialises in

Most bugs found here were not crashes. They were code that looked right and
never ran, or ran and silently did nothing. Check for both by reflex:

1. **mpv changes need a full restart.** Observed properties are registered once,
   at init, and mpv initialises once per window. Adding one and testing over HMR
   proves nothing — the new `case` looks correct and events simply never arrive.

2. **Controls a mouse can reach and a remote cannot.** A bare `<button>`
   renders, styles, hovers and clicks perfectly while being absent from the
   focus tree. Use `FocusButton` / `FocusInput` from `src/ui/`. **Test D-pad work
   with the mouse physically untouched** — one stray hover repairs focus and
   hides the failure completely.

   This covers **watching**: browsing, picking something, playing it, subtitles,
   resume, skipping an intro. That whole path has to work from a sofa with a
   D-pad and nothing else. It is not a requirement that *every* control in the
   app be reachable that way — **Developer tools in Settings is mouse-only by
   design**, and says so on screen. Please do not "fix" it.

## More than one platform

Kinema runs on Windows and Linux, with Android next, from one codebase, one
`master` and one version. Three rules keep that from turning into several
programs:

- **Ask what the device can do, never which system it is.** The interface
  reads `useCapabilities()` (`src/capabilities.ts`, answered by
  `capabilities.rs`) and shows or hides by it. `system` is for wording only.
  A module with a platform-only part states its own support beside its code
  (`equipment::DETECTS`, `display::switches`, `power::can_sleep`), so a port
  that implements it flips the answer in the same place.
- **Platform code lives in its own file** — `equipment/win.rs`,
  `display/win.rs` — not in `#[cfg]` branches spread through shared code.
- **mpv is reached only through `src/player/engine.ts`.** The player uses its
  Kinema-level calls (open, pause, seek, stop, the playback events); what is
  about mpv itself says `mpv` in its name.

CI builds and tests every push on Windows and on Linux for x86 and ARM; see
"Checking Linux from Windows" above for doing the same before pushing.

## Debugging

Two logs, both readable without a debugger. Read them instead of guessing; the
window's own console is otherwise invisible from outside the app. Both are in
`%APPDATA%\com.kinema.app\logs\` on Windows and
`~/.local/share/com.kinema.app/logs/` on Linux, whichever way the app was
started, and Settings → Advanced → Developer tools → **Open log folder**
opens it.

- `app.log` — the frontend's `console.*`, uncaught errors, rejections, and
  Rust's `crate::log!` lines (use it rather than `eprintln!`, which a release
  build has no console for)
- `mpv.log` — mpv's own verbose log

Each launch starts both fresh; the four sessions before are kept as
`app.previous.log` and `mpv.previous.log` (the last one), then
`.previous-2.log` back to `.previous-4.log`.

`mpv.log` is the authority on anything about rendering: it records what
libplacebo *did*, not what it was asked to do. Read it before theorising about
the pipeline. In a development build (`npm run tauri dev`), `F12` opens the
browser's developer tools in the app window; a release build has none.

## Settled decisions — please do not re-open

These are conclusions, not open questions. If a change seems to require breaking
one, say so in the issue rather than working around it quietly. The full
reasoning is in [docs/DESIGN.md](docs/DESIGN.md) and [docs/HISTORY.md](docs/HISTORY.md).

- **No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR, Intel
  VSR. They synthesise detail that was never in the master. Classical resampling
  only.
- **Nothing invents frames or detail.** No frame interpolation. 24p judder on a
  60 Hz panel is reported by the stats panel and deliberately not "fixed".
- **No quality-preset UI.** The right settings depend on the frame and the
  display, both of which mpv already knows. The app decides. **Settings describe
  the hardware, never taste:** frame timing, which audio formats the receiver
  takes, and whether the app may switch the screen's mode are allowed because
  each depends on equipment the code cannot always see — and each is detected
  where it can be, so the setting is an override rather than a question.
  Sound straight to the receiver, refresh matching and HDR each apply to every
  device that can, only the devices listed, or none, and are off until
  someone chooses. **On Android it is otherwise:** a TV box is always at its
  TV and plays nothing else while a film plays, so the system turns HDR on
  and passes the sound through by itself, and Kinema's one switch — matching
  the screen to the film, by the same rule — is on unless switched off, and
  not asked at the first run.
- **Vendor-neutral.** Must behave identically on AMD, Intel and NVIDIA.
- **On Linux, a stable base rather than a matrix.** Kinema is made by one
  person and Linux has more desktops, versions and drivers than one person
  can test. So it uses the shared standards first — Wayland protocols,
  logind, ALSA and the sound-device reservation, mpv's own detection — and a
  desktop's own interface only where no standard exists, always behind a
  check of what that desktop answers (never its name or version), falling
  back to "leave it as it is and play the film". Nothing trusts a size, a mode
  or a state it did not read back. There are no test rounds per desktop or
  per version: something that fails safe ships, and a setup that still
  misbehaves is a bug report (with the logs), not a release blocker.
- **A wrong metadata match is worse than no match.** The 0.75 threshold and the
  0.05 runner-up margin stay. Refusing and surfacing for review beats guessing —
  which is only defensible because the **Needs attention** queue makes refusals
  correctable, so that queue is load-bearing. A second source (Wikidata, for
  movies) is a fallback for when TMDB cannot be asked, never a way to accept
  what TMDB alone would not.
- **Nothing that needs periodic maintenance.** This has to run untended for
  years. `yt-dlp`, the Kodi YouTube resolver and an in-app embed with an ad
  blocker were all rejected on exactly this ground. A read-only metadata service
  behind a stable API, used on its own terms — TMDB, TVmaze, TheIntroDB,
  IntroDB, Wikidata, IMDb's published ratings file — is not maintenance; a
  scraper or a downloader is. The two skip-time services are asked about one
  title at a time, when it is played, and never about a whole library.
- **The detail page's badges describe the file, from the file.** Resolution,
  HDR, Dolby Vision, sound format and the rest are read with ffprobe and
  measured, never taken from the release name — a name saying "DV" or "Atmos"
  is not believed. Only the source (remux, WEB-DL…), the edition and Auro-3D
  come from the name, because nothing inside a file says them. The badges are
  in Kinema's own lettering: Dolby, DTS and IMDb logos are trademarks for
  licensed products, which this is not. The services a user connects are
  different — Settings → Accounts shows SIMKL's and Trakt's own marks because
  both ask apps to, each as its guidelines say (NOTICE.md). A service that
  publishes no terms for its logo is shown by name.
- **No shared key for scores.** IMDb's rating comes from the file IMDb
  publishes, on its terms: that file only, never imdb.com, and only the
  library's rows kept. Rotten Tomatoes needs OMDb, and only with the user's own
  key — a key built into every copy would exhaust OMDb's daily allowance for
  everyone within hours.
- **SIMKL and Trakt are one way, and only add.** What is finished in Kinema is
  added to the user's history there; nothing comes back, and un-watching in
  Kinema never removes anything, which the service may have from elsewhere. No
  live "Watching now". Both sign in with a device flow (a code and a phone).
  Trakt keeps duplicate plays, so what it already has is never sent to it
  again.
- **Subtitles from OpenSubtitles only when asked**, with one exception the
  user switches on: forced subtitles for a file that has none. Kept in app
  data, never beside the video; each file asked about once.
- **Forced subtitles show with subtitles off**, in the language being spoken,
  as on a disc. A switch turns this off.
- **No third-party binaries in the repo or the bundle.** The app may *invoke* a
  tool the user installed themselves, at a path they chose. It ships nothing,
  downloads nothing, and depends on nothing being present.
  One exception, for building only: the Android project's
  `gradle/wrapper/gradle-wrapper.jar` (Gradle's own 59 KB starter, which
  every Android project keeps). It runs on the build machine and is never
  in the app.
- **Sidecars are read, never written** by default. The reader stays so other
  producers of the format keep working.
- **The window is transparent so mpv can render behind the webview.** Never give
  `html`, `body` or `#root` an opaque background — it hides the video entirely.
  Full-screen browsing views paint their own background; the player must never
  paint over a video frame. Its one opaque surface is the black cover shown
  *before* a file's first frame (`.player-cover`), because a transparent window
  with no frame up shows the desktop.

## Pull requests

One feature per pull request. Say why, not just what, and tick the verification
boxes in the template — particularly the two failure modes above.

If you are unsure whether something fits, open an issue first. A question costs
less than a rewrite.

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
| [docs/PLAN.md](docs/PLAN.md) | What is done, and *why each decision went the way it did* |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is left, and what each remaining item is blocked on |
| [CLAUDE.md](CLAUDE.md) | The working rules, in short form |

## Building

Windows 11, Node 20+, Rust with the MSVC toolchain, and Microsoft C++ Build
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
is skipped and everything else works.

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

## Debugging

Two logs, both readable without a debugger. Read them instead of guessing; the
WebView2 console is otherwise invisible from outside the app. Both are in
`%APPDATA%\com.kinema.app\logs\` whichever way the app was started, and
Settings → Developer tools → **Open log folder** opens it.

- `app.log` — the frontend's `console.*`, uncaught errors, rejections, and
  Rust's `crate::log!` lines (use it rather than `eprintln!`, which a release
  build has no console for)
- `mpv.log` — mpv's own verbose log

Each launch starts both fresh; the session before is kept as
`app.previous.log` and `mpv.previous.log`.

`mpv.log` is the authority on anything about rendering: it records what
libplacebo *did*, not what it was asked to do. Read it before theorising about
the pipeline. `F12` opens WebView2 DevTools in the app window.

## Settled decisions — please do not re-open

These are conclusions, not open questions. If a change seems to require breaking
one, say so in the issue rather than working around it quietly. The full
reasoning is in [docs/DESIGN.md](docs/DESIGN.md) and [docs/PLAN.md](docs/PLAN.md).

- **No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR, Intel
  VSR. They synthesise detail that was never in the master. Classical resampling
  only.
- **Nothing invents frames or detail.** No frame interpolation. 24p judder on a
  60 Hz panel is reported by the stats panel and deliberately not "fixed".
- **No quality-preset UI.** The right settings depend on the frame and the
  display, both of which mpv already knows. The app decides. The one deliberate
  exception is frame timing, because the right answer depends on hardware the
  code cannot see.
- **Vendor-neutral.** Must behave identically on AMD, Intel and NVIDIA.
- **A wrong metadata match is worse than no match.** The 0.75 threshold and the
  0.05 runner-up margin stay. Refusing and surfacing for review beats guessing —
  which is only defensible because the **Needs attention** queue makes refusals
  correctable, so that queue is load-bearing.
- **Nothing that needs periodic maintenance.** This has to run untended for
  years. `yt-dlp`, the Kodi YouTube resolver and an in-app embed with an ad
  blocker were all rejected on exactly this ground.
- **No third-party binaries in the repo or the bundle.** The app may *invoke* a
  tool the user installed themselves, at a path they chose. It ships nothing,
  downloads nothing, and depends on nothing being present.
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

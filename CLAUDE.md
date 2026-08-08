# Kinema — working rules

A local, serverless media library. **Tauri 2 + React 19 + libmpv**, Windows 11.

> **If you are a person rather than a coding assistant:** this file is context
> for AI tools, which load it automatically. It is checked in because the rules
> in it are real rules — the settled decisions, the verification commands and
> the two failure modes are the same whoever is writing the code. Everything
> here is said again, aimed at you, in [CONTRIBUTING.md](CONTRIBUTING.md); read
> that one instead.

## Read before writing code

| File | Why |
|---|---|
| **docs/PLAN.md** | What is done, what is next, and *why each decision went the way it did*. The reasoning matters more than the status — it is what stops a later session re-opening a settled question. |
| **docs/GOTCHAS.md** | Traps in libmpv, Tauri, spatial navigation and quick-xml. **Read before touching the player or D-pad navigation.** Nearly every entry describes a failure that produces *no error at all*. |
| **docs/DESIGN.md** | Architecture, data flow, and the design decisions to preserve. |
| **docs/ROADMAP.md** | What is left, and what each remaining item is blocked on. The only place open items live. |

Add to these as you go. A trap that cost a debugging round belongs in GOTCHAS
the same day; a decision with a reason belongs in PLAN. They are the only thing
carrying context between sessions.

## Settled decisions — do not re-open

These are conclusions, not open questions. If a request seems to require
breaking one, say so rather than quietly working around it.

- **No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR, Intel
  VSR. They synthesise detail that was never in the master. Classical resampling
  only.
- **No quality-preset UI.** The correct settings depend on the frame and the
  display, both of which mpv already knows. The app decides.
  - **One deliberate exception: frame timing** (Settings → Playback). It is a
    switch because the right answer depends on hardware the code cannot see —
    the panel's true refresh rate, and whether audio is leaving as an untouched
    bitstream. It is not a taste preference and must not become the first of
    several. Anything mpv can determine for itself still gets decided, not asked.
- **Nothing invents frames or detail.** The rule above covers pixels; this one
  covers time. No frame interpolation — 24p judder on a 60 Hz panel is reported
  by the stats panel and
  deliberately not "fixed". mpv's `tscale=oversample` — madVR's "smooth motion"
  — has been raised and **deferred, not rejected**; it is in the PLAN backlog.
  Do not enable it without asking.
- **Vendor-neutral.** Must behave identically on AMD, Intel and NVIDIA.
- **A wrong metadata match is worse than no match.** Keep the 0.75 threshold and
  the 0.05 runner-up margin. Refuse and surface for review rather than guess.
  This is only defensible because the refusals are correctable by hand, so the
  **Needs attention** queue is load-bearing, not a nicety.
- **Nothing that needs periodic maintenance.** This has to run untended for
  years and may be published. `yt-dlp`, the Kodi YouTube resolver and an in-app
  embed with an ad blocker were all rejected on exactly this ground.
  - **TheIntroDB is not an exception to this**, and the reason is worth keeping:
    the app already needs TMDB to have a library at all, so a second read-only
    metadata service is not a new class of dependency. It is used strictly on
    their terms — one episode at a time when it is played, never the library in
    bulk, cached with an expiry rather than kept, attribution in Settings — and
    those terms are documented in `introdb.rs` rather than here, next to the
    code that has to honour them. **Do not add a bulk prefetch**, however
    tempting it looks for a "scan the whole library" button.
- **No third-party binaries in the repo or the bundle.** Unchanged, and it is
  the rule that matters. What *has* moved: the app may now **invoke** a Skiptro
  the user installed themselves, at a path they chose, with the command lines
  editable in Settings, and **read its database** at
  `%APPDATA%\Skiptro\skiptro.db`. It still ships nothing, downloads nothing and
  depends on nothing being present — without Skiptro, intro skipping falls back
  to whatever sidecars it finds and to TheIntroDB. The templates are text fields
  precisely so a change to Skiptro's CLI is an edit, not a rebuild.
  The same now applies to **ffmpeg**, which `analyse.rs` invokes to decode short
  windows of audio. Not bundled, not downloaded, path configurable in Settings,
  and without it that one source is skipped and everything else carries on.
  Ask before downloading any binary. A Rust crate or npm package is a
  dependency, not a binary — but weigh it against the maintenance rule above.
- **Sidecars are read, never written.** The `.skiptro.json` export is off by
  default (an empty command template) because the app reads Skiptro's database
  directly. Do not re-enable it to "make markers work" — that is the clutter the
  current design exists to remove. The reader stays so any other producer of
  that format still works.
- **The window is transparent so mpv can render behind the webview.** Never give
  `html`, `body` or `#root` an opaque background — it hides the video entirely.
  Full-screen browsing views paint their own background; the player must not.

## Verification

```bash
npm run check    # tsc --noEmit && eslint . && vitest run
npm run build    # tsc && vite build — check does NOT run the bundler
```

Both, before saying something is done. `check` passing while `build` is broken
is a real state this project has been in for months — see GOTCHAS.

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust changes only. `cargo build` fails while the app is running; stop it first.

```bash
npm run app:build    # release exe into dist-app/ + desktop shortcut
```

How the user actually launches it. Note that `tauri build` runs Vite **first**
and then spends minutes in cargo — editing a frontend file during that window
ships a stale bundle. Check that nothing under `src/` is newer than
`dist/index.html` before trusting a build.

`react-hooks/exhaustive-deps` is **error** on purpose — it caught stale-closure
bugs that produced silently wrong behaviour, not crashes.

There is no formatter config. If you must run Prettier, use
`--single-quote --print-width 100 --trailing-comma es5 --end-of-line auto`, and
check `git diff -w` afterwards to confirm you have not reformatted the file.

## Debugging

Two logs, both gitignored, both readable without a debugger. **Read them instead
of guessing** — the webview console is otherwise invisible from outside the app.

- `src-tauri/app.log` — frontend `console.*`, uncaught errors, rejections.
- `src-tauri/mpv.log` — mpv's own verbose log.

Running from the desktop shortcut instead, both land in `dist-app/` — they are
opened relative to the working directory.

`mpv.log` is the authority on anything about rendering. It records what
libplacebo *did*, not what it was asked to do: which shader passes ran, what
dither depth was resolved, the real display refresh rate, and whether each
post-init option was accepted. **Read it before theorising about the pipeline.**

`F12` opens WebView2 DevTools in the app window.

## Two failure modes this codebase specialises in

Most bugs found here were not crashes. They were code that looked right and
never ran, or ran and silently did nothing. Two recur often enough to check for
by reflex:

1. **mpv changes that need a full restart.** Observed properties are registered
   once, at init, and mpv initialises once per window. Adding one and testing
   over HMR proves nothing — the new `case` looks right and events simply never
   arrive.
2. **Controls a mouse can reach and a remote cannot.** A bare `<button>`
   renders, styles, hovers and clicks perfectly while being absent from the
   focus tree. Use `FocusButton` / `FocusInput` in `src/ui/`. **Test D-pad work
   with the mouse physically untouched** — one stray hover repairs focus and
   hides the failure completely.

   **Scope:** this applies to *watching* — browsing, choosing something,
   playing it, subtitles, resume, skipping an intro. That path must work end to
   end from a sofa with nothing but a D-pad. It is **not** a rule that every
   control in the app must be reachable that way. **Developer tools in Settings
   are mouse-only on purpose** and should stay that way; converting that panel
   is not a fix, and its description says so to the user.

## How the user works

- They test in the real app and report back. When handing work over, say exactly
  what to click and what a pass looks like — and what a *failure* would look
  like, so an ambiguous result is still informative.
- Confirm the order of work before starting a multi-item request.
- Commit only when asked. History is linear on `master`, one feature per commit,
  no remote.

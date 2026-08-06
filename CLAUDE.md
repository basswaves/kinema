# Personal Netflix — working rules

A local, serverless media library. **Tauri 2 + React 19 + libmpv**, Windows 11.

## Read before writing code

| File | Why |
|---|---|
| **PLAN.md** | What is done, what is next, and *why each decision went the way it did*. The reasoning matters more than the status — it is what stops a later session re-opening a settled question. |
| **GOTCHAS.md** | Traps in libmpv, Tauri, spatial navigation and quick-xml. **Read before touching the player or D-pad navigation.** Nearly every entry describes a failure that produces *no error at all*. |
| **README.md** | Architecture, data flow, and the design decisions to preserve. |

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
- **Vendor-neutral.** Must behave identically on AMD, Intel and NVIDIA.
- **A wrong metadata match is worse than no match.** Keep the 0.75 threshold and
  the 0.05 runner-up margin. Refuse and surface for review rather than guess.
  This is only defensible because the refusals are correctable by hand, so the
  **Needs attention** queue is load-bearing, not a nicety.
- **Nothing that needs periodic maintenance.** This has to run untended for
  years and may be published. `yt-dlp`, the Kodi YouTube resolver and an in-app
  embed with an ad blocker were all rejected on exactly this ground.
- **No third-party binaries in the repo or the bundle.** Skiptro is run by hand;
  the app only reads the sidecars it leaves behind. Ask before downloading any
  binary. A Rust crate or npm package is a dependency, not a binary — but weigh
  it against the maintenance rule above.
- **The window is transparent so mpv can render behind the webview.** Never give
  `html`, `body` or `#root` an opaque background — it hides the video entirely.
  Full-screen browsing views paint their own background; the player must not.

## Verification

```bash
npm run check    # tsc --noEmit && eslint .
npm run build    # tsc && vite build — check does NOT run the bundler
```

Both, before saying something is done. `check` passing while `build` is broken
is a real state this project has been in for months — see GOTCHAS.

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust changes only. `cargo build` fails while the app is running; stop it first.

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

## How the user works

- They test in the real app and report back. When handing work over, say exactly
  what to click and what a pass looks like — and what a *failure* would look
  like, so an ambiguous result is still informative.
- Confirm the order of work before starting a multi-item request.
- Commit only when asked. History is linear on `master`, one feature per commit,
  no remote.

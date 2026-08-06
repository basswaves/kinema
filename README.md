# Personal Netflix

A local, serverless media library for movies and TV shows. **Tauri 2 + React 19 + libmpv.**
No server, no daemon — the app scans your files, matches metadata, and plays directly.

Built because nothing existing fits: every serverless option (Kodi) locks the UI into
skin XML, and every good-looking option (Jellyfin Media Player, jellium-desktop) is a
thin client that does nothing without a Jellyfin server running.

- **[PLAN.md](PLAN.md)** — roadmap, what's done, what's next. Read this first.
- **[GOTCHAS.md](GOTCHAS.md)** — hard-won traps in libmpv and this toolchain. Read this
  before touching the player. Every entry cost a real debugging round.

## Status

| Phase | State |
|---|---|
| 0 — mpv embedding spike | **Done.** Compositing, `d3d11va`, HDR tone-mapping, PGS subs, fullscreen all verified on real content |
| 1 — Library core | **Done.** SQLite, NAS-aware scanner, guessit parsing |
| 2 — Metadata engine | **Done.** TMDB / TVmaze / OMDb, match scoring, ambiguity guard |
| 3 — Browsing UI | **Done.** Hero, rails, detail pages, search, D-pad navigation |
| 4 — Playback | **Done.** Resume, Continue Watching, per-show track memory, next-episode autoplay |
| 5 — Intro skip + trailers | **Not started** |

## Setup

Requires Node 20+, Rust (MSVC toolchain), and Microsoft C++ Build Tools.

```bash
npm install
```

Fetch the native playback libraries (~95 MB, gitignored):

```bash
npx tauri-plugin-libmpv-api setup-lib
```

That pulls `libmpv-2.dll` (LGPL build, from zhongfly/mpv-winbuild) and
`libmpv-wrapper.dll` into `src-tauri/lib/`.

```bash
npm run tauri dev     # run
npm run check         # tsc --noEmit && eslint .
```

API keys are entered in the app (Library tab → Settings) and stored in the SQLite
database in app data — **never** in the repo.

## Architecture

Single window. mpv renders into a **native child surface beneath the WebView2
control**; the window and the entire CSS chain are transparent so React composites on
top. This is the whole architectural bet, and it works — but it means `html`, `body`
and `#root` must never get an opaque background, or the video disappears completely.
Full-screen browsing views paint their own background; the player must not.

```
src-tauri/src/
  db.rs          SQLite schema + migrations (user_version, currently 3)
  scanner.rs     Filesystem walk. NAS-aware: identity is (path, size, mtime),
                 never a content hash — never read file bytes during a scan
  library.rs     Roots, scan, parse write-back, stats
  metadata.rs    Titles, episodes, file→title links, detail queries
  playback.rs    Resume points, Continue Watching, next episode, track prefs
  settings.rs    Key/value settings (API keys) + the frontend log bridge

src/
  ui/            Browse shell, Home, rails, cards, detail page, search
  player/        Player, shared mpv lifecycle, track handling, mpv options
  library/       Scan/parse/match dev surface (Library tab)
  metadata/      Providers, match scoring, orchestration
  spike/         Phase 0 diagnostic harness — deletable once trusted
  devlog.ts      Forwards console + unhandled errors to src-tauri/app.log
```

### Data flow

```
scan (Rust)  →  media_files rows          identity = path + size + mtime
parse (TS)   →  guessit-js + parent-dir fallback → parsed_title/season/episode
match (TS)   →  provider search → score → titles + episodes, or "unmatched" with reason
browse (TS)  →  titles/episodes → rails, detail pages
play  (TS)   →  mpv loadfile → resume seek → progress saved every 5s
```

Each stage is independently re-runnable. Re-parsing never re-reads the filesystem;
re-matching never re-parses. This matters when iterating on rules against a library on
a NAS.

## Key decisions

**No quality selector, ever.** The correct rendering settings don't depend on taste —
they depend on whether the frame needs resizing and whether the display can show the
source's dynamic range, and mpv knows both. `spline36` up, `mitchell` down, with the
correctness passes; `scaler-resizes-only` means nothing touches the image at 1:1.

**No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR or Intel VSR.
They synthesise detail that was never in the master. The path is vendor-neutral d3d11 —
identical on NVIDIA, AMD and Intel — and light enough for a GTX 1060 / RX 480 at 4K.
**Do not add ML upscaling or a quality-preset UI to this project.**

**HDR: one config for both display types.** `target-colorspace-hint` lets an HDR display
take the signal untouched; on SDR, mpv tone maps with BT.2390 (the ITU reference EETF)
using a measured frame peak rather than the frequently wrong static metadata in remuxes.
Dolby Vision profiles 5/8/9 are metadata-aware; **profile 7 plays as its HDR10 base
layer** — mpv is not a native DV output engine. Known limitation, not a bug to chase.

**Wrong matches are worse than no matches.** Matching needs 0.75 confidence *and* a
0.05 margin over the runner-up. Genuine ties are refused and surfaced for review rather
than guessed. An unmatched file is visible work; a confidently wrong one silently
corrupts the library.

**Track memory stores languages, not indices.** Track numbering differs between releases
of the same show, so "index 3" would pick the wrong track on the next episode; "da"
survives.

**Missing episodes are shown greyed out, not hidden.** A season with gaps should look
like a season with gaps.

## Debugging

Two logs, both gitignored, both readable without attaching a debugger:

- `src-tauri/app.log` — frontend `console.*`, uncaught errors and unhandled rejections,
  forwarded from the webview by `src/devlog.ts`. **The webview console is otherwise
  invisible from outside the app**, which hid several bugs during development.
- `src-tauri/mpv.log` — mpv's own verbose log. Diagnosed the `tone-mapping-mode -> -3`
  and `sid=1.000000 -> -2` failures precisely rather than by guesswork.

`F12` in the app window opens WebView2 DevTools for live console and network.

## Licensing

The bundled mpv is the **LGPL** build, so linking it does not impose GPL obligations on
this app. `guessit-js` is LGPL-3 (used as a library). TMDB requires attribution.

# Personal Netflix

A local, serverless media library for movies and TV shows. **Tauri 2 + React 19 + libmpv.**
No server, no daemon — the app scans your files, matches metadata, and plays directly.

Built because nothing existing fits: every serverless option (Kodi) locks the UI into
skin XML, and every good-looking option (Jellyfin Media Player, jellium-desktop) is a
thin client that does nothing without a Jellyfin server running.

- **[CLAUDE.md](CLAUDE.md)** — working rules, the settled decisions that must not be
  re-opened, and how to verify a change. Read this first.
- **[PLAN.md](PLAN.md)** — roadmap, what's done, and why each decision went the way it
  did.
- **[GOTCHAS.md](GOTCHAS.md)** — hard-won traps in libmpv and this toolchain. Read this
  before touching the player or D-pad navigation. Every entry cost a real debugging
  round, and most describe failures that produce no error at all.
- **[HANDOVER.md](HANDOVER.md)** — what is left, and what each remaining item is blocked
  on.

## Status

| Phase | State |
|---|---|
| 0 — mpv embedding spike | **Done.** Compositing, `d3d11va`, HDR tone-mapping, PGS subs, fullscreen all verified on real content |
| 1 — Library core | **Done.** SQLite, NAS-aware scanner, guessit parsing |
| 2 — Metadata engine | **Done.** TMDB / TVmaze / OMDb, match scoring, ambiguity guard |
| 3 — Browsing UI | **Done.** Hero, rails, detail pages, search, D-pad navigation |
| 4 — Playback | **Done.** Resume, Continue Watching, per-show track memory, next-episode autoplay |
| 5 — Intro skip + trailers | **Done.** Skip intro from Skiptro sidecars, trailers from local files |
| Artwork cache | **Done.** Posters/backdrops/stills in app data, served over the asset protocol — browsing works offline |
| Manual fix-match | **Done.** Review queue with reasons, provider search, ignore and unlink |
| 10-foot TV layout | **Done.** One `--ui-scale` knob, persisted; overscan-safe gutters; every control reachable by D-pad |
| Settings + background scan | **Done.** Scan/parse/match out of the dev tab; scans once per launch; developer stages kept behind a disclosure |
| NFO read/write | **Done.** Read as an authoritative override during matching; export is an explicit action |
| Watched tracking | **Done.** One flag shared with playback completion; ticks and progress on episode rows, manual toggle per episode and per film |
| Player episode stepping | **Done.** Previous/next buttons and keys, shown only where a neighbour exists |
| End-credit skipping | **Done.** Credits resolved from sidecar, then a named chapter, then a fenced time guess |
| Stats for nerds | **Done.** `i` in the player — madVR-style: cadence, scaling and why, HDR pipeline, audio in/out, dropped frames |
| Launchable exe | **Done.** `npm run app:build` → portable folder + desktop shortcut, no installer |
| Creator's-intent audit | **Done.** Verified against mpv's own verbose log; `deinterlace=auto` added, 24p cadence reported, frame-timing switch |
| Continue Watching removal | **Done.** Per-card Remove below the card, where a D-pad can actually reach it; window opens maximised |

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
npm run tauri dev     # run from source, with HMR
npm run check         # tsc --noEmit && eslint .
```

To get a version that launches without a terminal:

```bash
npm run app:build
```

That builds the release binary, assembles `dist-app/` (exe plus the two native
libraries) and refreshes a **Personal Netflix** shortcut on the desktop. It is a
portable folder rather than an installer on purpose — nothing to reinstall after
a rebuild. The identifier is unchanged, so it reads the same library database as
the dev build.

API keys are entered in the app (**Settings → Metadata providers**) and stored in the
SQLite database in app data — **never** in the repo. TV metadata works with no key at
all via TVmaze, so the library is usable before you enter anything.

`npm run check` is `tsc + eslint` and never runs the bundler. Run `npm run build` too
before trusting that the app can still ship — see GOTCHAS.md.

## Architecture

Single window. mpv renders into a **native child surface beneath the WebView2
control**; the window and the entire CSS chain are transparent so React composites on
top. This is the whole architectural bet, and it works — but it means `html`, `body`
and `#root` must never get an opaque background, or the video disappears completely.
Full-screen browsing views paint their own background; the player must not.

```
src-tauri/src/
  db.rs          SQLite schema + migrations (user_version, currently 6)
  scanner.rs     Filesystem walk. NAS-aware: identity is (path, size, mtime),
                 never a content hash — never read file bytes during a scan
  library.rs     Roots, scan, parse write-back, stats
  metadata.rs    Titles, episodes, file→title links, detail queries
  playback.rs    Resume points, Continue Watching, watched state, the
                 adjacent-episode lookup (both directions), track prefs
  artwork.rs     Downloads posters/backdrops/stills into app data, keyed by
                 remote URL; served back through the asset protocol
  skip.rs        Reads .skiptro.json sidecars for intro/credits markers,
                 cached against the sidecar's own size and mtime
  trailer.rs     Finds local trailer files by Jellyfin/Kodi convention; the
                 scanner shares its test so trailers never become titles
  settings.rs    Key/value settings (API keys) + the frontend log bridge

src/
  ui/            Browse shell, Home, rails, cards, detail page, search,
                 Settings. tv.ts holds the 10-foot scale switch; focus.ts
                 recovers focus after a view change; FocusButton/FocusInput are
                 the D-pad-reachable controls everything else is built from
  player/        Player, shared mpv lifecycle, track handling, mpv options.
                 chapters.ts and stats.ts read mpv as flat scalars only;
                 skip.ts resolves a credits marker from the sidecar, a named
                 chapter, or a fenced guess at the tail of the file
  library/       pipeline.ts — the scan→parse→match→artwork→trailers sequence,
                 shared by the startup scan and the Scan now button. LibraryView
                 is the developer surface behind a disclosure in Settings and
                 keeps library.css in fixed px; FixMatch, the user-facing review
                 queue, has its own fixmatch.css in rem so it scales
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

**Do nothing unless necessary — in time as well as space.** `scaler-resizes-only`
keeps every luma scaler out of the path when the frame is already at output size;
`deinterlace=auto` is the same rule applied to time, weaving only streams the
container actually flags as interlaced so every progressive file passes through
untouched. Combed fields are an artifact of the playback path rather than
something anyone shot, which is the one case where *adding* a stage serves
intent. Chroma upscaling is the honest exception: 4:2:0 → 4:4:4 runs on every
consumer encode whatever the resolution, and no setting can suppress it, so the
stats panel says so rather than implying nothing is touching the image.

**24p judder is reported, not fixed.** 23.976p on a 60Hz panel is 3:2 pulldown,
and it is the largest visible departure from intent in a typical setup — larger
than any scaler choice, and invisible in any discussion of them. No frame-timing
strategy makes an uneven division even, and interpolating the difference away
would invent frames nobody shot. So the panel names the cadence and the display
mode that would remove it. The one switch offered, display-clock frame timing,
removes drift and stray dropped frames but explicitly not the cadence — and
resamples audio, which makes it incompatible with bitstream passthrough. It is
the sole rendering preference in the app, and only because the right answer
depends on hardware the code cannot see.

**HDR: one config for both display types.** `target-colorspace-hint` lets an HDR display
take the signal untouched; on SDR, mpv tone maps with BT.2390 (the ITU reference EETF)
using a measured frame peak rather than the frequently wrong static metadata in remuxes.
Dolby Vision profiles 5/8/9 are metadata-aware; **profile 7 plays as its HDR10 base
layer** — mpv is not a native DV output engine. Known limitation, not a bug to chase.

**Wrong matches are worse than no matches.** Matching needs 0.75 confidence *and* a
0.05 margin over the runner-up. Genuine ties are refused and surfaced for review rather
than guessed. An unmatched file is visible work; a confidently wrong one silently
corrupts the library. That stance is only defensible because the refusals are
correctable by hand: the **Needs attention** view carries the reason for each refusal
and a provider search, links are recorded with a `manual:` reason so they stay
auditable, and a wrong match can be unlinked back into the queue.

**The artwork cache is an accelerator, never a source of truth.** Provider URLs stay
in `titles` and `episodes`; the cache is a separate table keyed by URL. Every query
returns both, and the UI falls back to the URL whenever the local file is missing —
so a half-built or hand-deleted cache degrades to the pre-cache behaviour rather than
to blank posters. `local_path` is stored *relative* to app data, because the cache and
the database live in the same directory and should move together.

**Track memory stores languages, not indices.** Track numbering differs between releases
of the same show, so "index 3" would pick the wrong track on the next episode; "da"
survives.

**Trailers are local files, never a live stream in-app.** A trailer beside the media
plays on the mpv surface: no ads, no network, no bundled binary, and the same
rendering path as the feature. Anything that resolves YouTube streams — yt-dlp, an
addon, an embed with an ad blocker — is a maintenance treadmill, which is exactly
what Kodi's YouTube addon demonstrates and why Jellyfin's ecosystem downloads
trailers to disk instead. Titles with no local file open the provider's link in the
user's own browser, where their own ad blocking applies.

**An NFO outranks the matcher.** A `.nfo` beside a video is someone having already
answered the question the scorer is about to guess at, usually by hand. With a provider
id in it there is no search and no score — the whole class of confidently-wrong matches
disappears for that title, which is the strongest form of the rule above. Without an id,
its `<title>` overrides the one guessit took off the filename, but the result still has
to clear the same threshold: the override is on the question asked, not the standard of
proof. Reading happens on every scan; **writing is an explicit action**, because these
files live in the user's media folders and an existing one was probably written by
another tool and carries fields this app does not model.

**Missing episodes are shown greyed out, not hidden.** A season with gaps should look
like a season with gaps.

**There is one notion of "watched."** Marking an episode by hand writes the same
`completed` flag that playback sets at 94%, not a column beside it. Two of them
would disagree the first time either was written without the other, and the
disagreement would be invisible — a row showing a tick while Continue Watching
still offered it. Un-watching deletes the row: "not watched" and "no history" are
the same state, and a file just declared unseen must not then resume.

**A guessed credits marker may offer, never decide.** Skiptro detects intros
only, so the closing segment is resolved from the sidecar, then a chapter named
for it, then `duration − 60s`. The first two are measurement and evidence; the
third is inference, so it never fires without a next episode to move to, and it
shows an Up next card over the still-playing video rather than ending the file.
A wrong guess then costs a card on screen instead of an ending nobody saw.

**Stats for nerds is the answer to having no quality selector.** The app decides
the rendering settings, so the only question left is whether it is doing what it
claims. `i` in the player, modelled on madVR's OSD, which gets two things right
that a property dump does not: it reports the **cadence** rather than two frame
rates in separate rows, and it lists the **render passes that actually ran**
rather than the settings that were requested — different claims, and only the
second answers "is anything touching my image?". All flat scalar reads, polled
rather than observed, each one individually allowed to fail.

**One layout, one scale knob — not a TV skin.** Every dimension in `ui.css` is in
`rem`; TV mode multiplies the root font size and everything follows. A parallel set
of TV styles would drift out of step with the desk styles the first time either was
edited, and the drift would only be visible to whoever was sitting in front of the
*other* screen. The switch is manual and persisted, because the webview can measure
the panel but not how far away you are sitting.

**Every browsing control goes through `FocusButton`.** A bare `<button>` is
reachable by mouse and invisible to a remote, and nothing about it looks wrong until
someone is holding one — the same silent-failure shape as the rest of GOTCHAS.md.
Four controls were already in that state when the TV layout was built.

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

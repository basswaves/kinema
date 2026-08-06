# Plan

## Goal

A local, Netflix-feeling media app for movies and TV that runs with **no server**,
plays anything directly, upscales faithfully, skips TV intros, scans a messy library
without exact folder names, and plays trailers in-app.

Confirmed constraints:

- Runs on **Windows 11**. Media on **local disk and NAS/SMB shares**.
- Must also work **from the couch on a TV** (D-pad/remote, 10-foot layout).
- Must handle **4K HDR / Dolby Vision remuxes** and **messy filenames**.
- **Creator's intent** rendering: no ML upscaling, no quality selector, vendor-neutral.

## Completed

### Phase 0 — mpv embedding spike ✅
The go/no-go gate. Verified on real content: mpv child surface under a transparent
WebView2 with React composited on top, `d3d11va` hardware decode, a 4K HDR remux
tone-mapping to SDR, seeking, PGS subtitle selection, fullscreen, drag-and-drop.

### Phase 1 — Library core ✅
SQLite in app data. Scanner walks local + SMB roots with **no content reads** —
identity is `(path, size, mtime)`. Unchanged files keep their parse results; vanished
files are flagged `missing`, never deleted; an unreachable root is skipped entirely.
`guessit-js` parses filenames, with a parent-directory fallback and scoring so
`Blade Runner 2049 (2017)/1080p.BluRay.x264.mkv` resolves correctly.

### Phase 2 — Metadata engine ✅
Providers: **TMDB** (preferred — only source with backdrops, logos, episode stills),
**TVmaze** (keyless TV fallback, has background art), **OMDb** (movie fallback, poster
only). Requests go through Tauri's HTTP plugin from Rust, so no CORS; hosts are
allow-listed in `capabilities/default.json`. Match scoring combines edit distance and
token overlap, with year proximity (±1 *adds* confidence — theatrical/festival dates
disagree), a 0.75 threshold, a 0.05 runner-up margin, and a popularity tie-break for
identically-named entries. Files are grouped by title before fetching, so a 12-episode
season costs one search.

### Phase 3 — Browsing UI ✅
Hero + rails (Continue watching, Recently added, TV, Movies, genres with ≥2 titles),
detail pages with episode lists, instant local search. Spatial D-pad navigation
throughout via `@noriginmedia/norigin-spatial-navigation`; one component set serves
mouse and remote.

### Phase 4 — Playback ✅
Resume points (saved every 5s and on exit), Continue Watching rail with progress bars,
per-show audio/subtitle memory **by language**, next-episode autoplay with a countdown.
Completion (≥94%) is decided in Rust so the rule lives in one place.

### Artwork caching ✅
Posters, backdrops and episode stills are downloaded once into `app data/artwork`
and served through Tauri's asset protocol, so browsing no longer needs a live
connection. The cache is keyed by **remote URL**, not by title, so all three
artwork kinds share one mechanism and re-matching never orphans a file. Every
query returns the URL *and* the local path; the UI prefers the local copy and
falls back to the URL — including on an `onError`, so a cache row that outlived
its file degrades to the old behaviour instead of to a blank poster. Filled in
after matching and backfilled on every Browse mount.

---

## Phase 5 — Intro skip + in-app trailers (NEXT)

### 5a. Intro/outro skip

**Skiptro** is a standalone tool (Windows/Linux/macOS) with its own web UI. It
fingerprints audio with an ONNX model and writes `.skiptro.json` sidecars next to the
video files. No server, no Kodi needed — the sidecar format is player-agnostic.

- Repo: <https://github.com/MikeSiLVO/skiptro-releases>
- Companion Kodi addon (GPL-2, useful as a reference for consuming the format):
  <https://github.com/MikeSiLVO/service.skiptro>
- Sidecar shape (verified for intro; **confirm whether credits/outro are also emitted**):
  ```json
  { "intro": { "start": 0, "end": 87.5 } }
  ```

**Work:**
1. Rust command `get_skip_markers(file_path)` → reads `<video basename>.skiptro.json`
   next to the file, returns `{ intro?: {start,end}, credits?: {start,end} }`.
   Cache in the DB keyed by `file_id` so a NAS isn't hit on every play.
2. `Player.tsx`: when `time-pos` enters the intro region, show a **Skip Intro** button
   bottom-right; auto-dismiss after ~10s; clicking seeks to `intro.end`.
   Same for credits → trigger next episode early.
3. Settings toggle: show button vs. skip automatically.
4. **Ask before downloading the Skiptro binary** — it's a third-party executable.
   Decide then whether to bundle it as a Tauri sidecar or just document running it
   separately. Bundling means shipping an ONNX model too.

**Fallback if Skiptro proves awkward:** the detection is reproducible with
`ffmpeg` + chromaprint (already installed). The sidecar format is trivial, so the
player side is unaffected by which producer is used.

### 5b. Trailers

- TMDB `/movie/{id}/videos` and `/tv/{id}/videos` return YouTube keys.
- mpv plays YouTube URLs directly **via yt-dlp** — needs the `yt-dlp` binary available
  (bundle as a Tauri sidecar; it needs periodic updating).
- Play on the same mpv surface, from the detail page. Treat as ephemeral: no resume
  point, no progress row.
- Store the trailer key on the `titles` row during matching to avoid a second fetch.

---

## Backlog (not in the original plan, worth doing)

**Manual fix-match UI** — the safety net the strict matching threshold *assumes* exists.
Refusing to guess is only reasonable if correcting it is easy. Needs: a "Needs
attention" view listing unmatched files with their reasons, a provider search box, and
a command to link a file to a chosen title. Data layer already supports it
(`link_file_to_title`).

**10-foot TV layout** — D-pad navigation works everywhere already, but there's no
larger-type couch layout yet.

**Delete `src/spike/`** — the Phase 0 harness. Keep until the real player is trusted for
HDR, subtitle and track handling; then remove it and `src/App.tsx`'s dev switcher.

**NFO read/write** — interop with MediaElch/tinyMediaManager. Read as an authoritative
override during matching.

**Library management out of the dev tab** — scan/parse/match currently live in a
developer-facing Library view. Should become a proper settings screen with automatic
background scanning.

## Verification

- **Matching:** the number that matters is *wrongly* matched, not unmatched. Target zero
  silent wrong matches; unmatched is acceptable work. Keep ugly real filenames as
  regression fixtures.
- **Playback:** H.264, HEVC 10-bit, AV1, HDR10, DV P5, DV P7, PGS + ASS subs, TrueHD/Atmos.
- **NAS:** full scan timed over SMB; verify no full-file reads and no UI blocking.
- **TV mode:** navigate every screen with arrow keys + Enter + Back only. Anything
  unreachable by D-pad is a bug.

## Still unverified

- **HDR passthrough** — untestable so far on a 1440p SDR panel. HDR *decode* and
  tone-mapping to SDR are confirmed working.
- **Per-show track memory across episodes** — implemented, but a bug in reading `sid`
  was aborting the apply path until late in Phase 4; worth re-confirming.
- **Movies at scale** — only one film in the library so far.

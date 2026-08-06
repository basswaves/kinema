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

### Manual fix-match ✅
The safety net the strict threshold assumes exists — refusing to guess is only
defensible if correcting the refusal is easy. A **Needs attention** view in the
Library tab lists everything the matcher declined, grouped exactly as matching
groups it (a season fails as a unit), each with the reason it recorded. A search
box re-queries the provider — deliberately *without* the parsed year, since a
wrong year is often what caused the failure — and picking a result links every
file in the group at confidence 1 with a `manual:` reason, so a hand-made link
stays distinguishable from a scored one. Files can be **ignored** (samples,
trailers) and un-ignored, and a wrong match can be **unlinked** from the titles
strip, which returns its files to the queue with parse data intact.

---

## Phase 5 — Intro skip + in-app trailers (NEXT)

### 5a. Intro/outro skip

**Skiptro** is a standalone tool (Windows/Linux/macOS) with its own web UI. It
fingerprints audio with an ONNX model and writes `.skiptro.json` sidecars next to the
video files. No server, no Kodi needed — the sidecar format is player-agnostic.

- Repo: <https://github.com/MikeSiLVO/skiptro-releases>
- Companion Kodi addon (GPL-2, useful as a reference for consuming the format):
  <https://github.com/MikeSiLVO/service.skiptro>
- Sidecar shape, **confirmed against real output from Skiptro 1.2.0**:
  ```json
  {
    "intro": { "start": 0.2, "end": 45.6 },
    "skiptro": { "confidence": 1, "version": "1.2.0" }
  }
  ```
  Named `<video stem>.skiptro.json`, i.e. the extension is replaced, not appended.
  **There is no credits/outro segment** — 1.2.0 detects intros only. The reader
  and the player handle one anyway, since the cost is a few lines and any other
  producer (including the ffmpeg fallback below) could emit one.

**Player side ✅ — the consumer is done and independent of the producer.**
`get_skip_markers` reads the sidecar (both `<stem>.skiptro.json` and
`<name.ext>.skiptro.json` are checked, since the naming convention is the
producer's choice) and caches the result against the sidecar's own size and
mtime — so running the detector *after* a file has been played is picked up
rather than leaving "no markers" cached forever. `Player.tsx` shows a **Skip
intro** button for 10 seconds on entering the intro, seeks to `intro.end`, and
on entering credits offers the next episode through the same up-next path as a
natural end. A settings toggle switches between prompting and skipping
automatically.

Parsing accepts `credits`, `outro` or `ending` for the closing segment and
rejects segments that would seek backwards or nowhere. A sidecar that exists but
yields nothing usable logs its actual top-level keys — an unreadable format must
not look like a show with no intro.

Skiptro itself is run **manually, not bundled** — no third-party executable
enters the repo or the ship. Verified end to end against real 1.2.0 sidecars on
a full season: button, seek, auto-skip, and no effect on files without one.

**Open:** the sidecar carries a `confidence` value that nothing currently reads.
A skip fired on a bad detection jumps over real content, which is the same class
of silent wrongness as a bad metadata match — so a minimum confidence is worth
adding once there is a low-confidence sample to calibrate against. Every marker
in the library so far reports `1`.

**Fallback if Skiptro proves awkward:** the detection is reproducible with
`ffmpeg` + chromaprint (already installed). The sidecar format is trivial, so the
player side is unaffected by which producer is used.

### 5b. Trailers

**Keys ✅.** `trailer_key` / `trailer_site` live on the `titles` row. New TMDB
matches get them free — `videos` is appended to the detail request, so a match is
still one round trip — and `backfillTrailers` fills in titles that predate this.
Selection prefers official over fan-uploaded, trailer over teaser, English over
other languages; anything that is neither trailer nor teaser is rejected, since a
featurette is not what "play trailer" promises. A title checked with no trailer
records an empty key so it is not re-asked every pass. Re-matching through a
provider with no video data (TVmaze, OMDb) `COALESCE`s rather than wiping a key
TMDB already found.

**Playback ✅ — local files first, browser second, nothing live in-app.**

`yt-dlp` was rejected: it needs an install step or a bundled binary, and it
breaks every few weeks because it scrapes something that does not want to be
scraped. An in-app YouTube iframe was rejected too — it shows ads, and blocking
them is the same treadmill relocated, on a project intended to be published.

What the other projects do settles it. Plex serves trailers from its own
backend, which needs content agreements. Kodi resolves YouTube streams through
an addon that visibly breaks. Jellyfin supports both, and its ecosystem has
converged on **plugins that download trailers to local files** — because local
files are the path that keeps working.

So: a trailer is an ordinary video file on disk, found with Jellyfin/Kodi
conventions (`trailers/` subfolder, `trailer.ext`, or a `-trailer` suffix) and
played on the mpv surface. No ads, no network, no binary, full rendering
pipeline, and the layout stays interoperable with other media apps.

The space-separated form Jellyfin also accepts (`Movie trailer.mkv`) is
deliberately unsupported: it cannot be distinguished from a film whose title
ends in the word, and misreading one removes a real title from the library
with nothing to notice. The scanner shares this test, so a `-trailer` file is
never indexed as a feature.

Titles with no local file offer **"Trailer on YouTube ↗"**, which opens the
stored key in the user's own browser — where their own ad blocking already
applies, and where this app ships nothing to maintain.

---

## Backlog (not in the original plan, worth doing)

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

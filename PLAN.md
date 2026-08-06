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

## Phase 5 — Intro skip + in-app trailers ✅

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

## 10-foot TV layout ✅

One knob. `ui.css` is expressed entirely in `rem`, `--ui-scale` multiplies the
root font size, and the whole browsing UI and player OSD follow. There is no
second set of TV styles on purpose: two stylesheets describing one layout drift
apart the first time either is edited, and the drift is invisible until someone
is sitting in front of the screen the other one was for.

The switch is **manual and persisted** (`tv_mode` in settings), not a viewport
heuristic. The webview can measure the panel but not the viewing distance, and a
4K monitor at arm's length looks exactly like a 4K TV across the room. It is one
switch rather than a slider, for the same reason there is no quality preset:
the question is "where am I sitting", which has two answers.
`Ctrl`+`Shift`+`T` toggles it from anywhere, which is what makes comparing the
two layouts practical.

TV mode is a little more than an enlargement. The gutter grows faster than the
type, because many TVs still crop a few percent of every edge; focused artwork
gets a dark halo outside the white ring, which is otherwise invisible against a
bright poster from three metres; and the hero overview drops to two lines, since
three crowd the buttons at that size.

With TV mode **off** the layout is numerically identical to the pre-conversion
px version — verified declaration by declaration against `git show HEAD:` — so
the desk experience is unchanged.

**Remote reachability.** The layout was the stated gap, but D-pad navigation
turned out not to work everywhere after all. None of this is visible with a
mouse, which is why it survived: hovering re-establishes focus and clicking
reaches anything, so the UI tests perfectly on a desk. See the new **Spatial
navigation** section in GOTCHAS.md.

- The top-nav **Home/Search** buttons and the detail page's **Back** button had
  no `useFocusable` at all — unreachable by D-pad. `FocusButton` now exists so a
  bare `<button>` in the browsing UI is the exception that has to justify itself.
- The **search box** was never registered, so `setFocus('search-input')` had no
  target and focus could not descend into the results.
- **Nothing claimed focus**, at startup or after any view change. Each view
  replaces the last entirely, so the remembered focus key routinely pointed at
  an unmounted card — no ring, no response to any arrow press, indistinguishable
  from a hang. `useClaimFocus` (`src/ui/focus.ts`) fixes this for every
  top-level view; the **detail page had no focus entry point at all**, which is
  why nothing on it responded.
- **Up could never reach the nav**, and not for want of a focusable: the
  library requires `sibling.bottom <= current.top` to move up, which an overlay
  nav can never satisfy. Solved with a `nextFocusResolver` on the shell, the
  only component that parents both. Details in GOTCHAS.md — it is not a bug that
  markup changes can fix.
- The resolver then **still did nothing**, because `useFocusable` reads the
  focus context of the component it is *called in*: declaring the shell and the
  nav containers side by side in `Browse` parented both to the root, so the
  resolver's "siblings" never included the nav. The markup was nested and the
  focus tree was flat. `TopNav` and `SearchView` are separate components for
  exactly this reason.
- **The page never scrolled back up.** `scrollIntoView({ block: 'nearest' })`
  does nothing once an element is on screen, so arrowing up to the hero left the
  page wherever the rails had scrolled it. Top-row controls now use
  `keepInView="page-top"`, which is absolute rather than relative.
- **Episode rows** did not scroll into view when focused, so arrowing down a
  season moved focus below the fold. Worse at TV scale, where a third as many
  rows fit.
- In the player, **Skip intro** and **Up next** were click-only. `Enter` now
  takes whichever is showing, and still just reveals the OSD when neither is —
  rebinding it to play/pause would change a behaviour nobody asked to change.

A detail page opens on its Play button for a movie, or the first episode it
actually holds for a series — via `preferredChildFocusKey`, so the choice of
landing spot lives next to the markup that knows which controls exist.

**Verified** on a desk, keyboard only with the mouse untouched: startup focus,
nav↔content in both directions, scroll return to the top of Home and of a detail
page, detail-page entry and episode navigation, search box to grid and back, and
`Enter` on both player prompts.

**Unverified:** real overscan behaviour on an actual TV, and whether 1.45 is the
right scale at typical sofa distance. Both need a TV; the value is one constant
in `ui.css`.

---

## Library management out of the dev tab ✅

Scan, parse and match no longer live behind a developer switcher. **Settings** is
a third nav entry beside Home and Search, and the dev switcher in `App.tsx` is
gone — `App` now renders `Browse` and nothing else.

**Scanning is automatic**, once per launch, in the background. Not on a timer and
not by watching the filesystem: a watcher over SMB is unreliable in exactly the
place most of the library lives, and a timer re-walks a NAS that may be asleep.
Once per launch plus a **Scan now** button is the version with no standing cost,
which is the same reasoning that kept `yt-dlp` out.

The startup scan is deliberately not awaited. Shelves render from the database
immediately and anything new appears when it appears; failures are logged rather
than surfaced, because an unreachable root at startup is normal and the scanner
already skips it. The nav shows the current stage where the title count sits.

`src/library/pipeline.ts` is the single sequence — scan → parse → match →
artwork → trailers — shared by the automatic scan and the button, so the two can
never disagree about what "up to date" means. It refuses a second concurrent run
rather than queueing one.

The individual stages survive under **Developer tools** in Settings, along with
the raw file table. Re-matching after changing a key or a scoring rule should not
cost a filesystem walk, and re-parsing should not cost a re-scan; that property
is why each stage was independently runnable in the first place.

Settings is fully D-pad operable — `FocusButton` and the new `FocusInput` — which
matters more here than anywhere else, since this is the screen where TV mode is
switched on. Toggles are buttons showing their state rather than checkboxes: a
checkbox is a poor target for a remote.

### Fix-match split out of the developer stylesheet ✅

The review queue was the one part of the old harness that is genuinely
user-facing, so it now has its own stylesheet, `src/library/fixmatch.css`, in
`rem` like the rest of the app. `library.css` stays in fixed px on purpose and
says so: it is a diagnostic table read at a desk, and scaling twelve columns to
1.45× would only push them off the screen. Its `font-size` pin is what holds it
at one size when TV mode changes the root.

Splitting it turned up a defect in the previous step. `FixMatch` was styled
entirely by `.library-root button`, and inside Settings it is not a descendant
of `.library-root` — so every control in the review queue was an unstyled
browser button on a dark background. It now carries its own button styling.

Its controls were also all mouse-only, the same class of bug as before: five
buttons, a text field, a checkbox and the expand/collapse row, none of them in
the focus tree. All now go through `FocusButton` / `FocusInput`, the checkbox is
a state-showing button, and `FocusButton` gained a `disabled` prop that also
removes it from the focus tree — a control a remote can land on but not activate
is a dead end with nothing to distinguish it from a bug.

The queue is no longer duplicated in the developer view; Settings owns it.

Conversion verified the same way as `ui.css`: every `rem` resolves to its
original pixel value at scale 1, with no property dropped.

---

## NFO read/write ✅

Interop with MediaElch, tinyMediaManager and Kodi, and the strongest available
answer to "a wrong match is worse than no match": **an NFO beside a video is
somebody having already answered the question the matcher is about to guess at.**

**Reading is authoritative and automatic.** It happens on every scan, with
nothing to enable. When the NFO carries a provider id there is no search, no
scoring and no ambiguity guard — the whole class of confidently-wrong matches
disappears for that group, because there is nothing left to get wrong. Recorded
as `nfo: tmdb:335984 from Movie.nfo`, so it stays as auditable as a `manual:`
link.

When there is no id, the override is on the *question*, not the standard of
proof: the NFO's `<title>` and `<year>` replace the guessit-parsed ones as the
search, and whatever comes back still has to clear the usual threshold and
margin. The reason records that the search title came from an NFO.

Ids resolve by how much the result carries rather than how direct the lookup is
— TMDB first, since it is the only source here with backdrops and episode
stills. `tmdb` goes straight through; `imdb` via TMDB `/find`, falling back to
OMDb for films and TVmaze for shows; `tvdb` via TVmaze lookup.

A series is matched as a unit, so the id that resolves twelve episodes is the
show's: only `tvshow.nfo` counts for a group, found up to two levels up.
An `<episodedetails>` id would link a whole season to one episode.

**Parsing is in Rust** (`src-tauri/src/nfo.rs`), with `quick-xml`. Not for
consistency but because the alternative — parsing in the webview — means
granting it filesystem read scope over the entire library including NAS shares,
and Rust already walks those paths. Tolerant of shape, strict about values: it
accepts `<uniqueid>`, legacy `<tmdbid>`/`<imdbid>`, ambiguous `<id>` routed by
what it looks like, `<premiered>` as a year source, a BOM, Windows-1252 bytes,
and Kodi's oldest convention of a file containing only a URL. Ids that are not
plausibly ids are dropped rather than sent to a provider. 11 unit tests.

**Writing is an explicit action only**, in Settings. These files live in the
user's media folders, which are frequently read-only shares, so writing must
never be a side effect of scanning. Existing NFO files are skipped unless
overwrite is chosen: one already there was almost certainly written by MediaElch
or tinyMediaManager and carries fields this app does not model, and replacing it
wholesale would discard someone else's work. `tvshow.nfo` goes in the *show*
folder, not the season folder the episodes sit in — an existing one wins, else
a `Season 01` / `S01` / `Specials` parent is stepped over.

**Verified** as a round trip against the real library: export, then re-match and
watch the reasons change from scores to `nfo:` ids; a deliberately unrecognisable
filename still matching correctly from an id beside it; and an implausible id
falling through to normal matching rather than erroring.

**Still unverified:** an NFO written by MediaElch or tinyMediaManager itself.
Every fixture here is synthetic, so the dialects are as documented rather than as
observed. A file that turns out to be a dialect too far logs
`nfo: nothing usable in <path>` rather than failing silently, which is the thread
to pull if a real one ever misbehaves.

---

## Backlog (not in the original plan, worth doing)

**Delete `src/spike/`** — the Phase 0 harness. No longer reachable from the UI (the dev
switcher is gone) but still on disk, because it is the diagnostic harness for HDR
passthrough and that is still unverified for want of an HDR display. Delete it, its
`App.css` styles and its `.skiptro`-era dependencies once that is confirmed.

**Confidence floor for skip markers** — the `.skiptro.json` sidecar carries a
`confidence` value nothing reads yet. A skip fired on a bad detection jumps over real
content, which is the same class of silent wrongness as a bad metadata match. Needs a
low-confidence sample to calibrate against; everything in the library so far reports `1`.

## Verification

- **Matching:** the number that matters is *wrongly* matched, not unmatched. Target zero
  silent wrong matches; unmatched is acceptable work. Keep ugly real filenames as
  regression fixtures.
- **Playback:** H.264, HEVC 10-bit, AV1, HDR10, DV P5, DV P7, PGS + ASS subs, TrueHD/Atmos.
- **NAS:** full scan timed over SMB; verify no full-file reads and no UI blocking.
- **TV mode:** navigate every screen with arrow keys + Enter + Back only, **without
  touching the mouse at all**. Anything unreachable by D-pad is a bug, and every
  one of them found so far was invisible in mouse testing — a stray hover repairs
  focus and hides the failure.

## Still unverified

- **HDR passthrough** — untestable so far on a 1440p SDR panel. HDR *decode* and
  tone-mapping to SDR are confirmed working.
- **Per-show track memory across episodes** — implemented, but a bug in reading `sid`
  was aborting the apply path until late in Phase 4; worth re-confirming.
- **Movies at scale** — only one film in the library so far.

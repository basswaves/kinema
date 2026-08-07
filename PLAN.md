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
defensible if correcting the refusal is easy. A **Needs attention** view in
Settings lists everything the matcher declined, grouped exactly as matching
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

> **Superseded on the marker *transport* — see [Where markers come from](#where-markers-come-from-).**
> The sidecars are no longer produced or relied on; the app reads Skiptro's own
> database, and TheIntroDB supplies the credits Skiptro cannot detect. The
> reader above still exists and still works, and everything about *how a marker
> is acted on* is unchanged.

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

## Watched tracking ✅

There is **one** notion of "seen": `playback_state.completed`, the flag playback
already set at 94%. Marking by hand writes that same flag rather than a column
beside it. Two of them would disagree the first time either was written without
the other, and the disagreement would be invisible — a row showing a tick while
Continue Watching still offered it.

Un-watching **deletes** the row rather than clearing the flag. "Not watched" and
"no history" are the same state, and leaving the position behind would resume a
file the user had just declared unseen.

Episode rows show a tick on the still, a progress bar when part-watched, and a
dimmed still once seen; the meta line counts how many of a season are done. The
manual toggle is a state-showing pill, not a checkbox, for the same reason the
Settings toggles are.

Getting it reachable by remote forced a structural change: **the row is now a
focus container with two children** rather than one focusable. A second
focusable rendered *inside* the row is unreachable by D-pad for exactly the
geometric reason the overlay nav was — see GOTCHAS.md, which now carries the
general form of the rule.

## Player: previous / next episode ✅

`next_episode` and `previous_episode` are one query with the comparison and the
sort flipped, so the two directions cannot disagree about ordering — a separate
"previous" query is the obvious place for that to drift. Both return the shared
`EpisodeRef` shape.

The buttons are rendered only when a neighbour actually exists, so they never
appear on a film or at the ends of a run. Neighbours are fetched once per file
and **cleared first**: until the answer for the current file arrives, the
previous file's neighbours are wrong, and a button that jumps somewhere
unrelated is worse than one that appears a moment late.

Keys are `n` / `p`, plus `MediaTrackNext` / `MediaTrackPrevious` — what the
transport buttons on a TV remote actually send, since a remote has no letters.

## End-credit skipping ✅

The player already had a complete credits path; what it never had was a marker,
because **Skiptro 1.2.0 detects intros only**. So the work was producing a
credits start, and the design question was how much to trust each way of getting
one. Three sources, in strict order:

1. **The sidecar.** Measured. Wins whenever a producer ever writes one.
2. **A named chapter.** Many remuxes carry an "End Credits" chapter — that is
   the author of the file stating where the credits are, which is evidence
   rather than inference. Guarded: only the back half of the file counts,
   because "Opening Credits" is a real chapter name and taking it would end the
   episode at the title sequence.
3. **A fixed tail**, `duration − N` (default 60s, cycling setting in Settings,
   0 disables). This one is a guess and is fenced as one — it never fires
   without a next episode to go to, and by default it only *offers*.

Because the guess only offers, the Up next card now has **two states**. With a
countdown, the file has genuinely ended and the next episode is coming either
way. Without one, the credits have merely started, the video is still running
underneath, and the card offers rather than announces: **Play next** or **Keep
watching**. A guess is not entitled to make the decision.

The credits prompt no longer times out after ten seconds either. That timeout is
right for an intro and wrong here, where the offer *is* the route onward and
runs to the end of the file.

**Fixed in passing:** automatic skip mode never checked whether there was a next
episode. Taking a credits segment ends the file, so on a film that meant quitting
a minute before the end. The prompt path had always refused it; auto mode had
not, and the two new sources make it reachable in a way a measured sidecar never
was.

## Stats for nerds ✅

`i` in the player, or the **Stats** button. The panel exists because this project
decides its own rendering settings and offers no quality selector, which makes
"is it doing what it claims?" the only question left — and there was previously
no way to answer it without reading `mpv.log` line by line.

Modelled on madVR's OSD, which gets two things right that a property dump does
not.

**It reports the cadence, not just two frame rates.** "23.976" and "59.97" in
separate rows do not tell you that motion judders; `3:2 pulldown — uneven` does,
and the note names the display mode that would fix it.

**It lists the render passes that actually ran.** Every other row reports what
was *requested*; `vo-passes` reports what libplacebo executed on the last frame,
with timings. Those are different claims, and only the second answers "is
anything touching my image?". Read as indexed scalars with the sub-path probed
rather than assumed — it moved between mpv versions. This gpu-next build does
not implement it at all, so rather than omit the section — indistinguishable
from "no passes ran" — the panel states that the VO does not report them and
carries the error, leaving what remains reading honestly as *requested* settings
rather than observed ones.

Beyond that it reports the source (resolution, codec, pixel format and bit depth,
frame rate, bitrate, scan type and whether the deinterlacer engaged), the display
(**measured from the webview**, which can see the actual panel), the rendering
path, **what scaling is happening and why**, the colour and HDR pipeline
including chroma siting and primaries conversion, audio in *and* out (so a
downmix is visible), and dropped frames, A/V sync and demuxer cache. Rows that
are costing quality are highlighted amber.

Every value is a flat scalar read, never a `node` — the crash in GOTCHAS.md
applies to `chapter-list` and `vo-passes` too, not just `track-list`. Every read
is individually fallible, because property names move between mpv and libplacebo
versions and reading one in an unimplemented format *throws* rather than
returning null (the `sid`/`aid` lesson). An unavailable field shows `—` instead
of emptying the panel.

It **polls**, at 1 Hz, and does not observe. Observed properties are registered
once when mpv initialises, so a panel that added its own would show nothing until
the whole app restarted and would look exactly like a panel that was wrong.

This is also the first thing in the project that can answer the **HDR
passthrough** question — `target-params/gamma` against the source transfer, plus
what the webview believes about the panel's dynamic range. It has already
confirmed the SDR half on real content: a 4K HDR10 remux reads pq / bt.2020-ncl /
1000 nits in, tone mapped with bt.2390 off a measured frame peak.

Also added: scan type and whether the deinterlacer is engaged, bit depth off the
pixel format, chroma siting (which is what MPEG-2 era content gets wrong),
primaries conversion, frame-timing mode, and an amber highlight on rows that are
costing quality — a downmix, an un-deinterlaced interlaced source, dropped
frames, debanding.

**Four of its own bugs, found by reading it against real files** — which is the
argument for building it at all, since every one produced a confident wrong
number rather than a blank:

- Luma scaling compared the source against the whole output *surface* rather
  than the letterboxed video rectangle. A scope master read "downscale 1.000×";
  a 16:9 file read 1.481× where the truth was 1.333×.
- Pixel format read `d3d11`, the hardware surface type, so bit depth vanished
  and p010 tested as "not subsampled".
- Mastering peak read "0.00× SDR white" on SDR content, because the peak
  properties report zero rather than going absent.
- Cadence used the container frame rate, which is the wrong input on precisely
  the interlaced content the deinterlacer exists for — one interlaced frame
  becomes two progressive ones.

## A launchable exe ✅

`npm run app:build` produces `dist-app/` — release exe plus the two native
libraries — and refreshes a desktop shortcut. Deliberately **not** an installer:
`--no-bundle` skips MSI and NSIS, which need extra toolchains and would mean
reinstalling on every rebuild. A folder and a shortcut have neither cost.

Both DLLs go *beside* the exe, not in a `lib/` subfolder. The plugin would find
the wrapper in either place, but `libmpv-2.dll` is resolved by Windows' own
search order, which starts at the executable's directory and never looks where
the wrapper was loaded from. See GOTCHAS.md.

The identifier is unchanged, so the built app reads the **same** database in app
data as the dev build — no re-scan, no second library. The shortcut sets its
working directory to the app folder, because `app.log` and `mpv.log` are both
opened relative to the current directory.

---

## The creator's-intent audit ✅

Prompted by "does it handle this optimally for every resolution, new and old,
always avoiding processing it does not need?" — answered by reading what mpv
actually did (`mpv.log`, verbose) rather than by reasoning about the config.

**What was already right, and stays.** `scaler-resizes-only` genuinely keeps
every luma scaler out of the path at 1:1. `spline36` up / `mitchell` down with
sigmoidised upscaling and linear downscaling is confirmed running — the shader
dump contains `pl_shader_sigmoidize` and its inverse. `dither-depth=auto`
resolved to 10-bit. Interpolation is off. All four post-init options applied.
Nothing was rejected and nothing warned. The scaler choices are **not** re-opened:
`ewa_lanczossharp` is sharper, and that sharpness is contrast the colourist did
not put there.

**Three real gaps, only one of which is about scaling at all.**

1. **24p on a 60Hz display.** The largest visible departure from intent in the
   whole setup, and invisible in any discussion of scalers: `Assuming 59.972 FPS
   for display sync` against `Container reported FPS: 23.976` is 3:2 pulldown,
   frames alternating between three refreshes and two, juddering on every pan.
   No timing strategy makes an uneven division even, and interpolating the
   difference away would invent frames nobody shot. So the app **reports** it —
   the stats panel names the cadence and says what display mode would fix it —
   and offers `video-sync=display-resample` as a switch, which removes drift and
   stray dropped frames but explicitly *not* the cadence.

   That switch is the one rendering preference in the app, and it exists only
   because the right answer depends on hardware the code cannot see: the panel's
   true refresh rate, and whether audio is leaving as an untouched bitstream. It
   resamples audio, so it is incompatible with passthrough, and Settings says so.

2. **Interlaced sources.** `--deinterlace` was off, which is right for
   everything modern and wrong for DVD-era TV: combed fields are an artifact of
   the playback path, not something anyone shot. Now `auto`, which acts only on
   streams the container flags as interlaced — the same "do nothing unless
   necessary" rule as `scaler-resizes-only`, applied to time instead of space.
   Applied post-init, because the `auto` value is newer than the option and a
   rejected *initial* option aborts mpv entirely.

3. **Chroma upscaling always runs.** 4:2:0 → 4:4:4 happens on every consumer
   encode whatever the resolution, and `scaler-resizes-only` neither does nor
   can suppress it. Nothing to fix — but "no processing" was never literally
   true, and the panel now says so rather than implying otherwise.

**Found while checking, not yet acted on:** audio is decoded to PCM and
**downmixed 5.1 → 2.0**, because there is no `audio-spdif` configuration at all
and the default Windows device is onboard stereo. That is a larger loss of
intent than any scaler question. See HANDOVER.md.

---

## The review follow-up ✅

Prompted by a full read of the project against its original prompt. The code was
in good shape; what the review found were places where the app fell short of
goals *this project had already written down*. Seven stages, each verified in the
real app before the next began.

### Continue Watching offers what to watch next ✅

`continue_watching` filtered `completed = 0`, so a show **left the rail the
moment an episode finished** — which is exactly the point at which you want it
offered. It now has two sources: a part-watched file, or for a series you have
finished an episode of and started nothing since, the next episode the library
holds. Merged in Rust rather than SQL: one query covering both would be
unreadable, and the existing one was the tested one.

**One card per show.** Starting three episodes of a series used to produce three
cards and push everything else off the rail.

The ordering logic is shared with the player's previous/next buttons through
`adjacent_from` — three callers, one definition of what "next" means. Its
predicate is *not finished* rather than *never started*: an episode you are ten
minutes into is the next one to watch, and testing for the absence of a playback
row would skip straight past it.

Pressing Play on a series used to start `movie_path`, which for a series is the
**largest file by size** — often a feature-length finale. Both Play buttons now
ask `first_unwatched_episode`, and the detail page names the episode on the
button so a press is never a surprise.

**Found while testing:** the browsing shell loaded the library once, on mount.
Marking an episode watched on a detail page changed the tick on the row and
nothing on Home. Replaced with the invariant *Home reflects the database
whenever Home is visible* — one effect keyed on the view — rather than a
callback per writer, which the next screen that writes something would have to
remember to call.

### The player OSD is reachable by remote ✅

Eighteen bare `<button>`s and no `FocusButton` anywhere: audio and subtitle
selection, stats and fullscreen were **mouse-only**, on the one screen where a
remote is most likely to be the only input. CLAUDE.md, README and GOTCHAS all
stated the rule this broke.

Left/Right still seek. **Up** hands the arrow keys to the OSD, **Escape** hands
them back — one layer at a time, closing a panel before dropping out of focus
mode before leaving the player.

The crux is that `preventDefault` cannot stop the *other* listener, so exactly
one of the two key handlers may be live at a time: the spatial system starts
`pause()`d and is `resume()`d only in OSD mode. Details in GOTCHAS.md, including
`resume()` on unmount — without it the browsing UI underneath is left unable to
navigate, silently.

A focus ring may never appear in seek mode. The ring means "arrows move between
these"; there it would be a lie, and a ring that lies is worse than none.

### A scan no longer freezes the app ✅

`scan_library` held the single `Mutex<Connection>` for the whole walk — minutes
over SMB, with every other command blocked behind it. WAL had been enabled since
the beginning with a comment saying it "keeps reads from blocking the scan
writer"; it never did, because WAL lets separate *connections* work concurrently
and there was only one.

The scanner now has its own connection, `busy_timeout` is set on both (without
it a second writer fails immediately rather than waiting, and `save_progress`
fires every five seconds during playback), and the walk gathers file metadata
**outside** any transaction — the stat calls over SMB were the slow part and
they were all happening with the write lock held.

Matching writes are batched: `link_files_to_title` takes a list in one
transaction. Every call site was already a loop over a group's files, so the
single-file command had no remaining users and was removed rather than left as
dead API.

### Browsing stays fast at scale ✅

Rails were uncapped except "Recently added" — every title in "Movies" and in
each of up to eight genre rails, each card a registered focusable, with spatial
navigation measuring elements live at navigation time. Capped at 30 with a **See
all** tile at the *end of the row*, which is where you arrive having scrolled
and keeps the rail one straight line for a D-pad.

**guessit-js was 390 kB of a 566 kB startup bundle** for code that only runs
during a scan. Dynamic-imported on first parse; startup JS is now 374 kB.
`parseMediaFile` stayed synchronous so the batch `.map()` did not have to become
a sequence of awaits, and parsing without loading **throws** rather than
recording every file as unparseable — which would look identical to a library of
unrecognisable names.

Settings fetched 2,000 rows of eighteen columns to call `.length` on a filter of
them, and silently under-reported past 2,000 files. Now a count query, with the
review queue loading its own rows.

### Logos and cast ✅

Both were in the original plan and never built, and both arrive on the TMDB
detail request the matcher **already makes** — `append_to_response` grew by two
words. No extra round trips, no new provider.

The hero draws the title treatment where every streaming service does. The `<h1>`
is the *fallback* rather than something hidden beside it, so a logo that fails to
load cannot leave the hero nameless. PNG is preferred over SVG: TMDB serves SVG
logos through the same size-prefixed CDN path unrasterised, and an `<img>`
pointed at one has no intrinsic size.

Cast is capped at ten — each one is another face in the artwork cache — and is
deliberately **not focusable**: nothing here is actionable, and ten dead landing
spots between the Play button and the episode list would be ten presses in the
way.

`people` is denormalised and keyed by title on purpose. Cast is a property of a
title here; nothing asks "what else were they in", and a shared table plus a
join table would buy that at the cost of orphan cleanup on every re-match.

The trailer backfill was generalised into `backfillTitleDetails`, since one
request returns all of it. **`NULL` means never asked; empty string means asked
and there is none** — without that distinction a title genuinely lacking a logo
would be re-fetched on every scan forever.

**Found while testing:** `Art` could loop indefinitely. It tracked a single
failed source, so when both the cached copy and the remote URL failed it flipped
between them — offline with a half-built cache, precisely when it mattered. It
now tracks a set, so each source fails once and then the fallback renders.

### Intro detection from inside the app ✅

Skip intro needed a `.skiptro.json` beside each episode and nothing produced
one, so a headline feature only worked on content processed by hand in another
window.

The app now runs a Skiptro the **user installed themselves**, at a path they
chose. Nothing is bundled, downloaded or required: with no path set, intro
skipping behaves exactly as before. See the settled-decisions note in CLAUDE.md
for why that is compatible with the rule rather than an exception to it.

Two commands, because that is what Skiptro's CLI does — `scan <dir>` fills its
own database, `export <dir>` writes the sidecars this app reads — and both are
**editable text fields**. A change to Skiptro's command line should be an edit,
not a rebuild; the same reasoning that keeps anything needing upkeep out.

Arguments never go through a shell. `{dir}` is substituted into a single token
and passed to the process directly, so a path with spaces needs no quoting
anywhere. Offered on TV roots only.

The first implementation drained stderr after stdout and could deadlock on a
full pipe buffer. GOTCHAS.md carries the general form.

## Where markers come from ✅

Two complaints, one of them the interesting one. The sidecars were clutter — a
`.skiptro.json` beside every episode forever — and **Skiptro only ever detects
intros**, so the end of an episode was never a measured thing.

Three options were looked at properly before any code was written.

**Jellyfin's intro-skipper**, reimplemented here. Deferred at the time, then
**built** — see [Detecting intros and credits in the app](#detecting-intros-and-credits-in-the-app-).
Its method — fingerprint every episode in a season, find the stretch of
audio they share, then sharpen the boundary with black-frame detection — is the
only one of the three that produces its own answer, works on files with no
metadata match at all, and finds credits as well as intros. Three things count
against doing it first:

- It is **GPL-3.0 C#**, so the code cannot be reused; only the method, which is
  documented and not copyrightable. A port would relicense this project.
- A pure-Rust build is genuinely close — `rusty-chromaprint` (MIT) already
  exposes `match_fingerprints` — but Symphonia cannot decode AC-3, E-AC-3, DTS
  or TrueHD, which is most of a remux library. So it needs `ffmpeg` for decode.
  `ffmpeg 8.1.2` on this machine is built `--enable-chromaprint`, so the door is
  open; it just swaps one invoked binary for another rather than removing one.
- It is weeks of work whose failure mode is a threshold slightly wrong and a
  skip over real dialogue — the silent wrongness the matching rules exist to
  prevent. It stays in HANDOVER as an upgrade, not a prerequisite.

**Skiptro's own database.** It was there all along: `%APPDATA%\Skiptro\skiptro.db`,
table `DetectedSegments`, with `FilePath`, `Type`, `StartSeconds`, `EndSeconds`
and `Confidence`. The sidecars were an *export* of it. Reading the source
instead removes every sidecar and changes no number. Two costs, both accepted
knowingly: it is another application's private schema, which can move under us
with no warning — so it fails loudly into the log, softly into the app, and
falls through to the sidecar reader — and it matches rows on the **exact file
path**, so renaming a video loses its detection until Skiptro runs again. That
was always true; this machine's database already holds twelve rows pointing at
paths that no longer exist. Sidecars had the same fragility plus the clutter.

**TheIntroDB.** A free community database keyed on **TMDB id + season +
episode**, which is precisely what `titles` already stores — so it needed no new
matching, no key and no account. It is where credits actually come from. Tested
against the real library before committing to it: Sex and the City returns an
intro for all twelve episodes agreeing with Skiptro to within a second, and
Breaking Bad returns both segments.

Three constraints on the way it is used come from **their terms, not from
taste**, and are in `introdb.rs` so they survive this document:

1. **One episode at a time, on play.** Never the library in bulk. Their licence
   is for client-side per-user lookups; a sweep is the shape it exists to stop.
2. **The cache expires** after 30 days. Permanent local copies of everything
   played would drift towards being a second copy of their database. A TTL also
   means a corrected timestamp reaches this machine.
3. **Attribution is shown**, in Settings. They request rather than require it.

**This is not a new class of dependency.** The app already needs TMDB to have a
library at all, so "nothing that needs periodic maintenance" is not breached by
a second metadata service — but it is a service that can vanish, and the local
sources are the reason that would be a degradation rather than a regression.

### The ranking, and why it is per segment

| | intro | credits |
|---|---|---|
| Skiptro's database | 1st — measured on *this* file | never has any |
| `.skiptro.json` sidecar | 2nd — the same detection, exported | 1st, if anything writes one |
| TheIntroDB | 3rd — community-timed | **2nd, and in practice the only one** |

**One rule: local before remote**, applied to both segments. Something measured
against the actual bytes on this disk beats something timed by somebody against
*a* copy of the episode — the same judgement the credits ladder in `skip.ts`
already made. The order does not change between segments; only which sources
have anything to say does.

Skiptro fingerprinted this file, so its intro wins. It cannot detect credits at
all and nothing writes a sidecar that does, so TheIntroDB is the only source of
a closing segment in practice, and the only measured one that has ever existed.
The chapter name and tail guess below it in `skip.ts` remain what they always
were: inference, fenced accordingly.

That "one rule" is not decoration. The first version had the cache-reuse path
overwriting a sidecar's credits with TheIntroDB's while the fetch path did the
opposite, so the winner depended on whether the cache happened to be warm — a
difference nothing would ever have reported.

### Found while testing: a button that was not dead, and then deleted anyway

**Save commands** was reported as doing nothing and proposed for deletion. It
was saving all three text fields correctly; its confirmation was rendering in
the banner under the page title, some 300 lines of markup above the button, so
the press had no visible consequence anywhere the user was looking.

Moving the confirmation next to the button fixed the symptom and left the real
problem. The fields were the only settings on the page that did *not* apply when
they changed, and something else read them: typing a new detect command and
pressing **Detect** without saving first ran the previous one, in silence. The
"integrate it into Detect" answer does not work either, because the Skiptro
database path is read during **playback**, not by detect at all.

So the fields now save themselves on a 600 ms debounce, like every other control
on the page, and the button is gone. `runDetect` flushes them before invoking
Rust, which turns the debounce from a race into a courtesy.

## Detecting intros and credits in the app ✅

The deferred third option, built. `analyse.rs` fingerprints the audio of every
episode in a season and looks for the stretch they have in common: near the
start that is the intro, near the end it is the closing theme. It is the only
source that finds credits by *measuring* them, and the only one that works on a
file with no metadata match at all.

**Why it stopped being deferred:** the other two left exactly the gap it fills.
TheIntroDB has no credits for Sex and the City, which is the only series in this
library, so the closing segment was still the fenced tail guess in practice.

### What was taken from intro-skipper, and what could not be

Its code is GPL-3.0 C# and none of it is here. Its **published operating values**
are, and they are what turned this from months of guessing into an afternoon:
intro searched in the first 25% of an episode or the first 10 minutes, whichever
is smaller; intro 15 s–2 min; credits under about 4 minutes. Those are facts
about how television is cut, and they transferred unchanged.

What could not transfer is the layer below — the score threshold that decides
whether two fingerprint frames match, and how far apart two candidates can be
and still be the same segment. Those are calibrated against the fingerprints
Jellyfin's ffmpeg emits; `rusty-chromaprint` produces a different fingerprint, so
their numbers are not on the same scale. `MAX_SCORE = 8.0` and a 3-second
cluster tolerance were set by running the real season, and
`calibrate_against_a_real_season` — `#[ignore]`d, because it needs media — is
how to re-check them.

### Agreement, not detection

Nothing is believed from one comparison. A segment must appear between an
episode and at least two *others* before it becomes a marker, and the reported
time is the median of that cluster rather than any single measurement. One
episode that happens to open on a similar chord cannot produce a marker alone —
which matters, because a wrong intro marker skips content the viewer never sees.

### Verified against the real library

Twelve episodes, one season, ~13 s each:

- **Intro** `0.0 → 45.6–45.8` on all twelve. Skiptro independently says
  `0.19 → 45.5–46.7`; TheIntroDB says `46.0`. Three methods, one answer.
- **Credits** ~69.3 s long, starting ~80 s before the end, on eleven of twelve —
  consistent to a tenth of a second.
- **The pilot was the exception**, and instructively so: it shares only the
  final 27.7 s with the others because its credit music differs, so its marker
  fired 32 s *late*. Fixed by the black-frame pass below.

### The picture gets the last word on the credits boundary ✅

The audio answer says where the closing *theme* starts. What a viewer sees as
the start of the credits is the fade to black just before it. A second ffmpeg
pass — `blackdetect` over about a minute of video around the marker, not the
eight minutes the audio pass read — moves the boundary onto that fade.

Two steps: snap onto the black period the marker lands in or just after, then
walk *backwards* through the run of short fades that separate credit cards.

**Two rules decide whether the walk is kept, and the second one is the whole
lesson of this change.**

The first is the obvious one: the reclaimed region must be at least half black,
so what is skipped is black frames rather than a scene fading out.

It is not enough, and measuring showed why. The pilot's *correct* 32-second walk
crosses **15 seconds of visible picture**; five other episodes' *wrong*
6-second walks cross only 2 seconds each. No threshold on blackness separates
them — the right answer looks worse than the wrong ones by that measure.

What separates them is the season. Every episode agrees its credits run about
69 seconds, established by the audio consensus across the whole folder, and that
is the strongest evidence available anywhere in this feature. So: **a refinement
that makes one episode's credits materially longer than its season's is not
finding a boundary, it is reaching back into the episode.** The median is used
rather than the mean, so the one outlier this exists to correct cannot move the
standard it is judged against.

Verified on all twelve:

- **The pilot: 1572.8 s → 1540.7 s.** Exactly 70.0 s before the end, against the
  69.3 s every other episode agrees on. Its refinement *shortens* the segment,
  so the length rule waves it through.
- **Six episodes move by under a second**, snapping onto the fade the music
  starts a tenth of a second inside.
- **Five are refused** and keep their audio answer, each logging why: the
  picture would have stretched their credits to 72–76 s. Inspecting those files
  shows the same structure every time — a short fade, ~2 s of visible picture,
  then the long black credits run. In automatic mode, taking that walk would
  have cut those two seconds.

The spread across the season is now 78.3–82.2 s before the end, plus the pilot
at 70.0 s.

### Ordering: Skiptro first, by decision not by measurement

Both fingerprint the same bytes on the same disk, and on real content they agree
within a second. Skiptro is ranked above anyway, because it has years of tuning
behind it and because ranking the newer thing second means **it cannot regress
an intro skip that already works**. When they disagree, `app.log` names which
spoke. For credits there is no contest: Skiptro has none.

### ffmpeg, and why not pure Rust

`rusty-chromaprint` is pure Rust and MIT, so fingerprinting needs nothing
external. Decoding does. Symphonia cannot read AC-3, E-AC-3, DTS or TrueHD,
which is most of a remux library, and a detector that silently skipped every
remux would be worse than none. ffmpeg has the same standing as Skiptro:
invoked, never shipped, path configurable, and skipped entirely when absent.

Only *windows* are decoded — the opening quarter and the closing eight minutes,
about six minutes of a 45-minute episode. `-ss` goes before `-i` so ffmpeg seeks
rather than decoding and discarding. That is the difference between a season
taking minutes and taking an hour.

### Found by shipping it: the Up next card outliving its file

A measured credits marker exposed a latent bug the guesses never could. The
player nulled `timePos` and `duration` on a change of file, with a comment
saying that stopped the previous episode's position leaking in. It could not:
both are **observed properties**, so mpv pushed the outgoing file's values back
within milliseconds — `loadfile` had not taken effect and the old file was still
open and still reporting.

So the *incoming* episode's credits start was compared against the *outgoing*
episode's position, the segment read as active, and the Up next card went up
thirty seconds into a fresh episode. It then never came down, because the offer
effect only ever sets `upNext` — and nothing cleared it on a change of file
either, only the countdown path that normally causes one.

The first fix was a `fileReady` flag — false on a new target, true on
`file-loaded` — with `active` null until then. **It was not enough, and the
second round is the one worth remembering.** `file-loaded` and the property
observer are two different Tauri channels with no guaranteed order between them,
so the flag flipped true while the last `time-pos` push still described the
outgoing file. A one-tick window, which fired on every single episode change.

Three changes made it hold:

1. **Ask, do not wait.** `file-loaded` reads `time-pos` and `duration` with
   `getProperty` instead of waiting to be told, and the observer is ignored
   entirely until the flag is true. Dropping the pushes alone would not do —
   `duration` may be emitted once per file, and a dropped one never returns.
2. **Set the flag early in that handler.** It had been placed after
   `applyPrefs`, the `video-sync` write and `readChapters`, so any one of those
   throwing left the file permanently unable to raise a Skip button.
3. **Let the offer come down again.** The effect only ever *raised* the card,
   which made every transient raise permanent — and because the Skip prompt is
   suppressed while a card is up, it hid the Skip intro button behind it too.
   The offer is tied to being inside the credits, so it is withdrawn when they
   are no longer where we are. A card with a countdown is exempt: that one means
   the file has genuinely ended.

The end-of-file handlers take the same gate through a ref — an `eof` arriving
before the new file is open belongs to the old one, and acting on it would mark
the incoming episode finished and roll straight past it.

Two lessons, both in GOTCHAS and both larger than this feature: **clearing an
observed property in React does not clear it**, and **one-way UI state turns a
one-tick glitch into a permanent one**. Any `setX` in an effect is worth asking
where its matching `setX(null)` lives.

### One button

Detect now runs Skiptro (if configured) and then the analysis, per TV folder,
reporting both through the same progress stream. It is no longer hidden when
Skiptro is unset, because the analysis needs only ffmpeg — gating the detector on
a tool it does not use would hide it from anyone who never installs that tool.
A season whose every file is already analysed against its current bytes is
skipped, so the second run costs nothing.

Sidecars are still **read** and no longer **written**. The export step became an
empty template — "do not run this" — rather than a deleted feature, so anyone
feeding another player from the same scan types `export {dir}` back in.

### Two things that would have been silently wrong

Both are in GOTCHAS. Opening Skiptro's database `immutable=1` — the flag that
promises not to touch someone else's file — ignores the write-ahead log and
reports **an empty schema with no error**, indistinguishable from "nothing has
ever been detected". And a cache keyed on `skiptro.db`'s mtime would never
notice a rescan, because the main file is 4 KB and every row lives in the
`-wal`.

The cache itself is now two-part for the same reason: `local_key` fingerprints
the local sources and is re-checked every play, `remote_at` is when the network
was last asked and is not. A Skiptro rescan re-reads the local sources without
asking their server about the credits again.

---

## Open items

**They live in [HANDOVER.md](HANDOVER.md), and only there.** They used to be
listed here twice — a "Backlog" and a "Still unverified" — as well as in
HANDOVER, which is exactly the drift this file keeps warning about. This
document is for decisions and the reasons behind them; what is left to do is a
different question with a different shelf life.

## Verification

- **Matching:** the number that matters is *wrongly* matched, not unmatched.
  Target zero silent wrong matches; unmatched is acceptable work. Keep ugly real
  filenames as regression fixtures.
- **Playback:** H.264, HEVC 10-bit, AV1, HDR10, DV P5, DV P7, PGS + ASS subs,
  TrueHD/Atmos.
- **NAS:** full scan timed over SMB; verify no full-file reads and no UI
  blocking.
- **TV mode:** navigate every screen with arrow keys + Enter + Back only,
  **without touching the mouse at all**. Anything unreachable by D-pad is a bug,
  and every one of them found so far was invisible in mouse testing — a stray
  hover repairs focus and hides the failure.

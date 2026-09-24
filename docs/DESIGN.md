# Design notes

Why Kinema is built the way it is. This is the reasoning behind the code —
the architecture, how data moves through it, and the decisions that are
settled rather than open.

It was extracted from the README when that became a document for people who
want to *use* the app rather than change it. Nothing here is required reading
to run Kinema; all of it is required reading before arguing with how it works.

See also [GOTCHAS.md](GOTCHAS.md) for the traps, [PLAN.md](PLAN.md) for what
was built and in what order, and [ROADMAP.md](ROADMAP.md) for what is left.

---

## Architecture

Single window. mpv renders into a **native child surface beneath the WebView2
control**; the window and the entire CSS chain are transparent so React composites on
top. This is the whole architectural bet, and it works — but it means `html`, `body`
and `#root` must never get an opaque background, or the video disappears completely.
Full-screen browsing views paint their own background; the player must never
paint over a video frame. Its one opaque surface is the black cover shown
*before* a file's first frame (`.player-cover`), because a transparent window
with no frame up shows the desktop.

```
src-tauri/src/
  db.rs          SQLite schema + migrations (user_version, currently 9).
                 busy_timeout is load-bearing: two connections exist
  scanner.rs     Filesystem walk. NAS-aware: identity is (path, size, mtime),
                 never a content hash — never read file bytes during a scan.
                 Gathers metadata outside the transaction and commits in
                 batches, so the write lock is never held for network I/O
  library.rs     Roots, scan, parse write-back, stats. Owns both `Db` and
                 `ScanDb` — the scanner's separate connection
  metadata.rs    Titles, episodes, cast, file→title links, detail queries
  playback.rs    Resume points, Continue Watching (part-watched *and* next-up),
                 watched state, the adjacent-episode lookup shared by three
                 callers, track prefs
  artwork.rs     Downloads posters/backdrops/logos/stills/cast faces into app
                 data, keyed by remote URL; served back through the asset
                 protocol
  skip.rs        Ranks the marker sources and returns the winner per segment;
                 caches locals and network separately, since only one of them
                 is free to re-read
  skiptro.rs     Reads Skiptro's own SQLite database — the source the
                 .skiptro.json files were only ever an export of
  analyse.rs     This app's own detector: fingerprints each episode of a
                 season and finds the audio they share. Intro near the start,
                 closing theme near the end; a second pass moves the credits
                 boundary onto the fade to black the picture actually has
  ffmpeg.rs      Finding ffmpeg; decoding short windows of audio, and finding
                 black frames, with it
  introdb.rs     TheIntroDB lookups, keyed on TMDB id. Where end credits come
                 from; per-episode, on play, cached with a TTL
  detect.rs      Runs the user's own Skiptro if configured, then analyse.rs.
                 Two ways in: a Detect button per TV folder, and automatically
                 at the end of every scan — Skiptro whenever new episodes
                 arrived, the analysis unless it is switched off. Nothing here
                 can fail a scan; a missing tool is a sentence in the report.
                 Nothing is bundled; the command lines and both tool paths are
                 settings
  trailer.rs     Finds local trailer files by Jellyfin/Kodi convention; the
                 scanner shares its test so trailers never become titles
  settings.rs    Key/value settings (API keys) + the frontend log bridge

src/
  ui/            Browse shell, Home, rails, cards, detail page, search, the
                 "See all" grid, Settings. tv.ts holds the 10-foot scale switch;
                 focus.ts recovers focus after a view change;
                 FocusButton/FocusInput are the D-pad-reachable controls
                 everything else is built from. Rail.tsx owns the one cap on
                 how long a rail gets
  player/        Player, shared mpv lifecycle, track handling, mpv options.
                 chapters.ts and stats.ts read mpv as flat scalars only;
                 skip.ts continues the credits ladder past the marker Rust
                 supplies — a named chapter, then a fenced guess at the tail
  library/       pipeline.ts — the scan→parse→match→artwork→details sequence,
                 shared by the startup scan and the Scan now button.
                 parse.ts loads guessit-js on demand, not at startup. LibraryView
                 is the developer surface behind a disclosure in Settings and
                 keeps library.css in fixed px; FixMatch, the user-facing review
                 queue, has its own fixmatch.css in rem so it scales
  metadata/      Providers, match scoring, orchestration
  devlog.ts      Forwards console + unhandled errors to app.log (app data\logs)
```

### Data flow

```
scan (Rust)  →  media_files rows          identity = path + size + mtime
parse (TS)   →  guessit-js + parent-dir fallback → parsed_title/season/episode
match (TS)   →  provider search → score → titles + episodes, or "unmatched" with reason
artwork(Rust)→  posters, backdrops, logos, stills, cast faces into app data
details (TS) →  re-fetch titles matched before a field was being stored
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

**HDR: decided per screen, per file.** Before each file the player asks whether the
screen the window is on has HDR switched on. If so, the output is tagged HDR10 with the
film's own metadata (`target-colorspace-hint-mode=source`) and the display tone maps, as
it would for a disc player. If not, the hint is off and mpv tone maps with BT.2390 (the
ITU reference EETF) using a measured frame peak rather than the frequently wrong static
metadata in remuxes. Left to itself mpv tags HDR10 even for an SDR screen and Windows
converts it — see GOTCHAS.
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

**Continue Watching answers "what next", not "what did I pause".** A finished
episode hands the rail on to the next one the library holds, because the moment
an episode ends is exactly when you want the show offered — not when it should
disappear. One card per show: three started episodes used to mean three cards.
The next-up rule is *first episode not finished*, so one you are ten minutes
into is offered rather than skipped past.

**Exactly one keyboard handler owns the arrow keys at a time.** The player binds
its own and the spatial navigation library binds another; `preventDefault` cannot
stop the other listener. So the spatial system is paused while arrows seek and
resumed only once **Up** hands the OSD focus. Without that split, one press both
seeks and moves the focus ring. A focus ring never appears in seek mode, because
the ring means "arrows move between these" and there it would be a lie.

**Rails are capped, and the cap lives in one place.** Every card is a registered
focusable and spatial navigation measures elements live at navigation time, so
an uncapped genre rail on a large library is a real cost for something nobody
scrolls. Thirty, then a **See all** grid — with the tile at the *end* of the row,
which is where you arrive having scrolled and keeps the rail one straight line
for a D-pad.

**Skiptro is invoked, never shipped.** The app can run a copy the user installed
themselves, at a path they chose, with the command lines editable in Settings —
so detecting intros is not a chore in another window. It still bundles nothing,
downloads nothing and requires nothing to be present: with no path set, intro
skipping behaves exactly as it always did. The templates are text fields so a
change to Skiptro's CLI is an edit rather than a rebuild, which is the same
reasoning that keeps anything needing upkeep out.

**Markers are read from the source, not from an export beside every video.**
Skiptro stores every detection in its own database; the `.skiptro.json` files
were a copy of that, one per episode, sitting in the media folders forever. The
app reads the database. The cost is knowingly taken: another application's
private schema can move without warning, so a mismatch fails loudly into the log
and falls through to the sidecar reader, which still works and is still how any
other producer can feed this app.

**End credits come from TheIntroDB, because nothing local can measure them.**
Skiptro detects intros only. TheIntroDB is a free community database keyed on
the TMDB id the title already has, so it needed no new matching and no account.
It is asked about **one episode at a time, when that episode is played** — never
the library in bulk — and the answer is cached with an expiry rather than kept.
Both of those are their licence terms rather than a design preference, and they
are in `introdb.rs` where the code that must honour them lives. Attribution is
in Settings. It is a second metadata service on top of TMDB, not a new class of
dependency; if it goes away, the local sources mean that is a degradation rather
than a regression.

**Local measurement outranks a community timing, for both segments.** Skiptro
and this app's own analysis both fingerprint the exact file on this disk, so
their intros beat a timing taken against some copy of the episode. The order
never changes between segments — only which sources have anything to say does.

**The app detects intros and credits itself.** `analyse.rs` fingerprints every
episode of a season and finds the stretch of audio they have in common: near the
start that is the intro, near the end it is the closing theme. It is the method
Jellyfin's intro-skipper uses, reimplemented — its code is GPL-3.0 C# and none of
it is here, but its published windows and duration bounds are, because those are
facts about how television is cut. It is the only source that finds credits by
measuring them, and the only one that works on a file with no metadata match at
all.

Nothing is believed from a single comparison. A segment must appear between an
episode and at least two *others* before it becomes a marker, and the reported
time is the median of that cluster — one episode that happens to open on a
similar chord cannot produce a marker on its own.

**The picture gets the last word on where the credits start.** Audio finds where
the closing theme begins; a viewer sees the credits begin at the fade to black
just before it. A second ffmpeg pass moves the marker onto that fade, and where
credits roll over black it can walk back through the run of card transitions —
which is what corrects an episode whose credit music differs from the rest of
its season and so matched only its final bars.

That walk is bounded by **the season's own credits length**, and the reason is
worth keeping. Requiring the reclaimed region to be mostly black is the obvious
guard and it is not sufficient: measured here, the one *correct* long walk
crosses more visible picture than the wrong short ones do, so no threshold on
blackness separates them. What does is that every episode agrees how long its
credits run. A refinement that makes one episode's credits materially longer
than its season's is not finding a boundary — it is reaching back into the
episode, and it is refused with the reason logged.

**Skiptro is ranked above it for intros by decision — where Skiptro is sure.**
Putting the older, more-tuned one first means adding the analysis cannot regress
an intro skip that already works. They do not always agree: measured on this
library, 34 of 61 episodes differ by more than a second, but every large
disagreement is one Skiptro itself scored at 0.70 or less. So below a
confidence of 0.8 the analysis answers instead, and Skiptro keeps first place
everywhere it said it was confident. `app.log` names which source spoke.

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

**A guessed credits marker may offer, never decide.** The closing segment is
resolved from TheIntroDB, then a chapter named for it, then `duration − 60s`.
The first two are measurement and evidence; the
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


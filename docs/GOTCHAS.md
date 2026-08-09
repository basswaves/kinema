# Gotchas

Every entry here cost a real debugging round. Most share a shape: **the code was
correct and simply never ran, or failed silently in a place with no visible output.**
Read this before touching the player.

---

## libmpv / tauri-plugin-libmpv

### `getProperty(..., 'node')` crashes the whole process

Reading `track-list` in `node` format kills the app with
`STATUS_ACCESS_VIOLATION` (0xc0000005). The node format deserialises a nested
array-of-maps across the FFI boundary; every flat scalar format is stable.

**Do:** read `track-list/count`, then `track-list/N/type`, `track-list/N/id`,
`track-list/N/lang` … as scalars. See `src/player/tracks.ts`.

This is a property of the *format*, not of `track-list`. Every other list-shaped
property is the same trap: `chapter-list`, `playlist`, `vo-passes`,
`demuxer-cache-state`. `src/player/chapters.ts` reads `chapters` for the count
and then `chapter-list/N/time` and `chapter-list/N/title` as scalars, for exactly
this reason. `src/player/stats.ts` is scalars throughout and reads no list
property whole.

The crash is silent from JS — no exception, the process just dies. Symptom: exit code
5 / `STATUS_ACCESS_VIOLATION` shortly after an action, nothing in the console.

### `sid` / `aid` fail in **both** directions

They are choice-style properties (`auto` / `no` / an integer), and the typed property
API cannot express that either way. This bit twice — once writing, once reading.

```ts
await setProperty('sid', 3);              // fails: -2 M_PROPERTY_NOT_IMPLEMENTED
await getProperty('sid', 'int64');        // throws: unsupported format
await command('set', ['sid', String(3)]); // works
// reading: take it from the track list's own `selected` flags
```

JS numbers always cross as `MPV_FORMAT_DOUBLE`, which those handlers don't implement.
Booleans map fine to flags; plain numeric properties like `volume` are fine.

### Observed properties are registered once, at init

Only properties in the init config's `observedProperties` ever emit change events, and
mpv initialises **once per window** (guarded on `window.__mpvInit`). Adding one later
does nothing until the app fully restarts — HMR cannot re-init mpv.

This is invisible: the new `case` looks right, nothing errors, events simply never
arrive. It cost a full round on next-episode autoplay while mpv's log proved the file
was ending (`EOF code: 4`).

**Do:** poll with `getProperty` for anything load-bearing. One property read per second
is nothing next to a lost debugging round.

### `keep-open=yes` means `end-file` never fires

`keep-open` holds the last frame instead of closing the file — which is what you want
visually. But then mpv emits **no `end-file` event** at the end of playback.
`eof-reached` is the property that fires.

### mpv init aborts on one bad option, silently

Options are applied in order; a rejected option aborts `mpv_initialize()`. The window
then renders transparent (no video surface) with no error anywhere.

**Do:** keep `log-file` and `msg-level` **first** in the options object so failures are
always recorded. Keep build-dependent options (tone mapping, gamut) out of the init set
and apply them individually *after* startup — losing one refinement beats losing the
player. `tone-mapping-mode` is exactly such a case: this libplacebo build returns
`M_PROPERTY_UNKNOWN` for it.

### `video-params/pixelformat` reports `d3d11` under hardware decode

It is the *surface* type, not the frame format. The real one is
`video-params/hw-pixelformat` (`p010`, `nv12`, …). Reading only the first gives
a plausible-looking value that silently loses the bit depth and makes every
subsampled source test as not subsampled — which is exactly the sort of wrong
answer a diagnostic panel must not give.

**Do:** prefer `hw-pixelformat`, fall back to `pixelformat`.

### `osd-dimensions` is the surface, not the video

It includes the letterbox margins, so comparing the source resolution against it
describes an image the frame was never drawn at. A 3840×1600 scope master in a
2560×1600 window reported "downscale 1.000×" — wrong, and self-contradictory
enough to notice; a 16:9 source in the same window reported 1.481× instead of
1.333×, which is wrong and looks perfectly reasonable.

**Do:** subtract `osd-dimensions/ml|mr|mt|mb` to get the rectangle the video is
actually scaled into.

### Peak-luminance properties report 0 rather than going absent

`video-params/sig-peak` and `max-luma` both read `0` on SDR content, so a
null-check passes them straight through and the panel confidently states
"0.00× SDR white". Treat non-positive as absent, and gate on the transfer
function instead.

### The verbose log answers rendering questions that reasoning cannot

`msg-level=all=v` records what libplacebo *did*, not what it was asked to do:
the shader dump names each pass (`pl_shader_sigmoidize`), `Dithering to 10 bit
depth` confirms `dither-depth=auto` resolved, `Assuming 59.972000 FPS for
display sync` against `Container reported FPS: 23.976024` is the whole 3:2
judder story, and `Set property: X -> 1` proves each post-init option landed.
The audio chain prints `[af] [in]`/`[out]`, which is how a silent 5.1 → 2.0
downmix was found.

**Do:** read `mpv.log` before theorising about the rendering path. Every claim
in the stats panel was checked against it first.

### Clearing an observed property in React does not clear it

`Player.tsx` nulls `timePos` and `duration` when the target changes, with a
comment explaining that it stops the previous file's position leaking into the
new one. It does not, and cannot: **both are observed properties**, so mpv pushes
the outgoing file's values straight back in — `loadfile` has not taken effect
yet, so the old file is still open and still reporting. The React state is
correct for a few milliseconds and then overwritten by the thing it was
protecting against.

This stayed invisible for as long as credits markers were guesses. A *measured*
credits marker exposed it immediately: the incoming episode's credits start
(~1360 s) was compared against the outgoing episode's position (~1400 s), the
segment read as active, and the Up next card was raised. Nothing ever lowered
it, because the offer effect only ever *sets* — so the card sat on top of a
freshly started episode for its entire duration.

**Do:** gate on whether the file mpv has open is the one you think it is.
`fileReady` goes false on a target change and true on `file-loaded`, and
`active` returns null until then — one check covering the Skip button, automatic
mode and the Up next offer. The event handlers use a **ref** of the same flag,
because re-registering mpv listeners to pick up a state change is its own
gotcha, three entries above.

**That flag is not enough on its own either**, and the second attempt is the
instructive one. `file-loaded` and the property observer are **two different
Tauri channels**, so their order against each other is not guaranteed: the flag
flipped true while the last `time-pos` push still described the outgoing file,
which is a one-tick window that fires reliably on every episode change.

**Do:** on `file-loaded`, *ask* for `time-pos` and `duration` with `getProperty`
rather than waiting to be told, and ignore the observer entirely until the flag
is true. Dropping the pushes alone is not safe — `duration` may only be emitted
once per file, and a dropped one never comes back.

**And set the flag early in that handler, not late.** It was placed after
`applyPrefs`, the `video-sync` write and `readChapters`, so any one of them
throwing left the file permanently unable to raise a Skip button — with no error
visible anywhere except a missing button.

### One-way UI state makes every transient bug permanent

The Up next offer effect only ever *raised* the card. So a card raised in error —
by any of the races above — stayed up for the entire episode, and because
`skipPrompt` is suppressed while a card is showing, it also silently hid the Skip
intro button behind it.

**Do:** let the effect lower it too. The offer is tied to being inside the
credits, so when the credits are no longer where we are, it comes down; a card
with a **countdown** is exempt, because that one means the file genuinely ended
and the next episode is coming regardless. One-way state turns a one-tick glitch
into a permanent one, and it is worth asking of any `setX` in an effect whether
the matching `setX(null)` exists.

**And:** clear derived UI on a target change, not only on the path that usually
causes it. `upNext` was cleared when a countdown advanced and by nothing else,
so every other route into a new file carried the old card in.

### `loadfile` is asynchronous

Seeking immediately after it fails — there is nothing loaded yet. Decide the resume
position before loading, apply it on the `file-loaded` event.

### Initialising mpv twice corrupts native state

React StrictMode double-invokes effects and HMR remounts components; either can call
`init()` against a live instance and take the process down. The guard lives on
`window` (not module scope — Vite replaces the module on HMR). StrictMode is
deliberately **off** in `src/main.tsx` for this reason.

---

## Tauri

### The asset protocol needs a **Cargo feature**, not just config

`app.security.assetProtocol.enable = true` in `tauri.conf.json` looks like the
whole switch. It is not: the `asset://` handler is compiled in only when the
`tauri` crate has the **`protocol-asset`** feature. Without it the config key is
accepted and ignored, `convertFileSrc()` still returns a perfectly plausible
`http://asset.localhost/...` URL, and every image fails to load.

```toml
tauri = { version = "2", features = ["protocol-asset"] }
```

Both halves are required, and neither one warns about the other being missing.

### Scope patterns are matched with a literal separator

The scope is a glob, and `require_literal_separator` is on (it closes a real
advisory). `$APPDATA/artwork/*` therefore covers files directly in `artwork/`
but **nothing in a subdirectory** — a nested layout needs `/**`. Tauri
normalises `/` to the platform separator itself, so writing the pattern with
forward slashes is correct on Windows.

`$APPDATA` here means the *app's* data directory
(`…\Roaming\com.kinema.app`), not the OS `%APPDATA%`.

---

## SQLite

### WAL does nothing with only one connection

`db.rs` has enabled `journal_mode=WAL` since the beginning, with a comment
saying it "keeps reads from blocking the scan writer". It did not, because
there was a single `Mutex<Connection>` for the whole app and the scanner held
it for the entire walk. WAL lets *separate connections* read while one writes;
a mutex around one connection serialises everything regardless.

**Do:** give the scanner its own connection (`ScanDb`). The mutex then only
serialises access to each connection, and SQLite does the rest.

### `busy_timeout` is load-bearing the moment there is a second connection

SQLite allows one writer at a time. With two connections, a write that arrives
while another is committing fails **immediately** with `database is locked` —
it does not queue. `save_progress` fires every five seconds during playback, so
watching something during a scan would silently lose resume points.

**Do:** `conn.busy_timeout(…)` on every connection. Use the rusqlite method
rather than `PRAGMA busy_timeout`, which returns a row and so cannot go in an
`execute_batch` (the same trap `journal_mode` already documents above).

**And:** bound how long any one transaction holds the write lock. The scanner
commits every 500 files rather than once per root, and — more importantly —
gathers file metadata *outside* the transaction. Stat calls over SMB are the
slow part of a scan, and they were all happening with the write lock held.

### `immutable=1` reports a WAL database as **empty**, with no error

Reading another application's SQLite file — Skiptro's, in `skiptro.rs` — the
obvious flag is `immutable=1`: it promises not to touch the file at all, which
is exactly the guarantee you want over someone else's data.

It also ignores the write-ahead log completely. Skiptro runs in WAL mode, so on
this machine `skiptro.db` is **4 KB** and all twenty-four detections live in
`skiptro.db-wal`. An immutable open therefore returns a database with no tables
in it: every query fails with `no such table: DetectedSegments`, which reads
exactly like "Skiptro has never scanned anything". Verified both ways against
the real file.

**Do:** `file:…?mode=ro`, which reads the WAL and still cannot write. It needs
the `-shm` file to be present and readable; when it is not, the open *fails
loudly*, which is the right failure.

### A graceful fallback with nothing to show for it is a silent bug

Adding season 2 of a show made the Up next card arrive eighteen seconds into the
credits. Nothing had broken: the new season had never been analysed, so the
credits marker fell through the whole ladder to `duration − 60s`, and the real
credits start about eighty seconds before the end.

Every layer behaved exactly as designed. The failure was that **the degradation
was invisible** — no badge, no count, no log line the user would ever look at,
and content that looked identical to content that worked. It was reported as a
regression in the player, which is where the several hours would have gone.

**Do:** when a source can be absent, show that it is. Each TV folder's Detect
button now carries "N episode(s) not analysed yet", from the same query Detect
uses so the number cannot drift from the work. The general rule already exists
in this codebase for matching — a visible refusal beats a silent wrong answer —
and it applies to every fallback, not only to metadata.

### …and a warning only counts where the user already is

The fix above was correct and did not work. Season 3 of the same show was added
some months later and produced the same silent result — an episode with no Skip
button at all — with "10 episode(s) not analysed yet" sitting on screen in bold
the whole time, **in Settings**, next to the button that would have fixed it.

That is the trap, and it generalises past this feature: a warning is only a
warning where the user will be *before* they know something is wrong. Settings
is where you go once you already suspect a problem and have guessed which
subsystem owns it. Putting the diagnosis there means it is only readable by
someone who no longer needs it.

Worse, it made the failure look self-inflicted. Nothing in the app connected
"the season I just added" to "a button in a screen about detectors", so the
honest reading from the sofa was that intro skipping had simply broken.

**Do:** prefer doing the work to reporting that it needs doing. The pass now
runs at the end of the scan that created the need for it. Where a report is
genuinely all that is possible — the analysis switched off, a configured Skiptro
that has gone missing — it now appears under the scan summary, which is what a
user reads after adding something, rather than beside the control that would act
on it.

**Also:** distinguish *never configured* from *configured and now broken*. The
first deserves silence — nothing was expected to happen. The second must speak,
every time, because the user believes it is working. Reporting both identically
is how a real failure gets filed as normal background noise.

### A file that is still arriving is a file, as far as everything is concerned

Four episodes of a new season produced no analysis at all. They turned out to be
partial — a torrent that had not finished, or a copy the scan caught mid-flight.
`ffprobe` cannot read a duration from them, so `analyse_season` skips them, which
is correct and self-healing: `analysed_segments` stores each file's size and
mtime, so the file completing invalidates the row by itself.

**Most of this area self-heals. Three things did not**, and they are worth
knowing because they are all the same mistake — treating a path as an identity
when the identity is the bytes:

1. **Watch state survived the file changing.** A partial MKV *plays* — the
   container streams — reports a plausible-but-wrong duration, reaches its short
   end, and `save_progress` marks it complete at 94% of a length that was never
   real. The scanner's "content changed" branch reset the parse and left
   `playback_state` alone, so the finished download stayed marked watched:
   invisible, and it drops the episode out of Continue Watching for good. MP4
   hides this — a truncated MP4 usually will not open at all, so nothing is
   recorded and the bug looks absent.
2. **The marker cache key did not include the video.** `local_key` covered
   Skiptro's database, the sidecar and the analysis timestamp, all of which go
   through `media_files` — which has not been updated yet for a file replaced
   *since the last scan*. Nothing moved, so markers measured against bytes that
   no longer exist were served.
3. **A growing file re-analysed its whole season on every scan.** Analysis
   compares episodes against each other, so one changed file makes all of them
   stale. Harmless when Detect was a button nobody pressed mid-download; minutes
   of ffmpeg per launch once the pass became automatic.

**Do:** clear derived state on **size**, never on mtime. An mtime moves for
reasons that are not content — a metadata write, a copy between drives, a NAS
touching a file — and clearing watch state on it would let *moving a library*
wipe every tick in it. Size changing is a real content change. `scanner.rs` has
both cases as tests, and the mtime one matters more.

**Do:** when a cache key claims to cover "everything that could change", check
whether the file itself is in it. Two of the three above were the same omission
at different layers.

### A season is not a folder

`analyse.rs` compares every episode of a season against every other, so how the
episodes are grouped *is* the algorithm — a group of one finds nothing, in
silence, and looks exactly like a show with no intro.

The obvious grouping is the containing directory. It is wrong on real libraries:
this machine's Sex and the City season has ten episodes in a `Season 1`
subfolder and two still loose in the show folder above it, because a renamer
moved some and not others. Grouping by folder would have compared ten against
each other, then two against each other, and quietly produced worse markers for
the two.

**Do:** group on `title_id` when the file is matched and `parsed_title` when it
is not, plus `parsed_season`. Falling back to the parsed title is also what lets
detection work on the Needs attention queue, which is the one thing no other
marker source can do.

### A WAL database's mtime is not its version

Following directly from the above: `skiptro.db` can go untouched through a scan
that adds hundreds of rows, because they land in `skiptro.db-wal`. Any cache
keyed on the main file's size and mtime looks completely correct and never
notices new data — the same shape of bug as caching "no markers" forever.

**Do:** stamp the `-wal` file too. `skiptro::version_stamp` covers both, and
there is a test that fails if the `-wal` is dropped from it.

---

## Child processes

### Draining stdout and stderr in sequence can deadlock

Pipe buffers are finite (~64 KB). A child that fills **stderr** while this side
is blocked reading **stdout** stops writing — so stdout never closes either, and
both ends wait forever. The symptom is a long-running job that hangs with no
output and no error, which is the worst shape a failure can take.

**Do:** drain one stream on its own thread and join it after the other closes.
`detect.rs` does this even though Skiptro writes progress to stdout and errors
to stderr, because "it usually does not write much there" is not a guarantee.

**Also:** on Windows, set `CREATE_NO_WINDOW` (`0x08000000`) via
`CommandExt::creation_flags`, or every spawned step flashes a console window
over the app.

---

## Spatial navigation (D-pad)

Both entries below are invisible with a mouse. Hovering re-establishes focus and
clicking reaches anything, so the UI tests perfectly on a desk and is unusable
from a sofa. **Test D-pad changes with the mouse physically untouched.**

### Focus cannot travel up into an overlay nav

Going up, the library requires a candidate whose **bottom** edge is above the
current element's **top** edge:

```js
// smartNavigate, direction 'up'
sibling.bottom <= current.top
```

A nav bar drawn *over* the content can never satisfy this — its bottom edge is
by definition below the content's top edge — and here the hero deliberately
slides further under it (`margin-top: -4rem`). No rearrangement of the markup
fixes it, which is worth knowing before spending an afternoon trying.

**Do:** put a `nextFocusResolver` on the nearest common parent of the nav and
the content (`resolveNavHop` in `src/ui/Browse.tsx`). It is consulted only after
the geometric search inside the content comes up empty, so ordinary rail-to-rail
movement is untouched — only a press that has run out of content reaches it.

Note that the resolver **replaces** the geometric search at that level rather
than supplementing it, so it has to return `null` for the directions it does not
handle, and the parent needs exactly the children you think it has. The search
view got a container of its own for that reason: without one, its grid cards
were direct children of the shell and every vertical move inside the grid hit
the resolver.

### `useFocusable` reads the context of the component it is *called in*

Rendering a `FocusContext.Provider` does not put your own `useFocusable` inside
it. The hook reads the context that was already in scope when the component
rendered, so all of these end up as children of the **root**, not of the shell:

```tsx
// WRONG — nav and shell both end up parented to ROOT
function Browse() {
  const shell = useFocusable({ focusKey: 'browse-shell', nextFocusResolver });
  const nav = useFocusable({ focusKey: 'top-nav' });   // context here is ROOT
  return (
    <FocusContext.Provider value={shell.focusKey}>
      <FocusContext.Provider value={nav.focusKey}>…
```

The markup looks nested and the focus tree is flat. Everything still renders,
every button still focuses, and left/right inside the nav still works — the only
symptom is that a `nextFocusResolver` on the parent never sees the children it
was written for, because they are its siblings. It silently returns `null` and
navigation just stops.

**Do:** give each container its own component (`TopNav`, `SearchView` in
`src/ui/Browse.tsx`), so the hook runs in a render scope that is genuinely
inside the parent's provider.

### Focus parked on an unmounted component is silent death

Each view replaces the last entirely — opening a detail page unmounts every card
on Home. The spatial system keeps pointing at whatever was focused, so after the
transition the current focus key names a component that no longer exists. No
error, no ring, and every arrow press does nothing: indistinguishable from a
frozen app.

`getCurrentFocusKey()` still returns that dead key, so testing for
`ROOT_FOCUS_KEY` alone is not enough — pair it with `doesFocusableExist()`. Every
top-level view claims focus on arrival through `useClaimFocus` in
`src/ui/focus.ts`.

The same applies at startup: nothing holds focus until something claims it, and
a remote has no equivalent of a hover to bootstrap it.

### `scrollIntoView({ block: 'nearest' })` is a no-op once on screen

Which is what you want almost everywhere, and wrong for the top row. Arrowing
down through the rails scrolls the page; arrowing back up to the hero reveals
nothing, because the hero's buttons are already visible — so the page stays
where the rails left it, with the hero cropped and the nav floating over half an
image. The top row is the one place where the correct scroll position is
absolute, not relative: see `scrollPageToTop` in `src/ui/focus.ts` and
`keepInView="page-top"`.

### A control overlaid on a card is unreachable, wherever you put it

The corollary of the two entries above, and the one that decides layout. Spatial
movement is geometric, so a button drawn *inside* another focusable's rectangle
— a ✕ in the corner of a card, a badge on a thumbnail — cannot be reached from
it in **any** direction: right needs the candidate's left edge past the current
right edge, up needs its bottom edge above the current top edge, and an overlay
satisfies none of them by construction.

So the position of a secondary control is a navigation decision before it is a
visual one. Continue Watching's **Remove** sits *below* its card rather than in
the corner for exactly this reason — and below rather than beside, because in a
horizontal rail a sibling to the right doubles the presses needed to travel the
rail, while one below is reached by Down and costs nothing.

### Two focusables inside one row need a container, not adjacency

The same geometry that stops focus reaching an overlay nav stops it reaching a
control drawn *inside* another focusable. Going right requires
`sibling.left >= current.right`; a button rendered within the row's own
rectangle can never satisfy that, so adding a second `useFocusable` next to the
row's produces a control that renders, styles, hovers and clicks — and that a
D-pad simply cannot reach. Identical symptom to the four bare `<button>`s, and
identically invisible with a mouse.

**Do:** make the row a **container** (`trackChildren`, `saveLastFocusedChild`)
holding the two focusables as children, each declared in a component of its own
so `useFocusable` runs inside the container's provider. Left/right then moves
within the row and up/down still moves between rows, because norigin walks up to
the parent level when the current level yields no candidate. `PlayableEpisodeRow`
in `src/ui/TitleDetail.tsx`.

A container is only worth having if it has a reachable child. An episode the
library does not hold has neither a play target nor anything to mark, so it is
rendered by `MissingEpisodeRow` with no focusable at all — a container whose
children are all unfocusable becomes a landing spot that swallows focus and
answers nothing, which looks exactly like the dead-key hang below.

### A bare `<button>` is invisible to a remote

`useFocusable` is what puts a control in the focus tree. A plain `<button>`
renders, styles, hovers and clicks perfectly while being completely unreachable
by D-pad. Four of them survived several phases of development this way.

**Do:** use `src/ui/FocusButton.tsx` in the browsing UI. The player OSD was the
last place still holding eighteen of them — every control except the two
prompts, including audio and subtitle selection, which is the one a remote needs
most.

### Two live key handlers cannot share the arrow keys

The player binds its own `window` `keydown` for seeking; the spatial system
binds one of its own at `init()`. Both fire on every press, and **`preventDefault`
does not stop the other listener** — it is a separate handler on the same event,
and the spatial system's was registered first, so even `stopImmediatePropagation`
would be too late. Handling `ArrowLeft` in both places seeks *and* moves the
focus ring on one press.

**Do:** make exactly one of them live at a time. `pause()` and `resume()`,
exported from the spatial navigation package, are the switch — the player starts
paused so arrows seek, and `resume()`s only once Up hands the OSD focus. The
player's own handler then has to `break` on every arrow *and* on `Enter`, or
both handlers act again.

**Also:** `resume()` before `setFocus()`. Navigation is ignored while paused, so
focus aimed at a control the system is not yet listening for lands nowhere.

**And:** `resume()` on unmount. The player pausing on the way in and not undoing
it leaves the browsing UI underneath unable to navigate at all, with no error
and nothing on screen to suggest why.

### A focus ring that lies is worse than no focus ring

The ring means "the arrow keys move between these". In the player that is only
true in OSD focus mode; the rest of the time arrows seek. Whatever the spatial
system believes is focused after the browsing UI unmounted beneath it, no
control may show a ring outside that mode — `.player:not(.osd-focused) .focused`
in `ui.css` enforces it.

---

## Frontend

### `process is not defined` from guessit-js

guessit-js reads `process.env.DEBUG_*`. In Node those are harmlessly `undefined`; in a
webview the bare `process` reference throws on the **first parse call**, so the parser
appeared to work and find nothing. Fixed by a Vite `define` mapping `process.env` to
`({})` — those three debug flags are its only `process` usage.

**Lesson:** a library working under Node proves nothing about WebView2. Test in the app.

### …and that `define` value must be `{}`, not `({})`

The obvious fix has a second trap in it. esbuild requires a `define` value to be
a JS literal or an entity name, and rejects `'({})'` with:

```
Invalid define value (must be an entity name or JS literal): ({})
```

`vite dev` never validates defines, so the parenthesised form worked perfectly in
development while `vite build` — and therefore `tauri build`, which runs
`npm run build` — could not produce a bundle at all. Nothing that runs day to
day touches the failing path, so it stayed broken silently.

**Do:** run `npm run build`, not just `npm run check`, before trusting that the
app can still be shipped. `check` is `tsc + eslint` and never invokes the bundler.

### Don't swallow errors in a parser or a command wrapper

A parser that throws on every file looks *identical* to one that works and finds
nothing. Surface failures; the `catch` that hides them costs more than it saves.

### Stale closures silently use old values

`runMatch` read a `tmdbKey` captured before the key was entered, so matching fell back
to OMDb while the UI showed TMDB as active. No error, just quietly wrong behaviour.
ESLint's `react-hooks/exhaustive-deps` is set to **error** for this reason.

**Better still:** read values that matter (API keys) from the database at use time
rather than from component state.

### The webview console is invisible from outside

`src/devlog.ts` forwards `console.*`, uncaught errors and unhandled rejections to
`src-tauri/app.log`. Without it, frontend failures leave no external trace at all.

### Confirmation at the top of a long page makes a working button look dead

Settings shows one `settings-note` banner directly under its `<h1>`, and every
action on the page writes to it. That is fine near the top and useless near the
bottom: **Save commands** sat roughly 300 lines of markup further down, so
pressing it saved three settings and put "Commands saved." somewhere entirely
off screen. It was reported as a dead button and proposed for deletion, and
reading the handler is the only thing that showed it was not — there was no
error, and the state really did persist.

**Do:** when the page is longer than a screen, either put the confirmation next
to the control, or remove the need to confirm at all. The button is gone now —
the three fields save themselves on a debounce, like every other control on the
page — which is the better answer where it is available.

**And:** an explicit save button next to fields that something *else* reads is a
second trap on its own. Typing a new detect command and pressing **Detect**
without saving ran the previous one, silently. `runDetect` now flushes the
fields before invoking Rust, so the debounce is a courtesy rather than a race.

**Note** the same banner still serves the shorter sections higher up, where it
is genuinely visible from the control that wrote it.

---

## quick-xml (NFO parsing)

Two behaviours that both silently truncate text rather than failing. A
round-trip test — render an NFO, parse it back, compare — caught both; reading
real files would not have, because most titles contain neither an entity nor an
ampersand.

### An entity reference is its own event

`&amp;` does not arrive inside `Event::Text`. It arrives as a separate
`Event::GeneralRef` between two text events, so code that reads the first
`Text` and moves on turns `Fish &amp; Chips` into `Fish`.

**Do:** accumulate text across events and commit at the closing tag, handling
`GeneralRef` (`resolve_char_ref()` for `&#38;`, the name for `&amp;` and
friends) and `CData` into the same buffer.

### `trim_text(true)` trims every run, not the whole value

Combine it with the above and `Fish &amp; Chips` becomes `Fish&Chips` — each
fragment is trimmed individually, so the spaces around the entity disappear.

**Do:** leave trimming off and trim the accumulated buffer once.

### Fields belong to a depth, not a document

`<movie>` legitimately contains `<set><name>` and `<actor><name>`, and
tinyMediaManager writes a `<title>` inside `<set>`. A parser that takes the
first `<title>` anywhere gets the collection's name and searches the provider
for it. Only accept fields that are direct children of the root.

---

## Environment (Windows)

### Spawned shells inherit a stale PATH

Newly installed tools won't resolve. Refresh from the registry at the top of each shell:

```powershell
$env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
```

### Killing the app leaves Vite holding port 1420

`tauri dev` then fails with "Port 1420 is already in use". Kill the listener too:

```powershell
Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### `cargo build` fails while the app is running

The running `.exe` is locked. Stop `kinema` first. `npm run app:build`
checks for the process and says so, rather than letting it surface as a linker
error.

### `libmpv-2.dll` must sit beside the **exe**, not beside the wrapper

The plugin looks for `libmpv-wrapper.dll` in the executable's directory *and* in
`<exe dir>/lib`, so putting the pair in a `lib/` subfolder looks like it should
work. It does not: `libmpv-2.dll` is a load-time dependency of the wrapper, and
Windows resolves that through its own search order, which starts at the
**executable's** directory and never looks in the directory the wrapper itself
was loaded from.

The failure is at load, before any of this app's code runs, so there is nothing
in `app.log` — and `mpv.log` does not exist yet either.

**Do:** copy both DLLs next to the exe. `scripts/build-app.ps1` does.

**And this is why the Tauri bundler is switched off.** `bundle.active` is
`false` in `tauri.conf.json`, and it used to be `true` with
`"resources": ["lib/**/*"]` — which installs the pair into `<install>/lib/`,
exactly the layout described above. An MSI or NSIS build from `tauri build`
therefore produced an app that installed cleanly, launched cleanly, and then
failed the moment you pressed Play, with nothing in either log. Nobody had ever
run it, because `build-app.ps1` passes `--no-bundle`.

If you ever want a real installer, the DLLs have to reach the install directory
itself rather than a subfolder, and the result must be tested by *playing a
file* — an installer that starts the app proves nothing.

### Verify a Rust rebuild by timestamp

`cargo build` output is easy to misread when filtered. Compare the binary's mtime
against the source file you just edited.


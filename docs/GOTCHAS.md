# Gotchas

Every entry here cost a real debugging round. Most share a shape: **the code was
correct and simply never ran, or failed silently in a place with no visible output.**
Read this before touching the player.

An entry describes a trap that is **still there** — in a library, a system, a
tool, or the shape of this code. When the trap goes away (a fix that makes it
impossible, an upgrade, the code it lived in removed), the entry goes too, and
the story of the fix belongs in HISTORY.md. A bug that was fixed and cannot
come back is not a gotcha. Last checked entry by entry against the code on
2026-10-16.

---

## libmpv / tauri-plugin-libmpv

### `getProperty(..., 'node')` crashes the whole process

Reading `track-list` in `node` format kills the app with
`STATUS_ACCESS_VIOLATION` (0xc0000005). The node format deserialises a nested
array-of-maps across the FFI boundary; every flat scalar format is stable.

**Do:** read `track-list/count`, then `track-list/N/type`, `track-list/N/id`,
`track-list/N/lang` … as scalars. See `readTracks` in `src/player/engine.ts`.

This is a property of the *format*, not of `track-list`. Every other list-shaped
property is the same trap: `chapter-list`, `playlist`, `vo-passes`,
`demuxer-cache-state`. `readChapters` (engine.ts) reads `chapters` for the count
and then `chapter-list/N/time` and `chapter-list/N/title` as scalars, for exactly
this reason. `src/player/stats.ts` is scalars throughout; its one list,
`vo-passes`, is read as a string (below).

The crash is silent from JS — no exception, the process just dies. Symptom: exit code
5 / `STATUS_ACCESS_VIOLATION` shortly after an action, nothing in the console.

### `vo-passes` has no sub-properties

`vo-passes/fresh/count`, `vo-passes/fresh/0/desc` and the like answer "error
accessing property" on every mpv build, gpu-next included, which does measure
its passes. Unlike `track-list`, the property implements only a whole read
(`mp_property_vo_passes` refuses the sub-key action, and mpv has no generic
fallback). The stats panel read it that way for months and showed "not
reported by this VO" while the passes were there.

**Do:** read `vo-passes` in `string` format. mpv prints a node property as its
JSON (`{"fresh":[{"desc","last","avg","peak","count","samples"}],"redraw":[…]}`,
times in nanoseconds) — a flat string across the FFI boundary, not the node
format above. `parseRenderPasses` in `stats.ts`. Before reading any other list
property by index, check that it accepts sub-paths.

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

### `secondary-sid` carries over to the next file as a number

Like `sid`, mpv keeps `secondary-sid` as a track number for the next file,
where it picks whatever track happens to have that number. So it is set on
every file, `no` included, never left alone because "nothing is chosen".
Set it through `command('set', ['secondary-sid', ...])`, as with `sid` above;
the typed property API sends a double and fails.

### Observed properties are registered once, at init

Only properties in the init config's `observedProperties` ever emit change events, and
mpv initialises **once per window** (guarded on `window.__mpvInit`). Adding one later
does nothing until the app fully restarts — HMR cannot re-init mpv.

This is invisible: the new `case` looks right, nothing errors, events simply never
arrive. It cost a full round on next-episode autoplay while mpv's log proved the file
was ending (`EOF code: 4`).

**Do:** add the property to `observedProperties` in `engine.ts` and test it only
after a full restart of the app — that is how `eof-reached` is heard now. Where a
value is wanted only while something is on screen, polling with `getProperty` is
the simpler answer, and the stats panel does that (once a second, while open).

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

### Dropped frames the graphics card did not cause

`frame-drop-count` counts every frame the video output left out, for any
reason. A 59.94 fps film on a screen left at 30 Hz drops every second frame
by design: 1786 in one film, with `decoder-frame-drop-count` and
`vo-delayed-frame-count` both 0. A film decoded in software
(`hwdec-current=no`) on a slow processor reaches the output late, and the
output drops it there, so `decoder-frame-drop-count` can stay 0 even when the
decoder is the limit. Read as "the graphics card fell behind", both stepped a
player down for good (A3-03). **Do:** take the frames the screen cannot show
(film rate above `display-fps`) off before counting, and treat drops under
software decoding or with decoder drops as not the card's
(`stepDown.ts` `judgeWindow`).

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

The player used to null `timePos` and `duration` when the target changed,
with a comment explaining that this stopped the previous file's position
leaking into the new one. It does not, and cannot: **both are observed properties**, so mpv pushes
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

**Do:** gate on whether the file mpv has open is the one you think it is. In
`session.ts` that is `open`: false on a new target, true only once this file's
own position has been read — and `active` returns null until then, one check
covering the Skip button, automatic mode and the Up next offer. It lives in a
reducer, not in React state plus a ref mirror for the mpv handlers: the mirror
is how the two used to disagree for a tick.

**The flag is not enough on its own either**, and the second attempt is the
instructive one. `file-loaded` and the property pushes arrive **on one channel,
in order** (an earlier version of this entry said two channels; the plugin's
source says otherwise) — but the `file-loaded` handler is asynchronous, and
pushes keep arriving while it awaits, so the flag flipped true while the last
push still described the outgoing file.

**Do:** on `file-loaded`, *ask* for `time-pos` and `duration` with `getProperty`
rather than waiting to be told, and ignore the pushes entirely until the file
is open. Dropping the pushes alone is not safe — `duration` may only be emitted
once per file, and a dropped one never comes back.

**And ask for `path` as well.** A `file-loaded` from the *outgoing* file can
land just after the new target's reset — press Next twice while an episode is
loading — and taking its position as the new episode's is the original bug by
another route. `session.ts` refuses an `opened` whose path is not the target's
(compared case- and separator-blind; an unreadable path is let through, since
refusing it would leave the file never able to open). Seen in the mock: the
log says `file-loaded for …E03, not …E04: left alone`.

**And open it early in that handler, not late.** It was placed after
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

### A transparent window shows the desktop whenever nothing is drawn

The window is transparent so mpv can render behind the webview. The flip side:
**any moment with no opaque pixel in it shows whatever is behind the app**, and
there were three such moments, each one reported only as "the player goes see-
through for a second". Screenshots of the screen during a scripted run
(`scripts/selftest.ps1`) are how they were found; no log says any of this.

- **Before the page has painted.** WebView2 starts white, then transparent
  until the first paint. The window is now created hidden and shown by
  `App.tsx` after React's first commit (with a fallback show in `lib.rs`).
- **Before mpv's surface exists.** Initialising mpv — loading the library,
  creating the d3d11 device — takes most of a second, and it used to start
  when Play was pressed. It now starts behind Home, at launch.
- **Before a file's first frame.** mpv's idle surface is an **RGBA** image
  (`reconfig to 960x540 rgba` in `mpv.log`), so its transparent parts are
  transparent all the way through the window. `background=color` makes it
  opaque black, and `.player-cover` covers the player until `playback-restart`.

**Do:** when adding any view or transition, ask what is opaque at every instant
of it — and check with a screenshot, not by reasoning, since a white or
see-through frame lasting a few hundred milliseconds is invisible in any log.

### A screen that throws leaves the desktop, not a blank window

React unmounts the whole tree when a component throws during rendering and
nothing catches it. In an ordinary app that is a white page. Here the window is
transparent (above), so it is the desktop, complete with a player that may still
be sounding behind it, and no message, no log line about *why* the tree went,
and no way to leave but the window's own close button, which TV mode's
fullscreen does not have.

`ErrorBoundary` (`src/ui/ErrorBoundary.tsx`) is the catch, and its screen is
opaque. Two rules for it: keep it made of plain `<button>`s with their own arrow
handling, because `FocusButton` needs the spatial navigation that lives inside the
tree that failed, and never make its recovery reload the page, because mpv
initialises once per window (see "Initialising mpv twice"). Errors in event
handlers and promises do not unmount anything and never reach it; those are
`devlog.ts`'s.

**Do:** to test it, throw from a component in `dev:mock`, and revert.

### `loadfile` is asynchronous

Seeking immediately after it fails — there is nothing loaded yet. The first fix
was to decide the resume position before loading and seek on `file-loaded`. That
works, and `mpv.log` shows what it costs: every resumed file restarted at
`0.000000` and then again at the resume point, so its first frame and sound were
shown before the jump.

**Do:** pass the position *with* the load — `loadfile <url> replace -1
start=<secs>`. The `-1` is the playlist index, which mpv 0.38 put in front of the
per-file options; without it the options are read as the index.

### A Blu-ray disc opens only as `bd://`, and its failures are only in the log

`loadfile <disc.iso>` and `loadfile <disc>/BDMV/index.bdmv` both fail with
nothing but `end-file` reason `error` (Windows libmpv, 2026-10-17). What plays
a disc folder or an image is `bd://` with the `bluray-device` option set to
it — through `set`, a plain string, rather than the per-file options, where a
comma in a folder name would need quoting. Two things follow:

- **mpv's `path` is then `bd://`**, never the disc. Anything comparing the
  open path with the file it meant to open (`samePath`) refuses it, and the
  file never counts as open. `openPath` in engine.ts answers with the disc's
  own path instead.
- **Why a disc did not open is not in any event.** An encrypted disc gives
  the same bare `error` as a missing one; the reason is a log line,
  `[e][bd] AACS encryption detected but cannot find libaacs.` (Windows) or,
  where libaacs is installed but cannot decrypt, `[e][bd] AACS error: …`
  (Ubuntu), with libaacs's own words on stderr, not in the log. `disc.rs`
  reads it from the end of `mpv.log`, waiting up to a second, since mpv
  writes the log from a thread of its own.

A Blu-ray `.m2ts` played as a file has **no track languages and no
chapters**: they are in the disc's CLPI and MPLS files. Played as `bd://`,
libbluray supplies both. A loose clip with its CLPI still beside it gets its
languages from there, joined on mpv's `src-id`, which for a transport stream
is the PID.

### Initialising mpv twice corrupts native state

React StrictMode double-invokes effects and HMR remounts components; either can call
`init()` against a live instance and take the process down. The guard lives on
`window` (not module scope — Vite replaces the module on HMR). StrictMode is
deliberately **off** in `src/main.tsx` for this reason.

### Subtitle file names are not always the film's, exactly

mpv's `sub-auto=fuzzy` takes a subtitle file whose name contains the
film's. A release's own subtitle file said `7. 1` where the film said
`7.1`, and was never offered — on Android, which took the same rule
(`subtitle_files.rs`), or on the desktop. **Do:** compare the names with
spaces, marks and capitals left out, and hand mpv the files its own search
misses (`addSubtitlesBeside` in engine.ts) — not the others: a file handed
over that mpv also finds itself is listed twice, and loses its language.

### A subtitle file mpv finds itself is titled by the end of its name

For `Film.en.srt` beside `Film.mkv`, mpv's `track-list/N/title` is `en.srt`
— the part after the film's name, not the whole name — and `lang` is `en`.
The mock gave the whole name, so a check for "title equals the file name"
passed every test and the real app still printed "English · en.srt ·
separate file" (cost a rebuild, 2026-10-30). Only short codes reach `lang`:
`Film.English.srt` comes with none. **Do:** read `external-filename`, drop
a title the file name ends with, and read a spelled-out tag yourself
(`trackLanguage` in tracks.ts).

### A track mpv cannot decode is dropped, and only the log says so

On Linux mpv uses the system's own codec libraries, and some systems' builds
leave formats out (Fedora's `libavcodec-free`: no HEVC, no E-AC-3, H.264 only
through OpenH264). mpv logs `Failed to initialize a decoder for codec 'hevc'`,
deselects the track (`vid` reads `no`) and plays on: sound and a black
window, or a picture and silence. To the player that silence looked exactly
like a sound output that refused to open, so it ran the output fallbacks and
said "playing in stereo" for a track nothing could decode. And the screen
switch waited its full 15 s, paused, for a first frame that could not come
(review 2026-11, A3-01/02/05).

A decoder can also open and then fail on every frame (10-bit, interlaced or
8K H.264 through OpenH264): the track stays selected, `vo-configured` stays
`no`, and no property counts the errors.

**Do:** read `decoder-list` as a **string** (JSON, like `vo-passes`; never the
node format) and look for the track's `codec`. For the decoder that turns out
nothing, read `reader-pts` from `demuxer-cache-state` (also a string): with no
picture it races to the end of the file within a second or two, where a
decoder that works holds it within a fraction of a second of the position
(also over an `smb://` share or `http://` with mpv's cache on: read-ahead
moves `cache-end`, not `reader-pts`).

**But not on one read.** A recording cut mid-GOP, through a full ffmpeg,
skips to its first keyframe: the position reads 0 while the reader is
already 6 s ahead, for a few milliseconds before its picture, and a full
ffmpeg logs decode errors for it too, so counting errors does not separate
the two cases either. Believe "no frames" only once it has held, still with
no picture, for 3 s. `decodeCheck.ts`.

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

### A picture outside the asset scope renders as nothing

The page may load pictures only from the asset protocol's scope,
`$APPDATA/artwork/*`. A file written anywhere else gets a perfectly good
`convertFileSrc()` URL, the image simply never shows, and nothing is logged.
That is why the frames taken from videos live in `artwork/` as
`frame-<id>.jpg`, beside the posters, and not in a folder of their own (which
would also need `/**`, see above). Put any new kind of picture there.

### The content security policy refuses things without a word

`tauri.conf.json` sets a CSP: scripts from the app only, images from the app,
the artwork cache (`asset:` / `http://asset.localhost`) and any `https:` host,
IPC through `ipc:` / `http://ipc.localhost`. Anything else is refused by the
webview **with no error in the app** — a blocked poster is a missing poster, a
blocked script is a feature that never ran. `devlog.ts` listens for
`securitypolicyviolation` and writes each refusal to `app.log`, so the first
place to look after adding a new kind of resource is there. `devCsp` is null:
Vite's dev server needs inline scripts and a websocket, and `dev:mock` runs in
an ordinary browser anyway.

Images are allowed from any `https:` host on purpose. TMDB, TVmaze and OMDb
each serve posters from hosts of their own choosing, and an image cannot run
code — the policy's job is scripts.

### A command without `async` runs on the window's thread

`#[tauri::command] pub fn …` executes on the **main thread**. While it runs
the window cannot repaint or move and every other command queues behind it.
Nothing errors; the app just freezes, and a NAS waking from sleep makes that
freeze seconds long. Anything that reads beside the media or starts a program
is `async` and goes through `jobs::off_main` (see `jobs.rs`). Quick database
commands stay synchronous on purpose — the main thread serialises them, and
that ordering is what keeps a `save_progress` ahead of the Home reload that
follows it.

**One stat call is enough.** A share that goes *silent* (a NAS switched off at
the wall, a laptop off its Wi-Fi: connections open, nothing answering, nothing
refused) holds every call to it until Windows' SMB client gives up — about
three minutes. Four plain `fn` commands looked at the film's file
(`disc_source` on every open, the loose-video saves every 5 s, `save_progress`
at the end, `playable_path` on a drop) and the window sat "Not responding" for
up to 3 min 5 s; a second Kinema started meanwhile hung too, invisibly, as the
single-instance hand-over waits for the same thread. `off_main` alone is not
enough either: the look never comes back, so each call would leave one more
stuck thread. **Do:** look at a film's file through `files::within(path, wait,
…)`, which gives up after `wait` and starts no second look at a path whose
first is still stuck; say `files::NOT_ANSWERING` when it gave up. A command
that must stay synchronous for its order (`save_progress`) waits at most
half a second, far below the five seconds after which Windows calls a window
not responding. The single-instance callback runs on the window's thread
too: it hands the look to a thread of its own.

---

### The page's process can end and nothing says so

The whole interface runs in one process of the web engine. On a computer short
of memory the kernel kills it (seen on 3.7 GB with 4000×6000 posters), and it can
crash. Nothing in the page can notice, being gone; Tauri does not hear of it.
Kinema went on running with the last picture on its window, as if frozen, for
as long as anyone waited. **Do:** listen to each engine (`page_life.rs`):
WebKitGTK's `web-process-terminated`, WebView2's `ProcessFailed`, Android's
`onRenderProcessGone`. The kernel's kill reads as `Crashed`, not as a memory
reason, so words to the person cannot claim the cause.

- A reload brings up a page that knows nothing, over an mpv that never stopped:
  the film's sound goes on, and `window.__mpvInit` is gone. `init` on a live
  instance is harmless in plugin 0.3.2 (it returns), but loading the mouse
  script again would double every click: ask `mpv_started` first. The new page
  reads what mpv has open and reopens it there (`pageRecovery.ts`).
- WebView2's *browser* process ending cannot be reloaded from: only a new Kinema. `app.restart()` on the main thread skips the exit event that frees the single-instance lock, so the new one found it held and left, and Kinema simply closed. It showed only in a real release build, not under a self-test (no lock there): free the lock first (`tauri_plugin_single_instance::destroy`).
- Android: not answering `onRenderProcessGone` has the system kill the whole
  app, and answering means that WebView may never be used again. Tauri cannot
  replace it, so Kinema starts anew (`PageGone.kt`). `RustWebViewClient` is
  written out by wry's build and final: the one way in is wry's
  `WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION`, in `.cargo/config.toml` **at the
  project root**. In `src-tauri/.cargo/` it was silently not applied: no error,
  the method was just not in the generated file.
- To test without root on the emulator: `Page.crash` over the debugging channel.
  Killing the renderer by hand needs a rooted image, which a production one is not.

## SQLite

### WAL does nothing with only one connection

`db.rs` has enabled `journal_mode=WAL` since the beginning, with a comment
saying it "keeps reads from blocking the scan writer". It did not, because
there was a single `Mutex<Connection>` for the whole app and the scanner held
it for the entire walk. WAL lets *separate connections* read while one writes;
a mutex around one connection serialises everything regardless.

**Do:** give the scanner its own connection (`ScanDb`). The mutex then only
serialises access to each connection, and SQLite does the rest.

### A blocking dialog in `setup` never appears on Linux

`app.dialog().message(…).blocking_show()` inside `setup` runs on the main thread. On
Windows and Android the dialog has a loop of its own and works. On Linux the plugin's
dialog is drawn by the GTK loop that the main thread runs, and the main thread is
blocked waiting for it: no window, no error, Kinema hangs with nothing on screen
(the main thread sits in a futex wait). Every start-up message had this since Linux
support began. **Do:** `startup_dialog::tell` / `ask`, which run a GTK dialog
directly on Linux. **And when testing it in WSL:** set `GDK_BACKEND=x11` and a
private `XDG_RUNTIME_DIR` beside `DISPLAY=:N`; with only `WAYLAND_DISPLAY` unset,
GTK still finds WSLg's socket and the window opens on the desktop of whoever is at
the computer.

### A dialog in `setup` spoils the page's start (Linux, Android)

The GTK loop a Linux dialog turns also runs the webview: the page starts while the
dialog waits, before `setup` has managed the library, and every call it makes fails
("state not managed for field `db`"). After "Put it back" the window showed those raw
errors over Welcome, as if the library were gone. On Android the page stayed black
until Kinema was started again. Windows waits and starts well. Nothing in the tests
showed it: the dialogs were checked, not the page behind them (seen on the Linux test
PC and the emulator before 0.15.2). **Do:** `setup` reloads the page once a
start-up dialog was shown (`startup_dialog::any_shown`), off Windows.

### Swapping a WAL database's file leaves its log behind

`library.db` in WAL mode has `library.db-wal` and `library.db-shm` beside it. Put
another file in the place of `library.db` and leave those, and SQLite may apply
the old log to the new file: a restored library that is silently damaged, or
silently missing what the log held. A crash leaves the log behind; a clean
close usually removes it, which is why "replace the file by hand" works nearly
every time and is worse for it.

`backup::swap_in` moves the logs aside and renames the copy in, before anything
opens the library. Moves and not deletes, in that order: on Windows a program
holding a log open refuses a delete just as it refuses a rename, and deleting
the library first and meeting that refusal second left no library and a message
saying "not changed" (2026-11). Copying the database out of a *running* app has the reverse
trap, and it is why every copy here is `VACUUM INTO` and never a file copy (see
`backup_before_upgrade`).

### A folder that fails to list is not a folder with nothing in it

A walk that carries on after a failed listing, then marks what it did not see as
missing, hides everything under that folder because of a permission or a dropped
connection. **Do:** keep what could not be read (`Unread` in `scanner.rs`) and let
`mark_missing` touch nothing under it. The same trap one level up: a disk not mounted
leaves its folder there, empty, so a folder empty where it held videos is left alone
too. A mount point removed with the disk cannot be told from a deletion by listing: it
is hidden and said with a count, never called deleted (HISTORY).

### `busy_timeout` is load-bearing the moment there is a second connection

SQLite allows one writer at a time. With two connections, a write that arrives
while another is committing fails **immediately** with `database is locked` —
it does not queue. `save_progress` fires every five seconds during playback, so
watching something during a scan would silently lose resume points.

**Do:** `conn.busy_timeout(…)` on every connection. Use the rusqlite method
rather than `PRAGMA busy_timeout`, which returns a row and so cannot go in an
`execute_batch` (`PRAGMA journal_mode` is the same).

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

### A WAL database's mtime is not its version

Following from `immutable=1` above: `skiptro.db` can go untouched through a
scan that adds hundreds of rows, because they land in `skiptro.db-wal`. Any
cache keyed on the main file's size and mtime looks completely correct and
never notices new data — the same shape of bug as a cache key that leaves out
the video itself (Library and intro detection, "A file that is still
arriving").

**Do:** stamp the `-wal` file too. `skiptro::version_stamp` covers both, and
there is a test that fails if the `-wal` is dropped from it.

---

### A file with no title fails a whole query that reads `title_id` as a number (2026-11-01)

Since round 6 a file can stay in the library with no title (kept unmatched,
a video). `r.get::<_, i64>` on its `title_id` is "Invalid column type Null",
and inside `query_map(...).collect()` one such row fails the whole query:
measuring pictures stopped for the whole library, and the Continue rail's
last-watched query would have the same way after an unmatched episode is
watched to the end. Tests had no such row, so nothing failed. **Do:** a
query over `media_files` that reads `title_id` as a number says
`AND m.title_id IS NOT NULL`; a test library has one file with no title.

---

### `PRAGMA optimize` before the data exists makes the statistics worse than none (2026-11-13)

The scan ran `PRAGMA optimize` straight after the file walk, when no new file
had a title yet. SQLite recorded every file as sharing one title
(`idx_media_title 5000 5000`), so the title index looked useless. For each
title's counts the bundled SQLite then read the whole `media_files` table
(`SCAN m`; Python's SQLite, without STAT4, chose `idx_media_files_missing`,
which matches every file — the same cost): Home read every file once per
title, 11.4 s at 5000 titles, 51 ms with statistics that know the titles.
Nothing ever fixed it: `PRAGMA optimize` re-analyses a table only when its row
count changes a lot, and matching changes no counts. A second trap hides a
fix: an `ANALYZE` on one connection does not reach another — each loads the
statistics once, so the window's connection keeps the old ones until restart.
Measure in the bundled SQLite too (a Rust test): Python's picks other plans.
**Do:** take statistics
only once the columns the indexes cover have their real values
(`db::refresh_statistics_if_stale`, after matching); then `ANALYZE
sqlite_schema` on every other open connection (`db::reload_statistics`). The
tests in `db.rs` reproduce the poisoned plan in the bundled SQLite.

## Library and intro detection

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

**…but a size check alone misses the commonest download.** Preallocating
clients, and most torrent clients' sparse files, create the file at its final
size and fill it in, so its size never changes and the rule above never fires.
What does change is the mtime, *while* the data lands. So `save_progress`, at
the moment a save would mark a file watched, stats it and declines if it was
written to in the last two minutes. That is safe in the other direction: a
finished file stops changing, so it would have to have been modified during
the viewing to be held back.

**Do:** when a cache key claims to cover "everything that could change", check
whether the file itself is in it. Two of the three above were the same omission
at different layers.

### A renamed file is a new path, and a new path was a new file (2026-11-08)

Every row is found by its exact path (`WHERE path = ?1`, binary), so a rename —
a change of capitals on Windows too — made a new, empty row, and what was
decided by hand stayed on the old one, now missing (review 2026-11, finding 4).
`following.rs` now pairs them. Three things in it are easy to undo by accident:

1. **Pair after every library folder is walked**, never inside `scan_root`. A
   folder marks its missing only at its own end, and a file moved from one
   library folder to another is new in the second before it is missing in the
   first. A library folder left with no video at all hides nothing (an
   unmounted disk looks like that), so files moved *all* out of one are not
   missing there and cannot pair; a test that empties its folder proves nothing.
2. **Anything said about missing files waits for the pairing.** "videos gone: 3"
   was pushed by `mark_missing`, so a renamed folder of three episodes read as
   three episodes gone on Home. The lines are kept with their rows
   (`gone_lines`) and said in `scan_all`, less what was followed.
3. **One against one, or nothing.** Same size and time, else same size and name;
   two candidates either way and the file is new. Loosening this (a "best"
   candidate) hands one film's watch history and hand match to another.

### A season is not a folder

`analyse.rs` compares every episode of a season against every other, so how the
episodes are grouped *is* the algorithm — a group of one finds nothing, in
silence, and looks exactly like a show with no intro.

The obvious grouping is the containing directory. It is wrong on real libraries:
one real library's season had ten episodes in a `Season 1`
subfolder and two still loose in the show folder above it, because a renamer
moved some and not others. Grouping by folder would have compared ten against
each other, then two against each other, and quietly produced worse markers for
the two.

**Do:** group on `title_id` when the file is matched and `parsed_title` when it
is not, plus `parsed_season`. Falling back to the parsed title is also what lets
detection work on the Needs attention queue, which is the one thing no other
marker source can do.

---

### A fix to the matcher's ties can move a match that was right by luck

Comparing raw scores instead of scores held to 1 fixed ties like "The Courier"
2020 against 2019, and every unit test passed. The dry run on a real library
showed one film that had been matched right *because of* the clamp: its file
said 2020, the film is 2019, and TMDB also holds a same-name stub dated 2020.
Clamped, the two tied and popularity chose the film; raw, the exact year
(0.12 against 0.04) chose the stub — a wrong match, no error, the poster just
a different one. Now an entry of the same name a year off that has ten times
the votes *and* three times the popularity goes first (`score.ts`). Any change
to scoring needs the dry run against a real library's answers, not only
tests: compare every matched file before and after.

### guessit reads a bare folder name as an episode

With the type hint `episode`, `Staffel 1` is `{title: "Staffel", episode: 1}`,
`Disc 1` the same, and `24` is `{episode: 24}` with no title at all. Nothing
fails: the folder's word becomes the show's name, every show laid out that way
becomes one group, and the folder's number can become the episode. **Do:** ask
`isSeasonFolder` (`parse.ts`) before giving a folder to guessit. It and
`util::is_season_folder` in Rust are tested against one list,
`src/library/seasonFolderNames.json`; add a word to both, and to the list.

### A rule change does not reach a file that is already matched

`reask_after_new_rules` re-reads refusals and untitled files only, once per
`MATCHER_RULES`, and never a held or ignored file. A file matched wrongly under
older rules keeps that match, with nothing saying so. Tests of the matcher pass
and a real library looks unchanged: to see a fix on a library, look at its
refusals, or use the dry run in `notes/tools/review/l1-dryrun.test.ts`.
`reset_parses` (developer tools) is not the way out: it clears hand matches too. Since
round 8 L3, "Worth a look" lists such files once per `MATCHER_RULES` for a
person to decide; bump `MATCHER_RULES` for a parser or scorer change, or it
reaches neither refusals nor matched files.

### A stored reading is not what today's parser would make of the name

`parsed_title` was written by whatever parser version scanned the file. Comparing
it with today's reading to find "files the new rules read differently" listed a
third of the real library's candidates for nothing: an older parser wrote a
series' name without `Part 2` for a file correctly linked to Part 2. No error,
just a list asking people about right matches. **Do:** ask whether today's
reading would still take the linked title (`worthALook.ts`, `stillTakes`), not
whether the words changed.

### guessit reads a word before a hyphen as a release group

`Spider-Man.2002.1080p.mkv` is `{release_group: "Spider", title: "Man"}`, and
so are other names that start with a hyphenated word (not all of them). Nothing fails: the title is wrong and
the match may still pass on similarity. Since a file's own name outranks a
release folder's (round 8 L1), more files are read this way.
`Spider-Man.Across.the.Spider-Verse` reads right. **Fixed** (`withHyphenedTitle`
in parse.ts): a group whose name and a hyphen start the file name, followed by
the title's first word, is put back into the title. Except when the file's folder
names that group (`blow-film.2016.mkv` in `Film.2016…-BLOW`): a scene file named
after its group, which a first version of the fix turned into "blow-film" on a
real library. A group at the end and `[GROUP]` in front are untouched.

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

### Cover art is a video stream

MP4 and Matroska carry a poster as a *video* stream flagged
`disposition.attached_pic`, and in an MP4 it is often stream 0. "The first
video stream" is then a 600×900 JPEG, and `-select_streams v:0` decodes the
poster rather than the film — which has no HDR10+, no Dolby Vision RPU, and
reports neither missing. **Do:** skip `attached_pic` streams, and select the
film by its absolute index (`-select_streams 3`), as `probe.rs` does.

### `cropdetect` ignores the first two frames it is given

Its `skip` option defaults to 2. Fed one or two frames — one keyframe per
sample point, as `aspect.rs` does — it prints nothing at all and exits 0, and
every file measures as "no answer". **Do:** `skip=0`.

**Also:** with `-skip_frame nokey`, a seek past the file's last keyframe
yields no frame either, which on a short clip with one keyframe is every seek
but the first. Test clips need `-g` set.

### ffprobe's `vdr_in_max` is one fixed-point number

A Dolby Vision RPU stores `vdr_in_max` as an integer part and a fraction;
ffmpeg joins them into one number with `coef_log2_denom` fractional bits. So
the "1.0" that marks a minimal enhancement layer (MEL) is printed as
`8388608` (`1 << 23`), not `1`. A check for `vdr_in_max == 1` calls every MEL
disc FEL.

### Your ffmpeg may not write Dolby Vision, and says nothing

To make a Dolby Vision test clip, `-x265-params dolby-vision-profile=8.1:
dolby-vision-rpu=rpu.bin` is the documented way. With an x265 built without
Dolby Vision support — the one in gyan.dev's ffmpeg build, for one — it
encodes a perfectly good HDR10 clip, exits 0, and leaves the RPU out. Check
the result with `ffprobe -show_frames -read_intervals %+#1` before trusting
it. What worked instead: encode plain HEVC to a raw `.hevc`, append the RPU as
a NAL unit of type 62 (`00 00 00 01 7C 01` + the RPU) after each picture's
slice, and remux; ffprobe then reads it as a Dolby Vision stream.

---

## Spatial navigation (D-pad)

Every entry below is invisible with a mouse. Hovering re-establishes focus and
clicking reaches anything, so the UI tests perfectly on a desk and is unusable
from a sofa. **Test D-pad changes with the mouse physically untouched.**

Entries marked **(before round 7)** describe the spatial library
(`norigin-spatial-navigation`) that Kinema moved by until round 7 — removed in
F4, 2026-10-31. They are kept as history: what it measured, when it updated
itself later, and the timers that corrected it are all gone, and Kinema's own
engine (focusStore.ts, focusModel.ts) gives each one's right answer by
construction (focusModel.test.ts has the cases). The unmarked entries still
apply.

### A focus key that changes is never registered (before round 7)

`useFocusable` registers a control with the spatial library **once**, when it
first mounts, under whatever `focusKey` it had then. Later renders call
`updateFocusable` with the *current* key — so if the key has changed, the
update goes to a key that was never registered, and the control keeps the
`onEnterPress` it was born with. Nothing errors; OK simply does the old thing.

`ConfirmButton` walked into it. Arming swaps its button for a Fragment holding
the confirm button first, and React keeps that first button as the same
instance. Given a `focusKey` on the unarmed button only, the key changed from
set to unset under a mounted control — and the second press armed again
instead of confirming. **Do:** keep a control's `focusKey` the same for its
whole life, or give it a React `key` so a different key means a new control.

A list whose items move does it too. Settings' search keyed each match by its
setting and its focus key by its place (`settings-search:0` for the first);
typing "r" put the OMDb key 37th, typing on to "rotten" made it first, and
React kept the button — still registered as the 37th. `setFocus` on the first
match then found nothing and the ring vanished. **Do:** when the focus key
follows the place, put the place in the React `key` as well.

### Focus cannot travel up into an overlay nav (before round 7)

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

### `useFocusable` reads the context of the component it is *called in* (before round 7)

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

### Focus parked on an unmounted component is silent death (before round 7)

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

**Closing a panel that holds focus: move focus out first.** Setting focus on
the opener *after* the panel closes loses — the library's own restore fires
300 ms after the unmount and lands on the parent's preferred child. The
player's track panel sent the ring to Pause this way. `closeTracks` and
`closeStats` in `usePanels.ts` aim at the opener while the panel still exists,
so there is nothing left for the library to restore.

"First" means *finished*, not *called*: `setFocus` is asynchronous, and the
library only records the new key when it completes. Unmount the focused
control in the same tick and, under load, the library still counts it as
focused — so it schedules the restore *after* `setFocus` has cancelled any
pending one, and 300 ms later the ring leaves the opener. Home's scan notice
lost its ring to the next notice's Choose this way, about one OK in four with
the machine busy, never on a quiet one. `dismissScanTrouble` in `Browse.tsx`
removes the notice in `setFocus(…).finally(…)`, and the player's panels close
the same way (`closeOnto` in `usePanels.ts`, which skips the close when the
panel was opened again meanwhile). Found only by running the flow 30 times
over 12 workers.

### …and a claim that succeeds can still be overwritten (before round 7)

`useClaimFocus` did all of the above and a remote was *still* dead after every
launch — found by `npm run dev:mock`, with the mouse untouched. Two library
behaviours, neither visible in its API:

- When a focused component unmounts, norigin restores focus to its **parent**,
  **300 ms later** (`AUTO_RESTORE_FOCUS_DELAY`). When a whole view is replaced,
  that parent has unmounted too. And `setFocus` is itself asynchronous, so a
  claim started by a view about to disappear — the first-run panel, shown for
  the instant before titles arrive — can finish after the next view's claim.
  Either way the last word goes to a key that no longer exists.
- A view that comes back re-registers its controls under the **same stable
  keys** (`hero-play`). The dead key the system was left holding then "exists"
  again, `doesFocusableExist` says yes, the view skips its claim — and no ring
  is drawn, because the new component was never told it is focused. Coming
  back from the player landed there.

**Do:** judge liveness by what is on screen — no element has the `focused`
class — not only by the key; look again after the restore window
(`SECOND_LOOK_MS` in `src/ui/focus.ts`); and keep the watchdog there, which
spends a navigation key pressed onto dead focus on putting focus back on the
current view's landing spot. It logs `focus: recovered …` when it fires, so a
new route into this state shows up in `app.log` instead of as a dead remote.

### A page's claim takes the ring back after a return has finished (before round 7)

Back from the player to the Folders page put the ring on the first file, not
the film just played. No error: the return worked, and then the page's own
claim (`useClaimFocus(…, page = true)`) took the ring again at its second look,
about 450 ms later, once `returnFocusTo` had finished.

**Do:** a page that claims focus must claim nothing when a return was pending
as it mounted (`hasPendingReturn` at mount). And key the claim per level, here
a small `Landing` component with `key={level}`, so each folder gets its own
count of "has the person pressed anything since arriving".

### `scrollIntoView({ block: 'nearest' })` is a no-op once on screen (before round 7)

Which is what you want almost everywhere, and wrong for the top row. Arrowing
down through the rails scrolls the page; arrowing back up to the hero reveals
nothing, because the hero's buttons are already visible — so the page stays
where the rails left it, with the hero cropped and the nav floating over half an
image. The top row is the one place where the correct scroll position is
absolute, not relative: see `scrollPageToTop` in `src/ui/focus.ts` and
`keepInView="page-top"`.

The bottom of a page has the mirror problem: `nearest` stops once the last
control is visible, so text under it (a card's year, the notes under the last
setting, the credits at the foot of Settings) stays below the edge with nothing
left to press. `keepOnScreen` in the same file goes to the very bottom when
everything below the control fits on screen with it. Use it, not a bare
`scrollIntoView`, for anything focusable in the browsing views.

### A scroll between two presses sends focus backwards (before round 7)

Holding Down in Settings bounced focus from a text field back up to a button
above it, and at the bottom of the page flipped it sideways between the two
buttons of the last row.

norigin re-measures the **current** control on every press, but reuses a
sibling's position if it was measured less than 16 ms ago
(`LAYOUT_STALE_TIME`). With `useGetBoundingClientRect` those positions are
relative to the viewport, so a scroll between two measurements moves them.
Under key repeat, a press compared the current control's new position with
its neighbours' old ones: a button *above* measured as *below*, or the one
beside it did, and Down went there. The first case came from `input.focus()`,
which jumps the page to the input at once — 746 px in the mock. Stopping that
jump was **not enough**: a smooth scroll catching up with a held key moves the
page 50+ px a frame, more than a button is tall.

Found by logging every focus change with its time and scroll offset (a
`MutationObserver` on the `focused` class) and holding a key at repeat speed.
At one press every 150 ms or more it never happens, because every sibling is
stale by then and gets re-measured.

**Do:** keep `throttle` in the `initSpatial` call in `src/ui/Browse.tsx` above
16 ms. Presses further apart than the cache lasts always re-measure every
sibling at the same instant as the current control, whatever is scrolling.
It is a correctness setting, not a feel setting — lowering it to "make
holding a key snappier" brings this back.

**And** keep `throttleKeypresses: true` beside it. Without it every key-up
**cancels** the throttle, so it only ever spaces out a key held down in one
unbroken press. The first attempt at this fix set `throttle` alone and changed
nothing in the mock, whose key repeat — like many remotes' — is a stream of
separate down/up presses.

### Focusing a container picks its "first" child by stale positions (before round 7)

`setFocus` on a container with no remembered child goes to the child nearest
the top-left corner — by `|left| + |top|` of the positions norigin last
measured, not where the children are now. The first setup page mounts while
the page is still scrolled the way the welcome page left it, and its rows
were measured at different scroll offsets: on CI's Linux WebKit, and here in
any window shorter than about 560 px, the ring landed on the second row. It
passed every time at full height on Windows.

**Do:** when focus has to land on a container's first control, put the page
where it will be first, call `updateAllLayouts()`, and only then `setFocus`
(`SetupPages.tsx`, `landOn`). And run a keyboard flow that lands this way in
a short window (`page.setViewportSize`), where the scroll makes it fail.

### A control drawn a moment after its neighbours is skipped by Up (before round 7)

Found 2026-10-17 with Trakt's resume row in Settings → Keep track of what I watch. The row read
its setting itself and appeared a few milliseconds after the Disconnect button
under it. norigin had measured Disconnect where it was before the row pushed
it down, so Up from Disconnect sometimes went past the row to the section
above — about one run in three in WebKit, never with a mouse.

**Do:** read what a group of controls needs together and draw them in the same
render (`AccountSection.tsx` reads the switch with the account's status), rather
than letting one fetch its own data after the rest are on screen. A keyboard
flow that moves onto such a control straight after it appears catches it;
repeat it (`--repeat-each`) before calling it passing.

### Focusing an empty container draws no ring anywhere (before round 7)

`setFocus` on a container with no focusable children focuses the container
itself. Containers render no `focused` class, so there is no ring, and every
arrow press goes nowhere — the watchdog in `focus.ts` "recovers" onto the
view's landing spot, which descends into the same empty container again. The
Keep track of what you watch setup page in a build without SIMKL's or Trakt's app and without an
OpenSubtitles key (every build but a release) has nothing to press: two
seconds after arriving the ring vanished for good, and the box's log said
`recovered from a dead focus key onto setup-pages` fifty times a minute.

The same silence comes from `setFocus` on a key nothing has registered: the
library holds that key, on purpose — the control is focused when it
registers (`focusOnPresetKey`), which Home's landing relies on — so a claim
for a button that is never drawn leaves focus on nothing.

**Do:** a container whose content can turn out empty is `focusable` only
while it has a control (`SetupPages.tsx`, `PageBody`), and a claim's `ready`
is true only when its control will be drawn (`AccountSection`'s Connect
needs `status.available`, not just a status).

### A container that renders nothing is still a place to move to (before round 7)

`useFocusable` registers the component whether or not its `ref` is ever
attached. A rail that returns `null` when empty — Continue Watching with
nothing to continue — stays in the tree with no element, and the library
then measures it at the screen's top left. Usually something else is closer;
with the scan's notice pushing Home down a few rows, Up from Play chose the
empty rail over the top bar, and the ring vanished.

**Do:** pass `focusable: false` while the component renders nothing
(`ContinueRail`, `Rail`, `HomeNotices`). An early `return null` after
`useFocusable` is the pattern to look for.

### The library's own restore counts as "something live holds focus" (before round 7)

A page that waits for its data before claiming focus — a series' page waits
for the next episode, so Play exists — gives the library's
`AUTO_RESTORE_FOCUS_DELAY` time to act first: the button that opened the
page is gone, and 300 ms later focus is restored to whatever the library can
find, the top bar. That is a live control with a ring, so the page's claim
stood aside and the page opened on Home's tab.

**Do:** a whole page passes `page` to `useClaimFocus`: it then claims when
ready unless the person has pressed, clicked or moved anything since it
arrived. Never for part of a page — data arriving while the person browses
the list beside it would pull the ring out of their hands.

### A press nothing answers goes to the parent — and from there anywhere (before round 7)

When a group's resolver (or the library's own search) finds nothing that way,
the press is handed to the group's parent, and on up. In the player that
reached the page behind it: Up or Left from Back put focus on a control that
was not drawn, and the ring vanished until the next press. Returning `null`
does **not** mean "stay". **Do:** say which arrows a group holds with
`isFocusBoundary` plus `focusBoundaryDirections` (`stopAt` in
`useFocusGroup`); a held arrow with nothing that way leaves focus where it is.
A row holds Left and Right, the player and a page of its own all four.

### A panel that is not a closed group shares Down with the controls behind it (before round 7)

The player's details panel ("Stats for nerds") failed a WebKit test about one
run in twenty-five: Down from one group of facts to the next sometimes landed
on **Pause**. The panel's groups had no group of their own, so they and the
player's controls were all siblings, and Down chose between "the next group"
and "Pause" by distance. While the panel was still smooth-scrolling the
previous group into view, the next one could measure farther away than the
control bar. Nothing failed; the ring just left the panel.

**Do:** any panel drawn over the player or a page is `useFocusGroup('menu')`
with its own `FocusContext.Provider`, as Audio & subtitles is. Inside a menu
the group's own resolver measures only the panel's children, at the moment of
the press, so nothing behind it is a candidate whatever is scrolling.

### A focus zoom can swallow the gap to the control below it (before round 7)

Continue Watching's **Remove** sits below its card precisely so Down reaches it
— and Down never did. The card grows to 105% when focused, and the spatial
library measures the **scaled** box: the focused card's bottom edge ended 1 px
below Remove's top, so Remove never counted as "below" and Down jumped to the
next rail. The layout was right; the zoom ate a 4 px gap. Found by reading
`focusableComponents[key].layout` in the mock, not by looking.

**Do:** keep the gap to any neighbouring control larger than the zoom grows the
focused element (half the scale excess of its size, per side), in `rem` so it
holds at TV scale. And do not let a container of a card-plus-secondary-control
`saveLastFocusedChild`: arriving should land on the card, not on Remove
because it was touched last.

Sideways it is worse, because nothing looks wrong. Settings' Add movies folder,
Add TV folder and Scan now sat edge to edge, and the focused one's 106% zoom
covered the middle button entirely, so Right went straight from the first to
the third. The row had lost its `gap` (below). **Do:** every row of buttons
needs a real `gap`, not buttons that happen to touch.

A gap is not enough on a **wide** button, because a share grows with its size:
a title page's Version button, as long as a release name, grew nearly 30 px a
side at 106 % — three times the row's gap — and the button to its right
painted over its ring (every `.btn-secondary` has `backdrop-filter`, so each
is its own layer, drawn in page order). **Do:** a highlighted control gets
`position: relative` and a `z-index`, and a button's growth is capped at a
fixed amount: `scale(min(1.06, calc(1 + 0.75 / var(--w, 1))))`, where `--w`
is its width in rem, set by `noteWidth` in `FocusButton` when the highlight
arrives (CSS cannot read an element's own width).

### A control overlaid on a card is unreachable, wherever you put it (before round 7)

The corollary of "Focus cannot travel up into an overlay nav" and the focus
zoom above, and the one that decides layout. Spatial movement is geometric, so a button drawn *inside* another focusable's rectangle
— a ✕ in the corner of a card, a badge on a thumbnail — cannot be reached from
it in **any** direction: right needs the candidate's left edge past the current
right edge, up needs its bottom edge above the current top edge, and an overlay
satisfies none of them by construction.

So the position of a secondary control is a navigation decision before it is a
visual one. Continue Watching's **Remove** sits *below* its card rather than in
the corner for exactly this reason — and below rather than beside, because in a
horizontal rail a sibling to the right doubles the presses needed to travel the
rail, while one below is reached by Down and costs nothing.

### Two focusables inside one row need a container, not adjacency (before round 7)

The same geometry that stops focus reaching an overlay nav stops it reaching a
control drawn *inside* another focusable. Going right requires
`sibling.left >= current.right`; a button rendered within the row's own
rectangle can never satisfy that, so adding a second `useFocusable` next to the
row's produces a control that renders, styles, hovers and clicks — and that a
D-pad simply cannot reach. Identical symptom to a bare `<button>` (below), and
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
answers nothing, which looks exactly like the dead-key hang above.

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

**Since round 7 (F4):** the other handler is the focus engine's, and the
switch is the player's screen taking no keys while watching (`FocusScreen
keys={osdFocus}`, Player.tsx); the seek bar keeps Left/Right through the
engine's `onArrow`. The rest of this entry is how it was done before.

**Do:** make exactly one of them live at a time. `pause()` and `resume()`,
exported from the spatial navigation package, are the switch — the player starts
paused so arrows seek, and `resume()`s only once Up or Down brings the controls
up. The player's own handler then has to `break` on every arrow *and* on
`Enter`, or both handlers act again. A focusable that needs the arrows for
itself while the controls are up (the seek bar) takes them in its
`onArrowPress` and returns `false`, which stops the library moving the ring —
one handler per press, still.

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

### Read-on with the ring still in sight leaves the page down for good

Down with nothing below reads on (`readOn`), and Up reads back (`readBack`) —
but only while the control left behind is under the top bar. On a short page
(a setup page with nothing to press but Next) reading on moved the page 90 px
and Next stayed in sight, so `readBack` had nothing to do, Up had nowhere to
go, and nothing scrolled: the page never came back up. The suite's flow only
checked the ring was in view, so it passed. **Do:** Up that moves nothing is
the top — `backToTop` (focusScroll.ts) brings the page up as far as keeps the
ring in sight; a flow checks `scrollTop` is 0, not just that the ring shows.

### A corner button drawn over an open panel hides the ring

Skip intro and Audio & subtitles both sit at the player's bottom right, and
Skip has the higher `z-index`: with an intro on, the panel's last rows (and the
ring on them) were under the button, and a tap there skipped. Nothing reports
it — the ring's rect is on screen; only `elementFromPoint` on it tells. **Do:**
Skip is not drawn while Audio & subtitles or Chapters is open (Player.tsx).

### Back can only return to a control with a stable key

Back remembers the focus key held on each view when it was left
(`history.ts`) and puts focus back there on return (`returnFocusTo`). A
focusable declared without a `focusKey` gets a generated one, and a remounted
view generates **new** ones — so the remembered key names nothing, the wait
times out after two seconds, and focus falls back to the view's landing spot.
No error, just Back that lands at the top of the page instead of on the card
you opened. Anything a user can open something from needs a key that is the
same every time it renders, and unique on the page: cards are keyed by where
they sit as well as what they show (`rail:<heading>:<id>`, `grid:<id>`,
`search:<id>`), because one title appears in several rails at once.

### Back restores the page's scroll, and a grid's landing claim must not undo it (before round 7)

Back puts the ring on the remembered card, but the returning view is built at
the top, so the page stayed there (or ended wherever the card's focus scroll
put it). `open()` now keeps `.browse`'s scrollTop with the entry and
`returnFocusTo` sets it just before the ring lands. A grid's page claim
(`useClaimFocus`, 450 ms second look) then saw "no input since arrival" and
pulled the ring back to the first card with a smooth scroll to the top; it now
leaves a ring that is within where Back just put it. **In a test of scroll
under parallel load:** Look `Auto` may switch to the light look mid-run
(cards 38 px tall, the grid short, the page clamped to the top) — set
`setLook('full')` first, or the flow fails in one engine only.

### Every press measures every sibling of the focused control (before round 7)

Left to itself the library answers an arrow press by calling
`getBoundingClientRect` on **each sibling** of the focused control and sorting
them by distance. A rail is capped at thirty cards; a grid or search is not, so
on a library of a thousand every press measured a thousand cards — nothing wrong
on a PC, a stall on a TV box, and no error.

**Do:** give a long, regular list its own focus group with
`measureChildrenLayout: false` and a `nextFocusResolver` that works out the
neighbour from the index (`CardGrid.tsx`, `gridMove.ts`; the column count is
read when the grid is resized, not per press). The resolver replaces the
geometric search for that group only, so keep the group to the cards: Back, the
order buttons and the search box sit beside it in a group that still measures.
A press the resolver answers `null` to (Up from the first row) goes on to the
parent's own search, which sees the whole grid as one block. A group with no
cards is `focusable: false`, and names a `preferredChildFocusKey`, or focusing
the group measures all its children after all.

### A big grid draws only the rows near the screen, and the ring needs rows ahead of it (round 8, part I)

Index steps (`gridStep`) work on the cards that are drawn, so a grid with rows
left out must always keep a few rows beyond the ring: past the last drawn row
a press finds "nothing further down" and stops, with no error. `CardGrid.tsx`
draws the visible rows plus three either side, and the ring's own rows too
(`navWatch` tells it when the ring moves, before the page has scrolled); Back
(`navWanted`) draws only the place it is returning to, since the page is put
there next. Empty space (padding of one measured row height) stands in for the
rest, so the page is as tall as before. Rows of unequal height (a search
result's note) cannot be skipped by arithmetic: those grids are drawn whole.
Measured on a 2-core PC with 1000 films: 100 ms a frame by keys before, 40
after (17-38 at 416 before); 6000 elements drawn before, 490 after.

The card holding the ring must stay drawn even when the page has scrolled far
from it (a wheel, the scroll bar): `CardGrid.tsx` keeps the ring's rows as a
part of their own, with empty space between. Left out, the card went, the
focus engine put the ring on another card and scrolled the page back to it — a
wheel turned fast moved the page 622 px instead of 2500 (WebView2) and 59 px a
notch instead of 149 (WebKit), with no error (round 8, part I2; e2e/big-grid
"a wheel turned away from the ring").

### The page that scrolls must be a stacking context, or WebKit repaints every card (round 8, part I2)

`.browse` scrolls but had no z-index, so it was not a stacking context, and each
card's picture box (`position: relative`, for its badges) belonged to the
window's paint order. Whenever one card's level changed — the focused or
hovered card's zoom sets `z-index: 1` — WebKit (Linux) repainted every one of
them: about 3,800 paints and a 250 ms frame per key press at 1000 films on a
2-core PC, growing with the library, and every wheel step over the grid too
(the pointer hovers a new card). Chromium (Windows, Android) is not affected.
No error; it looks like "a big page is slow". **Do:** `isolation: isolate` on a
scrolling page (`.browse`): same picture, 47,000 paints for eight presses fell
to 284. Find such a case by counting paints, not by timing: WebKit's own
inspector (`WEBKIT_INSPECTOR_HTTP_SERVER`, its Timeline domain) reports one
Paint per layer painted.

### A picture too big to shrink is not shown as itself (round 8, part I)

`thumbs.rs` decodes at most 512 MB per picture. A poster beside a file of
14000×14000 (a 7 MB JPEG) is over that, so no small copy is made — and the page
used to fall back to the original, which the web process decodes at full size,
780 MB each: thirty on screen took a 3.7 GB PC to 66 MB free, a full swap and the
kernel's out-of-memory killer, with no error in the app. `Art.tsx` now, where a
small copy is asked for, falls back to the remote picture and then the drawn
poster, never to the original (same PC, same pictures: peak 909 MB, no stall).

The title page's backdrop and poster and Home's big picture were left out (no
`thumbRem`), so a print-size fanart (14000×14000: 780 MB; 30000×30000: about
3.6 GB) was drawn as itself there. They now pass `screenRem` to `Art`: a
screen-sized `thumb://` copy (window width, or the poster's rem, times the
pixel ratio, never above 1920 — the largest size `thumbs.rs` makes), with the
same fallback, remote picture then drawn one, never the original. **Do:** a new
picture on any page asks for a copy (`thumbRem` in a grid, `screenRem` where it
is the point); `Art.test.tsx` checks the three call sites.

### An Enter a text field acts on must stop there

A field's `onEnter` that answers at once (a sign-in against the mock) put
the ring on the next screen's first button before the spatial library saw
the same keydown, which then pressed that button too. **Do:** FocusInput
stops the event when its `onEnter` takes it.

### A rule inserted into a selector list takes the whole list

A new rule (the My list ribbon, `.card-listed { position: absolute; width:
1rem; … }`) was put after a light-look list ending in a comma —
`.card-art, .continue-art, .detail-poster, .skip-button,` — so the list
became its selectors. In the light look every poster took the ribbon's place
and size, from 0.14.0 for a week, with no error; it surfaced only when a new
control on the poster was clicked on a loaded CI runner, where Auto picks the
light look. **Do:** insert a rule only at a blank line after a `}`; a test
that matters in both looks sets `data-look` itself (e2e/cardmenu.e2e.ts).

### OK held: every repeat must stop at the card, even after it opened the menu

The card menu opens on OK held (Card.tsx). Once the card had decided "menu",
it let the next repeat through untouched; the menu was drawn by then, the
spatial library took the repeat as a press on its first item, Play, and the
film started. The e2e flow, with repeats seconds apart, passed; the real app,
with repeats 60 ms apart, did not. No error. **Do:** a card swallows every
Enter while focused, repeats included, and the menu's guard against the same
held key registers in `useLayoutEffect`, before paint. Test a hold with
real-rate repeats.

### A control that turns disabled under the ring strands it there

On the playlist page, ↑ on the first row was disabled, since nothing is above
it. Pressing ↑ on the second row moved that item to the top; its ↑ became
disabled while it held the focus, and no arrow moved the ring any more. No
error, no log line. **Do:** Up at the top and Down at the bottom are no-ops, not
disabled. Never disable a control that can hold the focus as a result of its
own press.

### Two buttons in a heading above a row of tiles: engines disagree which tile is nearer (before round 7)

On a Videos folder's page, "+ Playlist" sat beside Play all, so the two buttons
lay between two tiles. Down picked the second tile in Edge and the first in
WebKit; the navigation checker caught it. **Do:** make the heading a `row`
focus group, arrived at on Play all, and the tiles a `list` group, arrived at
on the first video, so the groups decide the move and not which tile is a
pixel nearer. A list group alone was not enough: leaving a list upwards uses
the list's whole box and skipped the heading's own Play all.

### A row that wraps hides its second line from a remote (before round 7)

A `row` group answers only Left and Right, measured; Up and Down leave it. The
title page's buttons wrap when the window (or another engine's font) is too
narrow, and nothing lies to the right of the first line's last button, so the
buttons on the second line could not be reached at all. Edge at 1280 × 720 fit
them on one line; WebKit on Linux did not, and only CI saw it. Measuring every
button, not only those on the line, was no better: Right from the second line
went back up to the first, and the walk changed with where the line broke.
**Do:** Left and Right keep to the line, then go on in reading order
(`resolveInGroup`); a flow that walks a row walks all of it both ways, once
anything loaded late (the versions) is in it, in a window narrow enough to
wrap on every engine.

---

### The spatial library calls `preventDefault` on every key, even while paused (before round 7)

Kinema's own focus engine (focusStore.ts, round 7) first ignored a key whose
`defaultPrevented` was set, so that a control keeping a key to itself could
claim it. Every arrow on Home then did nothing, with no error: the spatial
library's window listener, registered first, calls `preventDefault` (and
`stopPropagation`, which cannot stop another listener on the same `window`)
on every key in its map **before** it checks whether it is paused. **Do:** a
control that keeps a key stops its *propagation* (a card's OK held in the
capture phase, a text box's Left in React); the engine listens in the bubble
phase on `window` and never reads `defaultPrevented`.

### Enter in a text box that closes a dialog clicks the button the ring returns to

Rename on a title page and "+ Playlist"'s name field reopened themselves
after Save, on both engines, with no error: the field's Enter saved and
closed the form or dialog, the ring and the DOM focus went back to the
button that had opened it (all before the browser was done with the press),
and the browser's `keypress` that follows every Enter keydown then landed on
that button — which a browser activates on Enter — and pressed it again.
`stopPropagation` does not stop it; it is the default action of the same
key. **Do:** FocusInput's Enter calls `preventDefault` as well, which cancels
the keypress.

### A scroll animated per frame stretches on a starved page

Kinema's scroll spring (focusScroll.ts) capped each frame's step at 50 ms.
A busy CI machine — and a weak box — gave WebKit a frame every few hundred
milliseconds, so every 220 ms scroll took seconds, the flows waiting for the
page to settle ran out of their minute, and it looked like a flake in the
focus engine. **Do:** advance an animation by the time that really passed;
the spring is solved exactly for any step, so a long one just lands. Test it
with frames handed out by hand (focusScroll.test.ts), not by waiting.

### A control's place in the engine's tree is where its hook runs, not where its element is drawn (round 7, F3)

A component that calls `useFocusLeaf` / `useNavLeaf` and renders its own
`FocusGroup` registers its control under the group's *parent*, because the
hook ran above the group's provider. In the DOM the control sits inside the
group; in the tree it is a sibling before it. Down from it then skipped the
whole group (Needs attention: Enter opened a row, Down went past its panel).
**Do:** put the control in a component of its own, rendered inside the group.

### A claim must outrank a recovery, and a screen swap must remount the screen (round 7, F3)

When the control the person pressed is replaced (Connect becomes Disconnect, a
question is answered) the engine has already recovered the ring to a
neighbour by the time the successor says it wants it, so "claim only if
nothing live holds the ring" never fires. `useClaim` (focusStore.ts) also
takes it when the ring was put there by recovery with nothing pressed since.
And two `FocusScreen`s that are the same element type in the same place are
one screen to React: Home's first run, setup pages and rows need `key`s, or
the second never "arrives" and its landing is not fresh.

### A tall area scrolls by its top; the ring still has to be on screen (round 7, F3)

Settings' scroll anchor is the whole layout (a row above the section's
column), taller than the window: lining it up put the layout's top under the
bar and a control far down stayed below the fold. `lineUp` now also clamps so
the ring itself is in sight. And typing room (`placeForTyping`) must stop a
glide the ring started (`stopGlide`), or the spring pulls the page back.

### Buttons side by side in a dialog are a row, or Up lands on the last of them (round 7, F4)

Moved onto the engine, the folder browser's Use this folder, Up a folder and
Cancel were plain children of the dialog's column, so Up from the first folder
went to the one just before it in the markup — Cancel, one OK from closing
the browser. The spatial library had picked Use this folder because it was
nearest. **Do:** controls side by side are a `FocusGroup kind="row"` with
the one to arrive on as `current` (the password field and its Show button
too: Right from the password's end is Show, Down is Connect).

### A test that fills a field moves the ring to it (round 7, F4)

Playwright's `fill` focuses the input. The engine follows the DOM focus
(`focusin`, focusStore.ts), so the ring is on the field afterwards, not on the
button it was on — the library ignored the DOM focus and left its ring where
it was, and a test that pressed Up to get back to the field then left it.
**Do:** after `fill`, expect the ring on the field.

### A heading far above still led the row (round 7, F7)

The one scroll rule lines an area up with the heading before it, when the
two fit. `headingBefore` looked for the last heading before the area at any
level up, so in a Settings section it found the section's title — or the
page's "Settings" — five rows of choices away, and while they fitted on
screen that heading went to the third, the focused row sat near the bottom,
and the page did not move at all for the first rows. The F3 note above
("keeps the ring in sight") was this. **Do:** a heading leads only the area
right after it: a control between them ends the search (`pressable`,
focusScroll.ts).

### The scroll rule scrolled the page behind a dialog (round 7, F7)

A dialog is drawn fixed over the page, but the nearest scrolling ancestor of
its controls is still the page, so every arrow inside the Poster dialog lined
the page *behind* it up, and Back gave the ring to its button while that
page was still gliding — under the bar, 2 runs in 30 on WebKit. Nothing
visible moved, so nothing looked wrong. **Do:** a control in a dialog
scrolls only what is out of sight (`nearest`), and read on / back never
scrolls the page behind one (`readablePage`, focusScroll.ts).

### A control disabled until a form is filled cannot be reached by remote (round 7, F7)

"Bring it in" was `disabled` until the address and key were typed. The
engine passes over a disabled control (as it must), so with a remote it was
not there at all, and nothing said why. **Do:** keep a form's button
enabled; on press, say which field is empty. Disable only while it works.

### A `<button>` centres its content vertically (round 7, F7)

Cast faces in a flex row are stretched to the tallest, and a button lays its
own content out centred, so a face whose name took two lines had its picture
pushed up out of line with the rest. A `div` does not do this, which is why
it showed only once the faces became buttons. **Do:** a button that is a
picture over words is `display: flex; flex-direction: column;
justify-content: flex-start`.

### A ring needs room the layout does not give it (round 7, F7)

An outline is drawn outside the box and takes no space, so a caption right
under a row of choices, or a line right above a dialog's Cancel, was drawn
under the ring (worst in TV mode: 4 px + 3 px offset + growth). Nothing
failed; the text was just covered. **Do:** keep `--ring-room` (ui.css)
above and below rows of controls; `ringCovers` (e2e/kb.ts) lists any text
the ring overlaps, and e2e/ring-room.e2e.ts walks screens with it.

### A button disabled while a press works has nowhere to take the ring back (round 8, G1)

Needs attention's Link set `busy` while it fetched the show, which disabled
the Link button under the ring; the question it then opened ("Season 2
already has these episodes…") closed with the ring on nothing, on both
engines, no error. **Do:** while a press fetches before opening a dialog,
guard a second press with a ref instead of disabling the button.

### Two Back handlers on `window`: the one added first runs first (round 8, G1)

A dialog adds its Escape/Back listener (capture, on `window`) when it opens;
a sub-view inside it (one row's episode menu) adds its own later.
`stopImmediatePropagation` in the later one is too late: the dialog's ran
first and closed everything. **Do:** the sub-view tells the dialog through a
ref (`pickingRef`, PlaceChooser.tsx) and the dialog's handler steps aside.

## Frontend

### A condition inside `try` switches the react-hooks rules off for the whole component

The react-hooks rules run on the React Compiler, which cannot yet lower a
condition — `?:`, `||`, `??`, `?.` — inside a `try` block. It does not report
that; it skips the component. Every rule in the file goes quiet at once, and
the only trace is a crop of "unused eslint-disable directive" warnings where
disables that used to be needed no longer are. Found when adding "Find
subtitles online" to the player. **Do:** keep `try` out of components and
hooks — put the awaited work in a function outside that returns what to show
(`onlineSearch` in useOnlineSubtitles.ts, `subtitlesShown` in engine.ts) —
and treat a sudden batch of unused-disable warnings as the compiler bailing
out, not as tidying to do.

**To check rather than infer:** `npx eslint --rule '{"react-hooks/todo":"error"}'
src` names every function the compiler could not lower. Not every entry there
switches the rules off: the `try … finally` in useSkipMarkers.ts is listed,
yet a setState put in an effect in that hook is still reported. Before
concluding the rules have gone quiet, put a known violation in and see. And an
unused disable can also mean the code moved: a state setter passed into a hook
as a plain function is no longer known as a setter, so the disable that its
call needed in the component is not needed there.

### A CSS block pasted into a selector list takes the list's rule with it

`.settings-row,` was the first half of `.settings-row, .settings-toggle-row {
display: flex; gap … }`. A later change inserted a new commented block between
the two lines, so the stylesheet read `.settings-row, .choice-row { margin … }`
and the settings rows silently lost their flex layout and their gap: no error,
nothing in the diff that looks like a deletion. **Do:** when adding a block to
`ui.css`, check the line above it does not end in a comma.

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

### The spatial library marks every control it ever focused

norigin sets `data-focused="true"` on a control when it focuses it, and takes
it off again only when `shouldFocusDOMNode` is on — which Kinema leaves off.
So the attribute means "was focused at some point while it was mounted", not
"is focused". **Do:** read the `focused` class that FocusButton sets, never
`[data-focused]`, in tests and styles alike.

### Stale closures silently use old values

`runMatch` read a `tmdbKey` captured before the key was entered, so matching fell back
to OMDb while the UI showed TMDB as active. No error, just quietly wrong behaviour.
ESLint's `react-hooks/exhaustive-deps` is set to **error** for this reason.

**Better still:** read values that matter (API keys) from the database at use time
rather than from component state.

### The webview console is invisible from outside

`src/devlog.ts` forwards `console.*`, uncaught errors and unhandled rejections to
`app.log` (in `%APPDATA%\com.kinema.app\logs\`). Without it, frontend failures
leave no external trace at all. The Rust side writes there too, through
`crate::log!` — `eprintln!` reaches no console in a release build.

### Confirmation at the top of a long page makes a working button look dead

Settings writes every action's result to one `settings-note` banner under its
heading. When Settings was one long page, **Save commands** sat about 300 lines
further down, so pressing it saved three settings and put "Commands saved."
entirely off screen. It was reported as a dead button and proposed for
deletion; reading the handler was the only thing that showed it was not.
Settings is one section at a time now, and those fields save themselves.

**Do:** when a page is longer than a screen, put the confirmation next to the
control, or remove the need to confirm — saving on change, as Settings does.

**And:** an explicit save button next to fields that something *else* reads is a
second trap on its own. Typing a new detect command and pressing **Detect**
without saving ran the previous one, silently. `runDetect` flushes the fields
before invoking Rust, so the debounce is a courtesy rather than a race.

### A standard scrollbar property switches the styled one off

WebView2, like Chrome, ignores every `::-webkit-scrollbar` rule on an element
that sets `scrollbar-width` or `scrollbar-color` — and only the pseudo-elements
can round the thumb and drop the arrow buttons. Adding `scrollbar-color` to
"help" brings Windows' grey bar straight back. The rails and cast rows set
`scrollbar-width: none` on purpose, to stay hidden. **Do:** style scrollbars
with the pseudo-elements only (`ui.css`, after `.browse`).

### A random pick per step disagrees with itself

Up next and the Next button both ask `playlist_step`. With a fresh random
pick on each call they named different items, and Previous could not retrace.
**Do:** draw the shuffled round once and store it with the playlist
(`playlists.rs`); every step reads from that order.

---

### A page decodes a picture at its full size, however small it is drawn

`loading="lazy"` and `decoding="async"` change when, not how much. 33 posters on
one screen are 800 MB at 2000×3000 and 3 GB at 4000×6000, in the web process,
kept while the page lives. Fetching only rows near the screen cannot help the
first screen. **Do:** a card gives `thumbRem` to `Art`, and gets a small copy
(`thumbs.rs`, `thumb://`). The page cannot make the copy itself without decoding
the very picture it should not decode. A new `thumb.localhost` needs the content
security policy too, and nothing says when it is missing but the fallback.

## Testing and tools

### Playwright's WebKit on Windows is not Linux's WebKit

Playwright ships its own WebKit build per system. The Windows one is neither
WebKitGTK (Linux's window) nor Chromium (WebView2, Android's WebView), and it
disagrees with both on one navigation tie: on Android's Settings → Intros, Up
from "Off" lands on "30s before" there and on "At the end" in Edge and in
WebKit on Linux. Every release from 0.13.0 to 0.14.0 approved that "WebKit-only
tie" by hand. **Do:** take WebKit's answers from Linux (CI, WSL, a cloud
session), Edge's from Windows; `npm run verify` and the nightly map already
run them that way. A difference seen only in Windows WebKit is not a bug in
Kinema.

### The dev server can go on serving a stylesheet from before an edit

Seen during the September UX pass: after a run of edits to `ui.css`, a reload
of `dev:mock` still had the old rules — `document.styleSheets` held the previous
`.player-label` — while script changes were arriving fine. The layout looked
wrong for a reason that was not in the code. **Do:** when a style change does
not show, read the rule back from `document.styleSheets` before theorising, and
restart the dev server if it is stale.

Scripts can go stale too: after files were rewritten by a script,
`FocusButton.tsx` was served in its old form while the other edited files were
fresh, and a whole round of scroll tests measured code that was not the code on
disk. **Do:** before believing a test in `dev:mock`, fetch the source the
server hands out (`await (await fetch('/src/ui/FocusButton.tsx')).text()`) and
check it contains the change.

### The mock library lives in the page, so a reload empties it

`mockBackend.ts` keeps playback positions, watched flags and settings in memory.
A `location.reload()` to pick up a change also throws away the state a check
built up — the watched episodes, the answered notice — and the check then reads
a fresh library as if it were the result. **Do:** set state with
`__TAURI_INTERNALS__.invoke(...)` and move between screens to re-read it, and
use the `localStorage` switches (`kinemaMockReview`, `kinemaMockUpdate`,
`kinemaMockEmpty`) for anything that has to survive a reload.

### A local picture path in the mock throws the whole screen

`Art` turns a `*_path` into an address with `convertFileSrc`, which Tauri's
`mockIPC` does not provide: the first mock value with a path (a poster beside
a file, round 6 T20) drew "Something went wrong" and the flow failed on a
missing dialog, with nothing in the test output saying why. Every fixture had
null paths until then, so nothing had needed it. Fixed with
`mockConvertFileSrc('windows')` beside `mockIPC`. **Do:** when a mock flow
fails on a missing element, print the page's console errors
(`page.on('console', …)`) before guessing; the error boundary hides them.

### Playwright empties `test-results/` at the start of every run

Any `npx playwright test`, with either config, deletes the whole
`test-results/` folder before it starts — not just its own files. The
navigation checker first wrote its map there, and the next keyboard-flow run
deleted 24 minutes of results without a word. **Do:** anything meant to
outlast a run goes elsewhere; the checker writes to `navmap-results/`.

### Most tools do not read `.gitignore`

Claude Code keeps its worktrees — whole copies of the project — under
`.claude/worktrees/`. Git ignores them; ESLint, Vitest and Vite's file watcher
do not, so `npm run check` linted and tested every copy (2,687 errors and over
a thousand test files, 2026-10-10) and the dev server watched them. All three
now skip `.claude/` (`eslint.config.js`, `vite.config.ts`); a new tool that
walks the project needs the same line.

### A fixed wait in a test is a bet on the machine (round 7, F5)

`waitForTimeout(500)` after a press "worked" until a runner was starved,
then the check ran before the page had answered (or, for "nothing happens",
long before the thing that should not happen could). 60 of them sat in `e2e/`.
**Do:** wait for a state — `expect.poll` on the focus key, `drawn(page)`
(two frames) after a press you will not poll for, `settled(page)` for a scroll,
`quiet()` in the nav checker (counts frames, not milliseconds). The few real
time checks and the input pacing go through `pause(page, ms, why)` in
`e2e/kb.ts`, the one place eslint allows `waitForTimeout`. `open()` waits
30 s for the page: expect's 5 s ended a starved startup as a failure.

### The e2e suite fails under load and passes alone (2026-11-13)

A full `npm run verify -- --all`, or any run beside a cargo build or another
worktree's verify, ended a few flows with a timeout (`page.goto`, "Previous
file" never attached) that passed alone. No app error: the app was right and
late. Cause: one worker per core, and `verify` ran the keyboard flows and the
nav walk at once, so two pools of that size plus cargo on 6 cores; WebKit on
Windows runs the same flow about 4x slower than Edge (10 s became 45 s of a
60 s test), and the first pages of a run all waited on Vite's cold
transforms. (`useFolderNeighbours` is a plain async call, no timer: not an
app race.) **Do:** workers default to half the cores (`KINEMA_E2E_WORKERS`
overrides; verify halves them again when ui and nav share the machine),
`e2e/warmupSetup.ts` loads the app once before the flows, and the dev-server
port is `KINEMA_E2E_PORT` / `KINEMA_E2E_NAV_PORT` (verify picks free ones, so
two worktrees can verify at once; a plain `npx playwright test` is still
1440). Do not answer the next one with a longer timeout or a retry.

### Screenshot baselines are per engine and per OS

`toHaveScreenshot` names a picture `name-<look>-<engine>-<platform>.png`:
Edge on Windows, WebKit on Windows and WebKit on Linux are three sets (fonts
differ; one set would fail on the others). A new engine or OS with no
baseline writes one and **passes** the first time — so a missing set is not
a green check. Linux's come from Ubuntu 24.04 (CI's image; WSL's distro is
the same): `scripts\wsl.ps1 'npx playwright test e2e/screens.e2e.ts
--update-snapshots'`, then copy the `*-linux.png` back. The Look is seeded
by `kinemaMockLook` in localStorage: the mock's settings are in memory, so
setting it after load is lost on a reload.

### A model-based nav map saves no time, only certainty (round 7, F5)

`navmap.nav.ts` asks the engine's pure rule (`__nav.model`) for where each
arrow goes and presses only where the ring moves (to see where it lands on
screen); a press that disagrees with the model is flagged `model-differs`.
Edge, full map: 3 m 57 s with the model, 3 m 53 s pressing everything
(`NAV_MODEL=0`) — the time is the screens' set-up and the held-key tests, not
the presses. Do not expect a speed-up from here.

### A self-test's screenshots are of whatever window is in front

`selftest.ps1` photographs the primary screen, not Kinema's window. Started
from a script while someone is using the PC, Windows' focus-stealing rules keep
the new window *behind* the one they are working in — fullscreen or not — and
every screenshot is of their browser. The run itself is fine (the report's
timeline shows every step); only the pictures are wrong, and they show someone
else's screen. **Do:** the self-test now sets the window always-on-top for the
length of the run (`on-top` in the report's timeline); if it says
`on-top-failed`, do not trust the screenshots.

### …and after a screen-mode switch they can be seconds old

On the test TV, with the refresh rate and HDR switched as a film opened, the
screenshot taken at 12 s showed the player as it was at 4 s — no times yet, a
Play icon — while the report's clock had been running for three seconds. The
one at 20 s still showed the volume as it read before the sound output opened,
and was taken as proof of a bug that was only half there. **Do:** read what
the report's timeline says was on screen (`screen` entries record the volume
label and whether the controls are shown) before believing a picture, and
read mpv with a `probe` action while the file plays. The plan's own `probe`
list runs after the player has closed, when there is no file and no sound
output to ask about.

### Moving effects into hooks moves them in React's order

A component's effects run in the order they are written; a hook's run where
the hook is called. Splitting Player.tsx into hooks (October 2026) grouped
effects that had been spread through one file, so within a commit they ran
in a different order. Usually that changes nothing — React runs every cleanup
before any effect, and state set in one batch renders once. Against
`dev:mock` it changed something: the mock backend answers at once rather
than a round trip later, so the request for the episodes either side, now
sent earlier in the batch, was answered before React drew the cleared state,
and the previous/next buttons were updated in place instead of disappearing
for a frame. Moving only that one effect earlier in the unsplit file did the
same, which is how it was told apart from a real change.

**Do:** when moving effects between components or hooks, compare the DOM in
fixed states before and after, not only the behaviour, and write down which
effects changed place and why that is safe. A difference that appears is
either a real change or the mock's instant answers; moving the one effect in
the old code tells which.

### The navigation checker's walk is part of what it measures

The checker stands on every control in turn and presses each arrow, so a
group that remembers its last control (a rail, the letter pad) answers with
wherever the walk last stood. Its first map said Up from a rail went to "the
last card" of the rail above and Up from a search result to the key "8" — both
were the memory working, the walk having just visited them. **Do:** before
calling a move wrong, ask what the walk had just focused in the group it
lands in.

### An edit during a Playwright run reloads the page under it

The tests run against the Vite dev server, which reloads a module the moment
its file is saved. Saving a component while `test:nav` or `test:ui` is running
reloads the page mid-screen: a screen comes back "not walked", or a flow fails
at a step that has nothing to do with the change. **Do:** leave `src/` alone
while a run is going (docs and notes are safe), and re-run the screen rather
than reading anything into the failure.

### A hidden browser pane never scrolls smoothly

When testing `dev:mock` in a browser pane embedded in another program: while the pane is hidden,
`requestAnimationFrame` never fires, so a `behavior: 'smooth'` scroll never
starts. `document.visibilityState` still says `visible`, instant scrolls
still work, and the result looks exactly like `keepInView` being broken — the
focus ring walks off the screen and the page stays put. Make sure the pane is
visible before believing any scroll result.

### Two key presses 25 ms apart are one key press

`Browse.tsx` sets `throttleKeypresses` with a 25 ms throttle, which is what
keeps a held arrow from racing through a rail. A scripted test that presses
Right and Enter back to back — as a browser tool's batch does — has the
Enter dropped, and it looks exactly like a control that does not respond, or
focus that will not move. No remote presses that fast. **Do:** wait between
scripted presses before believing a key did nothing.

### Restoring files after a "without the fix" build can leave cargo on the old one

Copying the originals in, building, then copying the fixed files back and
syncing from the worktree (rsync keeps the source's older times) leaves the
sources *older* than the last build, so cargo keeps the experimental build
and the tests fail for no visible reason. **Do:** `touch` the restored
files.

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

## Community skip services

### TheIntroDB and IntroDB.app are two different services

`introdb.rs` is **TheIntroDB** (theintrodb.org, TMDB ids, arrays of segments);
`introdb_app.rs` is **IntroDB.app** (introdb.app, IMDb ids, one object or null
per segment). Different people, different data, different shapes. The source
strings are `introdb` and `introdb-app`, and the settings keys
`introdb_enabled` and `introdb_app_enabled`. Reading "IntroDB" in an issue does
not say which is meant — ask.

### IntroDB.app says "nobody has timed this" with a 200

Not a 404, though its documentation lists one: an untimed title is a 200 with
every segment `null`. Both are answers and are stored for a month. Only a
failure to ask — offline, a timeout, a 429 — is not stored, or one moment
offline would mean no skip times for a month.

### Community answers contain the wrong kind of segment

Seen in IntroDB.app's real answers for films: an `intro` at the very end of a
film, and a `post_credits` scene that ended where the credits began (a
mid-credits scene, labelled as the other kind). Nothing errors; the Skip button
simply lands somewhere absurd. **Do:** read only the segments the API
documents for that kind of title, and check a scene against the credits and
the file's length before offering it (`checkedAgainstFile` in `skip.ts`).

### A cached skip row outlives switching a service off

`skip_markers` is served straight back when the local sources have not
changed. Its key used to cover only local sources, so switching TheIntroDB off
left its times on every episode already played, with no way to tell why.
**Do:** anything that decides which sources may answer belongs in the cache
key (`local_key`'s `remotes`).

---

## SIMKL

### Nobody saying no looks exactly like nobody having answered yet

The device sign-in has no "declined". A person who presses No on SIMKL's page
produces `authorization_pending` forever, the same as one who walked away.
**Do:** stop at the code's own expiry, by the clock, and offer to start again.

### Polling early locks the sign-in out

The poll timer is reset by the attempt itself, including one refused as too
early (`slow_down`). A client that retries at once keeps re-arming it until the
code expires. **Do:** add five seconds on `slow_down` and actually wait; Rust
answers the page's faster timer with "waiting" rather than asking SIMKL early.

### One grant, one live access token

Refreshing replaces the access token for everyone holding it. Two processes on
one library — a development build beside the release, or a self-test on its
copy, tokens included — cut each other off with 401s that look like random
expiry. **Do:** on a 401, look for a token someone else already refreshed
before refreshing; a self-test never talks to SIMKL.

### An unrecognised scope becomes read-only without a word

A typo in `scope` gets a working token that fails at the first write. **Do:**
check the granted `scope` for `media:write` before storing a token.

---

## OpenSubtitles

### A value equal to the default is answered with a redirect

`machine_translated=exclude` is OpenSubtitles' default, and sending it gets a
301 to the same address without it — a second round trip per search, and
redirects are where headers go missing. The same goes for names out of
alphabetical order and upper-case values. **Do:** send only what differs from
the default, names sorted, values in lower case (`query` in opensubtitles.rs).

### A sign-in lasts about a day

The JWT from `/login` expires in roughly 24 hours; OpenSubtitles' own Kodi
add-on renews it after 20. There is no refresh token and no device approval,
so renewing means the password. Kinema keeps it (DPAPI on Windows) and, when
signing in again fails, carries on with the free allowance rather than
failing the download.

---

## Trakt

### Trakt counts every play it is sent

SIMKL ignores a watch it already has; Trakt records it again, as a rewatch.
"It is up to your app to verify this and not send duplicate plays." **Do:**
never send a history without first reading what the account has, and never
re-queue a batch Trakt accepted.

### Trakt's watched lists are paged, and no longer list episodes

Both found on the first real connect (2026-09-30), and both silent:
`/sync/watched/movies` answers a hundred at a time (`X-Pagination-Page-Count`
says how many pages; an account's 135 films arrived as 100), and
`/sync/watched/shows` returns the shows **without** their seasons and episodes,
whatever `extended` says — so a comparison built on it saw no watched episodes
at all. `/sync/watched/episodes` has them, but names each by its own ids, not
its show's. **Do:** read every page of the films, and ask each show Kinema has
episodes of for its progress (`/shows/:id/progress/watched`, by IMDb id, or the
Trakt id found from the TMDB id), which marks each episode `completed`.

### A refresh token works once

Each refresh returns a new refresh token and kills the old one. Store the pair
before doing anything else; a crash between the answer and the write loses the
sign-in. A refresh refused because another process already used the token looks
exactly like one revoked by the user — compare with what is stored first.

---

## Output hardware (Windows)

What the screens and the audio device can take. Every entry here is something
that fails without an error — silence at the receiver, or a picture that is
quietly not what the disc carries.

### mpv relabels a refused bitstream as AC3

When WASAPI refuses a passthrough format, `find_formats_exclusive` in mpv's
`ao_wasapi_utils.c` retries it **with the sub-format set to AC3** ("Retrying as
AC3"). A device that takes AC3 but not TrueHD then *accepts* the TrueHD stream,
and the receiver gets data it cannot decode: silence or noise, no error
anywhere. Only when every attempt fails does mpv fall back to PCM.

**Do:** never put a codec in `--audio-spdif` that the device has not said yes
to *in its own right*. `equipment.rs` asks per codec, in exactly mpv's shape:
AC3/DTS 2 ch @ 48 kHz, E-AC3 2 ch @ 192 kHz, TrueHD/DTS-HD MA 8 ch @ 192 kHz,
16-bit, IEC 61937 sub-format — and a test pins those shapes, because if they
drift from mpv a "yes" stops meaning anything.

### HDR "passthrough" is not the default

`--target-colorspace-hint=yes` sends HDR, but with `--target-colorspace-hint-mode`
at its default, **`target`**, mpv first adapts the picture to the peak Windows
reports for the screen — which comes from the EDID and is often generic. `source`
is what a disc player does: the film's own HDR10 metadata, and the TV tone maps.
`mpvOptions.ts` sets `source`; before native output (HISTORY → Native output) it
said "passes through untouched" while mpv used `target`, and nothing showed it.

### mpv sends HDR10 to an SDR screen, and Windows quietly converts it

With `target-colorspace-hint` at `yes` **or `auto`**, playing an HDR file on
the development monitor here (Windows HDR off, DXGI reporting `RGB_FULL_G22_NONE_P709`) still
logged "New swap chain configuration received from hint: … G2084_NONE_P2020".
Nothing looks broken — Windows converts the HDR swap chain to SDR itself — so
for as long as the hint was `yes`, mpv's BT.2390 tone mapping, the one chosen
deliberately in `mpvOptions.ts`, never ran on an SDR screen, and nobody could
tell. `auto` did not help.

**Do:** decide the hint from the display, not from mpv: `displayHdr.ts` sets it
`no` unless Windows has HDR on for the screen the window is on. With `no`,
`video-target-params` reads `gamma2.2 / bt.709 / 80 nits` and the swap chain
stays SDR.

### The stats panel's HDR row asked for a property that does not exist

`stats.ts` read `target-params/gamma`. mpv's property is
**`video-target-params`**; the other name returns nothing, and `describeHdr`
treated nothing as "tone mapping". So every HDR file said "tone mapped" — on an
HDR TV that was receiving HDR10 — and the panel whose whole purpose is to
answer "passthrough or not?" could never say passthrough. Found from the test TV
log, where the swap chain plainly went to `RGB_FULL_G2084_NONE_P2020`.

The trap that stays: **mpv answers a property it does not have with nothing**,
exactly as it answers one with no value yet. **Do:** never let "no answer" stand
for one of the answers; `describeHdr` now says it does not know.

**How to tell what really happened:** in `mpv.log`, "New swap chain
configuration received from hint" gives the output colour space, and a
`pl_shader_color_map` block containing `tone_map(` in the shader dump means a
tone curve ran — in `target` mode it does even HDR→HDR, adapting to the peak
Windows reports.

### A half-configured Windows spatial sound leaves mpv with no audio at all

mpv's shared-mode 7.1 stream passed `IsFormatSupported` and then failed
`Initialize` with `0x887C0077`, and mpv carried on with `Audio: no audio` — a
film playing silent, no error in the UI. **Cause, found on the test TV:**
a half-configured spatial mode — the device's format dropdown switched to an
Atmos option without Dolby Access installed and spatial sound enabled. Nothing
could play in that state, not just Kinema. Once Dolby Access was set up and
only the spatial-sound option switched on, mpv's 7.1 opened normally
(`equipment:` then read `dynamic=20 static-mask=0xc1ffe`) and the fallback
never ran. Keep the fallback: a misconfigured Windows is exactly the case it
is for, and it now says so on screen.

**And what "Atmos" means there:** mpv decodes the track (a DTS:X track went
through the `dca` decoder) to 7.1 PCM, and Windows wraps that 7.1 as Dolby
Atmos for the receiver. The receiver's display says Atmos for anything played
this way; the film's own height and object sound is gone. Only "straight to the
receiver" (bitstream) keeps it.

### A failed audio open deselects the track

When mpv cannot open the audio output it logs "Audio: no audio" and
**deselects** the audio track, rather than leaving it selected with nowhere to
go. So "is a track selected but not playing?" never fires. The sign is a file
with audio tracks and none selected — which Kinema never asks for, having no
"audio off". Putting the same track back (`set aid N`) is what reopens the
output with new settings; `ao-reload` alone leaves it silent.
`silencedAudioTrack` in `audioOutput.ts`; staged in `selftest.ps1` by setting
`audio-device` to a GUID that does not exist and calling `ao-reload`.

### Exclusive mode with the default `audio-channels` is stereo

`auto-safe`, mpv's default, means "the system's preferred layout, and stereo if
there is none" — and in exclusive mode there is no system mixer to ask. So
"straight to the receiver" would have been a stereo downmix of every track not
bitstreamed. The plan sets an explicit list from the device's own answer
(`7.1,5.1(side),5.1,stereo` for an 8-channel receiver). With it, the onboard sound
here opened as `7.1 s32 … (exclusive)` — **with Windows Sonic switched on**,
which confirms exclusive output goes around Windows' spatial sound.

### The spatial audio API says "available" whether spatial sound is on or not

`IMMDevice::Activate` for `ISpatialAudioClient` succeeds on every device here
with spatial sound *off*, `GetNativeStaticObjectTypeMask` returns `0xffffe` and
`IsSpatialAudioStreamAvailable` returns S_OK — Windows provides a spatial
renderer regardless. So none of those means "Atmos for home theater is on", and
a first attempt that trusted them reported it on for all three devices.

**Do:** use `GetMaxDynamicObjectCount` alone. It is 0 with spatial sound off
and non-zero with it on — 128 for Windows Sonic, 20 for "Dolby Atmos for home
theater" set up through Dolby Access. It read 0 once with Atmos apparently on,
but that was the half-configured state (an Atmos format chosen in the device's
dropdown, spatial sound itself never enabled), in which nothing plays at all.

### Display-clock timing switches itself off while bitstreaming

With `video-sync=display-resample` and a passthrough stream, `adjust_sync` in
mpv's `player/video.c` just returns (`if (resample &&
using_spdif_passthrough(mpctx)) return;`). Nothing breaks and nothing is
logged — the frame-timing switch simply has no effect for that file. So the two
are not "incompatible", but the switch is inert.

### From Windows 11 24H2, "advanced colour" does not mean HDR

`DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` reports `advancedColorSupported` for an
SDR screen with automatic colour management, too. Ask
`DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2` (type 15) instead: bit 4 is
`highDynamicRangeSupported`, and `activeColorMode == 2` means HDR is on. It is
not in `windows` 0.61, so `equipment.rs` lays it out by hand, from wingdi.h.
Older Windows refuses type 15 and the code falls back to the old query, where
advanced colour did mean HDR.

### mpv does not notice the screen changing mode

Switch the development monitor from 59.972 to 23.976 Hz under a playing file and mpv's
`display-fps` stays at 59.972 — its window is a child of the app's, and the
display-change message never reaches it. Everything that uses the number goes
quietly wrong: display-resample timing, and the stats panel's cadence row,
which would report 3:2 judder on a screen now running at an even 1:1.

**Do:** after a switch, set `display-fps-override` to the rate Windows reports
for the new mode (`QueryDisplayConfig`'s exact fraction, not the nominal
23.976 — mpv warns that even slightly wrong values spoil display-sync), and set
it back to 0 on restore, when mpv's own stale value is right again.

### A full-screen window keeps the size of the mode it was made full screen in

On the TV PC, with the desktop at 1080p, Kinema switched the TV to 4K for a 4K
film and the film went on playing in the top-left quarter of the screen: the
window was still 1920×1080. Tauri sizes a full-screen window once, to the
screen's bounds at that moment, and Windows moves nothing when the screen
changes mode under it. No error; the stats panel then blamed "the desktop is
set lower than the video", which was no longer true. Reproduced on the second
monitor (720p switched to 1080p: mpv's `osd-dimensions` stayed 1280×720). A
desktop already at 4K, switching only HDR, never showed it.

**Do:** after a switch and a restore, and whenever Windows sends
`WM_DISPLAYCHANGE`, set a full-screen window to its screen's bounds as Windows
reports them now (`display.rs` → `fit_window`, `display/win.rs` →
`fit_to_screen`); app.log says "full-screen window … → …". The self-test's
`windowAndScreen` call reads window, screen and picture side by side.

### Turning HDR on puts back Windows' own HDR mode

On the test TV, a switch that set 4K@23.976 and *then* turned HDR on ended at
4K@**30** — the mode that screen had last used with HDR — and from a 1080p
desktop at 1080p@30. Windows keeps a mode per HDR state and restores it when
HDR changes. **Do:** change HDR first, then the mode, and check the mode
afterwards (`switch_screen` sets it again if it moved, and logs "asked for …
and Windows kept …" if it still did). Restore in the reverse order.

The same round left the TV receiving 4K 60 Hz while Windows reported a 1080p
desktop — the desktop scaled up to a signal nobody asked for — and only a full
mode change in the NVIDIA panel cleared it. `ScreenNow.signal` reads the signal
actually on the cable (`QueryDisplayConfig`'s target mode), the one before the
first switch is saved, and `restore` forces a full mode change (`CDS_RESET`) if
the signal did not come back with the desktop.
That forced change is belt and braces and must never fail the restore: it
once returned its error before the record was cleared, and a record saved on
a day the desktop was 4K@60 — a mode the TV no longer offered — failed at
every launch and after every film, and stood in for the real desktop at
every switch (TV PC, round 8 J). A refused forced change is now logged and
the record cleared.

### A temporary display mode dies with the process; HDR does not

`ChangeDisplaySettingsEx(…, CDS_FULLSCREEN)` never writes the registry, and
when the app was force-killed with the development monitor at 1080p@23.976, Windows put it
back to 2560×1600@60 by itself within seconds. Turning HDR on
(`DisplayConfigSetDeviceInfo`) is a persistent Windows setting and would stay
on. That is what the restore record in `display_restore` and the restore at the
next launch are for — the mode half is belt and braces, the HDR half is the
belt.

### Windows lists 23.976 Hz as `23`

`EnumDisplaySettings` gives whole numbers, and the NTSC rates are listed one
below the round figure: `23` is 23.976, `59` is 59.94, `119` is 119.88. That is
the convention madVR and Kodi rely on. The *current* mode is exact —
`QueryDisplayConfig` gives it as a fraction (`59972/1000` on the development monitor here) — so
use that for anything already running.

### The old mode call refuses a rate the link has room for only in a smaller colour format

On the TV PC (desktop at 4K 30 Hz, 10-bit YCbCr 4:2:2, set in the graphics
driver), a 59.94 fps film asked for 4K@59.94. `EnumDisplaySettings` listed the
mode, and `ChangeDisplaySettingsEx`'s `CDS_TEST` answered "not supported"
(`DISP_CHANGE_BADMODE`). Windows' own Settings set the same mode at once, at
8-bit YCbCr 4:2:0: the link had room for 4K60 only in the smaller format, and
the old call keeps the format the link is in. The film played at 30 Hz with
every second frame left out, and app.log was the only place that said so.

**Do:** when `CDS_TEST` refuses a listed mode, ask as Settings does —
`SetDisplayConfig` with the desktop's new size, the path's refresh as an exact
fraction, no target mode (`DISPLAYCONFIG_PATH_MODE_IDX_INVALID`) and
`SDC_ALLOW_CHANGES`, validated first (`display/win.rs` →
`set_mode_letting_driver_fit`). Not saved to the database, so `reset_mode`
(`ChangeDisplaySettingsEx(NULL)`) still puts the desktop's mode back — proven
on a second monitor at 50 and 59.94 Hz — but unlike `CDS_FULLSCREEN` it does
not die with the process: the restore record covers a crash. The link's format
before is kept in the record and the restore checks it came back. The details
panel says a refused mode (Motion) and a lowered link (Colour depth).

### Probing the device's formats needs nothing open

`IAudioClient::IsFormatSupported` in exclusive mode answers without opening the
device, so it is safe to ask at any time. It cannot answer while another program
holds the device exclusively (`AUDCLNT_E_DEVICE_IN_USE`): report that as
"busy", not as "no", or a receiver in use by something else looks like one that
takes nothing.

---

## Environment (Windows)

### A running Kinema does not see a program installed after it started

The same as the shell entry below, inside the app: a process keeps the `PATH`
it was started with, so `Command::new("ffmpeg")` fails for an ffmpeg winget
installed a minute ago — winget adds `%LOCALAPPDATA%\Microsoft\WinGet\Links`
to the *user* `PATH` in the registry, which nothing running re-reads. No
error, only "not found" until the next start. `ffmpeg.rs`
(`installed_since_start`) looks in the registry's `PATH`, winget's links
folder and its package folder when the bare name is not found. Anything else
Kinema learns to install the same way needs the same.

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

### CI's clippy can be newer than yours

CI installs the latest stable Rust on every run (`dtolnay/rust-toolchain@stable`),
so a lint added in a new release fails CI on code that passed clippy locally
the same day. 0.7.0's release commit did exactly that: Rust 1.98's
`chunks_exact_to_as_chunks` against a local 1.97. The release workflow does
not run clippy, so the release itself built — only the CI badge went red.
**Do:** `rustup update` before a release, and read the CI run for the release
commit, not only the release run.

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

**And this is why the Tauri bundler is off in `tauri.conf.json`**
(`bundle.active` is `false`; only `tauri.installer.conf.json`, passed with
`--config`, turns it on, with the DLLs mapped beside the exe). It used to be `true` with
`"resources": ["lib/**/*"]` — which installs the pair into `<install>/lib/`,
exactly the layout described above. An MSI or NSIS build from `tauri build`
therefore produced an app that installed cleanly, launched cleanly, and then
failed the moment you pressed Play, with nothing in either log. Nobody had ever
run it, because `build-app.ps1` passes `--no-bundle`.

The installer (2026-10-17) is built from `tauri.installer.conf.json`, which maps
the DLLs to sit beside the exe, and it was tested by *playing a file* — an
installer that starts the app proves nothing. Keep it that way.

### Running a newer setup by hand uninstalls instead of updating

The NSIS "already installed" page pre-selects "uninstall before installing"
and runs the old uninstaller without `/UPDATE`: Tauri unpins and deletes the
shortcuts and our `--uninstall-cleanup` drops the default-player entries. The
page cannot be told to pass `/UPDATE`, and `hooks.nsh` is read before the
template's variables, defines and plugins exist (no `$UpdateMode`, `${VERSION}`
or `nsis_tauri_utils::` there). So `hooks.nsh` has a `MUI_CUSTOMFUNCTION_GUIINIT`
function that, for a newer setup started without `/P` or `/UPDATE`, starts the
setup again with `/P /UPDATE /R` and quits. `.onGUIInit` is MUI's: defining it
yourself fails. Proof: `scripts/sandbox-installer-update.ps1` (previous release
→ new setup with defaults). A real taskbar pin cannot be made by script, so
the Sandbox run uses a copied shortcut for it.

### A clean Windows lacks `VCRUNTIME140.dll`, and error 126 blames the wrong file

The plugin's prebuilt `libmpv-wrapper.dll` needs Microsoft's Visual C++ runtime
(`VCRUNTIME140.dll`), which a fresh Windows may not have. Then the player cannot
start: "Failed to load libmpv-wrapper", Windows error 126, "module not found".
That error names the wrapper, which is there, and not the runtime it needs,
which is not. The ZIP had this fault too, and it hid for a long time because
every PC used for testing already had the runtime, and the Sandbox harnesses
copied `vcruntime140.dll` in.
**Do:** Windows builds the wrapper from its pinned source with the C runtime
built in (`scripts/build-mpv-wrapper.sh`, `crt-static`), and `kinema.exe` has
its own built in already. **Never copy a runtime into a test sandbox** — it
hides exactly this.

### Verify a Rust rebuild by timestamp

`cargo build` output is easy to misread when filtered. Compare the binary's mtime
against the source file you just edited.

---

### Splitting one file's changes over two commits: never `--unidiff-zero`

Without `git add -p` (no interactive tools here), staging some hunks of a
file by piping `git diff` into `git apply --cached` works — but with `-U0`
and `--unidiff-zero` the pure insertions land on the wrong side of their
neighbours: a component's opening line moved below the code that followed it,
a fallback prop went to another `<Art>`. No error; the commit was simply a
different file (caught only by `git diff HEAD`). Use `-U3` hunks and plain
`git apply --cached`, write and read the patch as **bytes** (Python's text
mode on Windows turns every `
` into `
` in the index), and check
`git diff` afterwards shows only the other feature's lines.

### Stopping a film does not give back mpv's memory

After 4K, mpv holds about a gigabyte of picture buffers and decoders for as long
as it runs: `stop` and `drop-buffers` change nothing. Only ending it does. On
Linux that alone leaves most of it with the process, in the allocator's free
lists (565 MB against 190): `malloc_trim(0)` after ending it is what returns it.
**Do:** nothing by hand; `giveBackEngineSoon` in engine.ts ends it 30 s after the
player closes and the next film starts it again. Anything set on mpv only once
per run would be lost with it: options belong in `startMpv` or the file's opening.
The timer must be set in the same moment the player unmounts, not after the
asynchronous stop, or it lands after the next film's `startEngine` cleared it,
and ends mpv under that film.

## Linux, and building it from Windows

### A Windows path in a test is one file name on Linux

`Path::new(r"C:\tools\ffmpeg\bin\ffmpeg.exe").parent()` is `C:\tools\ffmpeg\bin`
on Windows and **empty** on Linux, where a backslash is an ordinary character.
Four Rust tests passed for months on Windows and failed on their first Linux
run for that reason alone. **Do:** build test paths with `join`, never from a
Windows literal, unless the test is about Windows paths.

### Rebuilding a path from its parts loses its root

Splitting on separators, dropping empty parts and joining with `/` turns
`\\NAS\TV\Show` into `NAS/TV/Show` and `/media/TV/Show` into `media/TV/Show`.
Compared with the library folder afterwards, nothing on a network share or on
Linux was "inside" it, and no error said so. **Do:** cut a parent off the end
of the string; never rebuild one.

### File names are case-sensitive on Linux

`tvshow.nfo` does not find `TVShow.nfo` there, and the result is simply "no
NFO". Any file named by the user or by another tool is looked up through
`util::existing_file`, which searches the folder when the exact name is
missing (and does not on Windows, where the filesystem already ignores case).

### Code only Windows uses is dead code to Linux's clippy

Helpers shared by design but called only from a `#[cfg(windows)]` module
fail `-D warnings` on Linux (and the other way round). **Do:** allow it on
those items by name — `#[cfg_attr(not(windows), allow(dead_code))]` on the
function, as `display.rs` does for its two signal helpers and
`audio_reserve.rs` for Linux's — and on a whole file only when all of it
is one system's (`equipment/edid.rs`, Linux's EDID reader). A file-wide allow
outlives its reason: `display.rs` kept one after Linux gained its own
switcher, and it hid from Linux's clippy whatever that switcher stopped using.

### A constant used only off Android is dead code to Android's clippy

A constant (or helper) used only inside `cfg(not(target_os = "android"))` code
passes every local check and fails CI's Android clippy under `-D warnings`.
Nothing on a desktop shows it. **Do:** give the item the same `cfg`, as the
frame constants for Videos have.

### New files on Linux are readable by every account

Windows' app data is private to its user; a folder created on Linux with the
default umask is not. Kinema's holds sign-in tokens, so `util::keep_private`
makes it `0700` at every start.

### Inside WSL, `npm` is Windows' npm until Linux has its own

WSL appends Windows' `PATH` to Linux's. With no Linux Node installed, `npm`
resolves to `/mnt/c/Program Files/nodejs/npm` and a build silently mixes the
two systems. **Do:** install Node in the distribution before anything else.

### `wsl` hands its arguments to a shell, and pipes gain a CR

`wsl -d Ubuntu -- wslpath -a C:\x\y` passes the path through bash, which eats
the backslashes — the repository's own path survived only because its spaces
made PowerShell quote it. **Do:** use `wsl --exec`, which runs the program
directly. And text piped from PowerShell into a native program ends in CRLF,
so a script fed to `bash -s` ran `npm run check<CR>`. `scripts/wsl.ps1` writes
the script to a file with LF endings instead.

### One checkout cannot serve Windows and Linux

`node_modules` and `src-tauri/target` hold one platform's binaries, building
across `/mnt/c` is slow, and with `core.autocrlf` the files here have CRLF
endings that no Linux checkout has. `scripts/wsl.ps1` snapshots the working
tree through git (uncommitted work included) into `~/kinema` in the
distribution and runs the command there. That copy is a mirror: never edit it.

### A path stored in the library carries the separator of the system that wrote it

Cached artwork is stored as `artwork` + the system's separator + a file name,
and read by joining it onto the data folder. A Windows library opened on
Linux said `artwork\52.jpg` — one file name there — and every picture
"failed" and was quietly fetched from the network again; the only sign was a
warning per picture in `app.log`. `artwork::use_this_systems_separator`
rewrites them at every start. **Do:** store anything relative with `/` or
rewrite it on open; never let a stored path depend on where it was written.

### On Linux, mpv opens a window of its own

`force-window=yes` keeps an idle surface for the transparent window to show,
and on Windows that surface lives in Kinema's window through `--wid`. On
Linux it does not, for two different reasons. Under Wayland the plugin
cannot give mpv a window at all ("Window embedding via --wid is not
supported on Wayland"). Under X11 it does — `options/wid` reads Kinema's
window — but mpv still picks its Wayland context first whenever
`WAYLAND_DISPLAY` is set, and opens its own window anyway. Only an explicit
`gpu-context` would make it draw into Kinema's window, and on X11 that is on
top of the page, not under it.

### A library's warnings go nowhere unless something listens

The libmpv plugin reports through the `log` crate. Nothing listened, so its
one useful sentence — why mpv got no window — was never written anywhere,
and the first Linux runs could only guess. `applog::forward_library_logs`
now sends every library's warnings and errors to `app.log`, named by crate.

### In WSL, Mesa renders in software unless told otherwise

Ubuntu's Mesa in WSL picks `llvmpipe`, and mpv refuses a software renderer
— it tries every context and ends with no picture, while playback, the
clock and the events all look fine. `GALLIUM_DRIVER=d3d12` is WSL's route to
the real card (`glxinfo -B` then names it); `selftest.sh` sets it inside
WSL. With it, mpv decodes on the card (`hwdec-current` = `nvdec-copy` on
the development PC).

### The libmpv wrapper crashes on a client message

`script-message` is the obvious way for an mpv key binding to tell Kinema
something, and the first key pressed took the whole program down. The
wrapper (libmpv-wrapper v0.1.1, `src/event.rs`) walks a client message's
arguments until it meets a null pointer, but mpv gives a count, not a
terminator; it reads past the end. Nothing in Kinema may send or cause a
client message while that stands. Keys come through an observed property
instead (`mpvKeys.ts`).

### `user-data` looks made for passing values, and is not

Values set under `user-data/…` come back from a string read as JSON —
`"9a"`, quotes included — so a binding's `cycle-values` never recognises the
current value and a key pressed twice is one change; `add` on them is
refused (`-2`). A plain string option nobody reads (`term-status-msg`, with
`terminal=no`) behaves as expected.

### mpv runs a mouse button's binding when the button is released

An ordinary binding on `MBTN_LEFT` (`keybind`, input.conf) runs on the
*release* — mpv marks mouse buttons "emit on up" so a double click can be
told from a click — so nothing bound that way ever hears the press, and a
seek bar cannot be dragged. Only a script's binding with `complex = true`
is told both. That is why the mouse on mpv's own window goes through a Lua
script (`pointer/mouse.lua`), and the keys do not.

The script reports through a property, and Kinema hears a property's latest
value, not every value it had: a quick click's press and release can fall
between two readings. Each report therefore carries the last several
events, numbered (`mpvMouse.ts`).

### mpv can know of a click on its window and not where it was

A window opened under a pointer that has not moved since may be told of a
button but never where the pointer is: mpv then says 0,0, and `mouse-pos`'s
`hover` still says true (seen in a nested GNOME). 0,0 is the corner Back
sits in. The script acts on a click only after a move since the window
opened; the first move puts it right.

### Made-up DOM events cannot drag a slider; GDK events can

`dispatchEvent(new MouseEvent(…))` runs the page's handlers but not the
browser's own: no `:hover`, and a range input's thumb does not move. A GDK
event built in Rust and handed to `gtk_main_do_event` — what WebKit's own
test runner does — is taken by WebKitGTK as the user's, covered window or
not: hover, dragging, its own double-click counting from the event times
(`pointer/linux.rs`). Build it with the C functions: `gdk::Event::new`
copies the new event and leaks the original, one per mouse move.

### A covered WebKitGTK window stops producing snapshots

On Linux the player's page reaches the screen as a snapshot mpv draws
(`overlay.rs`), taken while mpv's window covers Kinema's. With the WebKitGTK of
2026-10, in nested KWin 5.27 and GNOME 46, the snapshots simply stopped
arriving after about a second — no error, the callback never runs — because the
compositor stops asking a covered window to draw, and WebKit's DMA-BUF renderer
waited for it. `WEBKIT_DISABLE_DMABUF_RENDERER=1` kept them coming.

That setting cost browsing smoothness on every Linux computer (22–37 frames a
second on a weak one, against 60), so since 2026-11-08 the card draws and the
snapshots are watched instead (`webkit_drawing.rs`): one not back within 3 s is
remembered, and the next start on that system draws on the processor. With
WebKitGTK 2.52 and 2.54 the stop was **not** seen anywhere it was looked for:
real KDE + Intel, headless Sway, nested KWin, an X11 display, and even with the
compositor frozen for 6 s. A frozen *page* process does not imitate it either:
its own requests freeze with it, so nothing waits. The fallback's trigger has
therefore never fired for real; its file and its next start were checked by a
unit test and a start with the file in place.

### `crate::log!` before the log is open goes nowhere

`applog::write` drops a line while no log file is set, and the file is set in
`setup`. Anything decided in `run()` before that (how WebKit draws) has to keep
its sentence and say it later (`webkit_drawing::say_choice`).

### Frame gaps are not the screen's rate

The Look check read the screen's pace from the quickest tenth of the gaps
between frames. Where frames come unevenly — a late one, then an early one to
catch up — that read 8–11 ms on a 60 Hz screen, with the processor drawing *and*
with the card, and Auto chose Light "on a screen that takes one every 11 ms".
The system knows the rate: on Linux GTK has it from the display server for the
monitor the window is on, on any desktop (`page_screen_hz`); elsewhere the
equipment check's. Gaps are the last resort.

### Two listeners of one property shared a "last seen" number

The player hears mpv's mouse script through an observed property whose value
lists the last events, numbered (`mpvMouse.ts`). The engine kept the last
number it handed on in one module-level variable — and two listeners were alive
during every film on Linux (one of them, the first ever made, across all films;
why it lives on is not known). Whichever heard a change first marked the events
seen; when that was the long-lived one, the player's own found nothing new and
the page heard no mouse for the whole film. On the slow Linux test PC with the
processor drawing that was about half the openings, with the card none — a
race, so timing decides. Which events are new is now decided once, where they
reach the page (`pageMouse.ts` `handMouseEventsToPage`), and any listener may
offer them.

### A transparent window without DMA-BUF loses everything but what just changed

That same setting has a price if the window is see-through. WebKitGTK then
repaints only what changed, and on a transparent window the rest is not kept:
hovering a button left that button alone over the desktop, and a real KDE
Wayland box with an Intel card showed the whole page missing, with no error in
any log (GitHub #17). Our WSL and headless runs never showed it, which is why it
reached a release. So Linux's window is opaque (`tauri.linux.conf.json`), which
costs nothing: mpv has a window of its own there, so nothing has to show through
Kinema's.

The page stays transparent, and that is what the player needs. The photo for mpv
asks WebKit for a transparent background, and keeps its see-through parts with an
opaque window behind it (seen on that box: the film moving behind the controls).
If the photo ever came back solid, the controls would hide the film, again with
no error: after a change here, look at a real picture, not the logs.

Linux's config replaces the main config's whole window list rather than adding to
it, so a new window setting has to go in both; a test in `capabilities.rs` fails
if they drift apart.

### `overlay-add` takes a size to scale to only from mpv 0.38

Before that it has exactly nine arguments, and eleven are refused ("has only
9 arguments"). `overlay.ts` tries with `dw`/`dh` and falls back once; the
unscaled page then only lines up when Kinema's window is the screen's size.

Decide that by `mpv-version`, not by the failure. The error that reaches the
page is the plugin's generic "error running command" — the "9 arguments" is
only in `mpv.log` — and the same error comes from an mpv shutting down as the
player closes. The first version took any failure for an old mpv: on the test
stick, mpv 0.41 logged "cannot scale the page" as each run ended, and in use
that path would have made Kinema's window full screen after the player had
gone.

### Quitting with mpv still running crashes on Linux

The plugin shuts mpv down only when a window's close button is pressed.
Kinema also quits by itself — Leave → Close, sleep, shut down, the end of a
self-test — through `app.exit`, and mpv was left running. On Linux the
graphics library then unloads its driver while mpv's video thread is still
drawing with it: a segfault in the `vo` thread during `exit()`, after
everything else had worked (seen in a nested KWin under gdb; WSLg happened
to survive it). `RunEvent::Exit` now destroys mpv first, on every system.

### Quitting with a film on a dead network mount: three silent waits

A film on a share that has stopped answering (sshfs stopped, a dead SMB
server) left Kinema running after its window closed, with nothing in the log:

1. The close button never reaches `ExitRequested`: the mpv plugin's own
   `CloseRequested` handler prevents the close, destroys mpv (which waits on
   the demuxer's read for good) and only then closes the window. A quit
   limit armed in `ExitRequested`/`Exit` never starts. Arm it at the main
   window's `CloseRequested`.
2. `std::process::exit` runs the exit-time clean-up, and that waited on the
   mount too: the limit fired, logged, and the process stayed. End with
   `_exit` (Linux) / `TerminateProcess` (Windows).
3. Even then a thread stuck on the mount keeps the ended process listed
   (defunct) until the mount answers — the kernel's doing — and its single-instance D-Bus name stays owned, so the next start
   waits on it for good. Give the name back (`tauri_plugin_single_instance::destroy`)
   before ending. `engine.rs`, `arm_exit_limit`.

### GNOME's colour mode 2 is not HDR

Mutter's `DisplayConfig` lists a screen's `supported-color-modes` as
numbers: 0 is the default, **1 is BT.2100 (HDR)**, and GNOME 50 added **2,
"sdr-native"** — wide-gamut SDR from the EDID's primaries, offered on screens
that cannot do HDR as well. A screen without HDR therefore lists `[0, 2]` and
one with it `[0, 2, 1]`, so "the first one that isn't 0" picks the wrong
mode. Asking for 2 is accepted, and reading the state back says 2, while the
TV stays in SDR and the compositor goes on telling clients "gamma 2.2, 80
nits" — nothing reports an error. Ask for 1 by number.

### Cinnamon answers GNOME's questions under its own name

Cinnamon's window manager, Muffin, is a fork of Mutter and kept
`DisplayConfig` request for request — the same `GetCurrentState` and
`ApplyMonitorsConfig`, the same shapes — but renamed the service to
`org.cinnamon.Muffin.DisplayConfig` at `/org/cinnamon/Muffin/DisplayConfig`.
Asked by GNOME's name, a Cinnamon session answers nothing, and Kinema used to
offer no switching there at all. It answers in Cinnamon's X11 session (Linux
Mint's default) as well as on Wayland, lists no colour modes and has no HDR.
To test it without a Cinnamon machine, Xvfb is not enough: its one mode has
no refresh rate (Muffin reports `1920x1080@-nan`), and it will not take new
ones. Xorg's dummy driver with modelines in its config gives real modes.

### The ELD files in /proc belong to ports, not to sound devices

`/proc/asound/cardN/eld#C.P` is one file per graphics-card pin, and on many
cards (NVIDIA's among them) the kernel attaches a pin to a PCM device only
when something is plugged in. The receiver on the TV PC was `eld#0.4` and played
on PCM device 3 ("HDMI 0", `hdmi:CARD=…,DEV=0`); nothing in the file says so.
Matching by position works until a second screen is connected. ALSA's `ELD`
control (interface PCM, `device` = the PCM number) holds the same bytes for
the device it is attached to — read that.

### zbus reports a taken bus name as an error

`request_name_with_flags` with `DoNotQueue` on a name someone else owns
returns `Err(zbus::Error::NameTaken)`, not `Ok(RequestNameReply::Exists)` as
the D-Bus reply would suggest. Code that matches on the reply never reaches
its "ask the owner" branch — the device reservation (`audio_reserve.rs`)
gave up on every card the sound server held until a stand-in holder
(`scripts/reserve-holder.py`) showed it. Map `NameTaken` to `Exists`.

### NVIDIA's Vulkan fails if its device files were never made

The driver needs `/dev/nvidia-modeset` and `/dev/nvidia-uvm` besides
`/dev/nvidia0` and `/dev/nvidiactl`. On Ubuntu its udev rule makes them
(`ub-device-create`); on a live USB session with the driver added to the
persistence that never happened, and the driver still loaded, GNOME ran on
it and OpenGL worked — but every Vulkan window failed at
`vkGetPhysicalDeviceSurfacePresentModesKHR` with `VK_ERROR_UNKNOWN`,
`vulkaninfo` crashed inside the driver, and NVDEC could not start. Making the
two files (`mknod`, as `nvidia-modprobe` would) fixed all three at once. mpv
hides the failure by falling back to OpenGL and playing: two failed `…vk`
contexts followed by `Initializing GPU context 'wayland'` in `mpv.log` is the
sign. Check `ls /dev/nvidia*` before blaming mpv.

### NVIDIA's Vulkan offers no HDR colour space on Wayland

With GNOME in HDR, the compositor tells mpv "PQ, BT.2020" — and NVIDIA's 580
driver still lists only `VK_COLOR_SPACE_SRGB_NONLINEAR_KHR` for the window's
surface (mpv.log: "Available surface configurations"). With nothing HDR to
pick, mpv converts the film to SDR and `video-target-params` says gamma 2.2,
BT.709, 203 nits; nothing is logged as an error. OpenGL is no way round it:
mpv has no colour-space hint there and targets BT.1886. This is the driver,
not Kinema, and not fixable by an option: on such a machine HDR films play
tone-mapped to SDR. (Mesa's Vulkan for AMD and Intel is meant to offer the
HDR colour spaces through `wp_color_management`; not yet tried here.)

### `kscreen-doctor` sometimes crashes, and one crash used to cost a session

Plasma 5.27's `kscreen-doctor -j` aborted now and then on its own heap
corruption (`corrupted size vs. prev_size in fastbins`, exit by SIGABRT) —
twice in three Kinema starts under a nested KWin, both while a film was
starting, and not once in 200 calls made one after another or in pairs
under load. Kinema asks once per launch which desktop it is on, so one crash
at that moment meant "not a desktop Kinema can ask" for the whole session:
no switching, and the equipment check saying it could not read the screens,
with nothing else logged. `kscreen.rs` now asks once more when the program
ended by a signal (an ordinary failure, such as an unknown mode, is not
repeated), and `desktop.rs` logs why a Plasma session was not recognised.
Plasma 6.6's did not crash once in a full run on a real TV (six Kinema
starts, a switch and a restore), so it may be 5.27's alone; the retry stays.

### Tiling desktops tile Kinema's window beside the film's

On Linux the player's controls are a photo of Kinema's window drawn over
mpv's. Sway and Hyprland tile windows, so when mpv's window appears Kinema's
is squeezed beside it (933 of 1920 pixels on Hyprland) and the photo is
scaled to the film's shape — stretched and soft, with no error anywhere; on
GNOME and Plasma windows float and it never showed. Both float a window
whose minimum and maximum size are equal *when it appears*, so
`display.rs` → `player_window` hides Kinema's window and shows it again
undecorated at the screen's size, fixed, while the film is full screen.
Undecorated matters: GTK's invisible shadow margins and title bar made a
"1600×900" window 1560×860 of page. It must stop floating when the film
leaves full screen (it would sit over the windowed film) and get its own
full screen back only when the player closes (or it covers the film).
Floating is for sharpness only, not for shape: no desktop's size is trusted.
Sway 1.11 floated it 90 pixels larger than asked, so the page is laid out in
the largest box of the film screen's shape that fits the window
(`overlay.ts` `stageFor`, `#root` sized from `--stage-w/h`) and only that
box is drawn; `app.log` says `overlay: page W×H, drawn W×H on mpv's W×H`.

### Changing the screen under a window leaving full screen froze mpv for a minute

On Linux, leaving full screen used to set mpv's `fullscreen=false` and then
put the screen's mode back at once. In a nested GNOME Shell the desktop
answered that pair with a window of **1×1** (`mpv.log`: `Resizing due to
xdg from 1920x1080 to 1x1`). A paused film is redrawn at the new size, and
with `correct-downscaling` shrinking 1920×1080 to one pixel takes a filter
thousands of taps wide (`Required filter size 4320 exceeds the maximum
allowed size of 4096`), which libplacebo writes out tap by tap: a 300 KB
shader that took the graphics driver close to half a minute per pass. mpv
answered nothing else meanwhile, so every property read, the stop and the
next film waited 50–60 s and then all answered at once. No error anywhere;
`mpv.log` just has a gap. It happened in every paused run tried (both
the Back button and the Back key), depending only on which of the two
requests the desktop handled first; while playing it never showed.

**Do:** where the picture is mpv's own window, put the screen back *first*,
while that window is still full screen and simply follows the screen
(`useScreen.ts` → `leaveFullscreen`), and do not take it out of full screen
at all when the player closes — the window closes with the film. Kinema's
own window (Windows) keeps the old order.

### Hyprland's report does not show HDR it passes through

With its defaults, a full-screen HDR window takes Hyprland's passthrough
path: the window's HDR metadata goes to the screen and the screen's own
colour setting is untouched, so `hyprctl monitors` keeps saying `srgb` and
an 8-bit format while the TV is in HDR. The connector says what is sent:
`modetest -c` shows `Colorspace` and `HDR_OUTPUT_METADATA` (empty when
SDR); Hyprland's log (`debug:disable_logs = false`) says `[CM] Updating HDR
metadata from surface`.

---

## Android

### A plugin with no Android side breaks the build twice

`tauri-plugin-libmpv` and `tauri-plugin-single-instance` have no mobile
code. Moving them under a target-specific dependency
(`cfg(not(any(target_os = "android", target_os = "ios")))` in Cargo.toml)
is not enough: `capabilities/default.json` still names `libmpv:default`,
and tauri-build stops on Android with "Permission libmpv:default not
found" and a list of hundreds of others. **Do:** put such a plugin's
permissions in a capability file of its own with `"platforms"` limited to
the desktop systems (`capabilities/player-mpv.json`). In Rust, `#[cfg(desktop)]`
and `#[cfg(mobile)]` come from tauri-build; `engine.rs` is the one place
the player plugin is named.

### Android's Back closes the app from any screen

The system's Back — a remote's Back button, a phone's gesture — is not a
key the page receives. Tauri's activity sends it to the WebView's own
history, and Kinema has none, so Back in the middle of Settings left the
app for the TV's home screen. **Do:** listen with `onBackButtonPress`
(`@tauri-apps/api/app`); with a listener present Tauri leaves the press to
it. `backButton.ts` passes it on as a `BrowserBack` key press to whatever
has focus, which every screen already handles.

### OK does nothing until an arrow has been pressed

At start the WebView does not have Android's focus. An arrow key goes
looking for something to focus and finds it; the remote's OK (DPAD_CENTER)
does not, so on a fresh start OK on the first-run page did nothing, twice.
**Do:** request focus for the WebView when it is created
(`MainActivity.onWebViewCreate`).

### Tauri's folder picker does not exist on Android

`open({ directory: true })` from the dialog plugin rejects with "Folder
picker is not implemented on mobile". Android TV 11 and later often has no
system folder picker either, and where there is one it answers with a
document address, not a path the scanner can walk. **Do:** ask
`chooseFolder` (`library/folders.ts`), which opens Kinema's own browser
wherever the capabilities say `folder_picker: false`.

### Android shows an app only the kind of file it asked for

From Android 13, reading a USB drive by path needs READ_MEDIA_VIDEO, and
with only that a folder lists its videos and subfolders — the `.srt`,
`.nfo` and `.skiptro.json` files beside a film are simply not there, with
no error. Up to Android 12 READ_EXTERNAL_STORAGE shows every file. **Do:**
treat a missing sidecar on Android as possibly hidden; "All files access"
(MANAGE_EXTERNAL_STORAGE) brings them back, and is granted in the system's
settings, not in a dialog. On Android TV that screen is a list of every
app, whichever of the two intents opens it; the person has to find Kinema
in it (`StoragePlugin.kt`).

### `run-as` does not see what the app sees on a drive

`adb shell run-as com.kinema.app ls /storage/…` answers "Permission
denied" even when Kinema has been allowed to read the drive: the
permission belongs to the app's process, not to its user id in a shell.
**Do:** check what Kinema can read through Kinema — the folder browser,
a scan, a self-test plan that plays a file from the drive.

### Android says the HDMI output takes a format it then refuses

A box with its own surround setting at "never" still reported DTS through
HDMI, Media3 passed a film's DTS through, and Android refused the output
(`ERROR_CODE_AUDIO_TRACK_INIT_FAILED`): the whole film failed. **Do:** treat
any failure of the sound renderer as a reason to step down, not to stop
(`Media3Plugin.kt` `fallBack`).

### Media3 leaves out sound it cannot play, without an error

A track neither decoded on the device nor offered by the HDMI output for
sending on untouched (TrueHD on most devices, even with a receiver that
takes it) is marked `NO_UNSUPPORTED_SUBTYPE` and simply not chosen. No
error comes, so a fallback that waits for one never runs, and a film whose
only sound is that track plays silent with no word. **Do:** once the
tracks are known, if none of the sound tracks is chosen, choose one that
can play, or say the film plays without sound (`Media3Plugin.kt`
`soundLeftOut`).

### Android's surround setting is not what a box does

`Settings.Global` `encoded_surround_output` read 1 ("never") one night
and 2 ("always") the next on an operator's box, while the box's own menu
was what decided whether surround reached the receiver. Repeating it in
Settings told the user something false. **Do:** report what the player
did — Media3's `onAudioTrackInitialized` gives the encoding that reached
the output (compressed and not offloaded = passed through) — and say
the device's own settings can overrule what Android reports.

### Media3 cannot tell Atmos in a Matroska file

A film whose track is Dolby Digital Plus with Atmos (E-AC-3 JOC) comes out
of Media3's Matroska reader as plain `audio/eac3`, and its output encoding
as E-AC-3: the receiver still showed Atmos, because the stream went through
untouched. **Do:** never claim Atmos from Media3's format on an `.mkv`; name
what it reports ("Dolby Digital Plus 5.1").

### Media3 gives no frame rate for a Matroska file

`Format.frameRate` is unset for every `.mkv` tried, though Media3's
Matroska reader reads the file's frame duration (`DefaultDuration`) — it
never turns it into a rate. Matching the screen's refresh rate to the film
then had nothing to match. Waiting for frames to be shown does not help
either: the film is held paused while the screen switches. **Do:** work it
out from the video samples' times as Media3 reads the file ahead, which it
does while paused (`FrameTiming.kt`, wrapping the extractors). Matroska's
times are rounded to a millisecond, so it takes about 4.5 s of film to tell
23.976 from 24; the rate is snapped to the standard one it is, and a file
whose frames are not evenly timed gets none rather than a guess.

### "Never past the device's capabilities" turns off the picture too

After a sound fallback the player was built with
`setExceedRendererCapabilitiesIfNecessary(false)`, so that a sound track
the device cannot play is not chosen again. The setting is for every kind
of track: a box's decoder listed a 4K HEVC film's level as beyond it
(`NO_EXCEEDS_CAPABILITIES`), though it had just shown that film's first
frame, and the reopened film played as sound alone over a blank screen.
**Do:** apply it to the sound only — `DefaultTrackSelector.selectAudioTrack`
overridden (`Media3Plugin.kt` `soundOnlySelector`) — and leave the
picture Media3's own leeway.

### A choice can land on the player a fallback is replacing

A sound fallback builds a new player, which reads the film's tracks
afresh. The page reads the tracks and chooses the remembered subtitles a
moment after the film opens; when the fallback falls in between, the
choice reached a player with no tracks yet, was refused, and the
subtitles never came on. Whether it happens is a matter of milliseconds
(a subtitle file beside the film was enough to shift it). **Do:** a choice
that finds no tracks yet waits for them (`selectTrack` → `choose`); the
film is the same, so its tracks are numbered the same.

### Media3 1.11 ignores `setAudioCapabilities`

Building the sink with `DefaultAudioSink.Builder.setAudioCapabilities(
DEFAULT_AUDIO_CAPABILITIES)` to stop passthrough did nothing: Media3 1.11
works the HDMI output's capabilities out again in its own output provider,
and passed DTS through anyway. **Do:** wrap the sink
(`ForwardingAudioSink`) and answer unsupported for anything that is not
decoded PCM; then Media3 decodes, or picks a track it can decode.

### Media3 does not open `.m2ts`

A Blu-ray stream file (`.m2ts`, 192-byte packets) fails with "None of the
available extractors": Media3's transport-stream reader reads 188-byte
packets, and the 192-byte ones of `.m2ts` are not recognised. Kinema reads
them with its own extractor (`M2tsExtractor.kt`), which hides the 4 extra
bytes of each packet from Media3's reader and turns the places it gives out
back into the file's own. It is added ahead of Media3's list in
`FrameTimingExtractors`. A disc's streams differ from a broadcast's too, in
ways that give no error:

- Media3's factory reads stream type 0x80 (a disc's uncompressed sound) as
  video and 0x86 (DTS-HD) as an ad marker. `BdTsPayloadReaderFactory.kt`
  decides these first. Dropping 0x80 made an LPCM disc play silent with no
  track listed and no word: `BdLpcmReader` gives it as PCM, the disc's
  big-endian samples and channel order turned into the WAV order.
- ffmpeg, making a `.m2ts`, writes AAC and MPEG sound as stream type 0x06
  ("private data") with no descriptor; Media3 reads that as nothing, so the
  sound was silently missing. The start of the file is looked at for what
  those streams' bytes are (`BdCoreScan.soundByBytes`).
- Dolby TrueHD (0x83) is one stream holding the TrueHD access units and, now
  and then, a Dolby Digital frame. Media3 has no reader for it. It is given
  as two tracks, TrueHD and the Dolby Digital "core".
- **A track Media3 is told of must get a format**, or preparing the film
  waits for it until the end of the file. A TrueHD stream without a core
  would hang if its core track were made regardless, so the start of the
  file is scanned for one first (`BdCoreScan`). A track made after
  Media3 has the tracks is dropped without a word.
- A disc's Dolby Digital Plus (0x84, 0xA1) is an AC-3 frame followed by
  E-AC-3 dependent frames. Media3's reader makes a sample of each frame and
  flips the track between `ac3` and `eac3`: the sound output reopened five
  times a second and stalled. `BdEac3Reader` joins them into one sample with
  one format (channels of all the frames together, each place counted once,
  at most 8: a first count read the dependent frame's channel map in the
  wrong order and gave 11, which the decoder refuses).
- Bytes the extractor looks at ahead (`peek`) are moved down in the input's
  buffer on every read after, so a long look ahead costs more than its
  length; and a loop over every byte of it is seconds on a weak box. The
  look for a Dolby Digital core is 1 MB and reads headers, not bytes.
- Picture subtitles (0x90) come one segment to a packet; Media3's reader
  wants a whole display set in a sample.

Tried on streams put together to this layout and played through Media3's
own reader on a computer; not yet on a file from a disc.

### A 1080p TV gives the page 960×540

Android TV's WebView draws at twice the density, so on a 1920×1080 screen
the page is 960 by 540 CSS pixels, not 1920 by 1080: the TV layout is laid
out for a much shorter screen than the photo suggests. A browser check at
1920×1080 passed while the first run's buttons sat half off the real TV.
**Do:** check layouts for Android at 960×540.

### Tauri never tells an Android plugin that the app left the screen

`Plugin.onStop` and `onResume` exist, and Tauri 2.11 generates the observer
that calls them (`TauriLifecycleObserver` in the generated
`TauriActivity.kt`), but never registers it. Nothing fails: the calls just
never come. A film went on playing behind the home screen, holding the
box's only video decoder, until the operator's own TV app took it away.
**Do:** register it in `MainActivity.onCreate`
(`ProcessLifecycleOwner.get().lifecycle.addObserver(TauriLifecycleObserver)`);
registering it twice is harmless if a later Tauri does it too.

### An app behind the home screen goes on working, and Android lets it

Nothing stops a page or its native side when Kinema leaves the screen: the
WebView only slows the page's timers, and a worker and Rust's threads are not
slowed at all. A scan left behind on a 2-core box read file names at one full
core, and the box got slower with Kinema nowhere in sight, so people force
closed it. There is no error, and an idle Kinema or a film left paused cost
next to nothing, so only a scan shows it. **Do:** work a person is not waiting for calls
`yieldToPlayback` (page) or `jobs::wait_for_turn` (Rust) between its units, and
gives a worker small parts rather than one long batch, which cannot be stopped.
`presence.ts` turns Kinema's being in front or not into those two flags; any key
proves it is in front, because a scan waiting by mistake looks like one that
never ends. A desktop never sets them.

### A TV box's screen going off stops a scan, and says nothing until someone is back

When a box goes to sleep at its screen timeout, Kinema has left the screen, so
the rule above holds the scan there. A film stays awake on its own. Seen on a box
whose timeout is 60 minutes: the scan stopped at the moment the screen went off
and went on at wake with nothing lost, and the "Picked up after a pause" line
only shows once someone is there to read it. **Do:** a library's first scan keeps
the screen on (`screenHold.ts`, Android's `FLAG_KEEP_SCREEN_ON`), on a lease it
renews as the work moves on, so a step that hangs cannot hold a TV awake for
good; a film lets go, since a paused one could otherwise do just that. Later
scans still wait. The flag stays set when Kinema is behind, and Android ignores
it there: `dumpsys window` showing it proves nothing about the screen, read
`mWakefulness`. An emulator has `stay_on_while_plugged_in` at 15 and never sleeps
until that is 0, which looks exactly like a hold that is never let go.

### Seek parameters do not reach the position Media3 opens at

`setMediaItem(item, start)` with `SeekParameters.PREVIOUS_SYNC` changes nothing:
they are used only for a seek on a prepared file. Opened at a resume point,
Media3 decodes from the keyframe before it and shows nothing until it gets
there, 2.8 s against 0.5 s on a box with keyframes ten seconds apart. **Do:**
seek to the same place with those parameters at the first `onTracksChanged`
that has tracks, before any frame is shown, and put them back straight after
(`Media3Plugin.kt` `resumeMs`).

### A WebView older than the build target is a black screen, and no message

The interface's JavaScript is built for Vite's default target. WebView 66
(Android TV 9's own, on a device that never updates it) stops at the first `?`
with "Unexpected token ?": no page, no log file, a black screen for good. **Do:**
when something looks dead on an old system, read the page's exceptions over
the debugging socket before anything else; the app's own log starts too late.
The small script at the top of `index.html` now says so in plain words. It keeps
to the oldest syntax, has no timer so a slow start cannot trip it, and acts only
on an error before anything is drawn: a `SyntaxError` before `ran.ts` has run, or
any error when something the interface uses is missing. `new Function` cannot
test the syntax: the page's CSP refuses it on a healthy engine too. The same goes
the other way: `Runtime.evaluate` is let through the CSP, so `new Function` working
over the debugging socket proves nothing about the page's rules; a stray inline
script does. An inline script of our own passes because Tauri hashes it at build.

### A TV box may have one video decoder, and the app in front is owed it

A box's decoder list can say `concurrent-instances max="1"`. An app that
keeps playing in the background keeps it, and the next app gets "no video
decoders available" (`ERROR_CODE_DECODER_INIT_FAILED`, `0xfffffff4`); if
the next app is in front, Android takes it back from the one behind
(`ERROR_CODE_DECODING_RESOURCES_RECLAIMED`). **Do:** pause and `stop()` the
player when Kinema leaves the screen, `prepare()` it again, paused, when it
returns (`Media3Plugin.kt`, `suspended`).

### smb-rs, the SMB library, needed two fixes to stream at all

Without `TCP_NODELAY` every request waited ~40 ms for a delayed
acknowledgement (22 MB/s reading a file on one machine instead of 368).
And its blocking receiver polls with a 100 ms read timeout and used
`read_exact`, which loses what it had read when the timeout falls inside a
message: on any slow link the next read starts mid-message ("bad magic")
and the connection never recovers. **Do:** keep the patched copy in
`src-tauri/vendor/` (its README lists the changes) until a released
version has them; `netshare::tests::a_slow_link_loses_nothing` fails
without the second.

### smb-rs's share list is NDR64 only, and Samba refuses NDR64

`Client::list_shares` binds `srvsvc` with the 64-bit encoding alone, and
Samba — inside most home NAS boxes — answers
`ProposedTransferSyntaxesNotSupported`. **Do:** `srvsvc.rs` sends
`NetrShareEnum` in classic NDR over the library's pipe. The library also
cannot finish a guest's sign-in ("session setup succeeded before SSPI
authentication completed"), and panicked when two sign-ins ran at once on
one connection; netshare signs in to one server one share at a time.

### Media3 says nothing about a file's tracks until it has read them

`prepare()` returns at once, and the tracks come later, in
`onTracksChanged`. The plugin used to say `loaded` as it handed the file
over, and the page put the remembered languages on a file with no tracks
yet: nothing was chosen, and no error said so. **Do:** say `loaded` at the
first `onTracksChanged` that has tracks (Media3Plugin.kt), which is what
`loaded` means in engine.ts.

### Media3 renames the subtitle files it is given

A `SubtitleConfiguration` given the id `kinema-file:1` comes back in
`currentTracks` as `1:kinema-file:1`: Media3 puts the number of the file's
source in front. Comparing ids for equality found nothing, so the files
were not marked "separate file" and an added one "timed out" although it
had loaded (seen on the emulator, 2026-10-05). **Do:** match the end of
the id (`isFile`, `contains(EXTERNAL)`).

### Media3's subtitle layer needs Kotlin 2.2 to build

`media3-ui` 1.11 is built with Kotlin 2.2 and brings its standard library;
Tauri's Android project compiled with Kotlin 1.9, which cannot read it
("compiled with an incompatible version of Kotlin"), and every Kotlin file
failed. **Do:** keep the Kotlin Gradle plugin (`gen/android/build.gradle.kts`)
at the standard library's version or above.

### tauri-plugin-http's fetch error hides the cause and shows the keys

The error is reqwest's top-level text, "error sending request for url (...)".
The URL includes query keys, and the real cause (DNS, TLS, refused) is only in
the error's source chain, which the webview never sees. Every failure then
looked the same, and the log held the keys. **Do:** use `reach.rs`
(`check_reach`) to ask the host again from Rust, and never print the raw URL
without `applog`'s key hiding.

### mpv plays a text file named `.mkv` as a playlist and fetches what it names

mpv picks the demuxer by content, not by extension: an M3U, PLS, CUE or mpv
EDL saved as `.mkv` is opened as that playlist, and mpv then requests every
address in it, `http://` included. With yt-dlp installed, mpv's ytdl helper
visits the address again posing as a browser. **Do:** keep
`access-references=no` and `ytdl=no` in `BASE_MPV_OPTIONS` (`mpvOptions.ts`);
Kinema reads its own playlists. The same switch also turns off Matroska
ordered chapters (mpv `demux_mkv_timeline.c`), so such a file plays straight
through; `bd://` and `sub-add` are not references and still work.

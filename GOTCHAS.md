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

### `loadfile` is asynchronous

Seeking immediately after it fails — there is nothing loaded yet. Decide the resume
position before loading, apply it on the `file-loaded` event.

### Initialising mpv twice corrupts native state

React StrictMode double-invokes effects and HMR remounts components; either can call
`init()` against a live instance and take the process down. The guard lives on
`window` (not module scope — Vite replaces the module on HMR). StrictMode is
deliberately **off** in `src/main.tsx` for this reason.

---

## Frontend

### `process is not defined` from guessit-js

guessit-js reads `process.env.DEBUG_*`. In Node those are harmlessly `undefined`; in a
webview the bare `process` reference throws on the **first parse call**, so the parser
appeared to work and find nothing. Fixed by a Vite `define` mapping `process.env` to
`({})` — those three debug flags are its only `process` usage.

**Lesson:** a library working under Node proves nothing about WebView2. Test in the app.

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

The running `.exe` is locked. Stop `personal-netflix` first.

### Verify a Rust rebuild by timestamp

`cargo build` output is easy to misread when filtered. Compare the binary's mtime
against the source file you just edited.

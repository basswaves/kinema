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
(`…\Roaming\com.personalnetflix.app`), not the OS `%APPDATA%`.

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

### A bare `<button>` is invisible to a remote

`useFocusable` is what puts a control in the focus tree. A plain `<button>`
renders, styles, hovers and clicks perfectly while being completely unreachable
by D-pad. Four of them survived several phases of development this way.

**Do:** use `src/ui/FocusButton.tsx` in the browsing UI.

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

The running `.exe` is locked. Stop `personal-netflix` first.

### Verify a Rust rebuild by timestamp

`cargo build` output is easy to misread when filtered. Compare the binary's mtime
against the source file you just edited.

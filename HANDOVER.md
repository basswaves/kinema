# Handover — what is left

**This file is the only place open items live.** PLAN.md records decisions and
why they went the way they did; GOTCHAS.md records traps. What remains to be
done is a different question with a different shelf life, and keeping it in
three places is how three copies drift apart.

In Claude Code, **CLAUDE.md is loaded automatically** and carries the working
rules, the settled decisions and the verification commands. Nothing needs
pasting; just say what you want next. The block under *Starting a fresh chat
elsewhere* is for a tool without that.

---

## Hardware this runs on

Several open questions are gated on it: a 2560×1600 **SDR** panel at 59.972 Hz,
a desktop GPU, media on local disk and SMB. Audio goes to the onboard device, not
a receiver.

---

## Worth doing, in rough order of payoff

### Audio is decoded and downmixed, never passed through

There is no `audio-spdif` configuration at all, so mpv decodes everything to PCM
and hands it to the default Windows device — onboard stereo here, so a 5.1 AAC
track arrives as 2.0. An AVR would receive that downmix rather than the original
bitstream, and TrueHD/Atmos and DTS:X object metadata are lost entirely before
they ever leave the app.

**This is a bigger departure from creator's intent than anything in the scaler
path.** Not fixable blind: enabling passthrough on a device that does not
support the codec produces silence or noise, so it needs the real AVR present to
verify, plus a device selection (mpv's `--audio-device`) because the default
device is the wrong one here. Note it is mutually exclusive with the
display-clock frame timing switch.

### Smooth motion (`tscale=oversample`) — deferred, not rejected

The one remaining lever on 24p judder short of a display-mode change. It is
madVR's "smooth motion": most refreshes still show a pure source frame and only
the transition refresh is a blend of two, trading discrete 3:2 judder for a
slight smear. It requires display-clock timing, which now exists.

It does alter frames, which cuts against "nothing invents frames or detail", so
it is a decision rather than an improvement. **Ask before enabling it.**

### Minimum confidence for skip markers

`.skiptro.json` carries a `confidence` value nothing reads. A skip fired on a bad
detection jumps over real content — the same class of silent wrongness as a bad
metadata match. Needs a low-confidence sample to calibrate against; every marker
in the library so far reports `1`.

Now more likely to come up than it was, since detection can be run from inside
the app over a whole library rather than by hand on one season at a time.

### Delete `src/spike/`

The Phase 0 mpv harness. Off the UI and unreachable, but still the diagnostic
tool for HDR passthrough, which is unverified for want of an HDR display. Delete
it, its styles in `App.css`, and this note once that is confirmed.

### Back from a detail page always goes Home

Opening a title from a **See all** grid and pressing Back returns to Home rather
than to the grid. A view stack instead of a single `View` would fix it. Left
alone deliberately: it is a behaviour change, not a bug fix, and nobody has said
the current behaviour annoys them.

---

## Unverified

- **HDR passthrough** — untestable on this SDR panel. HDR *decode* and
  tone-mapping to SDR are confirmed on real content by the stats panel, not
  merely by the picture looking right: a 4K HDR10 remux reads pq / bt.2020-ncl /
  1000 nits in, tone mapped with bt.2390 off a measured peak.
- **`vo-passes`** — returns nothing on this gpu-next build, so the stats panel's
  render-pass list is empty and every rendering row is a *requested* setting
  rather than an observed one. The panel carries the error. Worth revisiting if
  mpv is ever updated.
- **Per-show track memory across episodes** — implemented, but a bug in reading
  `sid` was aborting the apply path until late in Phase 4.
- **NFO against a real third-party file** — verified only as a round trip
  through this app's own export. Every fixture is synthetic. A dialect too far
  logs `nfo: nothing usable in <path>` rather than failing silently.
- **A credits chapter to calibrate against** — the chapter source for end-credit
  skipping cannot be confirmed until a file actually carries a chapter named for
  its credits. Until then the tail guess is what fires; `credits marker from
  <source>` in `app.log` says which won.
- **Real TV overscan**, and whether `--ui-scale: 1.45` is right at sofa
  distance. Both need a TV; the value is one constant in `ui.css`.
- **Behaviour at scale** — the library is small. Rails cap at 30 with a "See
  all" grid and the scanner no longer holds the database lock, but neither has
  met a few hundred films.
- **The four stats fixes** (video rectangle, `hw-pixelformat`, SDR peak, cadence
  after deinterlacing) are written and built but not eyeballed against the three
  test files that exposed them.

---

## Starting a fresh chat elsewhere

I'm continuing work on **Personal Netflix**, a local serverless media library
(Tauri 2 + React 19 + libmpv) at:

`C:\Projects\kinema`

**Read these before writing any code:**

1. `CLAUDE.md` — working rules, settled decisions that must not be re-opened,
   and how to verify. Start here.
2. `PLAN.md` — what is done and why each decision went the way it did.
3. `GOTCHAS.md` — traps in libmpv, Tauri, SQLite, child processes, spatial
   navigation and XML parsing. **Read before touching the player or D-pad
   navigation.** Nearly every entry describes a failure that produces no error
   at all.
4. `README.md` — architecture and data flow.

The app works end to end and the roadmap is complete: scanning, matching,
browsing, playback with resume and next-episode autoplay, cached artwork, the
manual fix-match queue, intro skipping with detection runnable from Settings,
local-file trailers, a 10-foot TV layout, NFO read/write, watched tracking,
previous/next episode stepping, end-credit skipping, title logos and cast, and a
madVR-style "stats for nerds" panel.

It launches from a desktop shortcut rather than a terminal: `npm run app:build`
assembles `dist-app/` and refreshes the shortcut. Logs land beside the exe when
launched that way.

**How I work:** I test in the real app and report back — tell me exactly what to
click, what a pass looks like, and what a failure would look like. Confirm the
order with me before starting a multi-item request.

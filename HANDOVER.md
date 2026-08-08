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
GTX 1080 Ti, media on local disk and SMB. Audio goes to the onboard device, not
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

Skiptro records a `Confidence` per detection and nothing acts on it. A skip fired
on a bad detection jumps over real content — the same class of silent wrongness
as a bad metadata match. Needs a low-confidence sample to calibrate against;
every detection in the library so far reports `1`.

Half-done: `skip.rs` now logs `skiptro: confidence <n> for <file>` for anything
below 1, which is how the missing sample gets found. Once there is one, the
threshold goes in the same place.

### Retiring Skiptro

Now genuinely on the table. `analyse.rs` does everything Skiptro does and finds
credits as well, on the same files, agreeing within a second. Skiptro is ranked
first for intros deliberately, so nothing regressed — but if a few months of use
show no case where it wins, dropping it removes an external binary, a private
schema read at `%APPDATA%\Skiptro\skiptro.db`, and the whole `detect.rs` command
template arrangement.

**Do not do this on one season's evidence.** The comparison it needs is a
library with several shows in it.

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
  its credits. `credits marker from <source>` in `app.log` says which won, and
  `intro marker from <source>` does the same for the intro.
- **A credits marker from TheIntroDB, in this library** — the source is verified
  against the live API (Breaking Bad S01E01 returns one) but **Sex and the City
  has none**, and it is the only series here. The app's own analysis now supplies
  the credits instead, so the introdb credits path is still untested against a
  real playback. Any show with community credits data confirms it.
- **`analyse.rs` on a second *show*** — two seasons of one show now work. Season
  2 was added later and analysed correctly on its first Detect run, which also
  exercised the grouping on a real second shape: its episodes sit directly in
  the show folder with no `Season 2` subfolder, and were still grouped as one
  season by title and season number rather than by directory.

  What that still cannot tell you is whether `MAX_SCORE = 8.0` holds for a show
  with a quiet intro, a spoken cold open, or no closing theme — every threshold
  remains calibrated against one programme. `calibrate_against_a_real_season` is
  the tool: point `KINEMA_SEASON_DIR` at a folder and run it with `--ignored`.
- **Black-frame refinement on credits that do *not* roll over black.** Every
  constant in it was set against one show whose credits are cards on a black
  background, which is the case it handles best. A show that cuts straight from
  the last shot to credits over live picture should simply find no black period
  and keep its audio answer — that is the designed behaviour and it is untested.
  The `credits … → … from the picture` and `kept the audio credits at …` lines
  in the Detect output say which happened for every episode.
- **A season where Skiptro and `analyse.rs` disagree** — they agree within a
  second on everything here, so the ranking between them has never actually been
  exercised. `intro marker from <source>` in `app.log` is what to watch.
- **Real TV overscan**, and whether `--ui-scale: 1.45` is right at sofa
  distance. Both need a TV; the value is one constant in `ui.css`.
- **Behaviour at scale** — the library is small. Rails cap at 30 with a "See
  all" grid and the scanner no longer holds the database lock, but neither has
  met a few hundred films.
- **The four stats fixes** (video rectangle, `hw-pixelformat`, SDR peak, cadence
  after deinterlacing) are written and built but not eyeballed against the three
  test files that exposed them.

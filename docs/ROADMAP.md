# Roadmap — what is left

**This file is the only place open items live.** [PLAN.md](PLAN.md) records
decisions and why they went the way they did; [GOTCHAS.md](GOTCHAS.md) records
traps. What remains to be done is a different question with a different shelf
life, and keeping it in three places is how three copies drift apart.

Two kinds of thing are listed below, and the distinction matters more than the
usual roadmap/backlog split:

- **Worth doing** — features and cleanups that are simply not built yet.
- **Unverified** — things that *are* built, and have only ever been exercised on
  one machine, one display and one television series. These are not known to be
  broken. They are known not to have been tested, which for a project asking
  other people to run it is the more useful thing to say out loud.

If you are looking for somewhere to start, the unverified list is worth more
than the backlog: most of it needs hardware the author does not have.

---

## Hardware this runs on

Several open questions are gated on it: a 2560×1600 **SDR** panel at 59.972 Hz,
a desktop GPU, media on local disk and SMB. Audio goes to the onboard device, not
a receiver.

---

## The improvement plan (from the September 2026 review)

Agreed with the owner on 2026-09-23 after a full review of the code, the logs and
the library database. One commit per item on `master`. Phase 0 — the safety
net and the test tools — is done; what follows is what is left, in order.

Decisions that shape it: the **Skip intro button shows from 0:00** whenever an
intro is known and stays until the intro ends, and pressing it during a cold
open jumps to the end of the intro (chosen knowingly — it skips the cold open
too); **Skiptro stays first** for intros; nothing is tested by hand.

**Phase 1 — starting playback and the Skip button.** No see-through window
before the first frame (mpv's idle surface is drawn with alpha: an opaque
idle background, a black cover in the player until the first frame, mpv
started with the app). Resume opens at the position instead of playing 0:00
and seeking. Playback does not wait on the startup scan. Skip intro from 0:00
to the end of the intro, no ten-second auto-hide, back after seeking into the
intro. mpv listeners registered once, so `file-loaded` cannot be missed.
Skiptro reads with a busy timeout and logged failures. **Found by the new
harness:** after launch, focus is left on the first-run panel's unmounted
button (norigin removes focusables on a delay, so `useClaimFocus`'s liveness
check passes), and a remote's first presses do nothing.

**Phase 2 — watching correctness.** Leaving or skipping in the credits counts
as watched (reproduced in the mock: "Play next" at 92.7% leaves the episode
unwatched). Continue Watching's Remove sticks. The `duration − 60s` guess only
offers, in automatic mode too. Duplicate and provider-unlisted episodes on the
detail page. Double-episode files. Media keys. A file still being written is
not marked watched.

**Phase 3 — library and matching.** Title from the show folder when the file
and its season folder have none; untitled files go to Needs attention rather
than vanishing. Unlink and manual links survive the next launch and a touched
file. Refused groups re-asked only when keys change. The NFO bare-`<id>` trap.
Trailer lookups not repeated every launch. TVmaze pacing. Artwork downloaded
in the scan that found it. The analysis's two-other-episodes rule.

**Phase 4 — responsiveness.** Slow commands off the main thread; one job
runner for scan, detection and artwork (no double runs, cancellable).

**Phase 5 — structure.** (a) Library rules and the pipeline into Rust.
(b) Watch history per episode rather than per file path, surviving moves,
renames, upgrades and re-added folders — a migration, rehearsed on a copy of
the real library first. (c) The player split around one event stream and one
state machine.

**Phase 6 — cleanup and docs.** Dead code, duplicated helpers, fewer TMDB and
track-list round trips, a CSP, and correcting the claims the review found
false (listed in the review; GOTCHAS' "two different channels" is one).

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
as a bad metadata match.

**The sample it was waiting for exists.** This section used to say every
detection reported `1`; that was never true — the `skiptro: confidence` log
line went through `eprintln!`, which a release build has no console for, so
nobody saw it. Measured on 2026-09-23 against Skiptro's own database: **23 of
79 intro detections are below 1**, lowest 0.48. And they are not random:

| Skiptro confidence | What the analysis says |
|---|---|
| 0.9 – 1.0 (56 episodes) | agrees, mostly within a second |
| 0.70 (S04E05–E11) | intro ends ~7 s later (37.6 s vs ~44.5 s) |
| 0.48 – 0.70 (all of S06) | intro ends ~15 s later (29.1 s vs ~44 s) |

So every large disagreement is one Skiptro itself was unsure of. **Done,
2026-09-23:** below 0.8 the analysis's intro is used instead
(`MIN_SKIPTRO_CONFIDENCE` in `skip.rs`), and Skiptro keeps first place wherever
it is confident. With no analysis for the episode, the unsure Skiptro intro is
still used, ahead of TheIntroDB.

### Retiring Skiptro

**Decided against, 2026-09-23.** the owner reports no bad intro endpoints and wants
Skiptro kept as the first intro source. The earlier claim here, that the two
detectors "agree within a second", did not survive measurement — see the table
above — but the disagreements coincide with Skiptro's own low confidence, so
they are a reason for a confidence threshold, not for removal — and that
threshold is now in place.

### The Phase 0 mpv harness is gone, if you need it back

`src/spike/PlayerSpike.tsx` was the diagnostic tool for HDR passthrough — a
standalone window that loaded one file and dumped every mpv property that
matters to the render pipeline. It was unreachable from the UI and was deleted
before publishing, along with its styles in `App.css`: 629 lines of dead code is
a lot to ask a first-time reader to walk past.

**If you have an HDR display and want to verify passthrough, it is worth
resurrecting rather than rewriting:**

```bash
git log --oneline --diff-filter=D -- src/spike/PlayerSpike.tsx
git checkout <that commit>~1 -- src/spike/ src/App.css
```

It renders through the same `ensureMpvInitialised` as the real player, so what
it reports is what the player gets.

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
  against the live API (Breaking Bad S01E01 returns one) but **Example Show
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

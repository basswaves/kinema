# Handover — starting a new session

In Claude Code, **CLAUDE.md is loaded automatically** and carries the working
rules, the settled decisions and the verification commands. Nothing needs
pasting there; just say what you want next.

The block below is for a fresh chat *without* that (claude.ai, a different
tool). It deliberately does not repeat the constraints — they live in CLAUDE.md,
and two copies of a rule drift apart the moment either is edited.

---

I'm continuing work on **Personal Netflix**, a local serverless media library
(Tauri 2 + React 19 + libmpv) at:

`C:\Projects\kinema`

**Read these before writing any code:**

1. `CLAUDE.md` — working rules, settled decisions that must not be re-opened,
   and how to verify. Start here.
2. `PLAN.md` — what is done and why each decision went the way it did.
3. `GOTCHAS.md` — traps in libmpv, Tauri, spatial navigation and XML parsing.
   **Read before touching the player or D-pad navigation.** Nearly every entry
   describes a failure that produces no error at all.
4. `README.md` — architecture and data flow.

The app works end to end and the roadmap is complete: scanning, matching,
browsing, playback with resume and next-episode autoplay, cached artwork, the
manual fix-match queue, intro skipping, local-file trailers, a 10-foot TV
layout, a Settings screen with automatic background scanning, NFO read/write,
watched tracking, previous/next episode stepping, end-credit skipping, removal
from Continue Watching, and a madVR-style "stats for nerds" panel.

It launches from a desktop shortcut rather than a terminal: `npm run app:build`
assembles `dist-app/` and refreshes the shortcut. Logs land beside the exe when
launched that way.

**Hardware this runs on**, since several open questions are gated on it: a
2560×1600 **SDR** panel at 59.972 Hz, GTX 1080 Ti, media on local disk and SMB.
Audio currently goes to the onboard device, not a receiver.

**What is left, in rough order of what would pay off most:**

- **Audio is decoded and downmixed, never passed through.** No `audio-spdif` at
  all, so a 5.1 or 7.1 track reaches the default Windows device as 2.0. This is
  a bigger loss of creator's intent than anything in the scaler path. Needs the
  real AVR present to verify, plus a device selection, and it is mutually
  exclusive with the display-clock frame timing switch.
- **Smooth motion — deferred, not rejected.** `tscale=oversample` is the one
  remaining lever on 24p judder short of a display-mode change, and it alters
  frames. Raised and explicitly set aside. **Ask before enabling.**
- **Delete `src/spike/`** — the Phase 0 mpv harness. Already off the UI and
  unreachable, but still the diagnostic tool for HDR passthrough, which is
  unverified for want of an HDR display. Delete it, its styles in `App.css`, and
  this note once that is confirmed.
- **Minimum confidence for skip markers** — `.skiptro.json` carries a
  `confidence` value nothing reads. A skip on a bad detection jumps over real
  content, the same class of silent wrongness as a bad metadata match. Needs a
  low-confidence sample; every marker in the library reports `1`.
- **NFO against a real third-party file** — verified only as a round trip
  through this app's own export. A dialect too far logs
  `nfo: nothing usable in <path>` rather than failing silently.
- **A credits chapter to calibrate against** — the chapter source for end-credit
  skipping cannot be confirmed until a file actually carries a chapter named for
  its credits. Until then the tail guess is what fires; `credits marker from
  <source>` in `app.log` says which won.
- **`playTitle` picks the largest file for a series**, not the first episode.
  Pre-existing; left alone deliberately, because changing what Play does is not
  a silent fix.

**Known unverified:** HDR *passthrough* (decode and tone-mapping to SDR are now
confirmed on real content by the stats panel, not just by the picture looking
right), `vo-passes` (returns nothing on this gpu-next build, so every rendering
row is a requested setting rather than an observed one), per-show track memory
across episodes, real TV overscan and whether `--ui-scale: 1.45` is right at
sofa distance, and behaviour with a large movie library.

**How I work:** I test in the real app and report back — tell me exactly what to
click, what a pass looks like, and what a failure would look like. Confirm the
order with me before starting a multi-item request.

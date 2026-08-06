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
watched tracking, previous/next episode stepping, end-credit skipping, and a
"stats for nerds" diagnostic panel.

**What is left, all of it currently blocked on something:**

- **Delete `src/spike/`** — the Phase 0 mpv harness. Already off the UI and
  unreachable, but still on disk because it is the diagnostic tool for HDR
  passthrough, which is unverified for want of an HDR display. Delete it, its
  styles in `App.css`, and this note once that is confirmed.
- **Minimum confidence for skip markers** — `.skiptro.json` carries a
  `confidence` value nothing reads. A skip fired on a bad detection jumps over
  real content, which is the same class of silent wrongness as a bad metadata
  match. Needs a low-confidence sample to calibrate against; every marker in the
  library reports `1`.
- **NFO against a real third-party file** — reading and writing are verified as
  a round trip through this app's own export, but no NFO written by MediaElch or
  tinyMediaManager has ever been tested. A dialect too far logs
  `nfo: nothing usable in <path>` rather than failing silently.
- **A credits chapter to calibrate against** — the chapter source for
  end-credit skipping is written and cannot be confirmed until a file in the
  library actually carries a chapter named for its credits. Until then the tail
  guess is what fires. `credits marker from <source>` in `app.log` says which
  won on any given file.

**Known unverified, all needing hardware or a bigger library:** HDR
*passthrough* (this display is 1440p SDR — decode and tone-mapping to SDR are
confirmed), per-show track memory across episodes, real TV overscan behaviour
and whether `--ui-scale: 1.45` is right at sofa distance, and behaviour with a
large movie library (currently one film and one TV season).

**How I work:** I test in the real app and report back — tell me exactly what to
click, what a pass looks like, and what a failure would look like. Confirm the
order with me before starting a multi-item request.

# Handover — starting a new session

Paste the block below into a fresh chat to continue development.

---

I'm continuing work on **Personal Netflix**, a local serverless media library
(Tauri 2 + React 19 + libmpv) at:

`C:\Projects\kinema`

Phases 0–4 are complete and committed (`git log`). The app works end to end:
scanning, metadata matching, browsing, and playback with resume and
next-episode autoplay.

**Before writing any code, read these three files in the repo:**

1. `PLAN.md` — roadmap, what's done, and the Phase 5 spec
2. `GOTCHAS.md` — libmpv and toolchain traps. **Read this before touching the
   player.** Every entry cost a real debugging round, and several describe
   failures that produce no error at all
3. `README.md` — architecture, data flow, and the design decisions to preserve

**What I want next**, in priority order — but confirm the order with me before
starting:

1. **Artwork caching** (backlog) — posters/backdrops currently re-fetch from
   TMDB on every render, so browsing needs a live connection. Cache to app data
   and serve via Tauri's asset protocol.
2. **Manual fix-match UI** (backlog) — the safety net the strict matching
   threshold assumes exists. `link_file_to_title` already exists in Rust.
3. **Phase 5a — intro/outro skip** via Skiptro `.skiptro.json` sidecars.
   **Ask me before downloading the Skiptro binary** — it's a third-party
   executable.
4. **Phase 5b — in-app trailers** via TMDB video keys + yt-dlp on the mpv
   surface.

**Constraints that must not be violated** (these are settled decisions, not
open questions):

- **No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR, Intel
  VSR. Classical resampling only.
- **No quality-preset UI.** The app decides; "potato mode" is the only switch.
- **Vendor-neutral** — must work equally on AMD, Intel and NVIDIA.
- **Wrong metadata matches are worse than no match.** Keep the strict threshold
  and the ambiguity guard; surface failures for review instead of guessing.
- The window is transparent so mpv can render behind the webview. **Never give
  `html`, `body` or `#root` an opaque background** — it hides the video
  entirely. Full-screen browsing views paint their own background; the player
  must not.

**How I work:**

- Run `npm run check` (tsc + eslint) before telling me something is done.
  `react-hooks/exhaustive-deps` is set to **error** deliberately — it caught
  real stale-closure bugs that produced silently wrong behaviour.
- When something fails, read `src-tauri/app.log` (frontend console + unhandled
  errors) and `src-tauri/mpv.log` (mpv's own verbose log) instead of guessing.
  The webview console is otherwise invisible from outside the app.
- Changing mpv's observed-property list requires a **full app restart**, not
  HMR — mpv initialises once per window.
- Ask before downloading any third-party binary.
- I test in the real app and report back with screenshots; tell me exactly what
  to click and what a pass looks like.

**Known unverified:** HDR *passthrough* (my display is 1440p SDR — decode and
tone-mapping to SDR are confirmed), per-show track memory across episodes, and
behaviour with a large movie library (I currently have one film and one TV
season).

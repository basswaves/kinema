# Handover — starting a new session

Paste the block below into a fresh chat to continue development.

---

I'm continuing work on **Personal Netflix**, a local serverless media library
(Tauri 2 + React 19 + libmpv) at:

`C:\Projects\kinema`

Phases 0–5 are complete and committed (`git log`). The app works end to end:
scanning, metadata matching, browsing, playback with resume and next-episode
autoplay, locally cached artwork, a manual fix-match queue, intro skipping from
Skiptro sidecars, and trailers from local files.

**Before writing any code, read these three files in the repo:**

1. `PLAN.md` — roadmap, what's done, and the Phase 5 spec
2. `GOTCHAS.md` — libmpv and toolchain traps. **Read this before touching the
   player.** Every entry cost a real debugging round, and several describe
   failures that produce no error at all
3. `README.md` — architecture, data flow, and the design decisions to preserve

**What I want next**, in priority order — but confirm the order with me before
starting:

1. **10-foot TV layout** — D-pad navigation works everywhere already, but there
   is no larger-type couch layout yet.
2. **Library management out of the dev tab** — scan/parse/match still live in a
   developer-facing Library view. Should become a settings screen with
   background scanning.
3. **NFO read/write** — interop with MediaElch/tinyMediaManager; read as an
   authoritative override during matching.
4. **Delete `src/spike/`** — the Phase 0 harness, plus the dev switcher in
   `src/App.tsx`. Keep only until the real player is trusted for HDR.

**Constraints that must not be violated** (these are settled decisions, not
open questions):

- **No machine-learning upscaling.** No FSRCNNX, RAVU, Anime4K, RTX VSR, Intel
  VSR. Classical resampling only.
- **No quality-preset UI.** The app decides; "potato mode" is the only switch.
- **Vendor-neutral** — must work equally on AMD, Intel and NVIDIA.
- **Wrong metadata matches are worse than no match.** Keep the strict threshold
  and the ambiguity guard; surface failures for review instead of guessing.
- **Nothing that needs periodic maintenance to keep working.** This has to run
  untended for years, and it may be published as open source. That is why
  `yt-dlp`, the Kodi-style YouTube resolver and an in-app embed with an ad
  blocker were all rejected for trailers: trailers are local files, with the
  provider link opening in the user's own browser as the fallback.
- **No third-party binaries in the repo or the bundle.** Skiptro is run
  separately by hand; the app only reads the sidecars it leaves behind.
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

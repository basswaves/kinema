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

As `equipment.rs` reads it (2026-09-24): the 2560×1600 development monitor (DisplayPort) offers
23.976/24 Hz only at 1920×1080 and below; a second screen, a 1080p monitor
(HDMI), offers 50 Hz but no 24 Hz mode. Neither does HDR. Sound: onboard
analogue (the default), onboard optical S/PDIF (takes AC3 and DTS only — all an
optical link can carry), and the development monitor's HDMI audio (no bitstreams). So display
*switching* can be tested for real here; HDR and bitstreaming cannot.

The target setup — a **4K HDR10 TV and an AV receiver with Atmos** — is on another
machine that only runs downloaded releases. Anything that needs it is verified
from the `equipment:` lines in that machine's `app.log`.

As read there (2026-09-24, first USB run): the TV reports over HDMI at 3840×2160 **@ 30 Hz, 8-bit**, HDR on, 1499 nits peak, with
23.976/24 Hz offered at 3840×2160 and 4096×2160. The TV's HDMI audio device takes **all five bitstreams** (AC3, E-AC3, DTS, DTS-HD MA,
TrueHD) and 8-channel PCM — so the chain is PC → receiver → TV, and the receiver
is answering under the TV's name. Windows was mixing to 7.1 at 44.1 kHz by the
end of his tests.

---

## The improvement plan (from the September 2026 review)

Agreed on 2026-09-23 after a full review of the code, the logs and
the library database. One commit per item on `master`. Phase 0 (the safety
net and the test tools), Phase 1 (starting playback and the Skip button),
Phase 2 (watching correctness), Phase 3 (library and matching), Phase 4
(responsiveness), Phase 5 (structure) and Phase 6 (cleanup and docs) are done,
which completes the plan — see PLAN.md for what each decided, including why the
scan pipeline stayed in the webview. What remains open is below, as before.

Decisions that shape it: the **Skip intro button shows from 0:00** whenever an
intro is known and stays until the intro ends, and pressing it during a cold
open jumps to the end of the intro (chosen knowingly — it skips the cold open
too); **Skiptro stays first** for intros where its confidence is at least 0.8;
nothing is tested by hand.

---

## Native output (agreed 2026-09-24)

The goal: whatever the PC is connected to, it gets the most native signal it
can take — 4K at 1:1, HDR10 as the disc carries it, surround as an untouched
bitstream — without anyone having to know which settings make that happen.
Decisions and reasons are in PLAN.md → "Native output". One commit per step, in
this order:

1. **Detection and the equipment report — done.** `equipment.rs` reads every
   screen (modes, exact refresh, HDR support and state, peak nits) and every
   audio output (the Windows mix, direct PCM channels, and each bitstream format
   probed exactly as mpv would send it). Checked at every launch, remembered
   per device across launches (settings key `equipment_memory`), written to
   `app.log` as `equipment:` lines, and shown read-only in Settings → Your
   equipment, where "Check again" re-asks the connected devices. Changes no
   playback. **Waiting on:** a run on the test machine, from the
   "Kinema USB test" folder (the app, a readme, and a script that copies the
   logs onto the stick); the logs come back in "Logs from the TV PC".
2. **HDR the way a disc player does it — built, waiting on the test TV.**
   `target-colorspace-hint-mode=source`, so the TV gets the film's own HDR10
   metadata (1000 nits for the test film) instead of a version remapped to the 1499
   nits Windows reports. And, found while testing it: mpv tagged its output
   HDR10 **on SDR screens too** (hint `yes` and `auto` alike), leaving Windows
   to convert it down, so mpv's own tone mapping never ran for SDR users. Now
   the player asks before every file whether the screen the window is on has
   HDR switched on (`window_display` → `displayHdr.ts`) and sends HDR only if
   so. Verified here with `selftest.ps1`, which can now pass mpv options
   (`"mpv"`) and read properties back (`"probe"`): with the hint off the swap
   chain stays SDR and mpv tone maps 1000 → SDR; with an HDR display stood in
   for, `source` renders at the film's own 1000 nits where `target` rendered at
   1499. **Confirmed on the test TV (USB round 2):** HDR on → hint `yes`, HDR10
   out, no tone curve in the shader at all; HDR off → hint `no`, SDR out,
   mpv's own tone mapping ran. Still to do: name the Dolby Vision handling in
   the stats panel.
   **Also the stats panel's HDR row**, which reads `target-params/gamma` — a
   property mpv does not have (it is `video-target-params`) — and so reports
   "tone mapping" for *every* HDR file whatever happened. Found on the test TV.
3. **Surround.** Behind one switch, **off by default** (2026-09-24: Kinema
   must not take the audio device exclusively by itself): "send sound straight
   to the receiver", which holds the device **only while a film plays** so
   Windows' spatial sound stays on for games. Offered **once**, on the first
   film on a setup that can use it (a receiver taking TrueHD/DTS-HD, or Windows
   spatial sound on), and never if already on — see PLAN.md → Native output. On: `--audio-spdif` built from step 1's probe, per format
   overridable (Auto / On / Off), and multichannel PCM straight to the device
   at the source's rate for anything not bitstreamed. Off: the Windows mixer,
   as today — Settings warns when it is set to Stereo for a device that takes
   8 channels, and when Windows' own spatial sound (Atmos / DTS:X for home
   theater) is on, which left mpv with **no audio at all** on the test TV. A file
   whose audio fails to open must never play silent: fall back to stereo and
   say why. Also an output device choice (default: Windows' default), and the
   volume control says "on the receiver" while bitstreaming.

   **Built (2026-09-24), waiting on the test receiver:** `audioOutput.ts` (the
   plan, unit-tested), Settings → Sound (the switch, the device, a per-format
   Auto/On/Off), the stats panel's "Path" row, and the never-silent fallback
   (through Windows, then stereo, with a notice). Verified here: with the
   output written to a file (`--ao=pcm`), **all 39 DTS-HD MA frames checked and
   26 TrueHD chunks were byte-identical to the film's own track**, IEC 61937
   data types 17 and 22, the Atmos substream present; exclusive 7.1 opened with
   Windows Sonic on and was released when the player closed ("Uninit wasapi");
   a staged mid-film failure recovered in under two seconds. **Verified on
   the test receiver (USB round 3):** DTS-HD MA and TrueHD went out as
   `spdif-dtshd` / `spdif-truehd` in exclusive mode and the receiver's display
   named each correctly. **The offer-once prompt** sits before a film starts
   (`DirectSoundOffer.tsx`, from `startPlayback` in `Browse.tsx`), where the
   remote works normally, rather than inside the player's focus handling: a
   focus boundary that takes focus itself, Back cancels without answering,
   either answer is final. Driven keyboard-only in `dev:mock`. **Step 3 is
   done.**

   **Spatial sound, as of USB round 2:** confirmed that with Atmos for home
   theater on, every film plays silent (`0x887C0077` on `Initialize`, twice
   more). Detecting it is not solved: the spatial audio API answers the same
   with it off (static mask `0xffffe`, stream available) on the development monitor here, and
   the dynamic object count read 0 on the test TV with it on. The log now carries
   every raw answer; a run with it on and one with it off, on the same device,
   will show which one moves. Whatever detection turns out to be possible, the
   player must catch the failed open itself and fall back — that does not
   depend on detection. Longer term, mpv PR #18389 (`--ao=wasapi-spatial`,
   milestoned for 0.43, open as of Sept 2026) would let decoded PCM go through
   Windows' spatial sound properly; worth adopting when a libmpv with it ships.
   Verified here by writing mpv's output to a file (`--ao=pcm`) and checking
   the IEC 61937 payload is bit-identical to the source, for every format, with
   clips made by ffmpeg; and on the onboard device that TrueHD falls back to PCM
   rather than silence. **Waiting on:** a second release run on the test machine.
4. **Display switching — every switch off by default**: match
   the refresh rate, match the resolution, turn HDR on for HDR content.
   Resolution is three-way, as agreed on 2026-09-24: **Off**;
   **Auto** — switch *up* when the desktop is below the film and the screen can
   **Only in fullscreen** (2026-09-24, as MPC-HC and madVR do it): a
   mode change is a whole-desktop change, and in a window the picture is
   scaled to the window anyway, so 1:1 and refresh matching only mean anything
   when the film fills the screen. Starting a film fullscreen switches before
   the first frame; going fullscreen mid-film **pauses**, switches, waits for
   the picture to come back, then resumes; leaving fullscreen or the player
   restores the desktop's mode.

   **Built (2026-09-25), waiting on the test TV for HDR:** `display.rs` (switch,
   HDR on/off, restore — the original saved to settings *before* the first
   change, restored on player exit, app exit, and at the next launch after a
   crash), `displayMode.ts` (the choice, unit-tested against the test TV's and the
   development monitor's real mode lists), `displaySwitch.ts` (fullscreen only, pause, settle,
   tell mpv the new rate), Settings → Screen. **Verified on the development monitor** with
   `selftest.ps1`: a 1080p film opened fullscreen switched 2560×1600@60 →
   1920×1080@23.976 before playing and mpv then reported 23.976; going
   fullscreen mid-film paused (clock held at 0:04), switched, resumed; leaving
   fullscreen, Back, and app exit each restored 2560×1600@60; after a forced
   kill the next launch logged "put back a screen mode left by the last
   session". **Confirmed on the test TV (2026-09-25, automatic run from the USB
   stick):** 4K@60 HDR off → 4K@23.976 **HDR on**, signal 3840×2160@23.976,
   mpv told 23.976 and switched to an HDR10 swap chain; restored to 4K@60 HDR
   off with the signal back at 3840×2160@60. And 4K@60 → 1080p@23.976 for a
   1080p film under Match content, restored with the signal back at 4K@60. The
   first round had ended at 4K@30 whenever HDR was involved — see GOTCHAS →
   "Turning HDR on puts back Windows' own HDR mode". **Step 4 is done.**

   The stick's `3. Run automatic test.cmd` runs `selftest.ps1` plans on that
   machine unattended and copies reports, screenshots and logs back — the tester sets
   Windows up once and waits, rather than working through a checklist.
   Resolution is three-way, as agreed on 2026-09-24: **Off**;
   **Auto** — switch *up* when the desktop is below the film and the screen can
   show the film natively (a 1080p desktop on a 4K TV playing a 4K film, where
   staying put means Kinema shrinks the film and the TV blows it back up), never
   down; **Match content** — always the film's own resolution, for a TV or a
   video processor (a madVR Envy) that should do all the upscaling. **Auto is
   the default** (2026-09-24) — the one exception to "switching off by
   default", because it only ever acts where staying put loses picture. The
   file loads paused behind the black cover, the mode switches, playback starts
   once mpv reports the new rate and the TV has had time to re-sync. The
   original mode is restored on stop, on exit, and at the next launch after a
   crash. Refresh and resolution switching are tested for real on this
   machine's two screens; the HDR
   switch only on his.

5. **Say what is not native, why, and what to do about it** (agreed
   2026-09-24: "when correct and native output can't be achieved, it should be
   informed about"). A plain verdict per film — resolution 1:1, HDR as
   mastered, frame rate matched, bit depth, sound untouched or decoded — each
   with the reason when it is not, and the fix: a Windows or driver setting, a
   cable path, or a Kinema switch. Includes the HDMI link itself, read
   vendor-neutrally from `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO`'s colour
   encoding and bits per channel: the test TV ran HDR at 4K **30 Hz, 8-bit**,
   because 4K + HDR + 10-bit does not fit the test PC's GPU → receiver → TV HDMI
   link at 60 Hz, and does at 24 Hz — so step 4's refresh switching is also
   what makes 10-bit possible there, and this is where Kinema says so.

   **Built (2026-09-25):** `outputCheck.ts` — five verdicts (picture size,
   HDR, motion, colour depth, sound), each *native*, *info* (true, nothing to
   change) or *limited* (with the fix), unit-tested — shown as "Output check"
   at the top of the stats panel (`i`). The link's bits and encoding come from
   the same vendor-neutral query as HDR (`link_of` → `screen_now`). "Even" uses
   the mode switch's own `cadenceRank`, after a looser tolerance called a
   monitor's 72 Hz mode at 800×600 a fit for 23.976 fps. Verified in the real
   app on the second monitor (1:1, SDR, judder with "no mode that fits", then
   "even — 25 fps on 50 Hz" after a switch). **Confirmed on the test TV
   (automatic run, 2026-09-25):** with default settings it named the judder
   (23.976 fps on 30 Hz), the 8-bit HDR link and the height sound lost through
   Windows, each with its fix; with refresh, HDR and direct sound on, picture,
   HDR, motion and sound all read native ("untouched DTS-HD → receiver"). The
   link stayed 8-bit RGB even at 4K 23.976 Hz — the driver's colour-depth
   setting, not bandwidth, which the check first blamed on the cable; it now
   tells the two apart (above 30 Hz at 4K the cable, otherwise the driver).
   **Step 5 is done.**

Also in every step: the matching docs (GOTCHAS for traps, PLAN for decisions).

## Worth doing, in rough order of payoff

### Tone mapping for the display's real brightness — later, maybe

Raised on 2026-09-24: could Kinema do what a madVR Envy or Lumagen does
— fit HDR to what the particular display can really show? libplacebo can: it is
exactly what `target-colorspace-hint-mode=target` did with the 1499 nits
Windows reported for the test TV (see PLAN → Native output). Two reasons it is not
the default, and one reason it may still be worth a switch:

- The number from Windows comes from the EDID and is often a round figure
  rather than a measurement — 1499 for an OLED is not what that panel
  reaches. Mapping to a wrong peak is worse than not mapping.
- A good TV's own tone mapping knows its panel; sending HDR10 as mastered and
  letting it work is what a disc player does.
- **Where it pays:** projectors (100–200 nits, often weak internal tone
  mapping), and TVs set to HGIG, which turn their own mapping off and expect
  the source to do it. A setting describing the display — "tone map for a
  display that really reaches N nits", off by default, N entered by the owner
  — fits the hardware-not-taste rule. Not before step 5.

### A first-run setup for picture and sound — later

A window the first time Kinema starts that walks through the picture and sound
choices — direct sound, display switching — with what each gains and costs,
built on what the equipment check found. Not before the native-output steps
exist: it would be a tour of switches that do not do anything yet.

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

**Decided against, 2026-09-23.** The owner reports no bad intro endpoints and wants
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

- **A file whose container misreports its length.** One test episode
  (an `.mp4`) is about 23 minutes, but mpv reports
  7008 s, and the player trusts mpv's duration: its progress percentage and
  "min left" are wrong, and its credits start (22:07) falls in the "first half"
  of that bogus length, so the credits-count-as-watched rule rightly ignores
  it — skipping its credits early will not mark it watched, though reaching
  the end still does. One file, left alone; if more turn up, compare mpv's
  duration against ffprobe's (which `analyse.rs` already reads) and prefer the
  shorter.
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
  against the live API (Breaking Bad S01E01 returns one) but **the one series in the test library
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
- **Real TV overscan**, and whether `--ui-scale: 1.45` is right at sofa
  distance. Both need a TV; the value is one constant in `ui.css`.
- **Behaviour at scale** — the library is small. Rails cap at 30 with a "See
  all" grid and the scanner no longer holds the database lock, but neither has
  met a few hundred films.
- **The four stats fixes** (video rectangle, `hw-pixelformat`, SDR peak, cadence
  after deinterlacing) are written and built but not eyeballed against the three
  test files that exposed them.

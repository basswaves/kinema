# Roadmap

Where Kinema is going, what is deliberately not planned, and where help would
make the most difference. For what has already been built, see the
[changelog](../CHANGELOG.md); for why things are the way they are, see
[HISTORY.md](HISTORY.md) and [DESIGN.md](DESIGN.md).

Ideas and reports are welcome as [issues](https://github.com/Basswaves/kinema/issues/new/choose).

---

## Next

**Android**, below under [Other platforms](#other-platforms).

---

## Being considered

### Tone mapping for projectors and HGIG TVs

Kinema sends HDR to the TV as it was mastered and lets the TV fit it to its
panel, as a disc player does. For projectors (often 100–200 nits, with weak
tone mapping of their own) and TVs set to HGIG, which expect the source to do
it, a setting that describes the display — "tone map for a display that really
reaches N nits", off by default — would help. Windows' own figure for a display's
brightness is often a round number rather than a measurement, so it would be
entered rather than read.

### Smooth motion

Blending the one refresh where a 24 fps film changes frame on a 60 Hz screen
(what madVR calls smooth motion) trades the regular judder for a slight smear.
It changes frames, which goes against one of Kinema's principles — nothing is
added to the picture that was not in the source — so it is a decision to be made
deliberately, not an improvement to switch on. Matching the refresh rate, which
Kinema already does, avoids the problem where the screen allows it.

---

## Not planned

These have been considered and turned down; [HISTORY.md](HISTORY.md) has the
reasons in full.

- **Machine-learning upscaling or sharpening**, and **frame interpolation**.
  Kinema shows what is in the file.
- **A picture-quality preset menu.** The right settings depend on the file and
  the display, which Kinema can see; settings describe equipment, not taste.
- **Anything that needs regular upkeep to keep working** — for example YouTube
  trailers in the app through a downloader. Trailers on your disk play in
  Kinema; others open in the browser.
- **Bundled third-party programs.** ffmpeg and Skiptro can be used if you have
  installed them; Kinema never ships or downloads them.
- **Looking up a whole library in TheIntroDB at once.** It is asked about one
  episode at a time, when that episode is played, on its terms.
- **An installer or automatic updates.** On Windows Kinema is a folder; it
  says when a new version is out and you download it when you choose. On
  Linux the `.deb` and `.rpm` are the system's own package format, which is
  how Linux users expect to install a program and what fetches mpv for them —
  not an installer of Kinema's — and a folder is there too. No automatic
  updates there either.

---

## Other platforms

**Linux** shipped in 0.8.0: packages that use the system's mpv, Kinema's
own controls over the video, the equipment check, sound straight to the
receiver and screen switching on GNOME, KDE Plasma, Sway and Hyprland — each
checked on a real TV and receiver, with an NVIDIA and an AMD card. HDR
reaches the TV on GNOME and Plasma with a driver that offers it (AMD on Mesa,
NVIDIA 595+), and on Hyprland, which switches it by itself (at 8 bits unless
set to 10); Sway's HDR (1.12) is used where Sway reports it, and has not yet
been tried on a real TV. Since 0.9.1 the screen is switched on Cinnamon
too (refresh rate and resolution; Cinnamon has no HDR), and the mouse works
in the Linux player as it does on Windows.

**Android** is next, with its own player engine (Media3) for Dolby Vision and
passthrough on TV boxes. macOS is not planned by the author; a port is
welcome. See [Platform support](../README.md#platform-support).

---

## Help wanted: untested on real equipment

Everything below is built and works where it has been tried, but has only been
tried on a small number of setups. Reports — from `app.log` and `mpv.log`
(Settings → Advanced → Developer tools → Open log folder) — are the most
useful contribution there is.

- **Linux on more desktops, distributions and graphics cards.** Kinema is
  built to work the same everywhere and fall back safely rather than tested
  on each; a setup where it still misbehaves is exactly what the bug report
  form is for.

- **HDR, bitstreaming and display switching on more setups.** Confirmed on one
  4K HDR TV with an AV receiver. Other TVs, receivers, graphics cards (AMD,
  Intel and NVIDIA should behave identically), and projectors are unknown.
- **Dolby Vision files.** Profiles 5, 7 and 8 are handled in code and named in
  the stats panel (`i`), but no Dolby Vision file has been played end to end.
  The detail page's badge — the profile, and FEL or MEL for profile 7 — has
  been checked against dovi_tool's sample data, not against a real disc.
- **The picture and sound badges on more files.** DTS:X, DD+ Atmos, HDR10+,
  HLG and Auro-3D names have been checked only against sample output; the
  aspect-ratio measurement has not yet met a film with IMAX scenes or a remux
  with black bars. The logs (Settings → Advanced → Developer tools → Open log
  folder) and a note of what the badge said against what the disc box says
  make a useful report.
- **Intro and credits detection on more shows.** The thresholds were tuned
  against one programme. Shows with a quiet intro, a spoken cold open, no
  closing theme, or credits over live picture rather than black are the
  interesting cases. For developers: `calibrate_against_a_real_season` in
  `analyse.rs` runs against any season (`KINEMA_SEASON_DIR`, `--ignored`).
- **Credits times from TheIntroDB** during real playback, and **chapters named
  for the credits** in a real file. Both paths are built; neither has met a
  file that has them.
- **Subtitles from OpenSubtitles on more files**, and forced subtitles found
  online. Search, ranking and download have been run against the real service
  on one episode; whether the ranking picks subtitles in step with a file,
  across many releases, is the question a report answers.
- **Trakt with a real account.** Connecting, comparing the history with what
  the account has, and later finishes are built and tested against a stand-in
  and Trakt's documented answers. SIMKL has been used for real.
- **Recaps, and a film's scene after the credits**, from TheIntroDB and
  IntroDB during real playback. Both are built and tested against recorded
  answers; neither has been watched on a real file. A note of where Skip
  landed against where the scene really starts is a useful report.
- **.nfo files from other programs** (Kodi, MediaElch, tinyMediaManager). Only
  Kinema's own exported files have been read back.
- **TV overscan and the TV layout's size** from a sofa, on different TVs.
- **Large libraries** — several hundred titles.
- **Movies identified through Wikidata**, the fallback when no TMDB key works.
  It has matched the films it has been tried on; how it does with a large,
  messily named movie collection is unknown. To try it, build from source
  without a key.
- **Files whose container reports the wrong length.** One such file is known;
  if they turn out to be common, Kinema could compare with ffprobe's length.
- **The stats panel's render passes**, which the current mpv build does not
  report; the rows show what was asked for rather than what ran.

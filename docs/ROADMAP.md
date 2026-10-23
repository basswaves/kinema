# Roadmap

Where Kinema is going, what is deliberately not planned, and where help would
make the most difference. For what has already been built, see the
[changelog](../CHANGELOG.md); for why things are the way they are, see
[HISTORY.md](HISTORY.md) and [DESIGN.md](DESIGN.md).

Ideas and reports are welcome as [issues](https://github.com/Basswaves/kinema/issues/new/choose).

---

## Next

The order, roughly. Films and TV shows come first, because they are what
Kinema is used for every evening; playing every file as accurately as the
equipment allows is what Kinema is, so that work follows close behind.

**Ready for newcomers.** A code-signed Windows download, so Windows no longer
asks whether to run it — waiting on a free signing service for open-source
projects. The rest of this step is done in 0.13.0: direct downloads from the
[website](https://basswaves.github.io/kinema/), Send a report, the guides, the
"what leaves your computer" page, Settings grouped by what you want and a
search box in Settings.

**Everyday films and TV.** Subtitle size and background; two subtitle
languages at once, for language learners and mixed households; a delay
setting per sound device, for receivers and TVs that hold the sound back; a
chapter list in the player; audio description and other accessibility
preferences; subtitle timing, by hand and automatic; pictures on the seek bar;
volume levelling and a dialogue boost for decoded sound. For choosing: a
**Play something** button; **smart collections** built from what Kinema
measured in each file ("everything in Dolby Vision", "Atmos films I have not
seen"); favourites and a watchlist; actor pages; a richer title page. For the
library: two copies of one film shown as versions of it; importing what you
have watched, and where you stopped, from Kodi, Jellyfin, Plex and Emby;
moving a whole library to a new computer; and every title identified through a
fallback (Wikidata, OMDb or TVmaze, used when TMDB could not be asked) moving
to TMDB by itself once it can be, for its pictures and the rest — today only
films whose Wikidata entry names their TMDB id do. Shuffle and repeat for playlists,
and the picture and sound badges for a video.

**Plays anything, accurately.** Dolby Vision checked end to end on the
desktop; 3D (below); more of the raw facts — what the TV and receiver said
about themselves, and the exact player settings chosen — as text you can copy
into a forum post; an **expert drawer** listing every decision Kinema made and
why, with overrides for facts about your equipment (never for taste), for
troubleshooting and edge cases; a live bitrate graph and an HDR brightness
graph; and **Check my setup**, which plays short reference clips (downloaded
when you ask, from their official source) and reports what really reached the
screen and the receiver. The projector work below.

**Evenings and ownership.** Channels made from your own library, with
something already playing when you turn one on; a health page for your
collection — files gone, changed or unreadable, a share that keeps dropping
out, films that exist on one disk only; a cinema evening, with a trailer from
your own shelf before the feature; a watching diary; a shelf for the physical
side of a collection — editions, and discs not yet ripped; Home Assistant,
so the lights follow the film; and your phone as a keyboard, remote and second
screen, with no app to install.

**Further out.** Music — a good player first (a library, bit-perfect and
gapless playback, a window showing the signal path), the specialist parts
later; profiles for each person in a household; syncing watch state through a
WebDAV folder of your own; a Jellyfin server as a source beside your folders,
played directly, never transcoded (Plex after a check of its terms); and
themes and layouts for the interface — never for the film's picture.

**Being looked into, nothing promised:** handing a film over to Kinema on
another TV in the house; watching together with a friend, each from their own
copy; and searching in plain words ("the heist film with the twist").

(Done in 0.12.0: Trakt resume points, so a
film stopped on one device continues on another; the next and previous file in
a folder when a video was opened from Explorer; **Videos** folders for home
videos and clips, with a picture taken from the file, under a Library tab; and
**Folders**, browsing drives and shares inside Kinema and playing anything in
them; and **playlists**, with `.m3u` import and export on desktops. Done in 0.11.0: a
Windows installer beside the ZIP; Blu-ray folders and disc images on Windows
and Linux; Kinema as a video player on Windows — open a file from Explorer,
or drop it on the window; and a film or show no database lists, kept under
its own name from Needs attention.)

**Android**, an early version (beta) since 0.10.0, moves on as reports come
in. Its open items: the badges on a film's page, intro detection from the
audio, Blu-ray folders, disc images and 4K UHD `.m2ts` files. See [Other platforms](#other-platforms).

---

## Being considered

### Projectors: tone mapping, screen shape and calibration

Kinema sends HDR to the TV as it was mastered and lets the TV fit it to its
panel, as a disc player does. Projectors (often 100–200 nits, with weak tone
mapping of their own) and TVs set to HGIG expect the source to do it. Planned,
as settings that describe the equipment rather than taste:

- **Brightness and contrast** — how bright the projector really is and how
  deep its black goes — so Kinema's frame-by-frame tone mapping fits it.
  Windows' own brightness figure is often a round number rather than a
  measurement, so it is entered rather than read.
- **Screen shape** — 16:9, or a wide 2.35/2.40 screen filled by zooming or
  an anamorphic lens. Films fill the height, and subtitles and Kinema's
  controls move inside the picture so nothing lands on the masked area;
  shape changes inside a film (IMAX scenes) are followed.
- **Calibration** — a 3D LUT or ICC profile made with DisplayCAL, Calman or
  ColourSpace, loaded per display.

Sharpening, "detail enhancement", vivid colour modes and motion smoothing are
not planned: they are taste or invented detail.

### winget, and other package managers

The Windows installer came with 0.11.0: it leaves nothing behind when
removed — the program, its shortcuts, the "Open with" entries, and the library
and settings too, after asking. A winget package, `Basswaves.Kinema`, is
ready; its first submission was made after 0.11.0 and is waiting for review
by winget's volunteer moderators. It brings ffmpeg
along, for the badges. Other package managers may follow. The
release workflow writes and checks the package's description on every build, so
a new version needs little hand work there. Automatic updates stay out.

### Smooth motion

Blending the one refresh where a 24 fps film changes frame on a 60 Hz screen
(what madVR calls smooth motion) trades the regular judder for a slight smear.
It changes frames, which goes against one of Kinema's principles — nothing is
added to the picture that was not in the source — so it is a decision to be made
deliberately, not an improvement to switch on. Matching the refresh rate, which
Kinema already does, avoids the problem where the screen allows it.

### 3D films

Today a side-by-side or top-and-bottom 3D file shows as two squeezed
pictures, and a 3D Blu-ray plays in 2D without saying so. First, every 3D
file will be shown correctly in 2D, with a "3D" badge. Then real 3D on
projectors and 3D TVs: full HD for each eye when the screen is set to the
1920×2205 frame-packing mode (made once in the graphics card's own settings;
Kinema recognises it), and half-resolution side by side or top and bottom
otherwise — which also covers VR headsets through a PC, with Virtual Desktop's
3D mode. 3D Blu-ray in real 3D needs a decoder for its second eye (MVC), which
ffmpeg does not have; the plan is to build on
[edge264](https://github.com/tvlabs/edge264) once it has a stable release.
Switching a screen into 3D through the graphics driver is not planned: that
support is optional, differs between NVIDIA, AMD and Intel, and has partly been
removed.

### Machine-learning upscaling

Some streaming boxes are bought for their AI upscaling alone, and Kinema is
meant as much for people who want that as for purists. The well-known ones
cannot be used here: they belong to one chip or one graphics maker, and
Kinema behaves the same on AMD, Intel and NVIDIA. What could fit is a shader
that runs on any graphics card through mpv, of the kind that redraws edges
cleanly rather than adding texture the film never had, used only where the
graphics card has room for it, chosen by Kinema rather than by a slider, and
named in the details panel (`i`) whenever it is on. The good ones are heavy
for integrated graphics at 4K, and every one of them draws some detail of its
own, which goes against one of Kinema's principles — so, as with smooth
motion, it is a decision to be made deliberately. Until then Kinema upscales
with classical filters, which add nothing.

---

## Not planned

These have been considered and turned down; [HISTORY.md](HISTORY.md) has the
reasons in full.

- **Frame interpolation**, and **sharpening as a matter of taste** — a slider
  or a "detail" setting. Kinema shows what is in the file. (Machine-learning
  upscaling chosen by Kinema itself is under [Being considered](#machine-learning-upscaling).)
- **A picture-quality preset menu.** The right settings depend on the file and
  the display, which Kinema can see; settings describe equipment, not taste.
- **Anything that stops working by itself if left alone** — for example YouTube
  trailers in the app through a downloader or with ads blocked. (YouTube's own
  player in the app, with its ads, is planned.) Trailers on your disk play in
  Kinema; others open in the browser.
- **Bundled third-party programs.** ffmpeg and Skiptro can be used if you have
  installed them; Kinema never ships or downloads them.
- **Looking up a whole library in TheIntroDB at once.** It is asked about one
  episode at a time, when that episode is played, on its terms.
- **Translations of the interface.** Kinema is in English, which nearly everyone
  who uses software like it reads, and a translation is work on every release.
  A pull request from someone who wants Kinema in their language is welcome;
  open an issue first, since the interface's text would need gathering in one
  place before it can be translated.
- **Automatic updates.** Kinema says when a new version is out, and you
  download it when you choose. On Linux the `.deb` and `.rpm` are the system's
  own package format, which is how Linux users expect to install a program and
  what fetches mpv for them, and a folder is there too.

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

**Android** is an early version (beta) since 0.10.0, with its own player
engine (Media3) for Dolby Vision and passthrough on TV boxes: the interface,
the library, network shares, subtitles and playing a film work, tried on one TV
box and the emulator. What is missing and untested is listed in the
[README](../README.md#android-early-version).

**macOS** is planned for later, once the Windows, Linux and Android work in
hand is done; a port is welcome sooner. What is known so far: the interface
and library carry over; whether the video can sit beneath Kinema's page as on
Windows needs a trial first (Linux's own-window mode is the fallback); macOS
cannot pass TrueHD or DTS-HD to a receiver, so those would be decoded and
said so; the first builds would be unsigned, which macOS only lets open after one
step the first time (to be explained with the build). See
[Platform support](../README.md#platform-support).

---

## Help wanted: untested on real equipment

Everything below is built and works where it has been tried, but has only been
tried on a small number of setups. Reports — from `app.log` and `mpv.log`
(Settings → Advanced → Developer tools → Open log folder) — are the most
useful contribution there is.

- **Android on more devices.** An early version since 0.10.0, tried on one TV
  box and the emulator: other boxes, sticks and TVs, held keys and the on-screen
  keyboard on a real device, a very large library, and a TV that reports HDR
  differently are all untested. A short "I tried it on my device" report, even
  if everything worked, is the most useful thing there is.

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
  and Trakt's documented answers. Resume points were checked once against a real
  account (the list read, one pause sent and removed). SIMKL has been used for
  real.
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

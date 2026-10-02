# Kinema

A media library for the movies and TV shows already on your disk. It scans your
folders, finds the artwork and descriptions, remembers where you stopped, and
plays them — with no server, no account, and nothing running in the background.

Built because nothing existing fits. Every serverless option (Kodi) locks the
interface into skin XML, and every good-looking option (Jellyfin Media Player)
is a thin client that does nothing without a Jellyfin server running somewhere.
Kinema is one program: close it and nothing is left running.

**Windows 11 and Linux**; see [Platform support](#platform-support).

![Kinema's home screen: a full-width backdrop for a title from the library, with rails of posters beneath it](docs/images/home.jpg)

![A movie's detail page, showing the poster, description and a row of cast portraits](docs/images/detail.jpg)

Detail pages carry the cast, the description and — for a series — every season
and episode, opening on the season you are in, with progress on the ones you
have started. Under the buttons, badges say what the file really holds — for a
series, what the season on screen holds, and which episodes differ — and
beside the year are its age rating and its IMDb, Rotten Tomatoes and TMDB
scores. Posters everywhere show what you have watched.

![The player's controls: seek bar, the transport in the middle, audio and subtitles and volume at the right, and when it will end](docs/images/player.jpg)

A remote works the way it does on any streaming app: **OK** pauses, **←/→**
seek (hold to go faster), and **↑/↓** bring up the controls — the seek bar,
audio and subtitles, volume. Back steps back to wherever you came from.

## What it does

- **Finds your movies and shows** by walking folders you nominate. It never reads
  file contents to identify them, so scanning a NAS stays cheap.
- **Fetches posters, backdrops, descriptions, cast and episode stills**, and
  caches them locally so browsing works with no connection.
- **Refuses to guess.** A match it is not confident about goes to a review queue
  with the reason, rather than silently attaching the wrong movie to your file —
  and Home tells you when something is waiting there.
- **Plays through mpv** — the same engine as the standalone player — with
  hardware decoding, HDR tone mapping, PGS subtitles and 4K remuxes.
- **Says what each file really holds.** A title's page shows the resolution,
  the Dolby Vision profile — with FEL or MEL — and HDR format, the exact sound
  format (TrueHD Atmos, DTS:X, DD+ Atmos), frame rate, bit depth and the aspect
  ratio measured from the picture itself, so a 2.39:1 film in a 16:9 file says
  2.39:1. Where it came from (UHD Blu-ray remux, WEB-DL…) is read from the
  release name; nothing else is.
- **Remembers where you were**, per file, and offers the next episode.
- **Tells SIMKL and Trakt what you watched**, if you connect them: whatever you
  finish in Kinema is added to your account. Connecting is a code on screen and a
  tap on your phone.
- **Keeps a safety copy** of your watch history, resume points and hand-made
  matches once a week, and puts one back from Settings if the library is ever
  damaged.
- **Skips intros, recaps and credits**, from two community databases, from
  chapter markers, or by fingerprinting a season's audio and finding what the
  episodes share. Where a film has a scene after its credits, Skip takes you
  straight to it.
- **Works from a sofa.** Browsing, searching (with an on-screen keyboard),
  playing, subtitles and resume all work with a D-pad, and the TV layout fills
  the screen with bigger text.
- **Speaks your language.** Subtitles in your language when the audio is in
  another, and none when it is not — set once, remembered per show when you
  change it. Forced subtitles, for the lines in yet another language, show
  even with subtitles off.
- **Finds subtitles online** when a file has none in your language: one press
  in the player takes the best from OpenSubtitles — one made for your exact
  file when there is one — and the rest are a list away. It can also fetch
  forced subtitles by itself.
- **Gets the most out of your equipment.** Atmos and DTS:X untouched, 24p
  without judder, HDR switched on for an HDR film — for every TV and receiver
  that can, only the ones you choose, or none, so a laptop can behave one way
  at a home cinema and another at a desk. The first run asks; Home says when
  something connected can do more than you have chosen.

![The playback statistics panel, listing resolution, codec, cadence, scaling and colour information](docs/images/stats.png)

Press `i` while watching for what is actually happening: the display's real
refresh rate, the frame cadence, which scaler ran and why, and the colour
pipeline end to end. It reports rather than flatters — the cadence line above is
telling the truth about 24p on a 60 Hz panel.

It reads [NFO sidecar files](docs/DESIGN.md) if you have them, from MediaElch,
tinyMediaManager or Kodi, and treats them as authoritative.

## Install

Everything is on the [Releases](https://github.com/Basswaves/kinema/releases)
page: a ZIP for Windows, and packages for Linux ([below](#linux)).

On Windows, download the ZIP, extract it anywhere, and run `kinema.exe`.
There is no installer — it is a folder, and deleting the folder uninstalls it.

### Windows will ask once whether to run it

The first time you open `kinema.exe`, Windows shows a blue box: **"Windows
protected your PC"**. Click **More info**, then **Run anyway**. Windows
remembers, and does not ask again.

It says that because Kinema is not *code-signed* — signed with a paid
certificate that tells Windows who made the program. That is all it means. It
is the same box for any small program from an independent developer, and it is
not a warning that something was found.

You should not have to take that on faith, so every release publishes a
checksum beside the ZIP. To check the file you downloaded is the one that was
published, run this in PowerShell in your Downloads folder and compare the
result with the one on the release page:

```powershell
Get-FileHash .\kinema-*-windows-x64.zip -Algorithm SHA256
```

Kinema asks GitHub for the latest version number when it starts, and says in
Settings when a newer one is out. It never downloads or installs anything by
itself — you download the new ZIP when you choose to.

### Linux

Since 0.8.0, each release has a `.deb`, an `.rpm` and a `.tar.gz` folder,
for x86-64 and for ARM, each with a checksum beside it. Kinema uses your
system's mpv and WebKitGTK; the packages have the package manager install
them:

```bash
sudo apt install ./kinema_<version>_amd64.deb          # Ubuntu 24.04 or later, Debian 13
```

```bash
sudo dnf install ./kinema-<version>-1.x86_64.rpm       # Fedora
```

Anything else: unpack the folder and run `./kinema`; its README.txt names the
two libraries to install. Updates are as on Windows: Kinema says when there
is one, and you install it when you choose.

**HDR on Linux** needs three things, and Kinema says in its stats panel
(`i`) which one is missing:

- **mpv 0.40 or later** — Ubuntu 26.04, Debian 13, Fedora 43, Arch.
- **A desktop with HDR switched on**, or switched on by Kinema for the film
  (Settings → Picture & sound → Screen): GNOME 48 or later, KDE Plasma 6.4
  or later, Sway 1.12 or later; Hyprland switches it on by itself.
- **A graphics driver that offers HDR to windows.** NVIDIA: driver 595 or
  later, which supports GeForce RTX 20 and GTX 16 cards onwards; Ubuntu
  26.04 installs 580 unless you choose a newer one under Additional Drivers,
  and GTX 10 cards and older stop at 580, so they cannot show HDR on Linux.
  AMD and Intel: Mesa 25.1 or later — Ubuntu 26.04, Fedora 43 and Arch have
  it; Debian 13 has it in its backports. (Checked with an AMD card on Mesa
  26.0: HDR10 reaches the TV on KDE Plasma.)

Without the driver part the desktop shows HDR, but each film is converted to
SDR before it reaches it. On Hyprland, which switches HDR on by itself for a
full-screen HDR film, add `bitdepth, 10` to the TV's monitor rule: without
it HDR goes out at 8 bits per colour, and smooth gradients show bands.

## First run

The app opens on a welcome panel that asks two things, each answered in a
press:

- **Where you will watch** — a TV from the sofa gives big text and the whole
  screen, made for a remote; a desk gives a window.
- **Where your videos are.** Point it at where you keep your movies, and
  another at your TV shows if they live somewhere else. Local drives and
  network shares both work. Nothing is moved, renamed or written to — the
  files are only read.

Then press **Scan my library**. The first scan takes a few minutes on a large
library, and while it runs Kinema asks the rest on a few short pages, each
one skippable, with **Finish later** to go straight to the library:

- **Picture and sound:** sound straight to a receiver, the screen matched to
  the film, HDR switched on for HDR films — each with what it gives and what
  it costs, for every device that can, only the ones connected now, or off.
  Skipped, everything stays off.
- **Intros and credits:** skip them, or show a Skip button; and whether to
  ask TheIntroDB and IntroDB, which know them from other viewers.
- **Accounts:** SIMKL or Trakt, to keep a record of what you finish, and
  OpenSubtitles.
- **Extras:** [ffmpeg](https://ffmpeg.org), which Kinema uses for intros,
  credits and a title's picture and sound details but does not include, and
  an OMDb key for Rotten Tomatoes scores.

Everything on them is in Settings too, and Settings → Library → **Run setup
again** brings the pages back. After the first scan, Kinema scans once at
every start and only looks at what changed.

Posters, descriptions and artwork come from [TMDB](https://www.themoviedb.org),
through a key Kinema carries — there is nothing to sign up for. If you would
rather use a free TMDB key of your own, paste it in Settings → Library. Should
TMDB ever be out of reach, movies are still identified through Wikidata, just
without pictures.

Press **?** at any time — or the **?** button in the top bar — for the full list
of keys and remote buttons.

## Optional extras

None of these are bundled, downloaded or required. Each one adds a feature, and
without it that feature is skipped and everything else carries on.

| | What it adds | Without it |
|---|---|---|
| **[ffmpeg](https://ffmpeg.org/download.html)** | Kinema's own intro and credits detection, by fingerprinting a season's audio; and the picture and sound badges on a title's page — resolution, Dolby Vision, HDR, Atmos, the measured aspect ratio | Intros and credits come from TheIntroDB and chapter markers only; a title's page keeps its source, studio, age rating and scores, without the picture and sound badges |
| **[Skiptro](https://github.com/MikeSiLVO/skiptro-releases)** | A second, well-tuned intro detector that Kinema can run and read | The built-in detector handles it |
| **An [OMDb key](https://www.omdbapi.com/apikey.aspx)** (free) | Rotten Tomatoes scores on a title's page, in Settings → Library. Kinema spends at most half of a free key's daily lookups | IMDb's and TMDB's scores only |

Put ffmpeg on your `PATH`, or point Settings at it. Skiptro is configured the
same way, at whatever path you installed it to — point Kinema at `skiptro.exe`,
the command-line one, not `Skiptro-Desktop.exe`.

**TheIntroDB** and **IntroDB** are on by default and need nothing installed.
They are two separate collections of intro, recap and credits times that viewers
have shared, looked up one episode or film at a time, when you play it. IntroDB
also knows where some films have a scene after the credits, so Skip can take
you straight to it. Only which film or episode it is gets sent — no account, no
key, nothing about you. Turn either off in Settings if you would rather it did
not.

**SIMKL** is off until you connect it, in Settings → Accounts. Kinema then adds
each film and episode you finish to your SIMKL account — and, once, everything
you had already watched in Kinema. It only ever adds: nothing comes back, and
marking something unwatched in Kinema leaves SIMKL alone. You approve Kinema on
SIMKL's own page, so Kinema never sees your password.

**OpenSubtitles** needs nothing to start: "Find subtitles online" in the
player's Audio & subtitles panel allows 5 downloads a day, or 20 with a free
OpenSubtitles account, signed in under Settings → Accounts. What is found is
kept in Kinema's own folder, never beside your videos. Settings → Playback can
also have Kinema fetch forced subtitles by itself for files without them.

**Trakt** works the same way, beside SIMKL in Settings → Accounts, with one
difference: Trakt keeps every play it is sent, so when you connect Kinema first
asks what your Trakt account already has and sends only the rest. A free Trakt
account can be connected to only one app besides Trakt's own.

## Platform support

**Windows 11**, using the WebView2 runtime that ships with it. Nothing else to
install.

**Linux**, since 0.8.0: Ubuntu 24.04 or later, Debian 13 and Fedora through
the packages, other distributions through the folder, on x86-64 and ARM.
Kinema uses the system's own mpv and WebKitGTK. Wayland offers no way to put
Kinema's page over mpv, so on Linux mpv plays in a full-screen window of its
own and draws Kinema's controls over the video itself (docs/HISTORY.md, "The
Linux player"). The equipment check, sound straight to a receiver and screen
switching have been checked on a real TV and receiver with GNOME, KDE Plasma,
Sway and Hyprland, on an NVIDIA and an AMD card. Kinema is built to work the
same on any desktop and fall back safely, rather than tested on every one —
see [When something goes wrong](#when-something-goes-wrong).

An Android version is planned next. macOS is not planned by the author; a
port is welcome, and [CONTRIBUTING.md](CONTRIBUTING.md) ("More than one
platform") says how the code is arranged for one.

| | Windows 11 | Linux |
|---|---|---|
| Builds and passes its tests | ✓ | ✓ |
| Library, matching, artwork, accounts | ✓ | ✓ |
| Playback, controls, remote keys | ✓ | ✓ |
| Equipment check, sound straight to a receiver | ✓ | ✓ |
| Screen switching (refresh rate, resolution) | ✓ | ✓ on GNOME, KDE Plasma, Sway, Hyprland and the other wlroots desktops |
| HDR switched on for an HDR film | ✓ | ✓ on GNOME and KDE Plasma, by Hyprland itself, and on Sway 1.12 or later (not yet tried on a real TV); needs a driver that offers HDR ([above](#linux)) |
| Sleep / shut down | ✓ | ✓ where the system allows it without a password (logind) |

## Building from source

On Windows 11: [Node](https://nodejs.org) 20+, [Rust](https://rustup.rs) with
the MSVC toolchain, and Microsoft C++ Build Tools. (On Linux, the packages to
install and how the playback wrapper is built are in
[CONTRIBUTING.md](CONTRIBUTING.md#building).)

```bash
npm install
```

Fetch the native playback libraries — about 95 MB, never committed:

```bash
npx tauri-plugin-libmpv-api setup-lib
```

That pulls an LGPL build of `libmpv-2.dll` and the plugin's wrapper into
`src-tauri/lib/`. See [NOTICE.md](NOTICE.md) for what that means licensing-wise.

```bash
npm run tauri dev
```

To build the portable app and put a shortcut on the desktop:

```bash
npm run app:build
```

`ffmpeg` on `PATH` is optional for development; without it the intro-detection
tests that need real media are skipped.

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything — particularly
[docs/GOTCHAS.md](docs/GOTCHAS.md), which is required reading before touching the
player or D-pad navigation.

## When something goes wrong

Kinema writes two logs to `%APPDATA%\com.kinema.app\logs\` on Windows and
`~/.local/share/com.kinema.app/logs/` on Linux. The quickest way there is
**Settings → Advanced → Developer tools → Open log folder**:

- **`app.log`** — the app's own messages. The window's own console is
  invisible from outside the app, so this is where its errors go.
- **`mpv.log`** — the player's. This is the authority on anything about video:
  it records what actually happened in the render pipeline, not what was asked
  for.

Attach both to a [bug report](https://github.com/Basswaves/kinema/issues/new/choose).
They are the most useful thing you can send, and most problems here produce no
visible error at all — only a log line.

On Linux, Kinema is built to work the same everywhere rather than tested on
every desktop, version and driver — there are too many for one person. It
uses the shared standards first and falls back safely: where it cannot ask a
desktop to switch the screen, or a driver offers no HDR, the film still
plays. If your setup still misbehaves, a bug report with the logs, your
distribution, desktop and graphics card is how it gets fixed.

## Known limitations

- **Windows and Linux only.** Android is planned next; macOS is not planned
  (see [Platform support](#platform-support)).
- **Tested on a small number of setups.** HDR passthrough, bitstreaming to a
  receiver and display switching have been confirmed on a 4K HDR TV with an AV
  receiver; TV overscan, intro detection on many different shows, and libraries
  of several hundred movies have had less exposure. The roadmap lists what is
  unverified. If something behaves strangely on your equipment, the log files
  (above) are the most useful thing you can send.

## Documentation

| | |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to build, verify and submit a change |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, data flow, and why each decision went the way it did |
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | Traps in libmpv, Tauri, SQLite and spatial navigation. Every entry cost a real debugging round |
| [docs/HISTORY.md](docs/HISTORY.md) | How it was built, and why each decision went the way it did |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is next, what is not planned, and where help is wanted |
| [NOTICE.md](NOTICE.md) | Third-party licences and attribution |
| [SECURITY.md](SECURITY.md) | What the attack surface is, and how to report something |

## Licence

[MIT](LICENSE).

Kinema links against libmpv, which is LGPL, and the release bundles an
unmodified LGPL build of it that you are free to replace. It uses data from TMDB,
TVmaze, Wikidata, Wikipedia, TheIntroDB and IntroDB, each under their own terms. [NOTICE.md](NOTICE.md) has the
detail.

This product uses the TMDB API but is not endorsed or certified by TMDB.

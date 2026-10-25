# Changelog

Notable changes, newest first. Follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic
versioning](https://semver.org/), with the usual caveat that a `0.x` release
makes no stability promises.

## [Unreleased]

### Added

- **Pictures already in your library are used.** A poster.jpg, folder.jpg,
  cover.jpg, fanart.jpg, backdrop.jpg or background.jpg beside a film, or
  `<file name>-poster.jpg` / `-fanart.jpg` (also .png, .webp), and the same in
  a show's folder (above its season folders), as Kodi, Jellyfin and
  tinyMediaManager leave them. They win over TMDB's, which are fetched only
  for what is missing. They are found after each scan, so adding or removing
  one shows at the next scan. Read only, never written. Works on network
  shares too.
- **A title kept without a match** ("Add without a match") now gets a picture
  taken from its file when there is none beside it (desktop; Android shows its
  name as before).
- **Subtitle size, and a dark box behind them.** Four sizes (Small, Normal,
  Large, Larger) and an optional dark box, for people who sit far from the
  screen, see less well, or lose white text on a bright picture. Kept per
  screen, so a desk monitor and a TV can differ. In Settings → Language and
  subtitles and in the player's Audio & subtitles panel ("Reading them"), by
  mouse, keyboard and remote. Applied as each file starts, so forced
  subtitles and OpenSubtitles files follow too. Picture subtitles (Blu-ray,
  DVD) only scale; styled subtitles keep their look, scaled. Desktop only;
  Android says so in Settings, since Media3 draws its own captions.
- **A second subtitle language, at the top.** Choose it in the player's Audio
  & subtitles panel ("Second subtitles, at the top"). Text subtitles only,
  never the same track as the first. Remembered per title, and per Videos
  folder; None clears it. Desktop only (Media3 shows one text track).
- Library upgrade to schema 29 (`sub2_lang` in `title_prefs` and
  `video_prefs`).
- **A sound delay for each sound device.** In 10 ms steps, for receivers or
  TVs that put the sound out of step with the lips. In the player's Audio &
  subtitles panel (-10 / +10 / 0, works with a remote), with Ctrl + / Ctrl - /
  Ctrl 0 on a keyboard, and in Settings → Picture & sound beside the sound
  device. Kept per device, put on as each file starts, and shown in Playback
  details. Computers only for now.
- **A chapter list in the player.** A Chapters button appears when the file has
  chapters; it opens on the chapter playing, and OK jumps to another. Remote,
  keyboard and mouse.
- **Shuffle and repeat on a playlist's page**, kept for each playlist. Shuffle
  plays every item once before any plays again; Previous goes back the way it
  came; repeat starts again from the top (or with a new shuffled round).
- Library upgrade to schema 30 (`shuffle`, `repeat_all`, `shuffle_order` on
  playlists).
- **My list.** One list for anything to keep handy, to watch later or loved.
  "+ My list" sits beside Play on a film's or a show's page; L on a
  highlighted card or page puts it on or takes it off (a small red ribbon on
  the card). Home has a "My list" rail, newest first, hidden while empty. Kept
  on this computer only and never sent to SIMKL or Trakt. It survives
  matching again (a key added, a folder moved).
- **Play something.** A button in Home's top row (and S) picks something to
  watch: a film you have not seen, or the next episode of a show you are in
  the middle of. On a genre, a collection or the Movies / TV shows shelf it
  picks from what that page shows. It shows the pick (poster, name, one line
  why) with Play, Another and Not now before anything plays. Never something
  in Needs attention or a Videos clip, and not the last few picks again. Only
  when nothing fits does it take anything not yet watched (a show not started
  begins at episode 1).
- Library upgrade to schema 31 (`my_list`).
- **Fallback matches move up to TMDB, all of them.** Kinema uses Wikidata and
  OMDb (films) or TVmaze (shows) only when no TMDB key works. Once one does,
  each scan moves up to 40 of those titles to TMDB, by the TMDB id held; else
  by the IMDb id; else (shows) by the TheTVDB id TVmaze holds; else by a TMDB
  search under the usual rules. A title matched by hand or by an NFO's id moves
  only by an id, never by search. With no confident answer it stays as it is
  (never sent to Needs attention) and is asked again a month later. Files,
  resume points, playlists, track choices and local pictures stay; watch
  history and My list follow. The last scan line in Settings says "12 films
  and 2 shows got pictures from TMDB". Before, only Wikidata films that named
  their TMDB id moved.
- Library upgrade to schema 32 (`upgrade_checked_at` on `titles`).
- **Videos: badges for the focused video.** The video you highlight or hover
  shows its picture and sound badges at the foot of a Videos page, from the
  file's own facts, as on a film's page.
- **A Videos folder with only its own videos** (no sub-folders) now has the
  Play all and + Playlist row, so even a single video can be added to a
  playlist from the page, not only from the player.
- **Several files of one film or episode are one title with versions.** A
  "Version · 4K UHD · HDR10" button sits beside Play when the film (or the
  episode Play means) is in more than one file. It opens a list naming each
  file in plain words: resolution, HDR (Dolby Vision, HDR10+, HDR10, HLG),
  edition, then size, e.g. "4K UHD · HDR10 · Director's Cut · 58 GB". Where two
  would read the same, the video codec, then the source, then the file's own
  name are added. Works by mouse, keyboard and remote. Episode rows on a show
  page play the same way.
- **Play picks the version for you.** The one you chose last time for that
  title. The first time, the one that fits the screen the picture is on: one
  it can show whole, then HDR where the screen shows HDR, then the most
  pixels, then the bigger file. An edition is never preferred by itself. Where
  the screen is not known (Android, or the query fails) it is the biggest
  picture, as before.
- **Your choice is remembered per title**, by the provider's ids, so it
  survives matching again. A show's choice carries over to other episodes by
  its words: picking "720p" once means the 720p copy of the next episode,
  where there is one. Resume points and watched marks are shared between
  versions, as they already were.
- **Settings → Library: "Here more than once".** How many films and episodes
  are in more than one file, with a list of each version and the total size.
  Kinema never deletes a file.
- Library upgrade to schema 33 (`version_choice`).

### Changed

- **The website's disc guide is rewritten** as "How to rip your DVDs, Blu-rays
  and 4K discs": DVD, Blu-ray and 4K in one page, step by step with drawings,
  picking the right title (including discs with many fake titles), which
  tracks to keep, series discs, naming, troubleshooting and questions. Same
  address as before.
- **Up next names the episode.** Up next and the playlist's Up next card say
  "S05E02 · its name". The episode's name also stays in the player's top line
  after Up next has moved on.
- **Audio & subtitles** tells apart tracks that would read the same: picture
  or text subtitles, then the track's number in the file. Audio tracks too.
- The player's Next and Previous episode buttons name the episode, not the
  show. Back has a name for screen readers and the test tools even while the
  controls are hidden.
- **Scan progress in plain words** everywhere: "Reading file names…" and
  "Finding the titles · 348 of 397", where it said "parsing…" and "matching:
  348/397".
- **Needs attention says why** in plain words ("The name is 52 % alike, the
  year is the same; another title looked just as likely", "Nothing came back
  for this name"), and counts titles, not "groups the matcher would not guess
  at".
- The Welcome page's folders each have a Remove button.
- **Network drives (Android) explain themselves.** The first steps say what a
  network drive is (your NAS, or a computer sharing a folder), that it needs
  that shared folder with its user name and password, and that guest sign-in
  is not possible yet. When a computer shares no folder yet, the share step
  says so and how to share one on Windows (right-click, Properties, Sharing,
  Share), with Try again. A path typed for a folder on that computer is
  explained instead of being opened.
- **Send a report** keeps each log's last 16 MB at most (mpv's own log can
  grow large), and the zip is never left half-written.
- **Settings search** finds a setting by the words shown for it on screen.

### Fixed

- A network drive's refusals ("Bad Network Name", wrong password, locked
  user, closed connection) are said in Kinema's words, never as a raw status
  code.
- Home: the dot for a new Kinema version shows beside the count of titles to
  review. It was hidden whenever titles waited for review, which is why
  Android TV seemed to have no update notice on Home.
- Home and the setup pages no longer log "Component added without a node
  reference", and Home's remote navigation keeps its place when titles first
  arrive in an empty library.
- Importing an .m3u named like an existing playlist names the new one "Name
  (2)" instead of making a second playlist with the same name.
- A Videos folder's typed name is kept when adding it merges library folders
  inside it.
- After a minute of not asking an unreachable TMDB, Kinema again takes three
  failed requests in a row before it stops asking, not one.
- Needs attention: "answers now" (TMDB dropped once but answers again) is no
  longer repeated for every later title of the same scan.
- The log hides key values in any letter case (API_KEY=, ApiKey=) and access
  tokens too.
- Leaving the player after it moved on to another episode of a show goes to
  that show's page, not Home.
- Finishing the setup pages while the first scan is still finding titles shows
  "Reading your library" with what it is doing, instead of the Welcome page
  again.
- Choosing second subtitles now closes their list, so a stray OK does not pick
  again.

### For contributors

- The Kinema MCP's `kinema_app` takes `env` for one run, e.g. a dead
  `HTTPS_PROXY` with `NO_PROXY` for `www.wikidata.org` to make TMDB
  unreachable.
- Versions: `versions.rs` (`title_versions`, `version_choice`,
  `choose_version`, `duplicate_titles`; 4 tests), `versions.ts` (the rule; 9
  tests), `VersionDialog.tsx`, `useVersions.ts`, `DuplicatesSection.tsx`, and
  `e2e/versions.e2e.ts` on the mock's `kinemaMockVersions` flag.

## [0.13.1] — 2026-10-24

Fixes for what the first outside tester met: when TMDB gives no answer, Kinema
tries again and on TMDB's second address, and says what really failed instead
of "could not identify" or "no internet". Send a report says which file to
attach before the form opens.

### Changed

- **Matching says what really failed.** When TMDB gives no answer, Kinema
  tries TMDB's second address (`api.tmdb.org`, the same service and terms) and
  keeps the one that answers. When neither does, it names the cause: the name
  could not be looked up, the connection was refused or cut off, it timed out,
  or the secure connection failed. It also says whether the internet itself
  works (checked against Wikidata), instead of "Couldn't reach the internet".
  Other services' failures name their host. Settings -> Privacy lists
  `api.tmdb.org`.
  The log records the full cause and whether a proxy is set (never its
  address), for Send a report.
- **Send a report** saves the zip and says its name and folder. "Open the
  report form" and "Show the file" are separate presses, so the browser no
  longer covers the note. The crash screen says the same, where a failed
  report used to say nothing.
- **Trakt's card** says that where you stopped is read back (Trakt resume); it
  said nothing comes back.
- ffmpeg found on the PATH is said so. The setup page says 5 subtitle
  downloads a day without an account and 20 with one.

### Fixed

- Keys no longer show: a failed request's address, with TMDB's or OMDb's key
  in it, is cut at its query on screen (Needs attention showed it) and in the
  log, which goes into Send a report's zip. A lookup that got no answer no
  longer says "could not identify this"; the next scan asks again.
- Re-watching a watched film or episode keeps it watched; a re-watch stopped
  before 80 % can be resumed. Where a play finished is no longer kept as a
  position (library schema 26 → 27, which clears it on the files already
  watched), so a finished film is never offered as a resume.
- A year written twice in a name ("Film 2017 (2017)") no longer stays in the
  title and stops it matching.
- Self-tests never run Skiptro, whose database is the real one.

### For contributors

- **The Kinema MCP** (`.mcp.json`, `scripts/mcp/`): Claude Code or another MCP
  client can drive the real release app on a copy of the library — state,
  keys, clicks, mpv properties, logs, read-only SQL. See CONTRIBUTING.

## [0.13.0] — 2026-10-23

Easier to start with and to trust: Settings is grouped by what you want and has
a search box, Settings → Privacy lists everything that leaves your computer,
Send a report packs the logs for a bug report, the website has direct
downloads and two guides, and text can be copied with the mouse. Release files
now have fixed names without the version.

### Added

- **Search in Settings**: a box at the top of the section list finds a
  setting by its name, what it does or one of its choices; OK on a match opens
  its section with the ring on that setting. The TV layout brings up
  Kinema's own letters on OK, as Search does.
- **What leaves your computer** (Settings → Privacy): every service Kinema
  can talk to, what it sends, when, and what stops it, with whether each
  switchable one is on now and a button to its setting. A test keeps the
  list in step with the code.
- **Send a report** (Settings → Advanced → Developer tools, and the crash
  screen; Windows and Linux): both logs and the equipment check in one zip
  in Downloads, shown in its folder, and the bug-report form opened. Your
  home folder's name is replaced by `~`. Kinema sends nothing itself.
- **Copy text with the mouse.** Titles, plots and cast on a title's page,
  Settings, the details panel and Needs attention's file names can be marked
  and copied (Ctrl+C, or right-click → Copy). Cards, buttons and the player
  stay unmarkable.
- **Language codes in the audio and subtitle menu** (`EN`, `NO`, `PT-BR` where
  the file names a region) at the start of each track's row.
- **A "+" on each episode row** adds just that episode to a playlist. The
  show page's button adds the whole season and now says so: "+ Playlist
  (season 1)".
- **Fixed names for release files**, without the version (for example
  `kinema-windows-x64-setup.exe`, `kinema-linux-amd64.deb`,
  `kinema-android.apk`), so a link to the latest release's file always works.
  The checksums and the install text follow.
- **Download buttons on the website**: a big one per system. On Windows it is
  the installer, with the portable ZIP beside it and a line on which to pick.
  The Download button at the top starts the download straight away on Windows
  and Android TV.
- **New guides on the website**: "How Kinema reads file names" (also a short
  section in the README), "Getting your Blu-rays into Kinema" (MakeMKV, names,
  4K discs; Kinema rips nothing itself) and "What leaves your computer" (the
  same text as Settings → Privacy).
- **Needs attention** (Settings → Library) has a button that opens the
  file-names guide.
- For contributors: the website is published only when the latest release has
  every file it links to; otherwise the old site stays up.

### Changed

- **Settings is grouped by what you want, not by service**: Language &
  subtitles, Skipping intros, Keep track of what I watch and Posters &
  ratings replace Accounts, and each service sits on the card that uses it
  (OpenSubtitles under subtitles, SIMKL and Trakt under keeping track, the
  OMDb key under ratings). The setup pages follow: Skipping intros, Keep
  track of what you watch, Subtitles online, Details and ratings. Messages
  that send you to a setting (the details panel's fixes, errors, the log)
  now name its section, as do the README and the website.
- **Right-click no longer shows the browser's menu** (Back, Reload, Save as,
  Print — Reload restarted the interface, even mid-film). Text fields keep
  Cut, Copy and Paste; elsewhere right-click does nothing.
- **At a desk, Library's Folders tile is "Add a folder"**: the system's
  folder window opens at once, then Kinema asks Movies, TV shows or Videos.
  The TV layout keeps the full Folders page, since a sofa has no Explorer.

### Fixed

- A playlist's name on Home's Playlists rail, and a video's name on its
  tile, now grow with the window and the TV layout as card titles do.

## [0.12.0] — 2026-10-18

For Windows and Linux: Videos folders and a Library tab, Folders (browse
drives and shares inside Kinema), Playlists with `.m3u` import and export,
Trakt resume across devices, previous and next file for a video opened from
outside the library, and Open With on Linux. Android gets the Library
screens, Folders, playlists and Trakt resume, but not `.m3u` import and
export, and its video tiles show a plain picture. The library is upgraded
(schema 26); a safety copy is made first.

### Added

- **Videos folders.** A third kind of library folder, for what is neither a
  film nor a show: home recordings, concerts, downloads. Settings → Library →
  Add Videos folder, then give it a name (it starts as the folder's own).
  Its files are never matched, so they never land in Needs attention, and
  re-parsing leaves them alone.
- **A Library tab.** The top bar is now Home, Movies, TV shows, Library,
  Search, Settings, ?. Library has tiles for Videos folders, Folders and
  Playlists, so the bar does not grow again.
- **A Videos folder's page.** Its own files first, then one group for each
  sub-folder with Play all, which starts at the first video you have not
  finished. Each video is a tile with a frame taken from the file, its name,
  its date (from a date in the name such as 2024-05-02, else the file's own)
  and a progress bar or a tick. On Android, and where no frame can be taken,
  the tile has a plain picture. Clearing the artwork cache removes the frames
  too; they are taken again.
- **Previous and next through a video's folder.** The buttons, `n`/`p` and
  Up next step through the videos beside it in file-manager order (clip 2
  before clip 10), as they do for episodes.
- **Videos are remembered like the rest.** Resume, watched, Continue Watching
  (one card for each folder, removable) and Search (a Videos row) all cover
  them. They never become Home's big picture, and a library of videos alone
  is not treated as a first run. Audio and subtitle choices are remembered
  for each folder instead of each title.
- **Services stay out of videos.** No intro or credits skipping, no
  OpenSubtitles, and nothing sent to SIMKL or Trakt, since a video has no
  title to send.
- **Previous and next file for a video outside the library.** A video opened
  from the file manager or dropped on the window now has previous/next
  buttons, `p`/`n` and a remote's track keys for the videos beside it in its
  folder, in the order the file manager lists them. The end of a video still
  ends playback, as before.
- **"Open with" on Linux.** The `.deb` and `.rpm` now list Kinema for video
  files, so a file manager offers it under Open With. The `.tar.gz` folder
  has Settings → Playback → Add Kinema to the app menu, which puts it in the
  app menu and in Open With for your account only, and can take it out again.
- **Folders, inside Kinema.** The Library page has a Folders tile that opens
  a page for browsing your drives and network shares and playing any video
  in them, on Windows, Linux and Android. It starts with places: your drives
  (named as the system names them), your library folders, and the network. On
  a desktop, type an address such as `\\server\share` (Windows) or any folder
  path (Linux); the system signs in, and addresses that opened are kept under
  "Opened before". Inside a folder, "Add this folder to the library" asks
  whether it holds movies, TV shows or videos and scans straight away. A
  video in a library folder plays as the library's own file (resume, languages,
  Skip intro); any other plays as a video of its own. Back goes up a level,
  and back from a film returns to its folder with the film selected.
- **Playlists.** The Library page has a Playlists tile beside Videos folders
  and Folders. It shows a tile for each playlist, the one touched last first,
  "+ New playlist" (you type the name) and, on desktops, "Import .m3u…". A
  playlist's page has ▶ Play, or "▶ Carry on: <item>", which goes on from the
  item last started, or the one after it if that was finished; Rename; Export
  .m3u… (desktops); and Delete, which asks first. Each item has play, ↑, ↓ and
  Remove. Items not found at the last scan are greyed and skipped when playing.
  Add with "+ Playlist" on a film's page, on a show's page (the season shown:
  its episodes on disk, in order), beside each Play all on a Videos folder's
  page, and "Add to a playlist ›" in the player's Audio & subtitles panel,
  which adds exactly what is playing — an episode, a video, or a file opened
  from outside the library. The same file is never added twice. In the player a
  new playlist is named "Playlist 2" and so on, since the player's keys leave
  no room for typing; rename it on its page. Previous and next, `n` and `p`,
  and Up next follow the playlist, not the show or the folder. A playlist plays
  once through; there is no shuffle or repeat yet. Home has a Playlists rail
  after Continue Watching whenever a playlist exists, and a tile opens the
  playlist. Importing `.m3u`: files the library holds play as themselves;
  other files that exist are kept as loose files and resume by path; files
  that are missing and web addresses are left out and counted in the message.
  Relative paths are read against the list's own folder, and `file://`
  addresses are read. Export writes `#EXTM3U` with a length, a name and the
  path for each item. Import and export are on Windows and Linux, not yet
  Android. The library upgrades to schema 26 with the usual safety copy.
- **Trakt resume across devices.** With Trakt connected, Kinema continues on
  one device where a film or episode was stopped on another. It is on while
  Trakt is connected; Settings → Accounts → Trakt, "Continue where you stopped
  on another device", turns it off. The newer position wins, never the older,
  and something finished here after the pause stays finished. Trakt is asked
  when a title's page opens and when Home's Continue Watching loads, once for
  the whole list, and the answer is kept two minutes. Leaving a film or
  episode part-way sends the position; at 80 % or more nothing is sent, since
  Trakt would count that as a play, and finished items go through the history
  as before. Finishing something here removes Trakt's resume point for it.
  There is still no "Watching now". Where this copy's length is not known (it
  was never played on this device), the share Trakt keeps is used and the title
  page says "Resume at 40 %". Videos, titles kept without a match and files
  holding two episodes are never sent or matched. SIMKL stays one way. Android
  has it too.

### Fixed

- A video whose file name starts with `-`, opened with Kinema, was passed over.
- The stats panel (`i`) said "Render passes: not reported by this VO" on
  Windows and Linux although mpv measures them. It now lists the passes that
  ran on the last frame, with their times.

### Library

The library is upgraded (schema 26); a safety copy is made first.

## [0.11.0] — 2026-10-17

For Windows and Linux: Blu-ray folders and disc images, Kinema as the video
player Windows opens files with, a Windows installer, ffmpeg in one press,
and titles kept without a match. Android is unchanged apart from the shared
fixes. The library is upgraded (schema 23); a safety copy is made first.

### Added

- **Add without a match.** In Needs attention, a film or show no database
  lists (a home video, a fan edit) can be kept under its own name and year,
  in Movies or TV shows; a later episode of a kept show joins it. Its page
  has Rename, and Find a match sends it back to the queue.
- **ffmpeg in one press on Windows.** Without ffmpeg, a film's page has no
  picture and sound badges and Kinema cannot find intros and credits from
  the sound itself. The first run's Extras page, Home's notice and Settings →
  Intro & credits now offer to install it through winget, Windows' own
  package manager (Gyan's build, about 110 MB, for your account only; it
  stays if Kinema is removed). Kinema finds it without a restart. Without
  winget, the download page opens instead. On Linux, the `.rpm` now
  recommends ffmpeg (or Fedora's ffmpeg-free), and Settings says what an
  ffmpeg that cannot decode some formats costs.

- **A Windows installer**, `kinema-<version>-windows-x64-setup.exe`, beside
  the ZIP (the ZIP stays). It installs for your own Windows account without an
  administrator, adds a Start menu entry and a desktop shortcut, and is listed
  in Settings → Apps. If Windows has no WebView2, it fetches it from Microsoft.
  Uninstalling removes the program, the shortcuts, Kinema's entries in
  Windows' "Open with" and Default apps lists; it asks first, with a box left unticked, before
  deleting your library and settings. Installing a newer version over it keeps
  everything. Every release publishes a checksum for it.
- **Kinema opens videos from File Explorer.** Open a video with Kinema, or
  drop one on its window, and it plays — whether or not it is in your
  library. One in the library plays as itself, with its resume point and
  languages; any other is remembered where you stopped. Started for a video,
  Kinema goes straight to the player and closes when the video ends or you
  press Back; already open, it plays the video and then goes back to where
  you were. On Windows, Settings → Playback → **Offer Kinema as a video
  player** adds it to Open with and to Default apps, where you choose what it
  opens; **Remove** takes it out again. The library is upgraded (schema 23)
  to remember videos that are not in it; a safety copy is made first.
- **Blu-ray disc folders and disc images play.** A folder holding a disc's
  `BDMV` is now one film in the library, and an `.iso` of a Blu-ray plays as
  the disc — the main film, with its chapters and the languages of its sound
  and subtitle tracks. Menus are not shown. An encrypted disc is not played;
  Kinema says so, in mpv's own words, instead of a vague failure.
- **Blu-ray `.m2ts` files know their languages** when the disc's `BDMV`
  folder is still beside them, so remembered sound and subtitle choices find
  the right tracks.
- **The film pauses when the sound has nowhere to go** (Windows and Linux).
  If the sound device a film plays through disappears, or the player's sound
  output closes, mid-film — a USB headset unplugged, an AV receiver that
  takes its input away when switched off — the film pauses and says so until you
  press Play, which opens the sound again. Not every receiver tells the PC it went off;
  where nothing changes, the film plays on as before.

### Fixed

- **A long shelf of posters keeps up when scrolled** on Windows and Linux.
  Posters were kept at their full 2000 × 3000 size for cards about 150
  pixels wide; they are now 780 wide, about a fifth of the work to draw.
  Posters already saved are fetched again once, in the background.
- **Needs attention counts only what is really waiting for you.** Adding a
  big folder put every new file there at once and the number then fell file
  by file; now only what the matcher refused or cannot match is counted, and
  the number holds until matching ends. The top bar, Home and Settings show
  the same number. A scan now matches all of a big folder, where it stopped
  after the first 2,000 files until the next start.
- **TV mode is the same size on every screen.** On a 4K TV with Windows
  scaling at 300 %, TV mode came out half as big again as it was drawn, so
  less fitted — the detail page's picture, sound and file badges ran off the
  bottom. TV mode is now the 1080p layout scaled to the screen, as on
  Android.
- **Two more studio logos keep their lettering.** The Warner Bros. shield was
  a white shape with nothing in it; it now shows the shield's outline and
  "WB". A logo with dark lettering on a white plate whose edges fade
  (Weed Road Pictures) was a white rectangle; its lettering now shows.
- **Lighter player controls on Linux.** With the controls up, only the parts
  of the page that show anything are handed to the player — about a fifth of
  what was copied ten times a second before, at 4K.
- **The player starts on a Windows without Microsoft's Visual C++ runtime.**
  On a fresh Windows the player could fail to load at all ("Failed to load
  libmpv-wrapper"). The small file that connects Kinema to the player now
  carries what it needs. This affected the ZIP too.
- **Down in the player's details panel stays in the panel.** With a remote or
  the arrow keys, going down through the panel's facts could now and then jump
  to Pause instead of the next group.
- **The Windows download's checksum file checks on Linux too.** Its line ended
  in a Windows line break, so `sha256sum -c` looked for a file of the wrong name.

## [0.10.0] — 2026-10-11

The first release with an Android TV version (an early version, below), and
for Windows and Linux a lot of work on how the interface moves, how much the
player keeps ready and how the library behaves while a film plays. The library
is not upgraded (schema 22, as in 0.9.0).

### Added

- **Kinema says which version it is.** Settings → Advanced → Updates now
  begins with "This is Kinema 0.10.0".
- **A folder that holds folders you already added can be merged.** Adding a
  parent folder used to be refused with a note to remove the others first, which
  would have forgotten what was watched in them. Kinema now offers to merge them
  into it, on the first run and in Settings: their films and shows, matches
  and watch history stay exactly as they are.
- **Android, as an early version (beta).** Kinema now runs on Android TV
  boxes, installed by hand from the release's `.apk` (sideloaded); the same
  file installs on a phone, which has not been tried yet.
  It has its own player engine (Media3) for Dolby Vision and sound passed
  straight through, the same library, matching, accounts and subtitles as
  the desktop, network shares and USB drives, and the same interface with a
  remote or a keyboard. In the player: volume and mute, the film's audio and
  subtitle tracks to choose from (the choice is remembered for the title),
  subtitles drawn the way mpv draws them on the desktop, subtitle files beside
  the film found before it opens, and a details panel that says what Android
  is doing. Blu-ray `.m2ts` files (1080p) play, with DTS-HD, TrueHD, E-AC-3 and
  picture subtitles. It has been tried on one TV box and on the Android TV
  emulator only, and a few things are not there yet: the badges on a film's
  page, intro detection from the audio, and Blu-ray folders, disc images and
  4K UHD `.m2ts` files (a file that cannot be opened here is said so before
  Play). Held keys and the on-screen keyboard have not yet been checked on a
  real box. Reports from other devices are welcome; the README says what is
  known.
- **Android: a line under Play when a film is far heavier than the device's
  video chip is made for.** When a file's average bitrate is more than twice
  the highest Android reports for the device's hardware decoder, the page says
  so ("Android says this device's video chip is made for up to 35 Mbit/s; this
  film averages about 88 Mbit/s. It may stutter or show no picture."). It is
  text only: nothing is blocked, and nothing like it shows on the desktop.
- **Playback details without a keyboard.** The details panel ("Stats for
  nerds") opens from the end of Audio & subtitles, and on a remote's Info
  key where it has one, as well as on `i`. A remote moves through it group
  by group, so the parts below the edge of a TV can be read.
- **A light look for weak devices, and a Look setting.** On a device with
  two processor cores or fewer, 2 GB of memory or less, or whose screen
  draws slower than its own pace, Kinema now drops the blur, the large
  shadows and the zoom on a focused card, so menus keep up. It decides by
  itself; Settings → Playback → Look says what it chose and why, and can be
  set to Full or Light instead. The focus ring, the layout and the text do
  not change, and nothing about the film's picture does.
- **Desktop: a graphics card that cannot keep up loses the least visible
  processing first.** If frames are being dropped early in a film, the
  player gives up HDR peak measuring, then the chroma scaler, then correct
  downscaling, then perceptual gamut mapping — one step at a time, only
  while it is needed — and remembers it for that card. The details panel
  names each step and why. A card that keeps up never sees any of it.

### Changed

- **The arrow keys go where you expect on every screen.** Each screen was
  checked arrow by arrow, for a remote, a keyboard and the mouse, on Windows,
  Linux and Android, and every move was agreed. A checker now holds every move
  in place, so a later change cannot quietly move one. In particular:
  - A group's heading stays clear of the top bar when you move into it, and a
    text box rises above an on-screen or hardware keyboard so what you type
    stays in sight.
  - Audio & subtitles keeps the focus inside it and goes round: Up from the top
    option goes to the bottom one.
  - A series' page opens on Play; Down from Back goes to Play; Up from an
    episode and Down from Play land on the season that is being watched, and
    "Mark season watched" is reached by Right from the last season.
  - Opening a "needs attention" item scrolls down to what it opened, and the
    Review button on Settings is in sight when Home sends you there.
  - Home's notice after a scan can be dismissed with the remote's OK.
  - Holding an arrow no longer queues up scrolling: the screen keeps up while
    the key is held.
- **Android: a bigger read-ahead and quicker skips on big films.** Kinema
  now reads ahead from the device's memory (a 4K remux from a USB drive was
  kept ready only about two seconds ahead, and is now about ten), and a skip
  lands on the nearest keyframe, so the picture comes back in about half a
  second instead of up to three. Resuming, the seek bar, chapters and intro
  markers stay exact.
- **A network share reads faster.** Kinema now asks the share for several
  pieces at once, where it waited for each in turn: on a 100 Mbit link it
  reads at the speed of the wire, and the buffer fills much further ahead.
  The first picture after a skip is quicker as well.
- **Desktop: the player keeps more of the film ready.** Every file,
  including one on a USB drive or a mounted share, gets a read-ahead from
  the computer's memory and a skip back is served from it; compiled shaders
  are kept between films; Windows falls back to hardware decoding with a
  copy rather than to software decoding.
- **The library works in the background without getting in the way.**
  Pictures, reading files, the IMDb import, scanning a share and matching
  titles wait while a film plays and run below it when nothing is playing;
  file names are read off the interface's own thread, and titles are
  matched a few at a time.
- **Menus are lighter.** A press in a grid or the search results costs the
  same with 50 titles as with 1,000, a held key no longer queues up
  scrolling, and Home does not redraw everything when you come back to it
  unchanged. The player page does less while a film plays.
- **Android: TMDB pictures are downloaded at TV size** (posters 500 pixels
  wide, backdrops 1280, episode stills 780, and title logos) rather than the
  original, for pictures downloaded from now on; a 4K backdrop took about 33 MB of
  memory. What is already downloaded is not touched, and Windows and Linux
  still fetch the originals.

- **Behind the scenes.** The library database keeps its temporary tables in
  memory and sizes its cache to the device's memory (about 2 MB on a device
  with 2 GB or less, 8 MB above). The developer tools' library view loads only
  when the panel is opened, and Kinema's own measuring tools gained playback
  costs on Android, memory and leak samples. Nothing here shows on screen.

### Fixed

- **Studio logos that lost their name.** Every studio logo is drawn in white,
  which turned a logo that is a coloured plate with light lettering into one
  white block. Light lettering on a clean two-colour plate (Marvel Studios') is
  now cut out of the white, and a logo that is a solid dark plate with its name
  on it (one film's studio badge was a plain white rectangle) has the plate
  taken away so the name and artwork show. Logos with a see-through background
  are untouched. Known to still look wrong: the gold Warner Bros. shield, which
  shows as a plain white shape, and any plate logo that is not a clean
  two-colour design.
- **The "Skip to the scene after the credits" card came up long before the
  credits.** On one big recent film it appeared thirteen minutes early, over
  the ending: two community databases disagreed about where the credits start,
  and Kinema took the earlier time from one and the scene from the other. A
  scene now brings the credits start of the service that timed it, so the card
  shows when those credits begin. Credits measured on your own file still win.
- **Android: a Blu-ray remux with many subtitle tracks stalled.** A film
  with 18 or more picture-subtitle tracks from a network share stopped five
  to seven times in under two minutes, because reading the film waited on
  turning every subtitle track into text. Only the chosen track is decoded,
  and when it is shown; the same films play without a stall.
- **Android: Dolby Vision profile 7 films had sound and no picture** on a
  device with no decoder for that profile, which is most of the Dolby Vision
  Blu-ray remuxes. They now play as their HDR10 picture, and the details
  panel says "Dolby Vision layer not applied".
- **Android: a DTS-HD track that fell back to ordinary sound** because its
  buffer was refused is now tried once at the plain size and, if the device
  takes it, reaches the receiver untouched.
- **Android: every film left a little of itself behind.** Each film played
  kept the closed player's state in memory until Kinema was restarted. Now
  it is let go, and the position stops being reported while Kinema is in the
  background.
- **Browsing a network share's folders no longer freezes the window** for up
  to twenty seconds when the server is slow to answer.
- **Subtitle files named a little differently from the film.** A
  subtitle file beside a film was only offered when its name held the
  film's exactly; one that wrote `7. 1` where the film wrote `7.1` was
  never offered. Spaces, dots, other marks and capitals no longer count,
  on Windows, Linux and Android alike.
- **Android: no picture after the sound fell back.** When a film's sound
  could not go to the receiver as it was — a TV box ran out of room for a
  DTS-HD track — Kinema opens the film again with sound the device can
  play. It then also refused a picture the device's decoder lists as
  beyond it, even one it had just shown, and the film played as sound
  alone. The picture is now left as it was.
- **Android: the remembered subtitles came on only sometimes** when the
  sound fell back while the film was opening: the choice could arrive
  just as the player was being built again, and was lost. It now waits
  for the film's tracks.
- **Android: the frame rate of `.mkv` films.** Media3 gives none for a
  Matroska file, so "Match the screen to the film" could not match the
  refresh rate and the details panel said "not read". Kinema now works it
  out from the frames' times while the film opens (23.976, 25 and 59.94
  checked), says so in the panel, and gives none for a film whose frames
  are not evenly timed rather than guess.
- **Android: the details panel says what Android says of HDR.** It said
  the TV was switched to HDR whenever the film was HDR. A TV box can tell
  Android its screen takes no HDR — one that restarted while the TV was off
  did, and turned HDR films into washed-out ordinary colour until it was
  restarted again. The panel now shows which HDR kinds Android says the
  screen takes, and warns when the film's kind is not among them; Settings
  → Picture & sound says the same, as Android's word, and how to make the
  device check the TV again. Where a device gives Android only one screen
  mode, the panel says the device itself decides what the TV gets — the
  box tested sent 4K while Android was told 1080p.
- **Holding Left or Right on a remote seeks at the right speed.** Where a
  remote's held button arrives as a run of separate presses — as it does
  through Android, and from remotes that re-send the button while it is
  held — every press counted as a tap and the seek ran away: two seconds
  held went to the end of the film. A press while the button is still down,
  or faster than anyone taps, now counts as holding it.
- **Wikipedia was often "busy".** Kinema asked Wikidata not to answer when its
  separate query service lagged, which it did for long stretches, so nearly
  every lookup was refused while the same request without the request was
  answered at once. Kinema only reads, one request at a time and with its name
  sent, and still waits when Wikimedia's servers say too many.
- **Home kept saying films waited for Wikipedia** after they were matched by
  hand, or after a TMDB key was added. The line now follows what still needs
  review and is gone when nothing does.
- **The focus ring could vanish on Home.** With the scan's notice showing, Up
  from Play went to a hidden, empty shelf and the ring disappeared. Empty
  shelves and notices can no longer be moved to.
- **A series' page could land on the first episode instead of Play** on a slow
  device, because Play appears only once the next episode is known. The page
  now waits for it.
- **Android: "No sound" flashed at every start** while the sound was playing
  fine. The check that asks mpv whether the sound opened ran where mpv does not
  exist, and counted the missing answer as a failure.
- **The remote works straight after Scan on a slow device.** Reading the
  names of a first scan's files kept the whole interface busy in one go:
  on an old TV box, the setup pages ignored the remote for 15 to 20
  seconds. The names are now read a few at a time, with the remote let
  through between them.

## [0.9.2] — 2026-10-05

For Windows and Linux: Kinema's own icon, reading on with Down, and fixes
to the first run and the interface. The library is not upgraded (schema 22,
as in 0.9.0).

### Added

- **Kinema's own icon:** a K whose upright is a strip of film, in the
  interface's red and white on its near-black — on the window, the taskbar,
  the desktop shortcut and Linux's app menu, where Tauri's placeholder was.
- **Down at the end of a page reads on, and Up reads back.** Text below a
  page's last control — the notes under the last setting, a film's picture
  and sound badges in a short window — could only be seen with a remote
  when it fitted on screen together with that control. Down with nowhere
  further to go now scrolls the page on, as a TV app does with text, and Up
  brings the control back before it moves anywhere. The focus ring is never
  left half under the top bar on the way.
- **A link that nothing can open is shown instead.** Kinema's links (a free
  TMDB key, a trailer, a sign-in page) go to the system's browser; where the
  system cannot open one, a card now shows the address in words and as a QR
  code to open on a phone, where the button used to do nothing.

### Changed

- **Quick skips are one seek.** Tapping Left or Right several times in a
  row, or a remote that sends a press for every step while the button is
  held, now seeks once, half a second after the last press, to where all of
  them lead — where it used to seek at every press, each one restarting the
  picture. A key held down and let go still seeks at once.
- **The setup pages always say Next.** The way on said Skip until something
  was chosen; Next now accepts what is shown, as it is.
- **Behind the scenes: the groundwork for Android TV.** The Android version
  is not part of this release, but the parts it shares with Windows and
  Linux are, and the points in this list are the only ones that show there.

### Fixed

- **A share or disk that is not mounted no longer empties the library.** On
  Linux the folder a share is mounted on stays behind, empty, when the share
  is not there, and one scan hid every film under it with no notice. A
  library folder that shows no video at all, where there used to be some, is
  now left alone and named on Home, exactly like a drive that is unplugged.
  To retire a folder you have really emptied, remove it in Settings.
- **Home's notice after a scan says what is true.** It ended every problem
  with "Anything from that folder is hidden until it is back" — wrong for a
  folder that is away, whose films stay on the shelves and only cannot be
  played, and for problems that have nothing to do with a folder. A folder
  that could not be reached is now named first, with what that means.
- **A setup page never loses the focus ring.** In a copy of Kinema built
  from source, the Accounts page has nothing to press, and a moment after
  arriving the ring went nowhere, leaving a remote with nothing to do. It
  now stays on Next, and Down reads the page to its end. A page whose first
  question arrives late, as Extras' can on a busy PC, gets the ring when it
  does; and on a computer busy enough, the ring that could go missing on
  arriving at a page until a key was pressed is now given again until it
  shows.
- **Settings: Up and Down stay in the open section.** Going up, the ring
  sometimes jumped to the list of sections beside it; only Left goes there
  now, and Right comes back to where you were.
- **Wikipedia being busy is waited out.** Matching without a TMDB key
  showed Wikidata's own "seconds lagged" message and no results when its
  servers were busy. Kinema now waits as long as they ask, a few times, and
  if they are still busy says so in plain words; the next scan tries again.
- **The player's messages no longer push the controls down.** An error, a
  sound notice or the offer to resume took the top of the screen while it
  showed, and Back and the title moved to the middle. They now sit
  together under the top bar.
- **"Matching the screen to the video…" only when it is.** With screen
  switching on, the notice showed at the start of every film, also when
  the screen was already in the film's mode and nothing changed.
- **An empty Movies or TV shows page says "Nothing here yet."** It said
  everything had been watched and to switch off "Unwatched only" — which
  was already off.

## [0.9.1] — 2026-10-03

For Linux: the mouse in the player, screen switching on Cinnamon, and a
player that no longer freezes after leaving a paused film. Windows is
unchanged. The library is not upgraded (schema 22, as in 0.9.0).

### Added

- **Screen switching on Cinnamon** (Linux Mint's desktop). Cinnamon's window
  manager is a fork of GNOME's and answers the same questions under its own
  name, which Kinema did not ask, so switching was never offered there. It
  now is: the refresh rate and resolution for a film, in Cinnamon's X11
  session (Mint's default) and on Wayland, and the equipment check shows the
  screen's modes. Cinnamon has no HDR, so HDR films are converted to SDR
  there. Checked against Cinnamon's own window manager on a test screen,
  not yet on a real TV.

### Fixed

- **Linux: leaving a paused film no longer freezes the player for a
  minute.** With screen switching on, pausing and then pressing Back
  (button or key) could leave Kinema waiting 50–60 seconds on mpv — the
  film would not close, and the next one would not start, until it was
  over. The screen is now put back before the film's window leaves full
  screen, so the desktop never squeezes the paused picture to a single
  pixel. Found and checked in a nested GNOME desktop.
- **The mouse works in the player on Linux.** Until now only the keyboard
  and a remote did: the film plays in mpv's own window there, and the mouse
  on it never reached the controls. Now moving it brings the controls up,
  clicking the film pauses and plays, a double click switches full screen,
  the buttons click, the seek bar and the volume drag, the wheel turns the
  volume, and the pointer hides with the controls — as on Windows. Checked
  on GNOME, KDE Plasma and Sway, and in an X11 session with Cinnamon's
  window manager (Linux Mint's default).
- **An HDR TV is no longer called an "SDR screen"** on a Linux desktop that
  offers no HDR (Cinnamon, or GNOME with an older driver). Settings → Your
  equipment and the playback statistics now say the screen can show HDR but
  the desktop offers none, which is why HDR films are converted to SDR there.

## [0.9.0] — 2026-10-03

Picture and sound set per device and asked about at the first run, and a
short setup while the first scan reads the library. The library is not
upgraded (schema 22, as in 0.8.0).

### Added

- **A short setup while the first scan runs.** The welcome screen asks where
  Kinema will be watched (a TV from the sofa turns TV mode on at once) and
  where the videos are. Scan then opens a few pages, each skippable, while
  the library is read: picture and sound (sound straight to a receiver, the
  screen matched to the film, HDR on for HDR films, each with what it gives
  and costs, whatever is connected now); intros and credits (skip them or
  show a button, and whether to ask TheIntroDB and IntroDB; Skiptro when it
  is installed); accounts (SIMKL, Trakt, OpenSubtitles); and extras (ffmpeg,
  and an OMDb key for Rotten Tomatoes). Finish later goes straight to the
  library; Settings → Library → Run setup again brings the pages back.
- **Picture and sound per device.** Each of those three now applies to every
  device that can, only the devices you choose, or none — in Settings →
  Picture & sound, with the list of every screen and sound device Kinema has
  seen — so a laptop can behave one way at a home cinema and another at a
  desk.

### Changed

- **Behind the scenes: the player's code is split into its parts, and SIMKL
  and Trakt share what they do alike.** Nothing changes in use: the same
  controls, keys, prompts and screen, and the same history sent to each
  service. Ten new keyboard tests cover everything the player does from a
  sofa, and passed before and after.
- **Home's equipment notice never repeats an answer.** For a question never
  answered, Choose opens Picture & sound instead of switching everything on
  in one press; with only some devices chosen, it mentions only new
  equipment that can do more, and Use it too adds it.
- **"Every device", for sound, means one that takes some of a film's sound
  untouched.** Laptop speakers and other devices that take none keep working
  as usual during a film, rather than the PC's other sounds going silent for
  nothing. A setup that sent sound straight to a receiver still does.
- **Linux: the player rests while its controls are hidden.** The page drawn
  over the film is no longer photographed ten times a second when nothing is
  on it — most of a film — which costs a 4K PC noticeably less.

## [0.8.0] — 2026-10-02

Kinema on Linux, alongside Windows. Packages for Ubuntu and Debian (`.deb`),
Fedora (`.rpm`) and a folder for anything else (`.tar.gz`), for x86-64 and
ARM. The library is not upgraded (schema 22, as in 0.7.0).

### Added

- **Kinema for Linux.** The whole app — library, matching, artwork,
  accounts, the player with its own controls, remote keys, intro skipping —
  using the system's own mpv and WebKitGTK, which the packages install.
  Checked on a real TV and AV receiver with GNOME, KDE Plasma, Sway and
  Hyprland, on an NVIDIA and an AMD card. It is built to work the same
  everywhere rather than tested on every desktop and version: where it
  cannot ask a desktop to switch the screen, or a driver offers no HDR, the
  film still plays. A setup that still misbehaves is a bug report (README,
  "When something goes wrong").
- **Linux: Picture & sound.** Settings → Your equipment lists the screens and
  what each receiver takes; Settings → Sound sends films straight to the
  receiver, untouched, as on Windows; and on GNOME, KDE Plasma, Sway,
  Hyprland and the other wlroots desktops, Settings → Screen switches the
  refresh rate and resolution for a film and puts them back after — and HDR
  on GNOME, Plasma and Sway 1.12 or later (Hyprland switches HDR by itself
  for an HDR film).
- **Linux: sleep and shut down from Leave**, through the system's own
  logind, wherever it lets this session do so without a password — as a
  desktop's own menu does. Elsewhere Leave offers to close Kinema only.
- **Linux: why an HDR film is shown in SDR.** When the desktop is in HDR but
  the graphics driver offers the player no HDR output, the stats panel now
  says so and names the driver that would — instead of calling the screen
  SDR. The README lists what HDR needs on Linux.

### Changed

- **TV mode on a 4K screen the system does not scale** (GNOME's default for a
  large TV, or Windows at 100 %) is no longer drawn at half its size: past a
  1080p screen it now grows with the screen. At 1080p and below, and on any
  screen Windows scales, it looks exactly as before.

### Fixed

- **Folders and films linked into a library are scanned.** A folder linked
  in from another drive (a symlink on Linux, a link or junction on Windows)
  was skipped without a word, so its films were simply missing; links are now
  followed, and one that loops back into the library is skipped.
- **A film slow to show its first frame no longer misses the screen
  switch.** Kinema waited five seconds for it, then played the film in
  whatever mode the screen was in without a word; it now waits fifteen (the
  film is held paused meanwhile anyway) and logs it if it still gives up.
- **Episodes on a network share named only by their numbering** — a
  `Season 1\S01E01.mkv` with nothing else in its name — now take their show's
  name from the folder above, as they already did on a local drive.
- **Pictures in a library brought from another system** — a safety copy
  restored on a new PC — are found again instead of downloaded afresh.

## [0.7.0] — 2026-09-30

Subtitles from OpenSubtitles, forced subtitles that show with subtitles off,
and Trakt beside SIMKL. The library is upgraded on first start (schema 20 to
22, with a safety copy first).

### Added

- **Subtitles from OpenSubtitles.** "Find subtitles online" in the player's
  Audio & subtitles panel shows the best match at once — one made for your
  exact file when there is one — and lists the rest under "Choose another".
  5 downloads a day without an account, 20 with a free one (Settings →
  Accounts). Subtitles are kept in Kinema's own folder, never beside your
  videos, and a subtitle already fetched is used again.
- **Forced subtitles with subtitles off.** The lines for what is said in
  another language now show even with subtitles switched off, in the language
  being spoken, as on a disc — and Kinema can fetch them from OpenSubtitles
  for files without them (Settings → Playback, off unless you turn it on).
- **Trakt.** Connect your Trakt account in Settings → Accounts, beside SIMKL —
  a code on screen and a QR code for your phone — and each film and episode you
  finish in Kinema is added to it. What you had already watched in Kinema is
  sent once, leaving out what Trakt already has, since Trakt would otherwise
  count it twice. It only adds, as SIMKL does. A free Trakt account can be
  connected to only one app besides Trakt's own.

### Changed

- **Settings → Accounts shows SIMKL's and Trakt's own marks**, as both
  services ask apps to. OpenSubtitles stays a name: it publishes no terms for
  its logo.

### Fixed

- **The cover on a title's page is no longer stretched.** Since the picture
  and sound badges, the column beside it was often taller than the cover,
  which pulled the picture taller to match.

## [0.6.0] — 2026-09-30

Recaps and the scene after a film's credits can be skipped to, a second
collection of skip times fills gaps, and what you watch can go to your SIMKL
account. The library is upgraded on first start (schema 18 to 20, with a
safety copy first).

### Added

- **Skip recap.** "Previously on…" gets a button of its own, from TheIntroDB
  or IntroDB. When a recap comes before the intro, that is two presses: Skip
  recap, then Skip intro. Automatic skipping skips recaps too.
- **The scene after the credits.** Where a film has one, Skip takes you
  straight to it instead of the credits running out — always as a button, even
  with automatic skipping on.
- **SIMKL.** Connect your SIMKL account in Settings → Accounts — a code on
  screen and a QR code for your phone — and each film and episode you finish
  in Kinema is added to it, as is everything you had already watched, once.
  It only adds: nothing comes back from SIMKL, and marking something unwatched
  in Kinema leaves SIMKL alone. Anything finished while SIMKL cannot be reached
  waits and goes later.
- **IntroDB**, a second collection of intro, recap and credits times shared by
  viewers, used where TheIntroDB has nothing. On by default, with its own
  switch in Settings → Intro & credits; only which film or episode it is gets
  sent. It is a different service from TheIntroDB.
- **F11** switches between the desk and TV layouts, as Ctrl+Shift+T does —
  the TV layout is Kinema's full-screen mode.

### Changed

- **Scrollbars** are a thin dark bar that fits the app instead of Windows'
  grey one, and there is none in the TV layout, where the page follows the
  remote.

### Fixed

- Switching TheIntroDB off did not take its times away from an episode that
  had already been played; they stayed until something else about the episode
  changed. Now switching either service off takes effect at the next play.
  The skip cache is rebuilt once as a result, so each episode's times are
  asked for again the next time it is played.

## [0.5.1] — 2026-09-29

This release is about what happens when something goes wrong. Your library is
kept safe and can be put back, a crash leaves a trace, and Kinema says when a
feature is missing a program. No library upgrade: 0.5.0
libraries open as they are.

### Added

- **Safety copies of the library.** Once a week Kinema keeps a copy of
  everything in it that cannot be rebuilt by scanning: what you have watched,
  where you stopped, the matches you corrected by hand, your settings. The last
  four are kept, apart from the copy made before each upgrade. Settings,
  Advanced lists them and puts one back: Restore closes Kinema, and the copy is
  swapped in as it starts again. What it replaces is kept too, so a restore can
  be undone. If the library cannot be opened at all, the message now says where
  the copies are.
- **Kinema says when ffmpeg is missing.** The picture and sound details on a
  title's page and Kinema's own intro detection both need it, and without it
  they were simply absent. Home now says so once (Not now is for good), a
  title's page says why its details are missing, and Settings has a link to
  ffmpeg's download page beside the field for its location.

### Changed

- **A screen that fails to draw shows a message** with Try again, Open the log
  folder and Close Kinema. It used to leave the window empty, and because the
  window is transparent, an empty window showed the desktop.
- **A crash on any thread is written to `app.log`**, with where it happened.
  In the released app it used to leave no trace.
- **Starting Kinema a second time brings the running one forward** instead of
  opening another window that would fight the first for the screen and the
  sound device.

## [0.5.0] — 2026-09-29

A title's page now says what its file really holds, with badges down to the
Dolby Vision profile and the measured aspect ratio, and scores from IMDb,
TMDB and, with an OMDb key of your own, Rotten Tomatoes. Kinema carries its
own TMDB key, so setting up is picking your folders. **The library is
upgraded on first start**; a safety copy is made first (in app data, under
`backups`), and 0.4.x cannot open the upgraded library.

### Added

- **Kinema has its own TMDB key.** Movies are identified, with posters and
  descriptions, without registering for anything. A key of your own in
  Settings is still used instead when there is one.
- **If TMDB ever stops accepting that key,** Kinema stops asking with it,
  says so on Home, and takes you to the field for a key of your own. The
  first release with a key re-checks movies that were waiting for one.
- **Movies are identified without any TMDB key,** through Wikidata: title,
  year, running time, genres, cast, and the opening of the film's Wikipedia
  article as its description — everything but posters and backdrops. It is
  the fallback when TMDB cannot be asked, and once it can again, those films
  move to TMDB by the id Wikidata holds for them and get their pictures, with
  their watch history untouched.
- **A title's page says what the file holds**, in three rows of badges under
  its buttons. Picture: resolution, Dolby Vision profile — with FEL or MEL for
  profile 7 — HDR10, HDR10+ or HLG with the mastering brightness, codec and
  bit depth, frame rate, and the aspect ratio measured from the picture
  itself, so a 2.39:1 film with black bars in a 16:9 file says 2.39:1, and one
  with IMAX scenes says both. Sound: each format, with Atmos and DTS:X told
  apart. File: where it came from (UHD Blu-ray remux, WEB-DL from Netflix…,
  read from the release name), edition, subtitles and bitrate. For a series,
  the badges describe the season on screen and follow the season tabs: where
  its episodes differ they show every version, and an episode unlike the rest
  of its season says so in the list ("720p"). The picture and sound badges
  need ffmpeg; each file is read once, when it is scanned.
- **The US age rating** (R, PG-13, TV-MA) beside the year, and **the studios
  or TV network** as logos among the badges, from TMDB. Titles already in
  the library get them on the next scan.
- **IMDb's rating** beside TMDB's, each score in its source's own colour, from
  the ratings file IMDb publishes for personal use. No key and no account;
  Kinema fetches it at most once a week and keeps only your library's titles.
- **Rotten Tomatoes' Tomatometer**, when you have entered an OMDb key of your
  own. Each title is looked up once a month, using at most half of a free
  key's daily allowance.
- **Close, sleep or shut down from the sofa.** In TV mode, Back on Home now
  offers Close Kinema, Put the PC to sleep and Shut down the PC. At a desk
  nothing changes.

### Changed

- **Setting up is one step: pick your folders.** The first-run panel no
  longer asks for a TMDB key. (A build from source, which has no key of its
  own, still asks.)
- **TMDB's data is kept for six months at most,** as their terms ask. Older
  titles, with their episodes and cast, are fetched again a few per scan,
  and older posters and backdrops downloaded again a few hundred per pass —
  the old picture stays on screen until the new one has arrived.
- **Settings says everything on screen.** Each setting says what it does and,
  in quieter type below, when to choose otherwise; "More about this" is gone.
  One Detect button covers every TV folder, and Skiptro's command fields
  appear only once Skiptro is set up.
- **At a desk, Kinema grows with the window**, up to the TV layout's size on a
  maximised large monitor. TV mode is unchanged.
- **Pausing brings up the controls with the ring on Play/Pause**, so the next
  OK plays again. Down from the seek bar goes to Play/Pause.
- **Plainer wording throughout**: full stops and commas where there were
  dashes, and an episode reads "Show · S01E04".

### Fixed

- **A key or path typed just before leaving Settings is kept.** Fields there
  save themselves a moment after the last keystroke, and pressing Back
  within that moment used to drop the change.

- **The volume says "Receiver" from the first frame.** With the sound going
  straight to a receiver, it read "100" until the controls were next
  brought up — they are often already up while a film opens, before its
  sound has started.
- **The volume bar works with a mouse.** It used to close as the pointer
  crossed the gap to it; now it can be reached, clicked and dragged. Clicking
  the volume control mutes without also pausing the film.
- **The last things on a page can be reached by remote.** Moving to the last
  control now scrolls the page to the bottom, so the notes under the last
  setting and the credits at the foot of Settings come into view.
- **The Library buttons in Settings are spaced again**, so Right from Add
  movies folder reaches Add TV folder instead of skipping to Scan now.
- **"Nothing new" from intro detection is said once**, not once per TV folder.

## [0.4.0] — 2026-09-28

A pass over everything a new user meets, after an outside-eye review. No
library upgrade: 0.3.x libraries open as they are. TV mode now fills the
screen; switch to "At a desk" in Settings → Playback, or press
Ctrl+Shift+T, for a window.

### Changed

- **The remote in the player works like a streaming app.** OK pauses and
  resumes; Left/Right seek, faster the longer they are held; Up or Down bring
  up the controls, where the seek bar can now be reached. The controls step
  aside by themselves.
- **A redesigned player bar**, with icons, the episode's name, "Ends at", and
  a **volume control** (M to mute, − and + to change it; it says so when the
  receiver has the volume).
- **TV mode fills the screen** — library and player — so display switching
  works from the sofa without finding a Fullscreen button.
- **Back goes back** to where you came from — search results, a grid, the page
  a film was started from — with the thing you picked still highlighted.
- **Settings has sections** (Library, Playback, Picture & sound, Intro &
  credits, Advanced), every option shows its choices side by side, and each
  has one line of explanation with the rest behind "More about this".
- **Home changes daily** and repeats itself less; genre rows wait until the
  library is big enough for them.
- **Track names are readable**: "English · 7.1 · Dolby TrueHD Atmos",
  "Norwegian · Forced", "English · SDH".
- **A show's page opens on the season you are in**, Specials last, with a
  quiet watched tick per episode and **Mark season watched**.
- **Movies**, not films, throughout; counts read "1 file", "3 files"; error
  messages say what happened in words.

### Added

- **Watched ticks and progress bars on posters**, and how many episodes are
  left of a show you have started.
- **Default audio and subtitle languages** in Settings → Playback. Subtitles
  default to Windows' language when the audio is in another one.
- **Start over** on the "Resumed from" notice, and **Resume / Play from start**
  on a title's page.
- **Search from a remote**, with an on-screen keyboard in the TV layout, and
  search by actor, genre or year as well as title.
- **Sorting and "Unwatched only"** in every grid, and **Movies** and **TV shows**
  in the top bar.
- **Home says when videos need identifying**, with a button straight to the
  review queue.
- **Home says when your equipment can do better** than it is set to — a
  receiver that takes Atmos and DTS:X, a TV with a 24p mode, HDR switched off —
  with one press to turn it on.
- **A notice when a newer Kinema is out**, from one request to GitHub per launch
  (Settings → Advanced turns it off). Nothing is downloaded.

### Removed

- The question about sending sound to the receiver that interrupted the first
  film. The notice on Home replaces it.

## [0.3.1] — 2026-09-25

Small follow-ups to 0.3.0's native output.

### Added

- **Dolby Vision is named.** The stats panel (`i`) shows the profile and what
  Kinema does with it — profile 5 converted to HDR10 with its own metadata,
  profiles 7 and 8 shown as their HDR10 layer — and the Output check says why
  Dolby Vision itself is not sent: Windows has no way to send it to a TV.

### Changed

- **Better advice for 8-bit HDR.** When the graphics driver is sending 8 bits
  at a refresh rate the cable could carry more, the Output check now also says
  to set the driver's output colour format to YCbCr 4:2:2 first if only 8 bits
  are offered — some drivers offer 10 or 12 bits at 4K only then.

## [0.3.0] — 2026-09-25

Native output: whatever the PC is connected to, the film reaches it the way it
was mastered — HDR as mastered, surround untouched to the receiver, the screen
at the film's own frame rate — and where that cannot happen, Kinema says why and
what would fix it.

### Upgrading

- **No library upgrade this time.** Everything new is a setting, and every
  setting starts where 0.2.0 behaved — except that HDR now reaches an HDR screen
  as mastered, and an SDR screen now gets Kinema's own tone mapping (see below).
- **Worth a look after updating:** Settings → **Screen** and **Sound**, and
  **Your equipment** to see what Kinema found.

### Added

- **Settings → Your equipment.** What Windows reports about every screen and
  sound device: resolution and refresh, HDR support, the modes a screen offers
  for films, which surround formats a receiver takes untouched, how many
  channels it takes directly, and whether Windows spatial sound is on. Checked
  at every launch and remembered per device, so a receiver that is on standby at
  launch keeps its last answers; the same account is written to `app.log`.
- **Send sound straight to the receiver** (Settings → Sound, off by default).
  While a film plays, Kinema takes the sound device for itself and passes Dolby
  TrueHD and Atmos, DTS-HD Master Audio and DTS:X, Dolby Digital (Plus) and DTS
  to the receiver untouched — only the formats the receiver said it takes, each
  overridable. Everything else goes as multichannel PCM up to what the device
  takes. Windows' speaker setup and spatial sound are bypassed while a film
  plays and untouched otherwise, so games keep "Dolby Atmos for home theater".
  The first film played on a setup that can use it offers this once.
- **A choice of sound device** in Settings → Sound.
- **Settings → Screen: match the screen to the film,** in fullscreen only.
  *Match the refresh rate* (off by default) switches to 23.976 Hz, 24, 25, 50
  or a clean multiple for each film, so pans stop juddering. *Resolution*
  (Auto by default) switches up when the desktop is set lower than the film;
  *Match content* hands the TV — or a video processor — the film at its own
  size. *Turn HDR on for HDR films* (off by default) switches Windows HDR on and
  back. The film waits, paused, until the picture is back, and the screen is
  put back on leaving fullscreen, leaving the player, closing Kinema, and at the
  next launch after a crash.
- **Output check** at the top of the stats panel (`i`): picture size, HDR,
  motion, colour depth and sound — each either native, or what is holding it
  back and how to fix it, including the HDMI link's bit depth and whether the
  cable or the graphics driver is the limit.

### Changed

- **HDR reaches an HDR screen as mastered.** mpv used to adapt the picture to
  the peak brightness Windows reports for the screen — often a round figure —
  and send that; the film's own HDR10 metadata now goes to the screen, which
  tone maps it, as with a disc player.
- **An SDR screen gets Kinema's tone mapping.** mpv used to send HDR even to a
  screen with HDR off and let Windows convert it; before each film Kinema now
  asks whether the screen showing it has HDR on, and sends HDR only if so.
- **Logs keep five sessions** instead of two.

### Fixed

- **A film no longer plays silently when Windows refuses the sound** (for
  example with a half-configured Windows spatial sound): Kinema falls back to
  the Windows mixer, then to stereo, and says so on screen.
- **The stats panel's HDR row reported tone mapping for every HDR file** — it
  read a property mpv does not have. It now says passthrough, compressed, or
  tone mapped to SDR, as it happened.

### Known limitations

- **Dolby Vision** is sent as HDR10: Windows has no way to send a Dolby Vision
  signal to a TV. Profile 7/8 play their HDR10 layer; profile 5 is converted.
- **With sound through Windows, Atmos and DTS:X height sound is lost,** even
  when Windows' "Atmos for home theater" makes the receiver show Atmos — that is
  Windows re-wrapping decoded 7.1. Only *Send sound straight to the receiver*
  keeps it.
- **Kinema cannot change the HDMI link's bit depth.** Where the Output check
  says the graphics driver is sending 8 bits, the setting is in the driver's own
  control panel.

## [0.2.0] — 2026-09-24

The result of a full review of the code, the logs and a real library — mostly
things that looked right and quietly did not happen, and the structure that let
them.

### Upgrading

- **Your library is upgraded automatically on first launch** (database version
  9 → 13), and a copy is made first, in `%APPDATA%\com.kinema.app\backups\`.
  The three most recent copies are kept.
- **Your watch history carries over**, and now belongs to the episode rather
  than to the file — see below.

### Added

- **Watch history follows the episode, not the file.** Moving or renaming a
  file, replacing it with a better copy, removing a folder and adding it back,
  or re-matching a show no longer loses what you have watched. Two copies of
  one episode are watched — or un-watched — together.
- **Detection can be stopped.** In Settings, **Detect** becomes **Stop
  detecting** while it runs, and **Scan now** becomes **Stop detection** during
  the scan's own detection. Seasons already finished are kept. Closing Kinema
  now stops a running Skiptro too; Windows used to leave it scanning, unseen,
  after the window had gone.
- **A remote's transport keys work in the player:** Play/Pause, Play, Pause,
  Stop (leaves the player), fast-forward and rewind (30 s), and the Back key
  many remotes send.
- **Settings → Developer tools → Open log folder.** Both logs now live in
  `%APPDATA%\com.kinema.app\logs\`, and the previous session's are kept
  beside them.

### Changed

- **Skip intro is offered from 0:00** whenever an intro is known, and stays
  until the intro ends — through a cold open too, where pressing it jumps to
  the end of the intro. It no longer disappears after ten seconds, and seeking
  back into the intro brings it back. Automatic mode still waits for the intro
  itself.
- **Skiptro's intro is used where Skiptro is sure of it** (confidence 0.8 and
  up). Measured on a real library, every large disagreement with Kinema's own
  analysis was one Skiptro had scored 0.70 or less; there, the analysis answers.
- **An episode counts as watched once its credits start**, not only at 94% —
  long end credits no longer leave a finished episode in Continue Watching.
- **A guessed credits start** (the last minute of a file) only ever offers Up
  next. It never skips by itself, in automatic mode either.
- **Remove in Continue Watching sticks** until you watch that show again, works
  on "Next episode" cards, and can be reached with a remote.
- **A match the matcher refused is not asked again at every launch** — only
  when you add or change a TMDB or OMDb key, the one thing that can change the
  answer.
- **Unlinking a wrong match holds it for you** in Needs attention, instead of
  the next scan matching it straight back.
- **Episodes named only `S01E01.mkv`** take the show's name from the folder
  above, and a file that still has no name goes to Needs attention instead of
  vanishing from the library.
- **Faster:** a show's episodes come from TMDB twenty seasons to a request, a
  file's audio, subtitle and chapter lists are read at once rather than one
  value at a time, and work that touches a network drive no longer freezes the
  window while the drive wakes up.
- **Nothing runs twice at once.** A second scan or detection is refused with a
  sentence saying why; a second artwork download waits its turn.
- **The player's controls open on Play**, and closing Audio & subtitles or
  Stats returns the focus ring to the button that opened it.
- **Settings works with a held remote key:** the focus ring scrolls into view,
  text fields let go of the cursor when you move on, and holding a key no
  longer sends focus the wrong way.
- **Intros and credits are now detected automatically.** A season dropped into a
  watched folder used to appear in the library immediately and then play with no
  Skip button, because both local detectors only ever ran from a button in
  Settings — the one screen you do not visit before you know something is wrong.
  Every scan that finds new episodes now goes on to detect their markers.
  Skiptro runs whenever it is installed and something new arrived; the built-in
  ffmpeg analysis runs unless it is switched off, under **Settings → Intro and
  credits markers → Built in**, since it is the slow one. Neither can fail a
  scan: a Skiptro that is not installed says nothing, one that has gone missing
  says so under the scan summary, and everything else carries on.
- ffmpeg now runs at below-normal priority, so an analysis triggered by a scan
  cannot compete with an episode being played at the same time.
- Settings no longer describes TheIntroDB as "asked once per episode", which
  read as though the app would ask *you* something and left at least one user
  waiting for a dialog that does not exist. It is a background lookup and always
  was.

### Fixed

- **The window no longer shows the desktop through it** in the moment between
  pressing Play and the picture arriving.
- **A resumed episode opens at its position** instead of playing its opening
  first and then jumping.
- **The Skip button could be missing for a whole episode** if the episode
  loaded at the wrong instant after launch.
- **The remote could go dead** after launch and after leaving the player.
- **The detail page lists each episode once**, shows files for episodes the
  provider does not list, and treats a double-episode file (`S01E01E02`) as
  both of its episodes — for Up next too.
- **A download still being written is not marked watched.**
- **Touching a file no longer undoes its match.** A changed date or size used
  to send it back through the matcher, undoing matches made by hand.
- **Pressing Next twice while an episode was loading** could take the wrong
  episode's position for the new one.
- An NFO file's bare `<id>` is no longer read as a TMDB id.
- Titles with no trailer are no longer looked up again at every launch.
- TVmaze's rate limit is respected, and a "too many requests" reply is waited
  out instead of landing the show in Needs attention.
- Logos and cast photos found during a scan are downloaded in that scan, not
  the next.
- The built-in analysis only believes an intro heard in at least two *other*
  episodes; one episode matching twice used to count as both.
- **A part-downloaded episode no longer stays "watched" once it finishes.** An
  incomplete MKV plays — the container streams happily from a partial file —
  reports a wrong duration, reaches its short end and was marked complete. That
  flag survived the rest of the file arriving, so the episode silently dropped
  out of Continue Watching and was never offered again. Watch state is now
  cleared when a file's **size** changes, never merely its timestamp: an mtime
  moves when files are copied between drives or a NAS touches them, and
  clearing on that would let moving a library wipe every tick in it.
- **A file replaced since the last scan no longer keeps the old file's intro and
  credits markers.** The cache key covered every source but not the video.
- **A season that is still downloading is no longer re-analysed on every
  launch.** One growing file made the whole season stale, and analysis has to
  compare episodes against each other — so it re-read the lot each time, for an
  answer about to be discarded. The automatic pass now waits for files to stop
  changing and says how many it is waiting for; the Detect button still runs
  immediately.

### Security

- **The window has a content security policy:** it runs only Kinema's own
  code. Anything the policy refuses is written to `app.log`.

## [0.1.0] — 2026-08-08

First public release.

### Added

- **A first-run panel.** An empty library now offers the two things it needs —
  a folder and a TMDB key — as controls, with a link to where a free key comes
  from, instead of a sentence pointing at Settings.
- **A controls overlay**, on `?`, on a button in the top bar and on one in the
  player. It documents the control scheme for the first time inside the app,
  including that **Up** is what lets a remote reach subtitles, audio tracks,
  the stats panel and fullscreen at all.
- MIT licence, and a `NOTICE.md` covering libmpv (LGPL), guessit-js (LGPL-3),
  TMDB and TVmaze attribution, TheIntroDB's terms, and the provenance of the
  intro-detection method.
- TMDB and TVmaze attribution in Settings, with TMDB's logo, as their terms
  require.
- A README written for someone who has never seen the project, plus
  `CONTRIBUTING.md`, `SECURITY.md` and a code of conduct.

### Changed

- **Renamed from "Personal Netflix" to Kinema.** The bundle identifier changed
  with it, so the app now stores its library in
  `%APPDATA%\com.kinema.app\`. Anyone upgrading from a pre-release build must
  rename the old `com.personalnetflix.app` folder, or the library will look
  empty.
- **Settings is written for the person using it**, not the person who built it.
  The frame-timing help was one paragraph containing *24p judder, 3:2 cadence,
  resampling, bitstream passthrough, TrueHD, DTS:X, AVR* and *PCM*, and
  documented a feature that does not exist; it is now two sentences saying what
  to try. `SMB`, `overscan`, `10-foot`, `sidecar`, `PATH`, `ffprobe` and `NFO`
  are gone or explained. **Skip intros** is now **Skip intros and credits**,
  which is what it always did.
- **Skiptro is explained and linked.** It was named in three places and never
  once described, and the section now opens by saying most people can skip it.
- Items in **Needs attention** lead with a plain sentence about what to do; the
  scorer's own wording is kept underneath for anyone who wants it.
- **Provider keys moved from sixth of eight sections in Settings to second**,
  and they now save themselves as you type. The old **Save keys** button was
  the only control on the page that did not apply on change, so typing a key
  and navigating away lost it.
- Both key fields are masked. This screen is routinely on a television.
- The design documents moved to `docs/`, and `HANDOVER.md` became
  `docs/ROADMAP.md`.
- Continuous integration on Windows: type-check, lint, frontend build and Rust
  tests on every push.
- A release workflow producing a portable ZIP with a published SHA-256.

### Removed

- `src/spike/PlayerSpike.tsx`, the Phase 0 mpv harness, and its styles. It had
  been unreachable from the UI for a long time. `docs/ROADMAP.md` says how to
  get it back from git history if you have an HDR display and want it.

### Fixed

- **Settings claimed detection results were "written next to your video
  files".** That stopped being true when sidecar export was turned off, and it
  is the wrong thing to be wrong about for anyone watching what lands on a NAS.
- The Tauri bundler is switched off. It had been configured to install the
  native playback libraries into a `lib/` subfolder, which produces an app that
  installs and launches normally and then fails the moment you press Play, with
  nothing written to either log. No installer was ever shipped from it.
- Removed a dead entry allowing requests to `api.mdblist.com`, which nothing had
  called since that provider was dropped.

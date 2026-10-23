# Screenshots

Referenced from the top-level [README](../../README.md).

| File | What it shows |
|---|---|
| `home.jpg` | The home screen — hero backdrop, a notice, and the rails beneath it |
| `detail.jpg` | A movie's detail page, with the cast row |
| `player.jpg` | The player controls over a paused file |
| `stats.png` | The playback statistics panel (`i` while watching) |
| `settings.png` | The Settings section list and search box, cut from a fullscreen shot |

Take them in fullscreen, with no viewing history, playlists or device names on
screen. Settings is left out on purpose: it shows the library's folder paths.
Check the audio list in `player` too: each track's title is often the file's
release name, so the current picture has those names painted out. `stats` is
the panel cut out of a player shot. The website uses the same pictures, smaller,
as `site/img/*.webp`, and `og.jpg` (1200 × 630) is the top of `home`.

Ordinary Windows capture — `Win`+`Shift`+`S` or PrintScreen — picks these up
fine, video included. If the video area comes out black, check where you are in
the file rather than assuming the capture failed: a still taken during an
opening fade is black because the frame is black.

## Keep them reasonable

Full-window, and ideally a few hundred KB each — they load on every visit to the
repository's front page. A backdrop-heavy screen makes a large PNG; JPEG at high
quality is visually identical for photographic content and a tenth of the size.

A library with a few real titles in it looks more honest than a staged one.

# Screenshots

Referenced from the top-level [README](../../README.md).

| File | What it shows |
|---|---|
| `home.jpg` | The home screen — hero backdrop, a notice, and the rails beneath it |
| `detail.jpg` | A movie's detail page, with the cast row |
| `player.jpg` | The player controls over a paused file |
| `stats.png` | The playback statistics panel (`i` while watching) |

`home`, `detail` and `player` were taken by `scripts/selftest.ps1 -ShotDivisor 2`
on a copy of a real library with its watch history deleted and the equipment
notice dismissed first — so no viewing history and no device names are in the
pictures. Settings is left out on purpose: it shows the library's folder paths.

Ordinary Windows capture — `Win`+`Shift`+`S` or PrintScreen — picks these up
fine, video included. If the video area comes out black, check where you are in
the file rather than assuming the capture failed: a still taken during an
opening fade is black because the frame is black.

## Keep them reasonable

Full-window, and ideally a few hundred KB each — they load on every visit to the
repository's front page. A backdrop-heavy screen makes a large PNG; JPEG at high
quality is visually identical for photographic content and a tenth of the size.

A library with a few real titles in it looks more honest than a staged one.

# Screenshots

Referenced from the top-level [README](../../README.md). Four files, these exact
names:

| File | What it shows |
|---|---|
| `home.png` | The home screen — hero backdrop and the rails beneath it |
| `detail.png` | A film's detail page, with the cast row |
| `stats.png` | The playback statistics panel (`i` while watching) |
| `player.png` | The player controls — **optional**, see below |

## The player one is the awkward one

mpv renders into a native surface *underneath* the webview, so `Win`+`Shift`+`S`
captures the controls perfectly over a **black rectangle** where the video should
be. That is not a bug — it is the same compositing arrangement that makes the app
work — but it makes for a poor screenshot, and there is no software route around
it. See the entry in [GOTCHAS.md](../GOTCHAS.md).

The only way to a still with video in it is a camera pointed at the screen. If
that is not worth the trouble, leave `player.png` out; the README does not
reference it.

## Keep them reasonable

Full-window at 1080p or so, PNG, and ideally under about 500 KB each — they load
on every visit to the repository's front page. A library with a few titles in it
looks more honest than a staged one.

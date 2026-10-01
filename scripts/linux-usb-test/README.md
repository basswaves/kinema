# Linux test stick

How Kinema's Linux version is checked on a real TV and receiver: an Ubuntu
26.04 live session booted from a Ventoy stick, nothing installed on the
machine — Ubuntu itself for GNOME, Kubuntu for KDE Plasma. The Windows
counterpart is `scripts/usb-test`.

The machine it was made for has an NVIDIA card, whose own driver a plain live
session cannot use (it gets `nouveau`: no hardware decoding, no HDR). So the
stick has a **persistence file**, where the live session keeps what it
installs: the first boot installs NVIDIA's driver, the second runs the tests
with it.

## Building it

On Linux (WSL is fine), from a checkout:

```bash
bash scripts/package-linux.sh
bash scripts/linux-usb-test/build-kit.sh            # Ubuntu (GNOME)
bash scripts/linux-usb-test/build-kit.sh kubuntu    # Kubuntu (KDE Plasma)
```

That makes `~/kinema-usb/persistence.dat` — or `persistence-kubuntu.dat` —
(8 GB, mostly empty, the kit inside at `/opt/kinema-kit`) and
`~/kinema-usb/ventoy.json`. Each system needs its own persistence file: what
one live session installs is not the other's system. On the Ventoy stick:

```
ubuntu-26.04-desktop-amd64.iso      (any name starting ubuntu-26.04)
kubuntu-26.04-desktop-amd64.iso     (any name starting kubuntu-26.04)
kinema-linux-test/persistence.dat
kinema-linux-test/persistence-kubuntu.dat
ventoy/ventoy.json                  (merge with an existing one)
```

The kit is the same for both: `run.sh` and `tools/display.py` tell GNOME and
Plasma apart by `XDG_CURRENT_DESKTOP`, as Kinema does — Mutter's
`DisplayConfig` on GNOME, `kscreen-doctor` on Plasma. Kubuntu's ISO carries
the same NVIDIA 580 set for the same kernel as Ubuntu's, so the first boot is
the same too.

## At the TV

1. Boot from the stick and choose the Ubuntu ISO in Ventoy's menu; Ventoy
   picks the persistence file by itself after five seconds.
2. Choose **Try Ubuntu** (not Install), and make sure the network is
   connected — the first run downloads the driver and the tools.
3. Open a Terminal (Ctrl+Alt+T) and run:

   ```bash
   bash /opt/kinema-kit/run.sh
   ```

   About ten minutes. It ends by asking for a restart.
4. Restart, choose Ubuntu again in Ventoy's menu, Try Ubuntu, Terminal:

   ```bash
   bash ~/kinema-kit/run.sh
   ```

   A few minutes. Kinema plays test clips full screen, and the receiver plays
   short, quiet test tones in each sound format. Keep its volume low.
5. Shut down and bring the stick back.

Nothing is written to the machine's own disks.

### Kubuntu (KDE Plasma)

The same two boots, choosing the Kubuntu ISO in Ventoy's menu each time (it
has its own persistence file, so the driver is installed again for it). If an
installer window opens, close it or choose to try Kubuntu; Ctrl+Alt+T opens
Konsole. The first boot is `bash /opt/kinema-kit/run.sh` as above; it ends by
naming the second, which on Plasma goes straight to Kinema's own check:

```bash
bash ~/kinema-kit/run.sh check
```

The live user is `kubuntu` rather than `ubuntu` (casper names it after the
ISO), which matters only when reading the results back.

### A later round: Kinema's own picture and sound

```bash
bash ~/kinema-kit/run.sh check
```

Installs the Kinema build in the kit over the earlier one, then lets Kinema
do it all itself, each run on its own copy of an empty library with the
settings the run needs: the equipment check it makes as it starts; sound
straight to the receiver for a Dolby Digital, Dolby Digital Plus, DTS and
TrueHD clip, with PipeWire's own list of outputs read during each (the card
should be Kinema's) and after (given back); and the 4K HDR clip with
refresh-rate and HDR switching on, the screen read during the film and after
it. The screen is put back as it was at the end. The receiver plays short,
quiet test tones; the TV goes black for a moment at each switch.
`~/kinema-results/check-<time>/`: `equipment.txt`, `direct.txt`,
`switch.txt` and `display.txt` are the overview.

### Another graphics card, and Sway and Hyprland

`check` works with any card: NVIDIA's needs the first boot's driver, while
an AMD or Intel card needs nothing (the live system's own Mesa drives it),
so with an AMD card in, the same persistence file and the same command
check HDR on Plasma through Mesa.

Sway and Hyprland are checked from a text console, since each takes the
screen for itself while it runs:

1. In the desktop, `bash ~/kinema-kit/run.sh check` as above (optional).
2. Ctrl+Alt+F3, log in as the live user (`kubuntu`, no password — just
   Enter), then:

   ```bash
   bash ~/kinema-kit/run.sh wlroots
   ```

   It installs Sway and Hyprland from Ubuntu's archive (network needed),
   then starts Sway on the screen, lets Kinema run its check inside it (the
   equipment check, TrueHD straight to the receiver, the 4K HDR film with
   the screen switched for it) and leaves; then the same in Hyprland, with
   Hyprland's own defaults — which switch HDR on by themselves for a
   full-screen HDR film. Each has a five-minute limit. Afterwards
   `sudo poweroff`.

`~/kinema-results/wlroots-<time>/`: `versions.txt`, then per desktop
(`sway/`, `hyprland/`) `equipment.txt`, `direct.txt`, `switch.txt` and the
desktop's own view of its screens before, during and after the film
(`screens-*.json`, from `swaymsg` and `hyprctl`).

### Hyprland's HDR, three ways

```bash
bash ~/kinema-kit/run.sh hyprland
```

From a text console as above. Starts Hyprland three times with its own log
on — its defaults, the screen at 10 bits, and passthrough off — and plays
the 4K HDR film in each, recording every two seconds Hyprland's view of the
screen and of the film's window, and the kernel's of what is sent to the
TV (`modetest`: `Colorspace` and `HDR_OUTPUT_METADATA`). About five
minutes. `~/kinema-results/hyprland-<time>/A`, `B`, `C`.

### A later round: the picture path

```bash
bash ~/kinema-kit/run.sh graphics
```

On any boot after the two above (the driver is already installed). Records
why the picture takes the path it does: the driver's Vulkan by itself
(`vulkaninfo`, `vkcube` on Wayland and X11) before and after making the
driver's device files that nothing else made (`/dev/nvidia-modeset`,
`/dev/nvidia-uvm`), NVIDIA's decoder, then mpv by
itself full screen with each graphics API — at the desktop's own mode, and at
3840x2160 at 23.976 Hz with HDR off and on — and Kinema at that mode with
HDR on. The screen is put back as it was at the end. The TV goes black for a
moment at each mode or HDR change, and Ubuntu's problem reporter may show
crash windows from the Vulkan tests; they can be closed.
`~/kinema-results/graphics-<time>/`: `vk-summary.txt` and `mpv-summary.txt`
are the overview, the rest is the detail behind them.

## What it records

`~/kinema-results/<stage>-<time>/` inside the persistence file: the
hardware as each driver sees it (`lspci`, GNOME's screen state through
Mutter's `DisplayConfig`, each screen's EDID, `modetest`, the HDMI sound
devices, what each receiver announced in its ELD, PipeWire's view); for each
sound format, whether mpv could pass it through PipeWire and straight to each
HDMI device; and three Kinema runs (`selftest.sh` with the installed
program) — the HDR10 test film with HDR off and on, and TrueHD the ordinary
way — each with mpv's own picture of its window (the video and Kinema's
controls, nothing else on the screen), mpv's properties and both logs.

## Reading the results back

On the development machine, without mounting the stick's file system:

```bash
e2fsck -fy <stick>/kinema-linux-test/persistence.dat
debugfs -R "rdump /upper/home/ubuntu/kinema-results /tmp" <stick>/kinema-linux-test/persistence.dat
```

(The live session's changes sit under `upper/` in the persistence file. It
is never unmounted cleanly, so its journal needs replaying with `e2fsck`
before reading or writing it. Kubuntu's: `persistence-kubuntu.dat` and
`/upper/home/kubuntu/…`; `debugfs -R "ls /upper/home"` shows the name.)

All test media is generated (`make-clips.sh`): a test pattern and a sine
tone. Nothing personal goes on the stick.

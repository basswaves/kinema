# Linux test stick

How Kinema's Linux version is checked on a real TV and receiver: an Ubuntu
26.04 live session booted from a Ventoy stick, nothing installed on the
machine. The Windows counterpart is `scripts/usb-test`.

The machine it was made for has an NVIDIA card, whose own driver a plain live
session cannot use (it gets `nouveau`: no hardware decoding, no HDR). So the
stick has a **persistence file**, where the live session keeps what it
installs: the first boot installs NVIDIA's driver, the second runs the tests
with it.

## Building it

On Linux (WSL is fine), from a checkout:

```bash
bash scripts/package-linux.sh
bash scripts/linux-usb-test/build-kit.sh
```

That makes `~/kinema-usb/persistence.dat` (8 GB, mostly empty, the kit inside
at `/opt/kinema-kit`) and `~/kinema-usb/ventoy.json`. On the Ventoy stick:

```
ubuntu-26.04-desktop-amd64.iso      (any name starting ubuntu-26.04)
kinema-linux-test/persistence.dat
ventoy/ventoy.json                  (merge with an existing one)
```

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
debugfs -R "rdump /upper/home/ubuntu/kinema-results /tmp" <stick>/kinema-linux-test/persistence.dat
```

(The live session's changes sit under `upper/` in the persistence file.)

All test media is generated (`make-clips.sh`): a test pattern and a sine
tone. Nothing personal goes on the stick.

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

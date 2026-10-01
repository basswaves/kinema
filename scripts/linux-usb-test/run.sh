#!/usr/bin/env bash
# Kinema's Linux test, for an Ubuntu 26.04 live session with persistence.
# Run it once on each boot; it knows which boot it is:
#   1st boot: records the hardware, installs NVIDIA's driver, Kinema and the
#             tools, and asks for a restart;
#   2nd boot: records the hardware again with NVIDIA's driver and runs the
#             tests. Results go to the stick, and to ~/kinema-results.
# `run.sh graphics` on a later boot: why the picture took the path it did —
#             the driver's Vulkan, HDR and the 4K film mode, mpv by itself
#             and Kinema (the third round, after the second showed Vulkan
#             failing and HDR not reaching mpv).
# Nothing is asked for on screen, and nothing outside the live session is
# touched: Windows and its disks are left alone. Results are read back from
# the persistence file (README.md).
set -u

kit="$(cd "$(dirname "$0")" && pwd)"
home_kit="$HOME/kinema-kit"   # the kit, copied off /opt so later runs find it
stamp="$(date +%Y%m%d-%H%M%S)"
say() { printf '\n== %s\n' "$*"; }

if lsmod | grep -q '^nvidia '; then stage='test'; else stage='setup'; fi
# For a rehearsal on a development machine: KINEMA_KIT_STAGE=test.
stage="${1:-${KINEMA_KIT_STAGE:-$stage}}"
R="$HOME/kinema-results/$stage-$stamp"
mkdir -p "$R"
exec > >(tee -a "$R/run.log") 2>&1
say "Kinema Linux test, stage: $stage ($(date))"

system() {   # what the machine is, as this boot sees it
  local out="$1"; mkdir -p "$out"
  { uname -a; cat /etc/os-release; } > "$out/os.txt" 2>&1
  lspci -nnk > "$out/lspci.txt" 2>&1
  lsmod | grep -E 'nvidia|nouveau|snd_hda|drm' > "$out/modules.txt" 2>&1
  mokutil --sb-state > "$out/secureboot.txt" 2>&1
  echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}" > "$out/session.txt"
  gnome-shell --version >> "$out/session.txt" 2>&1
  command -v nvidia-smi > /dev/null && nvidia-smi > "$out/nvidia-smi.txt" 2>&1
  command -v glxinfo > /dev/null && glxinfo -B > "$out/glxinfo.txt" 2>&1
  command -v vulkaninfo > /dev/null && vulkaninfo --summary > "$out/vulkaninfo.txt" 2>&1
  # Screens: GNOME's view, the kernel's, and each screen's own EDID.
  python3 "$home_kit/tools/display.py" state > "$out/gnome-displays.json" 2>&1
  for c in /sys/class/drm/card*-*; do
    n="$(basename "$c")"
    { echo "status: $(cat "$c/status")"; echo "enabled: $(cat "$c/enabled" 2>/dev/null)"; cat "$c/modes"; } > "$out/drm-$n.txt" 2>&1
    # Copied first, then checked: sysfs reports a size of 0 for every edid
    # file, so testing the original for content skips them all.
    cat "$c/edid" > "$out/edid-$n.bin" 2> /dev/null
    if [ -s "$out/edid-$n.bin" ]; then
      command -v edid-decode > /dev/null && edid-decode "$out/edid-$n.bin" > "$out/edid-$n.txt" 2>&1
    else
      rm -f "$out/edid-$n.bin"
    fi
  done
  command -v modetest > /dev/null && modetest -c > "$out/modetest-connectors.txt" 2>&1
  # Sound: every card, every HDMI device, and what each receiver announced.
  cat /proc/asound/cards > "$out/asound-cards.txt" 2>&1
  aplay -l > "$out/aplay-l.txt" 2>&1
  aplay -L > "$out/aplay-L.txt" 2>&1
  for e in /proc/asound/card*/eld#*; do
    [ -e "$e" ] && { echo "### $e"; cat "$e"; } >> "$out/eld.txt"
  done
  for p in /proc/asound/card*/pcm*p/info; do
    { echo "### $p"; cat "$p"; } >> "$out/pcm-info.txt"
  done
  for c in /proc/asound/card[0-9]*; do
    n="${c##*card}"
    amixer -c "$n" controls >> "$out/amixer-controls.txt" 2>&1
  done
  pactl list cards > "$out/pactl-cards.txt" 2>&1
  pactl list sinks > "$out/pactl-sinks.txt" 2>&1
  wpctl status > "$out/wpctl-status.txt" 2>&1
  command -v mpv > /dev/null && mpv --audio-device=help > "$out/mpv-audio-devices.txt" 2>&1
  echo "recorded in $out"
}

copy_out() {   # the results stay in the persistence file; say so
  sync
  say "Results kept in $R (inside the stick's persistence file)"
}

kinema_plan() {   # name, clip, extra actions (JSON list items); env vars may precede
  local d="$R/kinema-$1"; mkdir -p "$d"
  cat > "$d/plan.json" <<JSON
{"path":"$2","fileId":null,"titleId":null,"seconds":18,"openAfter":2,
 "actions":[{"at":7,"do":"key","key":"ArrowUp"},
            {"at":8,"do":"mpv","args":["screenshot-to-file","$d/mpv-window.png","window"]},
            {"at":9,"do":"probe","args":["current-vo","current-gpu-context","gpu-api","hwdec-current","video-params/gamma","video-params/primaries","video-target-params/gamma","video-target-params/primaries","video-target-params/max-luma","target-colorspace-hint","display-names","display-fps","estimated-vf-fps","osd-width","osd-height","current-ao","audio-out-params/format","audio-out-params/channel-count","audio-params/format","mpv-version"]}$3]}
JSON
  bash "$home_kit/tools/selftest.sh" "$d/plan.json" /usr/bin/kinema 99 > "$d/selftest.out" 2>&1
  tail -n 1 "$d/selftest.out"
}

if [ "$stage" = setup ]; then
  say "Copying the kit into the persistent home"
  rm -rf "$home_kit"; cp -r "$kit" "$home_kit"
  say "Software sources (universe, restricted, multiverse)"
  sudo add-apt-repository -y universe > /dev/null
  sudo add-apt-repository -y restricted > /dev/null
  sudo add-apt-repository -y multiverse > /dev/null
  sudo apt-get update -q
  say "Tools for the survey"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q mpv ffmpeg alsa-utils pulseaudio-utils \
    mesa-utils vulkan-tools edid-decode libdrm-tests > /dev/null
  say "The hardware with nouveau"
  system "$R/nouveau"
  say "Kinema"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$home_kit"/kinema_*_amd64.deb
  say "NVIDIA's driver, from the ISO, for the kernel this stick runs"
  # Not `ubuntu-drivers install`: it takes the newest module from the
  # archive, which is built for a newer kernel, and pulls that kernel in —
  # which a live session cannot install (the first attempt failed exactly
  # so). The ISO carries the module for its own kernel and the driver parts
  # of the same version, for offline installs: a matching set.
  ubuntu-drivers list > "$R/ubuntu-drivers-list.txt" 2>&1
  kernel="$(uname -r)"
  iso=""
  for d in /cdrom $(findmnt -rn -t iso9660 -o TARGET); do
    [ -d "$d/pool/restricted" ] && { iso="$d"; break; }
  done
  echo "kernel $kernel, ISO at ${iso:-not found}" | tee "$R/nvidia-source.txt"
  if [ -n "$iso" ]; then
    mapfile -t debs < <(ls "$iso"/pool/restricted/n/nvidia-graphics-drivers-580/*.deb \
      "$iso"/pool/restricted/l/linux-restricted-modules/linux-modules-nvidia-580-"$kernel"_*.deb \
      "$iso"/pool/restricted/l/linux-restricted-modules/linux-modules-nvidia-580-generic-hwe-26.04_*.deb \
      "$iso"/pool/restricted/l/linux-restricted-modules/linux-objects-nvidia-580-"$kernel"_*.deb \
      "$iso"/pool/restricted/l/linux-restricted-signatures/linux-signatures-nvidia-"$kernel"_*.deb \
      "$iso"/pool/main/e/egl-wayland/*.deb 2> /dev/null)
    printf '%s\n' "${debs[@]}" >> "$R/nvidia-source.txt"
    # The generic-hwe module package is in the set because it is what
    # provides nvidia-dkms-580 at exactly this version, which the driver
    # requires; without it apt reaches for the archive's newer one.
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${debs[@]}"
    # Held, so nothing later swaps them for the archive's newer versions.
    sudo apt-mark hold nvidia-driver-580 linux-modules-nvidia-580-generic-hwe-26.04 > /dev/null
  else
    echo "No ISO to take the driver from; the module for $kernel from the archive instead."
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "linux-modules-nvidia-580-$kernel" nvidia-driver-580
  fi
  # nouveau must not take the card first at the next boot. It is not in the
  # live system's boot image, so this file, kept by the persistence, is read
  # in time.
  printf 'blacklist nouveau\noptions nouveau modeset=0\n' | sudo tee /etc/modprobe.d/kinema-no-nouveau.conf > /dev/null
  sudo depmod "$kernel"
  dpkg -l | grep -E '^(ii|iF|iU) +(nvidia-driver|linux-modules-nvidia|linux-image)' | tee "$R/nvidia-installed.txt"
  if ! ls "/lib/modules/$kernel"/kernel/nvidia-580*/nvidia.ko* > /dev/null 2>&1 \
     && ! find "/lib/modules/$kernel" -name 'nvidia.ko*' | grep -q .; then
    say "PROBLEM: no NVIDIA module for $kernel was installed. Shut down and bring the stick back."
    exit 1
  fi
  copy_out
  say "Done. Restart now (top right, Power Off / Restart), choose Ubuntu in the Ventoy menu again, open a Terminal and run:"
  echo
  echo "    bash ~/kinema-kit/run.sh"
  echo
  exit 0
fi

if [ "$stage" = graphics ]; then
  # Round 2 found NVIDIA's Vulkan failing (mpv: GetPhysicalDeviceSurface-
  # PresentModesKHR -> VK_ERROR_UNKNOWN on Wayland and X11, then OpenGL;
  # vulkaninfo crashing inside the driver), CUDA failing (no nvidia_uvm),
  # and HDR on in GNOME while the compositor still told mpv "SDR, 80 nits",
  # at 1920x1080@60. Round 3 showed the same with NVIDIA's Vulkan driver
  # alone and with layers off; the driver's device files missing; and that
  # colour mode 2 is GNOME 50's sdr-native, not HDR (1). Crash windows from
  # Ubuntu's problem reporter are expected here and can be closed.
  media="$home_kit/media"; clip="$media/hdr10-2160p23.976.mkv"
  lsmod | grep -q '^nvidia ' || { say "NVIDIA's driver is not loaded: run plain 'bash ~/kinema-kit/run.sh' first."; exit 1; }

  say "The driver, as the kernel and the system see it"
  { lsmod | grep -E '^nvidia'
    for p in /sys/module/nvidia_drm/parameters/*; do echo "${p##*/}=$(cat "$p")"; done
    ls -l /dev/nvidia* /dev/dri; } > "$R/driver.txt" 2>&1
  sudo journalctl -b -k --no-pager | grep -iE 'nvidia|NVRM|drm' > "$R/kernel.txt" 2>&1
  sudo journalctl -b --no-pager | grep -iE 'gnome-shell|mutter' | grep -iE 'color|hdr|nvidia|egl|gbm|kms|vulkan|warn|crit|error' \
    | tail -n 300 > "$R/compositor-journal.txt" 2>&1
  { for d in /usr/share/vulkan/icd.d /etc/vulkan/icd.d /usr/share/vulkan/implicit_layer.d /etc/vulkan/implicit_layer.d; do
      echo "### $d"; ls -l "$d" 2>&1
    done
    for f in /usr/share/vulkan/icd.d/nvidia* /etc/vulkan/icd.d/nvidia*; do [ -e "$f" ] && { echo "### $f"; cat "$f"; }; done
    dpkg -l | grep -E 'nvidia|vulkan|egl|gbm|libmpv|libplacebo' | awk '{print $1, $2, $3}'
  } > "$R/vulkan-setup.txt" 2>&1
  cat "$R/driver.txt"

  say "Vulkan by itself, and a spinning cube"
  vk() {   # name, then [VAR=value ...] command
    local name="$1"; shift
    timeout 40 env "$@" > "$R/vk-$name.txt" 2>&1
    echo "$name: exit $?" | tee -a "$R/vk-summary.txt"
  }
  vk summary vulkaninfo --summary
  vk cube-wayland vkcube --wsi wayland --c 300

  # Round 3: the driver's device files /dev/nvidia-modeset and
  # /dev/nvidia-uvm were missing — normally made by nvidia-modprobe or the
  # driver's udev rules, neither of which did it here — and Vulkan's
  # presenting and CUDA both open them. Made by hand (what nvidia-modprobe
  # does), then the same tests again.
  say "The driver's missing device files, made by hand, then Vulkan and the decoder again"
  { ls -l /usr/bin/nvidia-modprobe /lib/udev/rules.d/*nvidia* /usr/lib/udev/rules.d/*nvidia*
    grep -iE 'nvidia' /proc/devices; } > "$R/nodes.txt" 2>&1
  sudo modprobe nvidia_uvm 2>&1 | tee -a "$R/nodes.txt"
  [ -e /dev/nvidia-modeset ] || sudo mknod -m 666 /dev/nvidia-modeset c 195 254
  uvm_major="$(awk '$2 == "nvidia-uvm" {print $1}' /proc/devices)"
  if [ -n "$uvm_major" ] && [ ! -e /dev/nvidia-uvm ]; then
    sudo mknod -m 666 /dev/nvidia-uvm c "$uvm_major" 0
    sudo mknod -m 666 /dev/nvidia-uvm-tools c "$uvm_major" 1
  fi
  ls -l /dev/nvidia* | tee -a "$R/nodes.txt"
  vk summary-nodes vulkaninfo --summary
  vk cube-wayland-nodes vkcube --wsi wayland --c 300
  vk cube-xcb-nodes vkcube --wsi xcb --c 300
  timeout 30 mpv --no-config --vo=null --ao=null --hwdec=nvdec --length=3 --msg-level=all=v \
    --log-file="$R/mpv-nvdec.log" "$clip" > /dev/null 2>&1
  echo "nvdec: $(grep -m1 -E 'Using hardware decoding|Could not|failed' "$R/mpv-nvdec.log" || echo '?')" | tee -a "$R/nodes.txt"

  # mpv by itself, full screen, the HDR10 clip: which GPU context it ends up
  # with, what the compositor says the screen wants, and what mpv sends.
  cat > "$R/probe.lua" <<'LUA'
local u = require 'mp.utils'
mp.add_timeout(5, function()
  for _, p in ipairs({'current-gpu-context', 'gpu-api', 'hwdec-current', 'video-target-params',
                      'display-names', 'display-fps', 'osd-width', 'osd-height'}) do
    mp.msg.info('PROBE ' .. p .. ' = ' .. (u.format_json(mp.get_property_native(p)) or 'nil'))
  end
end)
LUA
  play() {   # name, then [VAR=value ...] and mpv options
    local name="$1"; shift
    local vars=(); while [ $# -gt 0 ] && [[ "$1" == *=* && "$1" != --* ]]; do vars+=("$1"); shift; done
    timeout 40 env "${vars[@]}" mpv --no-config --vo=gpu-next --fs --length=8 --hwdec=auto-safe \
      --target-colorspace-hint=yes --msg-level=all=v --script="$R/probe.lua" \
      --log-file="$R/mpv-$name.log" "$@" "$clip" > /dev/null 2>&1
    local rc=$? L="$R/mpv-$name.log"
    {
      echo "== $name (exit $rc)"
      grep -E 'Initializing GPU context|\]\[e\]' "$L" | sed 's/^\[[^]]*\]//' | head -n 8
      grep -A2 'Preferred surface feedback' "$L" | sed 's/^\[[^]]*\]//' | tail -n 2
      grep -o 'PROBE .*' "$L"
    } | tee -a "$R/mpv-summary.txt"
  }
  hdr() { python3 "$home_kit/tools/display.py" hdr "$1" | tee -a "$R/display.txt"; sleep 6; }
  mode() { python3 "$home_kit/tools/display.py" mode "$@" | tee -a "$R/display.txt"; sleep 4; }
  read -r w0 h0 r0 < <(python3 "$home_kit/tools/display.py" current)
  echo "screen mode at the start: ${w0}x${h0}@${r0}" | tee "$R/display.txt"

  say "mpv by itself, the desktop's own mode, HDR off"
  hdr off
  play desktop-sdr-auto

  say "The film's own mode, 3840x2160 at 23.976 Hz, HDR off"
  mode 3840 2160 23.976
  python3 "$home_kit/tools/display.py" state > "$R/gnome-displays-4k.json" 2>&1
  play 4k-sdr-auto

  say "3840x2160 at 23.976 Hz, HDR on"
  hdr on
  python3 "$home_kit/tools/display.py" state > "$R/gnome-displays-4k-hdr.json" 2>&1
  play 4k-hdr-auto
  play 4k-hdr-opengl --gpu-api=opengl

  say "Kinema at 3840x2160 at 23.976 Hz, HDR on"
  kinema_plan 4k-hdr "$clip" ""

  say "The screen back as it was"
  hdr off
  mode "$w0" "$h0" "$r0"
  python3 "$home_kit/tools/display.py" state > "$R/gnome-displays-after.json" 2>&1

  copy_out
  say "All done. You can shut down, take the stick out and plug it into the development PC."
  exit 0
fi

# ---- stage: test --------------------------------------------------------------
media="$home_kit/media"
say "The hardware with NVIDIA's driver"
system "$R/nvidia"

say "Passthrough through PipeWire"
pw="$R/passthrough-pipewire"; mkdir -p "$pw"
sink="$(pactl list short sinks | awk '/hdmi/ {print $2; exit}')"
echo "HDMI sink: ${sink:-none}" | tee "$pw/sink.txt"
if [ -n "$sink" ]; then
  pactl set-sink-formats "$(pactl list short sinks | awk -v s="$sink" '$2==s {print $1}')" \
    'pcm; ac3-iec61937; eac3-iec61937; dts-iec61937; truehd-iec61937' >> "$pw/sink.txt" 2>&1
  pactl list sinks >> "$pw/sink.txt" 2>&1
  for codec in ac3 eac3 dts truehd; do
    timeout 20 mpv --no-config --no-video --length=4 --ao=pipewire --audio-spdif="$codec" \
      --msg-level=all=v --log-file="$pw/$codec.log" "$media/sound-$codec.mkv" > /dev/null 2>&1
    echo "$codec: $(grep -m1 -E 'AO: \[' "$pw/$codec.log" || echo 'no output opened')" | tee -a "$pw/summary.txt"
  done
fi

say "Passthrough straight to each HDMI device (PipeWire paused)"
al="$R/passthrough-alsa"; mkdir -p "$al"
systemctl --user stop pipewire.socket pipewire-pulse.socket pipewire pipewire-pulse wireplumber 2> /dev/null
sleep 1
for dev in $(aplay -L | grep -E '^hdmi:'); do
  for codec in ac3 truehd; do
    name="$(echo "$dev" | tr ':,=' '___')-$codec"
    timeout 20 mpv --no-config --no-video --length=3 --ao=alsa --audio-device="alsa/$dev" \
      --audio-spdif="$codec" --msg-level=all=v --log-file="$al/$name.log" "$media/sound-$codec.mkv" > /dev/null 2>&1
    echo "$dev $codec: $(grep -m1 -E 'AO: \[|Could not open|busy|error' "$al/$name.log" || echo '?')" | tee -a "$al/summary.txt"
  done
done
systemctl --user start pipewire.socket pipewire-pulse.socket wireplumber 2> /dev/null
sleep 2

say "Kinema: the HDR10 film, HDR off"
python3 "$home_kit/tools/display.py" hdr off | tee "$R/hdr-off.json"
kinema_plan hdr-off "$media/hdr10-2160p23.976.mkv" ""

say "Kinema: the HDR10 film, HDR on"
python3 "$home_kit/tools/display.py" hdr on | tee "$R/hdr-on.json"
sleep 3
python3 "$home_kit/tools/display.py" state > "$R/gnome-displays-hdr-on.json" 2>&1
kinema_plan hdr-on "$media/hdr10-2160p23.976.mkv" ""
python3 "$home_kit/tools/display.py" hdr off > /dev/null

say "Kinema: TrueHD the ordinary way (through PipeWire)"
kinema_plan sound-truehd "$media/sound-truehd.mkv" ""

copy_out
say "All done. You can shut down, take the stick out and plug it into the development PC."

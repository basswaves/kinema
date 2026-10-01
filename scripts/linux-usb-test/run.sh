#!/usr/bin/env bash
# Kinema's Linux test, for an Ubuntu or Kubuntu 26.04 live session with
# persistence (GNOME or KDE Plasma; each has its own persistence file).
# Run it once on each boot; it knows which boot it is:
#   1st boot: records the hardware, installs NVIDIA's driver, Kinema and the
#             tools, and asks for a restart;
#   2nd boot: records the hardware again with NVIDIA's driver and runs the
#             tests. Results go to the stick, and to ~/kinema-results.
# `run.sh graphics` on a later boot: why the picture took the path it did —
#             the driver's Vulkan, HDR and the 4K film mode, mpv by itself
#             and Kinema (the third round, after the second showed Vulkan
#             failing and HDR not reaching mpv).
# `run.sh check` on a later boot: Kinema's own Linux picture and sound — what
#             the equipment check sees, sound straight to the receiver in
#             each format, and the screen switched for a film and put back —
#             with the build in the kit, installed over the earlier one.
# `run.sh wlroots` from a text console: the same Kinema check inside Sway and
#             then Hyprland, each started on the real screen for the purpose.
# `run.sh hyprland` from a text console: Hyprland three ways (defaults, 10-bit,
#             no passthrough) with its log on, for its HDR path.
# `check` and `wlroots` work with any graphics card: NVIDIA's needs the
#             first boot's driver, AMD's and Intel's need nothing.
# Nothing is asked for on screen, and nothing outside the live session is
# touched: Windows and its disks are left alone. Results are read back from
# the persistence file (README.md).
set -u

kit="$(cd "$(dirname "$0")" && pwd)"
home_kit="$HOME/kinema-kit"   # the kit, copied off /opt so later runs find it
stamp="$(date +%Y%m%d-%H%M%S)"
say() { printf '\n== %s\n' "$*"; }
# KDE Plasma (Kubuntu) rather than GNOME (Ubuntu): display.py chooses the same way.
is_plasma() { [[ ":${XDG_CURRENT_DESKTOP:-}:" == *:[Kk][Dd][Ee]:* ]]; }

if lsmod | grep -q '^nvidia '; then stage='test'; else stage='setup'; fi
# For a rehearsal on a development machine: KINEMA_KIT_STAGE=test.
stage="${1:-${KINEMA_KIT_STAGE:-$stage}}"
# The part of a stage that runs inside a desktop it started writes into
# the folder that stage made (KIT_R).
R="${KIT_R:-$HOME/kinema-results/$stage-$stamp}"
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
  plasmashell --version >> "$out/session.txt" 2>&1
  command -v kscreen-doctor > /dev/null && kscreen-doctor -o > "$out/kscreen-doctor.txt" 2>&1
  command -v nvidia-smi > /dev/null && nvidia-smi > "$out/nvidia-smi.txt" 2>&1
  command -v glxinfo > /dev/null && glxinfo -B > "$out/glxinfo.txt" 2>&1
  command -v vulkaninfo > /dev/null && vulkaninfo --summary > "$out/vulkaninfo.txt" 2>&1
  # Screens: the desktop's view (GNOME or Plasma), the kernel's, and each
  # screen's own EDID.
  python3 "$home_kit/tools/display.py" state > "$out/screens.json" 2>&1
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
            {"at":9,"do":"probe","args":["current-vo","current-gpu-context","gpu-api","hwdec-current","video-params/gamma","video-params/primaries","video-target-params/gamma","video-target-params/primaries","video-target-params/max-luma","target-colorspace-hint","display-names","display-fps","estimated-vf-fps","osd-width","osd-height","current-ao","audio-device","audio-spdif","audio-out-params/format","audio-out-params/channel-count","audio-params/format","mpv-version"]}$3]}
JSON
  bash "$home_kit/tools/selftest.sh" "$d/plan.json" /usr/bin/kinema 99 > "$d/selftest.out" 2>&1
  tail -n 1 "$d/selftest.out"
}

# The NVIDIA driver's device files, which nothing on the stick makes (the
# third round): without them Vulkan cannot present and NVDEC cannot start.
# What nvidia-modprobe would do.
nvidia_nodes() {
  sudo modprobe nvidia_uvm 2>&1
  [ -e /dev/nvidia-modeset ] || sudo mknod -m 666 /dev/nvidia-modeset c 195 254
  local uvm_major
  uvm_major="$(awk '$2 == "nvidia-uvm" {print $1}' /proc/devices)"
  if [ -n "$uvm_major" ] && [ ! -e /dev/nvidia-uvm ]; then
    sudo mknod -m 666 /dev/nvidia-uvm c "$uvm_major" 0
    sudo mknod -m 666 /dev/nvidia-uvm-tools c "$uvm_major" 1
  fi
  ls -l /dev/nvidia*
}

# Whichever card is in: NVIDIA's needs its own driver (installed by the
# first boot) and its device files; AMD and Intel need nothing — the live
# system's own Mesa drives them (the AMD round: a Polaris or Vega card in
# the test PC). Records what the picture runs on either way.
graphics_ready() {
  if lspci -n | grep -qE ' 03[0-9]{2}: 10de:'; then
    lsmod | grep -q '^nvidia ' || { say "NVIDIA's driver is not loaded: run plain 'bash ~/kinema-kit/run.sh' first."; return 1; }
    say "The NVIDIA driver's device files"
    nvidia_nodes > "$R/nodes.txt" 2>&1
    tail -n 3 "$R/nodes.txt"
  fi
  { lspci -nnk | grep -A3 -E 'VGA|3D|Display'
    command -v vulkaninfo > /dev/null && vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|driverInfo|apiVersion'
  } > "$R/graphics.txt" 2>&1
  grep -E 'deviceName|driverInfo' "$R/graphics.txt" | sort -u
  return 0
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
  # Ubuntu's stick went on to the survey (test); a later desktop goes
  # straight to Kinema's own check, which is what is left to confirm there.
  next='bash ~/kinema-kit/run.sh'
  is_plasma && next="$next check"
  say "Done. Restart now, choose the same system in the Ventoy menu again, open a Terminal and run:"
  echo
  echo "    $next"
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
  nvidia_nodes | tee -a "$R/nodes.txt"
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
  python3 "$home_kit/tools/display.py" state > "$R/screens-4k.json" 2>&1
  play 4k-sdr-auto

  say "3840x2160 at 23.976 Hz, HDR on"
  hdr on
  python3 "$home_kit/tools/display.py" state > "$R/screens-4k-hdr.json" 2>&1
  play 4k-hdr-auto
  play 4k-hdr-opengl --gpu-api=opengl

  say "Kinema at 3840x2160 at 23.976 Hz, HDR on"
  kinema_plan 4k-hdr "$clip" ""

  say "The screen back as it was"
  hdr off
  mode "$w0" "$h0" "$r0"
  python3 "$home_kit/tools/display.py" state > "$R/screens-after.json" 2>&1

  copy_out
  say "All done. You can shut down, take the stick out and plug it into the development PC."
  exit 0
fi

if [ "$stage" = check ]; then
  # Steps 1–3 of the Linux port on the real TV and receiver (notes: PORTING,
  # phase 4 round 2). Kinema itself does the work here; the kit only sets
  # its settings on each run's copy of the library and reads what it logged.
  media="$home_kit/media"
  graphics_ready || exit 1
  display() { python3 "$home_kit/tools/display.py" "$@"; }

  say "The hardware and the desktop, as this boot sees them"
  system "$R/system"

  say "Kinema, the build in the kit"
  sudo dpkg -i "$home_kit"/kinema_*_amd64.deb 2>&1 | tee "$R/install.txt" > /dev/null
  dpkg -l kinema | tail -n 1 | tee -a "$R/install.txt"
  read -r w0 h0 r0 < <(display current)
  echo "screen at the start: ${w0}x${h0}@${r0}" | tee "$R/display.txt"
  display hdr off >> "$R/display.txt"

  say "1 — what Kinema sees: the equipment check it makes as it starts"
  kinema_plan equipment "$media/sound-ac3.mkv" ""
  grep -h 'equipment:' "$R/kinema-equipment/data/logs/app.log" | tee "$R/equipment.txt"

  say "2 — sound straight to the receiver, in each format"
  # PipeWire's view during the film (Kinema should hold the card, so the HDMI
  # sink is gone) and after it (given back, so it is there again).
  direct=',{"at":0.5,"do":"call","fn":"setSetting","args":["audio_direct","on"]}'
  for codec in ac3 eac3 dts truehd; do
    ( sleep 9; pactl list short sinks > "$R/sinks-during-$codec.txt" 2>&1 ) &
    reading=$!   # waited for by number: a bare wait also waits for the log's tee
    kinema_plan "direct-$codec" "$media/sound-$codec.mkv" "$direct"
    wait "$reading"
    sleep 3
    pactl list short sinks > "$R/sinks-after-$codec.txt" 2>&1
    echo "-- $codec" >> "$R/direct.txt"
    grep -hE 'audio: |shown to the user' "$R/kinema-direct-$codec/data/logs/app.log" | tee -a "$R/direct.txt"
  done

  say "3 — the screen switched for a 4K HDR film, and put back"
  switch=',{"at":0.5,"do":"call","fn":"setSetting","args":["display_switch_refresh","on"]},{"at":0.6,"do":"call","fn":"setSetting","args":["display_switch_hdr","on"]}'
  ( sleep 12; display current > "$R/display-during.txt" 2>&1; display state > "$R/screens-during.json" 2>&1 ) &
  reading=$!   # waited for by number: a bare wait also waits for the log's tee
  kinema_plan switch "$media/hdr10-2160p23.976.mkv" "$switch"
  wait "$reading"
  sleep 3
  echo "during: $(cat "$R/display-during.txt")" | tee -a "$R/display.txt"
  echo "after:  $(display current)" | tee -a "$R/display.txt"
  # Kinema's own restore, HDR included: Plasma keeps a change made through
  # kscreen-doctor, so this is the read that says whether it was undone.
  display state > "$R/screens-after.json" 2>&1
  grep -hE 'display: |shown to the user' "$R/kinema-switch/data/logs/app.log" | tee "$R/switch.txt"

  say "The screen back as it was, whatever happened above"
  display hdr off >> "$R/display.txt"
  display mode "$w0" "$h0" "$r0" >> "$R/display.txt"
  echo "end:    $(display current)" | tee -a "$R/display.txt"

  copy_out
  say "All done. You can shut down, take the stick out and plug it into the development PC."
  exit 0
fi

if [ "$stage" = wlroots-in ]; then
  # Inside Sway or Hyprland, started by the wlroots stage below: Kinema's own
  # check there — the screen read through wlr-output-management, a film
  # switching it, sound straight to the receiver — with the desktop's own
  # view of its screens beside it (swaymsg / hyprctl: the kit's tools only).
  desk="${2:?which desktop}"
  media="$home_kit/media"
  outputs() {
    case "$desk" in
      sway) swaymsg -t get_outputs -r ;;
      hyprland) hyprctl monitors -j ;;
    esac
  }
  { echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}"
    case "$desk" in sway) sway --version ;; hyprland) hyprctl version ;; esac
  } > "$R/session.txt" 2>&1
  outputs > "$R/screens-before.json" 2>&1

  say "$desk 1 — what Kinema sees"
  kinema_plan equipment "$media/sound-ac3.mkv" ""
  grep -hE 'capabilities: |equipment: |display: ' "$R/kinema-equipment/data/logs/app.log" > "$R/equipment.txt"

  say "$desk 2 — TrueHD straight to the receiver"
  direct=',{"at":0.5,"do":"call","fn":"setSetting","args":["audio_direct","on"]}'
  kinema_plan direct-truehd "$media/sound-truehd.mkv" "$direct"
  grep -hE 'audio: |shown to the user' "$R/kinema-direct-truehd/data/logs/app.log" > "$R/direct.txt"

  say "$desk 3 — the 4K HDR film, the screen switched for it and put back"
  switch=',{"at":0.5,"do":"call","fn":"setSetting","args":["display_switch_refresh","on"]},{"at":0.6,"do":"call","fn":"setSetting","args":["display_switch_hdr","on"]}'
  ( sleep 12; outputs > "$R/screens-during.json" 2>&1 ) &
  reading=$!   # waited for by number: a bare wait also waits for the log's tee
  kinema_plan switch "$media/hdr10-2160p23.976.mkv" "$switch"
  wait "$reading"
  sleep 3
  outputs > "$R/screens-after.json" 2>&1
  grep -hE 'display: |shown to the user' "$R/kinema-switch/data/logs/app.log" > "$R/switch.txt"
  exit 0
fi

if [ "$stage" = wlroots ]; then
  # Sway and Hyprland on the real screen, one after the other, each started
  # from a text console (they take the screen from Plasma while they run;
  # back to Plasma afterwards with Ctrl+Alt+F1 or F2). Each runs the
  # wlroots-in part above and leaves by itself; a time limit ends either if
  # it does not.
  if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    say "Run this from a text console, not a desktop window: Ctrl+Alt+F3, log in as $(id -un) (no password), then: bash ~/kinema-kit/run.sh wlroots"
    exit 1
  fi
  graphics_ready || exit 1
  say "Sway and Hyprland from Ubuntu's archive, and the Kinema build in the kit"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q sway hyprland > "$R/install.txt" 2>&1
  sudo dpkg -i "$home_kit"/kinema_*_amd64.deb >> "$R/install.txt" 2>&1
  { sway --version; Hyprland --version; dpkg -l kinema | tail -n 1; } 2>&1 | tee "$R/versions.txt"
  nvidia=""
  lspci -n | grep -qE ' 03[0-9]{2}: 10de:' && nvidia="--unsupported-gpu"

  say "Sway: the screen goes black for a moment, then Kinema plays three short clips"
  d="$R/sway"; mkdir -p "$d"
  cat > "$d/sway.conf" <<CONF
exec "KIT_R=$d bash $home_kit/run.sh wlroots-in sway; swaymsg exit"
CONF
  XDG_CURRENT_DESKTOP=sway timeout 300 sway $nvidia -c "$d/sway.conf" > "$d/sway.log" 2>&1
  echo "sway ended ($?)" | tee -a "$R/versions.txt"

  say "Hyprland: the same again"
  d="$R/hyprland"; mkdir -p "$d"
  # Hyprland's defaults otherwise: HDR switched on by itself for a
  # full-screen HDR film (render:cm_auto_hdr = 1) is part of what is checked.
  cat > "$d/hyprland.conf" <<CONF
exec-once = KIT_R=$d bash $home_kit/run.sh wlroots-in hyprland; hyprctl dispatch exit
misc {
  disable_hyprland_logo = true
}
CONF
  XDG_CURRENT_DESKTOP=Hyprland timeout 300 Hyprland -c "$d/hyprland.conf" > "$d/hyprland.log" 2>&1
  echo "Hyprland ended ($?)" | tee -a "$R/versions.txt"

  copy_out
  say "All done. Shut down (sudo poweroff), take the stick out and plug it into the development PC."
  exit 0
fi

if [ "$stage" = hyprland-in ]; then
  # Inside Hyprland, started by the hyprland stage below: one 4K HDR film
  # with switching on, and every two seconds Hyprland's view of the screen
  # and of mpv's window, and the kernel's of what goes down the cable —
  # HDR_OUTPUT_METADATA on the connector is what the TV is actually told.
  media="$home_kit/media"
  for o in render:cm_auto_hdr render:cm_fs_passthrough render:cm_enabled debug:disable_logs; do
    echo "$o: $(hyprctl getoption "$o" 2>&1 | head -n 1)"
  done > "$R/options.txt"
  sample() {
    local t="$1"
    hyprctl monitors -j > "$R/monitors-$t.json" 2>&1
    hyprctl clients -j > "$R/clients-$t.json" 2>&1
    sudo -n modetest -c > "$R/drm-$t.txt" 2>&1
  }
  sample before
  ( for t in 04 06 08 10 12 14 16; do sleep 2; sample "$t"; done ) &
  reading=$!   # waited for by number: a bare wait also waits for the log's tee
  switch=',{"at":0.5,"do":"call","fn":"setSetting","args":["display_switch_refresh","on"]},{"at":0.6,"do":"call","fn":"setSetting","args":["display_switch_hdr","on"]},{"at":14,"do":"probe","args":["video-target-params/gamma","video-target-params/primaries","video-target-params/max-luma","target-colorspace-hint","display-fps","osd-width"]}'
  kinema_plan switch "$media/hdr10-2160p23.976.mkv" "$switch"
  wait "$reading"
  sleep 3
  sample after
  grep -hE 'display: |shown to the user' "$R/kinema-switch/data/logs/app.log" > "$R/switch.txt"
  # Hyprland's own log, with logging on: its [CM] lines say which HDR path it took.
  cp "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr/${HYPRLAND_INSTANCE_SIGNATURE:-none}/hyprland.log" "$R/hyprland-own.log" 2>> "$R/run.log"
  exit 0
fi

if [ "$stage" = hyprland ]; then
  # Why Hyprland did not seem to show the HDR film as HDR (the wlroots round,
  # AMD card): its log was off, and its report cannot tell its two HDR paths
  # apart. Three starts, each from a text console like wlroots:
  #   A  its defaults (what a user has): full-screen HDR passed through;
  #   B  the screen at 10 bits per colour;
  #   C  passthrough off, so its automatic HDR switch is what acts.
  # WAYLAND_DISPLAY points nowhere so it does not also open itself as a
  # window in the Plasma session still running on another console.
  if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    say "Run this from a text console, not a desktop window: Ctrl+Alt+F3, log in as $(id -un) (no password), then: bash ~/kinema-kit/run.sh hyprland"
    exit 1
  fi
  graphics_ready || exit 1
  command -v Hyprland > /dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q hyprland > "$R/install.txt" 2>&1
  sudo dpkg -i "$home_kit"/kinema_*_amd64.deb >> "$R/install.txt" 2>&1
  { Hyprland --version | head -n 1; dpkg -l kinema | tail -n 1; } 2>&1 | tee "$R/versions.txt"
  for v in A B C; do
    d="$R/$v"; mkdir -p "$d"
    case "$v" in
      A) extra="" ;;
      B) extra="monitor = , preferred, auto, 1, bitdepth, 10" ;;
      C) extra="render {
  cm_fs_passthrough = 0
}" ;;
    esac
    cat > "$d/hyprland.conf" <<CONF
exec-once = KIT_R=$d bash $home_kit/run.sh hyprland-in; hyprctl dispatch exit
debug {
  disable_logs = false
}
misc {
  disable_hyprland_logo = true
}
$extra
CONF
    say "Hyprland $v of 3: the screen goes black for a moment, then the HDR test film plays"
    WAYLAND_DISPLAY=kinema-none XDG_CURRENT_DESKTOP=Hyprland timeout 240 Hyprland -c "$d/hyprland.conf" > "$d/hyprland.out" 2>&1
    echo "Hyprland $v ended ($?)" | tee -a "$R/versions.txt"
    sleep 3
  done
  copy_out
  say "All done. Shut down (sudo poweroff), take the stick out and plug it into the development PC."
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
python3 "$home_kit/tools/display.py" state > "$R/screens-hdr-on.json" 2>&1
kinema_plan hdr-on "$media/hdr10-2160p23.976.mkv" ""
python3 "$home_kit/tools/display.py" hdr off > /dev/null

say "Kinema: TrueHD the ordinary way (through PipeWire)"
kinema_plan sound-truehd "$media/sound-truehd.mkv" ""

copy_out
say "All done. You can shut down, take the stick out and plug it into the development PC."

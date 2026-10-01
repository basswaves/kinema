#!/usr/bin/env bash
# Kinema's Linux test, for an Ubuntu 26.04 live session with persistence.
# Run it once on each boot; it knows which boot it is:
#   1st boot: records the hardware, installs NVIDIA's driver, Kinema and the
#             tools, and asks for a restart;
#   2nd boot: records the hardware again with NVIDIA's driver and runs the
#             tests. Results go to the stick, and to ~/kinema-results.
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
stage="${KINEMA_KIT_STAGE:-$stage}"
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
    if [ -s "$c/edid" ]; then
      cp "$c/edid" "$out/edid-$n.bin"
      command -v edid-decode > /dev/null && edid-decode "$c/edid" > "$out/edid-$n.txt" 2>&1
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
  say "NVIDIA's driver"
  ubuntu-drivers list > "$R/ubuntu-drivers-list.txt" 2>&1
  cat "$R/ubuntu-drivers-list.txt"
  sudo DEBIAN_FRONTEND=noninteractive ubuntu-drivers install
  dpkg -l | grep -E '^ii +(nvidia-driver|linux-modules-nvidia)' | tee "$R/nvidia-installed.txt"
  copy_out
  say "Done. Restart now (top right, Power Off / Restart), choose Ubuntu in the Ventoy menu again, open a Terminal and run:"
  echo
  echo "    bash ~/kinema-kit/run.sh"
  echo
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

kinema_plan() {   # name, clip, extra actions (JSON list items)
  local d="$R/kinema-$1"; mkdir -p "$d"
  cat > "$d/plan.json" <<JSON
{"path":"$2","fileId":null,"titleId":null,"seconds":18,"openAfter":2,
 "actions":[{"at":7,"do":"key","key":"ArrowUp"},
            {"at":8,"do":"mpv","args":["screenshot-to-file","$d/mpv-window.png","window"]},
            {"at":9,"do":"probe","args":["current-vo","gpu-api","hwdec-current","video-params/gamma","video-params/primaries","video-target-params/gamma","video-target-params/primaries","video-target-params/max-luma","target-colorspace-hint","display-names","display-fps","estimated-vf-fps","osd-width","osd-height","current-ao","audio-out-params/format","audio-out-params/channel-count","audio-params/format","mpv-version"]}$3]}
JSON
  bash "$home_kit/tools/selftest.sh" "$d/plan.json" /usr/bin/kinema 99 > "$d/selftest.out" 2>&1
  tail -n 1 "$d/selftest.out"
}

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

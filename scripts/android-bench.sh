#!/usr/bin/env bash
# The Android test bench: Google's Android TV emulator, run with no window, and
# the commands to drive it. Nothing appears on any screen and no real keyboard
# or mouse is used — every key press and click is made inside Android by adb —
# so the person at the computer can carry on while it runs.
#
#   scripts/android-bench.sh setup            install the SDK pieces below, make the TVs
#   scripts/android-bench.sh start [tv|tv9]   boot a TV (default tv) and wait for it
#   scripts/android-bench.sh stop [tv|tv9]
#   scripts/android-bench.sh info             Android version, screen, WebView
#   scripts/android-bench.sh key UP DOWN OK BACK HOME ...   the remote's buttons
#   scripts/android-bench.sh text 'words'     typing, as a keyboard would
#   scripts/android-bench.sh click X Y        a mouse click at a screen pixel
#   scripts/android-bench.sh scroll X Y DY    the mouse wheel (DY < 0 is down;
#                                             Android 9's `input` has no wheel)
#   scripts/android-bench.sh tap X Y          a touch
#   scripts/android-bench.sh shot FILE.png    a photo of the TV's screen
#   scripts/android-bench.sh install FILE.apk
#   scripts/android-bench.sh log [FILE]       the system log so far (logcat)
#   scripts/android-bench.sh adb ARGS...      anything else, on the chosen device
#
# The two TVs: `tv` is Android TV 16 (API 36, x86_64), the current system;
# `tv9` is Android TV 9 (API 28, x86), the oldest Kinema aims at — what many
# operator boxes still run. tv9's own WebView is Chrome 66, far older than the
# interface's build target (Vite's default, Chrome 107): a real box updates
# its WebView through Google Play, this image cannot.
#
# A real device — a phone or a box with network debugging on, paired with
# `adb pair` / `adb connect` — is driven by the same commands: set
# KINEMA_ANDROID_SERIAL to its address (`adb devices` lists it). The emulator
# commands (start, stop) ignore it.
#
# Needs: a JDK 17 (openjdk-17-jdk-headless), unzip, and /dev/kvm usable by this
# account (the `kvm` group). Android's command-line tools unpacked into
# $ANDROID_HOME/cmdline-tools/latest (default ~/Android), from
# https://developer.android.com/studio#command-line-tools-only. `setup` then
# asks you to accept Google's SDK licences before it downloads anything.
set -eu

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
# Where avdmanager puts the TVs (it does not follow ANDROID_AVD_HOME into a
# folder that does not exist yet, so the default stays).
avd_home="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
state="$ANDROID_HOME/bench"

# Pinned, so every run of the bench — and CI later — tests the same systems.
NDK='ndk;28.2.13676358'
PLATFORM='platforms;android-36'
BUILD_TOOLS='build-tools;36.0.0'
TV_IMAGE='system-images;android-36;android-tv;x86_64'
TV9_IMAGE='system-images;android-28;android-tv;x86'

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
adb_bin="$ANDROID_HOME/platform-tools/adb"
emulator_bin="$ANDROID_HOME/emulator/emulator"

die() { echo "android-bench: $*" >&2; exit 1; }

# Each TV has its own console port, so both can run at once; adb names an
# emulator after its port.
port_of() { case "${1:-tv}" in tv) echo 5580 ;; tv9) echo 5582 ;; *) die "no TV called '$1' (tv or tv9)" ;; esac; }
avd_of() { case "${1:-tv}" in tv) echo kinema-tv ;; tv9) echo kinema-tv9 ;; esac; }
image_of() { case "${1:-tv}" in tv) echo "$TV_IMAGE" ;; tv9) echo "$TV9_IMAGE" ;; esac; }

serial() {
  if [ -n "${KINEMA_ANDROID_SERIAL:-}" ]; then echo "$KINEMA_ANDROID_SERIAL"; return; fi
  # The one bench TV that is running, tv first.
  for t in tv tv9; do
    s="emulator-$(port_of $t)"
    if "$adb_bin" -s "$s" get-state >/dev/null 2>&1; then echo "$s"; return; fi
  done
  die "no TV is running (scripts/android-bench.sh start) and KINEMA_ANDROID_SERIAL is not set"
}
adb_dev() { "$adb_bin" -s "$(serial)" "$@"; }

make_avd() {
  local t="$1" name image
  name="$(avd_of "$t")"; image="$(image_of "$t")"
  [ -f "$avd_home/$name.ini" ] && return 0
  # It prints "Could not load devices from …/devices.xml" for TV images; that
  # is about the image's own list, and the stock tv_1080p is used instead.
  echo no | "$avdmanager" create avd --name "$name" --package "$image" --device tv_1080p >/dev/null 2>&1 || true
  [ -f "$avd_home/$name.avd/config.ini" ] || die "avdmanager did not make $name"
  # A 1080p TV with enough memory for a WebView and a player; no camera, no
  # sensors — a TV box has neither.
  cat >> "$avd_home/$name.avd/config.ini" <<CONFIG
hw.ramSize=4096
disk.dataPartition.size=8G
hw.keyboard=yes
hw.dPad=yes
hw.camera.back=none
hw.camera.front=none
CONFIG
  echo "made $name ($image)"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  setup)
    [ -x "$sdkmanager" ] || die "Android's command-line tools are not in $ANDROID_HOME/cmdline-tools/latest (see the top of this file)"
    [ -x "$JAVA_HOME/bin/java" ] || die "no JDK at $JAVA_HOME (apt install openjdk-17-jdk-headless)"
    # Interactive on purpose: the licences are yours to accept.
    "$sdkmanager" --licenses
    "$sdkmanager" --install platform-tools emulator "$PLATFORM" "$BUILD_TOOLS" "$NDK" "$TV_IMAGE" "$TV9_IMAGE"
    make_avd tv; make_avd tv9
    [ -r /dev/kvm ] && [ -w /dev/kvm ] || echo "android-bench: /dev/kvm is not usable by $(id -un) — add it to the kvm group, then start a new session" >&2
    echo "NDK_HOME=$ANDROID_HOME/ndk/${NDK#ndk;}"
    ;;

  start)
    t="${1:-tv}"; port="$(port_of "$t")"; s="emulator-$port"
    make_avd "$t"
    mkdir -p "$state"
    if ! "$adb_bin" -s "$s" get-state >/dev/null 2>&1; then
      # No window, no sound card, software drawing (works everywhere, WSL
      # included); a fresh start each time, so one run cannot leave state for
      # the next. A session of its own (setsid), or it is stopped with the
      # shell that started it — under `wsl.exe`, as soon as the command ends.
      setsid nohup "$emulator_bin" -avd "$(avd_of "$t")" -port "$port" \
        -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
        < /dev/null > "$state/$t.log" 2>&1 &
      echo $! > "$state/$t.pid"
    fi
    "$adb_bin" -s "$s" wait-for-device
    for _ in $(seq 1 240); do
      [ "$("$adb_bin" -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
      sleep 1
    done
    [ "$("$adb_bin" -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] \
      || die "$t did not finish booting in 4 minutes; see $state/$t.log"
    # Screen always on, so a photo is never of a sleeping TV.
    "$adb_bin" -s "$s" shell svc power stayon true
    echo "$s"
    ;;

  stop)
    t="${1:-tv}"; s="emulator-$(port_of "$t")"
    "$adb_bin" -s "$s" emu kill >/dev/null 2>&1 || true
    if [ -f "$state/$t.pid" ]; then
      pid="$(cat "$state/$t.pid")"
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill "$pid" 2>/dev/null || true
      rm -f "$state/$t.pid"
    fi
    ;;

  info)
    echo "device:  $(serial)"
    echo "android: $(adb_dev shell getprop ro.build.version.release | tr -d '\r') (API $(adb_dev shell getprop ro.build.version.sdk | tr -d '\r'))"
    echo "model:   $(adb_dev shell getprop ro.product.model | tr -d '\r')"
    echo "abi:     $(adb_dev shell getprop ro.product.cpu.abilist | tr -d '\r')"
    echo "screen:  $(adb_dev shell wm size | tr -d '\r' | sed 's/.*: //') at $(adb_dev shell wm density | tr -d '\r' | sed 's/.*: //') dpi"
    echo "tv:      $(adb_dev shell pm has-feature android.software.leanback | tr -d '\r')"
    echo "webview: $(adb_dev shell dumpsys webviewupdate | tr -d '\r' | grep -m1 'Current WebView package' | sed 's/.*(//; s/).*//')"
    ;;

  key)
    [ $# -gt 0 ] || die "which keys? (UP DOWN LEFT RIGHT OK BACK HOME MENU PLAY_PAUSE, or any KEYCODE_ name)"
    codes=()
    for k in "$@"; do
      case "$k" in
        UP|DOWN|LEFT|RIGHT) codes+=("KEYCODE_DPAD_$k") ;;
        OK|CENTER) codes+=(KEYCODE_DPAD_CENTER) ;;
        BACK|HOME|MENU|ENTER|ESCAPE|SPACE) codes+=("KEYCODE_$k") ;;
        PLAY_PAUSE|PLAY|PAUSE|STOP|NEXT|PREVIOUS|FAST_FORWARD|REWIND) codes+=("KEYCODE_MEDIA_$k") ;;
        KEYCODE_*) codes+=("$k") ;;
        *) die "unknown key '$k'" ;;
      esac
    done
    # Sent from the remote's source, as a TV box's remote would send them.
    adb_dev shell input dpad keyevent "${codes[@]}"
    ;;

  text)
    # `input text` takes %s for a space.
    adb_dev shell input keyboard text "$(printf '%s' "$*" | sed 's/ /%s/g')"
    ;;

  click)  [ $# -eq 2 ] || die "click X Y"; adb_dev shell input mouse tap "$1" "$2" ;;
  tap)    [ $# -eq 2 ] || die "tap X Y"; adb_dev shell input touchscreen tap "$1" "$2" ;;
  scroll)
    [ $# -eq 3 ] || die "scroll X Y DY"
    adb_dev shell input mouse scroll "$1" "$2" --axis "VSCROLL,$3"
    ;;

  shot)
    [ $# -eq 1 ] || die "shot FILE.png"
    adb_dev exec-out screencap -p > "$1"
    [ -s "$1" ] || die "the photo is empty"
    echo "$1"
    ;;

  install) [ $# -eq 1 ] || die "install FILE.apk"; adb_dev install -r "$1" ;;

  log)
    if [ $# -eq 1 ]; then adb_dev logcat -d -v threadtime > "$1"; echo "$1"
    else adb_dev logcat -d -v threadtime; fi
    ;;

  adb) adb_dev "$@" ;;

  *) sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'; [ -z "$cmd" ] || exit 1 ;;
esac

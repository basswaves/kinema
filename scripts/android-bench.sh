#!/usr/bin/env bash
# The kit, one command per job, from Windows' Git Bash or from WSL (Windows goes
# through WSL by itself). A few plain lines each; nothing needs a script of its own.
#
#   android-bench.sh status                   what is on it: version, debug or release,
#                                             library, screen timeout, what is in front
#   android-bench.sh ready [ABI]              build only if the sources changed, install
#                                             only if the device has another APK. Slow when
#                                             it builds: run it in the background. Builds in
#                                             ~/kinema-android, never in ~/kinema
#   android-bench.sh lib prepare|clean|show   test clips in the library, scanned; `lib
#                                             prepare names 8000` for a big one; clean takes
#                                             out only what the kit put there
#   android-bench.sh play [--keys] [NAME]     a film through the real player; says whether
#                                             a picture really shows, and where the photo is
#   android-bench.sh picture [NAME]           the same question for what is on screen now
#   android-bench.sh screen show|off|on|timeout MS|restore    the old value is kept once and
#                                             put back by `restore`, by the end of a check,
#                                             and by itself after 30 minutes
#   android-bench.sh start|stop [tv|tv2|tv9]  an emulator; tv2 is a second TV 16 for when
#                                             another session has tv. Never touches a device
#   android-bench.sh check NAME               a whole check in one call, with its build:
#                                             play subtitles resume seeks walk scan webview
#                                             or `all`
#   android-bench.sh measure ...              scripts/android-measure.sh on the chosen target
#   android-bench.sh page eval 'JS' | keys ArrowDown Enter | walk    the page of a debug build
#
# Flags, before the command:
#   (none)        an emulator, never a real device
#   --tv tv2      that emulator
#   --device      the real device named in $ANDROID_HOME/bench/device.conf (address=...,
#                 library=<its library folder>), kept outside the repository. Reading only:
#                 anything that changes what its screen shows is refused without
#   --tv-free     the owner of that TV has said it is free. Say so and ask first.
#   --wipe        `ready` may uninstall to swap debug and release. Erases its library.
#   --no-build    `check` uses what is installed
# A key for matching in a test build: put a TMDB key in ~/.kinema-tmdb-key in WSL (never in
# the repository); `ready` builds it in, as a release has one, and rebuilds when it changes.
#
# The rest, one step at a time:
#
# The Android test bench: Google's Android TV emulator, run with no window, and
# the commands to drive it. Nothing appears on any screen and no real keyboard
# or mouse is used — every key press and click is made inside Android by adb —
# so the person at the computer can carry on while it runs.
#
#   scripts/android-bench.sh setup            install the SDK pieces below, make the TVs
#   scripts/android-bench.sh start [tv|tv2|tv9]   boot a TV (default tv) and wait for it
#   scripts/android-bench.sh stop [tv|tv2|tv9]
#   scripts/android-bench.sh build [x86_64|aarch64|armv7]   Kinema's debug APK (default
#                                             x86_64, the emulator's; aarch64 for phones and
#                                             most boxes; armv7 for a box whose Android is
#                                             32-bit — `getprop ro.product.cpu.abilist`)
#   scripts/android-bench.sh launch [--fresh] install the last build and start Kinema;
#                                             --fresh forgets its library and settings first
#   scripts/android-bench.sh selftest DIR [SHOTS]   a self-test plan (src/selftest.ts) on
#                                             the installed build: DIR/plan.json and anything
#                                             beside it go to Kinema's private selftest/
#                                             folder (/data/data/com.kinema.app/selftest, the
#                                             paths a plan names); report.json, app.log and
#                                             photos at SHOTS seconds (default 6,14) come back
#                                             into DIR
#   scripts/android-bench.sh mcp [PORT]        the installed build as an interactive self-test,
#                                             its WebView forwarded to PORT (default 9223) for
#                                             the Kinema MCP: kinema_app attach, then kinema_run
# What Kinema costs a device, read from the side: `measure ...` (scripts/android-measure.sh).
#   scripts/android-bench.sh leak DIR [EVERY]   `selftest DIR`, and every EVERY seconds
#                                             (default 20) while it runs, a row in
#                                             DIR/meminfo.csv: the app's memory from `dumpsys
#                                             meminfo` (Java and native heap, graphics, total
#                                             PSS, views, WebViews) and, for the app and for
#                                             the WebView's renderer, resident memory, threads
#                                             and open files. A plan's `leak` samples (src/
#                                             selftest.ts) and this file graph the same run
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
#   scripts/android-bench.sh share [VIDEO...] a network share on this computer, for
#                                             Kinema's share tests and the emulator
#                                             (Samba; asks for sudo), with these videos
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
# commands (start, stop) ignore it. Anything that changes its screen then needs --tv-free.
#
# Needs: a JDK 17 (openjdk-17-jdk-headless), unzip, and /dev/kvm usable by this
# account (the `kvm` group). Android's command-line tools unpacked into
# $ANDROID_HOME/cmdline-tools/latest (default ~/Android), from
# https://developer.android.com/studio#command-line-tools-only. `setup` then
# asks you to accept Google's SDK licences before it downloads anything.
set -eu

# On Windows: everything runs in WSL. By the script file, with no quoting through
# PowerShell, which broke every long command tried that way.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
  here="$(cd "$(dirname "$0")" && pwd -W)"
  drive="${here%%:*}"
  wsl_script="/mnt/$(printf %s "$drive" | tr 'A-Z' 'a-z')${here#*:}/android-bench.sh"
  export MSYS_NO_PATHCONV=1
  to_wsl() { wsl.exe -d Ubuntu-24.04 -e bash "$wsl_script" "$@"; }
  # Through wsl.ps1, into a copy of its own: ~/kinema is what `wsl.ps1 'npm run verify'`
  # runs from, and overwriting it mid-run took a file out from under another session.
  in_mirror() {
    q=""; for a in "$@"; do q="$q $(printf %q "$a")"; done
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$here/wsl.ps1" -Mirror kinema-android "bash scripts/android-bench.sh$q"
  }
  flags=(); no_build=0; on_device=0; args=("$@")
  while [ ${#args[@]} -gt 0 ]; do
    case "${args[0]}" in
      --tv) flags+=(--tv "${args[1]}"); args=("${args[@]:2}"); continue ;;
      --no-build) no_build=1 ;;
      --device) on_device=1; flags+=("${args[0]}") ;;
      --*) flags+=("${args[0]}") ;;
      *) break ;;
    esac
    args=("${args[@]:1}")
  done
  case "${args[0]:-}" in
    ready) in_mirror "$@"; exit $? ;;
    check)
      if [ "$no_build" = 0 ]; then
        [ "$on_device" = 1 ] || to_wsl "${flags[@]}" start >/dev/null || exit $?
        in_mirror "${flags[@]}" ready || exit $?
      fi
      to_wsl "${flags[@]}" --no-build "${args[@]}"; exit $? ;;
    *) to_wsl "$@"; exit $? ;;
  esac ;;
esac

ON_DEVICE=0; TV_FREE=0; WIPE=0; NO_BUILD=0; TV_CHOICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --device) ON_DEVICE=1 ;;
    --tv-free) TV_FREE=1 ;;
    --wipe) WIPE=1 ;;
    --no-build) NO_BUILD=1 ;;
    --tv) TV_CHOICE="$2"; shift ;;
    --*) echo "android-bench: unknown flag $1" >&2; exit 1 ;;
    *) break ;;
  esac
  shift
done

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
# What `build` makes and `launch` installs.
scripts_dir="$(cd "$(dirname "$0")" && pwd)"
# Run from Windows' checkout the build is in the kit's WSL copy; a checkout under /mnt
# cannot hold one.
case "$scripts_dir" in /mnt/*) build_root="$HOME/kinema-android" ;; *) build_root="$(dirname "$scripts_dir")" ;; esac
apk_dir="$build_root/src-tauri/gen/android/app/build/outputs/apk/universal/debug"
# Where avdmanager puts the TVs (it does not follow ANDROID_AVD_HOME into a
# folder that does not exist yet, so the default stays).
avd_home="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
state="$ANDROID_HOME/bench"

# Pinned, so every run of the bench tests the same systems. CI builds with
# the same NDK (NDK_VERSION in .github/workflows/ci.yml).
NDK='ndk;28.2.13676358'
PLATFORM='platforms;android-36'
BUILD_TOOLS='build-tools;36.0.0'
TV_IMAGE='system-images;android-36;android-tv;x86_64'
TV9_IMAGE='system-images;android-28;android-tv;x86'
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/${NDK#ndk;}}"

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
adb_bin="$ANDROID_HOME/platform-tools/adb"
emulator_bin="$ANDROID_HOME/emulator/emulator"

die() { echo "android-bench: $*" >&2; exit 1; }

# Each TV has its own console port, so both can run at once; adb names an
# emulator after its port.
port_of() { case "${1:-tv}" in tv) echo 5580 ;; tv9) echo 5582 ;; tv2) echo 5584 ;; *) die "no TV called '$1' (tv, tv2 or tv9)" ;; esac; }
avd_of() { case "${1:-tv}" in tv) echo kinema-tv ;; tv9) echo kinema-tv9 ;; tv2) echo kinema-tv2 ;; esac; }
image_of() { case "${1:-tv}" in tv|tv2) echo "$TV_IMAGE" ;; tv9) echo "$TV9_IMAGE" ;; esac; }

serial() {
  if [ -n "${KINEMA_ANDROID_SERIAL:-}" ]; then echo "$KINEMA_ANDROID_SERIAL"; return; fi
  if [ -n "$TV_CHOICE" ]; then echo "emulator-$(port_of "$TV_CHOICE")"; return; fi
  # The one bench TV that is running, tv first. A busy emulator can drop out
  # of adb's sight for a few seconds ("offline"), so it gets ten.
  for _ in $(seq 1 10); do
    for t in tv tv2 tv9; do
      s="emulator-$(port_of $t)"
      if "$adb_bin" -s "$s" get-state >/dev/null 2>&1; then echo "$s"; return; fi
    done
    sleep 1
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

# `dumpsys meminfo` for one app as a row of numbers: Java heap, native heap,
# graphics, total PSS (all KB), Views, WebViews. Android 9 and 16 word the
# total differently ("TOTAL:", "TOTAL PSS:"); a number that is not there is
# left empty.
meminfo_row() {
  adb_dev shell dumpsys meminfo "$1" | tr -d '\r' | awk '
    /^ *Java Heap:/ { j = $3 }
    /^ *Native Heap:/ { n = $3 }
    /^ *Graphics:/ { g = $2 }
    /^ *TOTAL:/ { t = $2 }
    /^ *TOTAL PSS:/ { t = $3 }
    /^ *Views:/ { v = $2 }
    /^ *WebViews:/ { w = $2 }
    END { printf "%s,%s,%s,%s,%s,%s", j, n, g, t, v, w }'
}

# The process ids of the app and of its WebView's renderer (sandboxed_process…),
# or empty when there is none.
pid_of_app() { adb_dev shell ps -A | tr -d '\r' | awk -v p="$1" '$NF == p { print $2; exit }'; }
pid_of_renderer() { adb_dev shell ps -A | tr -d '\r' | awk '$NF ~ /sandboxed_process/ { print $2; exit }'; }

# Resident memory (KB), threads and open files of one process, as a row. The
# app's own files need run-as, and the renderer's cannot be read at all: those
# are left empty.
proc_row() {
  local pkg="$1" pid="$2" status files
  [ -n "$pid" ] || { echo ",,"; return; }
  status="$(adb_dev shell "cat /proc/$pid/status 2>/dev/null" | tr -d '\r')"
  files="$( { adb_dev shell "ls /proc/$pid/fd 2>/dev/null"; adb_dev shell "run-as $pkg ls /proc/$pid/fd 2>/dev/null"; } | tr -d '\r' | grep -c . || true)"
  printf '%s' "$status" | awk -v f="$files" '
    /^VmRSS:/ { r = $2 }
    /^Threads:/ { t = $2 }
    END { printf "%s,%s,%s", r, t, (f > 0 ? f : "") }'
}

# ------------------------------------------------------------------ the kit
PKG=com.kinema.app
PRIVATE_LIB="/data/data/$PKG/files/lib"
PRIVATE_NAMES="/data/data/$PKG/files/libtv"
shots="$state/shots"
apk_stash="$state/apk"
device_conf="$state/device.conf"
# A TMDB key for test builds, never in the repository.
tmdb_key_file="$HOME/.kinema-tmdb-key"

tmdb_key_for_build() {
  if [ -s "$tmdb_key_file" ]; then VITE_TMDB_API_KEY="$(tr -d ' \r\n' < "$tmdb_key_file")"; export VITE_TMDB_API_KEY; fi
}

conf() { [ -f "$device_conf" ] && sed -n "s/^$1=//p" "$device_conf" | head -1; }

# The real device, by its address: adb without -s fails with an emulator also up.
connect_device() {
  local address answer
  address="$(conf address)"
  [ -n "$address" ] || die "no device named: put address=<ip:port> and library=<folder> in $device_conf"
  answer="$(timeout 15 "$adb_bin" connect "$address" 2>&1 || true)"
  case "$answer" in
    *connected*) ;;
    *) die "the device does not answer ($answer). 'No route to host' means it is off: ask the owner." ;;
  esac
  export KINEMA_ANDROID_SERIAL="$address"
}

is_real_device() { case "$(serial)" in emulator-*) return 1 ;; *) return 0 ;; esac; }

# The owner uses that TV. Nothing it would see happens unless told to.
need_tv_free() {
  is_real_device || return 0
  [ "$TV_FREE" = 1 ] || die "refused on $(serial): $1 would show on the TV the owner uses. Ask the owner, then add --tv-free."
  echo "On the TV now: $1."
}

dev_q() { "$adb_bin" -s "$(serial)" "$@" 2>/dev/null | tr -d '\r'; }
is_debug() { dev_q shell run-as "$PKG" id | grep -q '^uid='; }
installed_version() { dev_q shell dumpsys package "$PKG" | sed -n 's/^ *versionName=//p' | head -1; }
in_front() { dev_q shell dumpsys window | grep -m1 mCurrentFocus | grep -q "$PKG"; }
wakefulness() { dev_q shell dumpsys power | sed -n 's/^ *mWakefulness=//p' | head -1; }

# Windows' name for a file here, for reading it from there.
win_path() { wslpath -w "$1" 2>/dev/null || echo "$1"; }

# Read-only, on a copy pulled to this side: library.db and its write-ahead file.
lib_query() { # SQL [db path on the device]
  local d db="${2:-library.db}"
  d="$(mktemp -d)"
  "$adb_bin" -s "$(serial)" exec-out run-as "$PKG" cat "$db" > "$d/l.db" 2>/dev/null || true
  "$adb_bin" -s "$(serial)" exec-out run-as "$PKG" cat "$db-wal" > "$d/l.db-wal" 2>/dev/null || true
  python3 -I -c 'import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
for r in c.execute(sys.argv[2]): print("|".join(str(x) for x in r))' "$d/l.db" "$1" 2>/dev/null || true
  rm -rf "$d"
}

page_port() { local s; s="$(serial)"; case "$s" in emulator-*) echo $(( 9400 + ${s#emulator-} % 100 )) ;; *) echo 9499 ;; esac; }
page() { node --experimental-websocket "$scripts_dir/android-page.mjs" "$(page_port)" "$@"; }

# The WebView's debugging socket, forwarded. A debug build only.
forward_page() {
  local port="${1:-$(page_port)}" pid socket=""
  for _ in $(seq 1 40); do
    pid="$(pid_of_app "$PKG")"
    [ -n "$pid" ] && socket="$(adb_dev shell cat /proc/net/unix | tr -d '\r' | grep -o "webview_devtools_remote_$pid" | head -1 || true)"
    [ -n "$socket" ] && break
    sleep 1
  done
  [ -n "$socket" ] || die "no WebView debugging socket (is the installed build a debug one? status says)"
  adb_dev forward "tcp:$port" "localabstract:$socket" >/dev/null
}

# A page that answers, with this expression truthy.
wait_page() { # EXPR [SECONDS]
  local answer=""
  for _ in $(seq 1 "${2:-40}"); do
    answer="$(page eval "!!($1)" 2>/dev/null || true)"
    [ "$answer" = true ] && return 0
    sleep 1
  done
  return 1
}

front_app() { adb_dev shell monkey -p "$PKG" -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1; }

# Awake, and the timer started: `input keyevent 224` on an awake device and monkey
# do not reset it, so a real key goes with them.
wake_for_real() { adb_dev shell input keyevent 224; adb_dev shell input keyevent 19; }

# Kinema's real library, opened as a person would, its page forwarded.
start_real() {
  adb_dev shell am force-stop "$PKG"
  adb_dev shell run-as "$PKG" rm -f selftest/plan.json selftest/report.json >/dev/null 2>&1 || true
  wake_for_real
  front_app
  if is_debug; then
    forward_page
    wait_page "window.__TAURI_INTERNALS__" || die "Kinema's page did not come up"
  fi
}

# The installed (debug) build as an interactive self-test, on a copy of the library,
# with __kinemaSelfTest on the page. The copy is what `selftest/data/library.db` holds.
start_copy() {
  local port="${1:-$(page_port)}"
  adb_dev shell am force-stop "$PKG"
  # selftest/data too: an older copy would not have what was added since.
  adb_dev shell run-as "$PKG" rm -rf selftest/plan.json selftest/report.json selftest/data
  printf '{"interactive":true,"path":"","fileId":null,"titleId":null,"seconds":0}' \
    | adb_dev shell "run-as $PKG sh -c 'mkdir -p selftest && cat > selftest/plan.json'"
  wake_for_real
  front_app
  forward_page "$port"
}

# So the next start is an ordinary one, and no forward is left about.
end_of_app_test() {
  adb_dev shell am force-stop "$PKG" >/dev/null 2>&1 || true
  adb_dev shell run-as "$PKG" rm -f selftest/plan.json selftest/report.json >/dev/null 2>&1 || true
  adb_dev forward --remove "tcp:$(page_port)" >/dev/null 2>&1 || true
}

# ---- the picture

# Is a film showing? Two photos 2 s apart: not black, and moving. Settings or a page is
# still, which is how two rounds measured the wrong screen. Writes $shots/NAME.png.
picture() { # NAME
  local name="${1:-now}" d answer
  mkdir -p "$shots"; d="$(mktemp -d)"
  adb_dev exec-out screencap -p > "$d/a.png"
  sleep 2
  adb_dev exec-out screencap -p > "$d/b.png"
  ffmpeg -hide_banner -loglevel error -y -i "$d/b.png" -vf 'scale=960:-1' "$shots/$name.png" || true
  for f in a b; do ffmpeg -hide_banner -loglevel error -y -i "$d/$f.png" -vf 'scale=96:54,format=gray' -f rawvideo "$d/$f.raw" || true; done
  answer="$(python3 -I -c 'import sys
a=open(sys.argv[1],"rb").read(); b=open(sys.argv[2],"rb").read()
if not a or len(a)!=len(b): print("no 0 0"); raise SystemExit
n=len(b); m=sum(b)/n; spread=(sum((x-m)**2 for x in b)/n)**.5; moved=sum(abs(x-y) for x,y in zip(a,b))/n
print("yes" if moved>=.15 and (m>=5 or spread>=5) else "no", round(m), round(moved,2))' "$d/a.raw" "$d/b.raw")"
  rm -rf "$d"
  local verdict bright moved front=yes
  read -r verdict bright moved <<< "$answer"
  in_front || front=no
  [ "$front" = yes ] || verdict=no
  echo "picture: $verdict (brightness $bright of 255, moving $moved, Kinema in front: $front)"
  echo "photo: $(win_path "$shots/$name.png")"
  [ "$verdict" = yes ]
}

first_frame_line() { dev_q logcat -d -s KinemaPerf:I | grep 'event=first-frame' | tail -1 | sed 's/.*event=first-frame *//'; }
wait_first_frame() { # SECONDS
  for _ in $(seq 1 "${1:-45}"); do
    [ -n "$(first_frame_line)" ] && return 0
    sleep 1
  done
  return 1
}

# ---- the library

# A film for every check: 120 s, bright, moving, 1080p, a keyframe every 10 s, with SRT
# beside it, and a copy with a styled ASS beside it.
make_clips() {
  local m="$state/media/kit"
  mkdir -p "$m/Kit Clip (2001)" "$m/Kit Styled (2002)"
  [ -f "$m/Kit Clip (2001)/Kit Clip (2001).mkv" ] || ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i 'testsrc2=s=1920x1080:r=24:d=120,lutyuv=y=255-val*0.15' -f lavfi -i 'sine=f=440:d=120' \
    -c:v libx264 -preset veryfast -g 240 -keyint_min 240 -sc_threshold 0 -b:v 1500k -pix_fmt yuv420p \
    -c:a aac -b:a 96k "$m/Kit Clip (2001)/Kit Clip (2001).mkv"
  [ -f "$m/Kit Styled (2002)/Kit Styled (2002).mkv" ] || cp "$m/Kit Clip (2001)/Kit Clip (2001).mkv" "$m/Kit Styled (2002)/Kit Styled (2002).mkv"
  python3 -I -c 'import sys
m=sys.argv[1]
t=lambda s:"%02d:%02d:%02d,000"%(s//3600,(s%3600)//60,s%60)
open(m+"/Kit Clip (2001)/Kit Clip (2001).srt","w").write("\n".join("%d\n%s --> %s\nWhite words on a bright picture, line %d\n"%(i//6+1,t(i),t(i+6),i//6+1) for i in range(0,120,6)))
ass="[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,60,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
ass+="".join("Dialogue: 0,0:%02d:%02d.00,0:%02d:%02d.00,Default,,0,0,0,,Yellow styled line %d\n"%(i//60,i%60,(i+6)//60,(i+6)%60,i//6+1) for i in range(0,120,6))
open(m+"/Kit Styled (2002)/Kit Styled (2002).ass","w").write(ass)' "$m"
}

# Where test files go. A device's real library folder (files anywhere else are never
# scanned, and that looks like a healthy idle device), or on an emulator a private
# folder, which needs no permission.
lib_folder() { # clips|names
  if is_real_device; then
    local l; l="$(conf library)"
    [ -n "$l" ] || die "no library= in $device_conf: read the folder in Settings on the device"
    echo "$l"
  elif [ "${1:-clips}" = names ]; then echo "$PRIVATE_NAMES"; else echo "$PRIVATE_LIB"; fi
}

dev_sh() { # a shell line where the test files are: as the app on an emulator, as adb on a device
  if is_real_device; then adb_dev shell "$1"; else adb_dev shell "run-as $PKG sh -c \"$1\""; fi
}

tar_in() { # FOLDER SUBFOLDER : a tar on stdin
  dev_sh "mkdir -p '$1' && cd '$1' && tar -xf -" 2>/dev/null
}

count_in() { dev_sh "find '$1' -type f 2>/dev/null | wc -l" 2>/dev/null | tr -d '\r '; }

scanned_under() { lib_query "select count(*) from media_files where path like '%/$1/%' and missing=0"; }
# Listing a folder is over in seconds; reading the names is what a screen going off holds back.
parsed_under() { lib_query "select count(*) from media_files where path like '%/$1/%' and missing=0 and parsed_at is not null"; }

add_root_if_new() { # FOLDER KIND
  local have
  have="$(page eval "window.__TAURI_INTERNALS__.invoke('list_library_roots').then(r => r.map(x => x.path).join('|'))" 2>/dev/null || true)"
  case "|$have|" in
    *"|$1|"*) ;;
    *) page eval "window.__TAURI_INTERNALS__.invoke('add_library_root',{path:'$1',kind:'$2',name:null}).then(() => 'added')" >/dev/null ;;
  esac
}

# Copied whole *before* Kinema starts, so its start scan cannot find part of them.
lib_prepare() { # clips | names COUNT
  local what="${1:-clips}" count="${2:-8000}" folder sub tar
  folder="$(lib_folder "$what")"
  adb_dev shell am force-stop "$PKG"
  if [ "$what" = names ]; then
    sub=kitnames; tar="$state/media/names-$count.tar"; mkdir -p "$state/media"
    [ -f "$tar" ] || bash "$scripts_dir/android-measure.sh" names "$tar" "$sub" "$count"
    tar_in "$folder" < "$tar"
  else
    sub=kit; make_clips
    tar -C "$state/media" -cf - kit | tar_in "$folder"
  fi
  echo "files on it: $(count_in "$folder/$sub") in $folder/$sub"
  if is_debug; then
    # Added, then a fresh start: the start scan then finds it all.
    start_real
    add_root_if_new "$folder" "$([ "$what" = names ] && echo tv || echo movies)"
    adb_dev shell am force-stop "$PKG"
    [ "${LIB_NO_START:-0}" = 1 ] && return 0
    wake_for_real; front_app; forward_page
    local n=""
    for _ in $(seq 1 90); do
      n="$(scanned_under "$sub")"
      [ "${n:-0}" -gt 0 ] && break
      sleep 2
    done
    echo "library has: ${n:-0} of them"
    [ "${n:-0}" -gt 0 ] || die "the scan found none: read logs/app.log"
  else
    wake_for_real; front_app
    echo "release build: its library cannot be read from here; if this folder is not one of its folders, nothing is scanned"
  fi
}

lib_clean() {
  local folder
  adb_dev shell am force-stop "$PKG"
  for folder in "$(lib_folder clips)" "$(lib_folder names)"; do
    dev_sh "rm -rf '$folder/kit' '$folder/kitnames'" >/dev/null 2>&1 || true
  done
  echo "kit files out; left in $(lib_folder clips): $(count_in "$(lib_folder clips)") files"
}

lib_show() {
  if is_debug; then
    echo "folders: $(lib_query 'select path||" ("||kind||")" from library_roots' | paste -sd ';' -)"
    echo "files: $(lib_query 'select count(*) from media_files where missing=0'), titles: $(lib_query 'select count(*) from titles')"
  else
    echo "folders: a release build keeps them to itself; on the device, $(lib_folder clips) holds $(count_in "$(lib_folder clips)") files"
  fi
}

# ---- the screen

screen_saved() { echo "$state/screen-$(serial | tr ':/' '__').saved"; }

# Read once, before anything changes it; a second test must not save the test's value.
screen_save() {
  local f; f="$(screen_saved)"
  [ -f "$f" ] && return 0
  mkdir -p "$state"
  printf '%s %s\n' "$(dev_q shell settings get system screen_off_timeout)" \
    "$(dev_q shell settings get global stay_on_while_plugged_in)" > "$f"
  # If this session dies, the device still gets its timeout back.
  setsid nohup bash "$0" ${TV_CHOICE:+--tv "$TV_CHOICE"} screen restore-later \
    < /dev/null > /dev/null 2>&1 &
  echo $! > "$f.watch"
}

screen_restore() {
  local f timeout stay; f="$(screen_saved)"
  [ -f "$f" ] || return 0
  read -r timeout stay < "$f"
  adb_dev shell settings put system screen_off_timeout "$timeout"
  adb_dev shell settings put global stay_on_while_plugged_in "$stay"
  rm -f "$f"
  if [ -f "$f.watch" ]; then
    local watch; watch="$(cat "$f.watch")"; rm -f "$f.watch"
    [ "$watch" = "$$" ] || kill "$watch" 2>/dev/null || true
  fi
  echo "screen timeout back at $timeout, stay-on $stay"
}

screen_cmd() {
  local what="${1:-show}"; shift || true
  case "$what" in
    show)
      echo "screen: $(wakefulness), timeout $(dev_q shell settings get system screen_off_timeout), stay-on $(dev_q shell settings get global stay_on_while_plugged_in)"
      [ -f "$(screen_saved)" ] && echo "that is a test's value; the real one is kept: screen restore" || true ;;
    off) need_tv_free "the screen goes dark"; adb_dev shell input keyevent 223; sleep 1; echo "screen: $(wakefulness)" ;;
    on) need_tv_free "the screen wakes"; wake_for_real; sleep 1; echo "screen: $(wakefulness)" ;;
    timeout)
      [ $# -eq 1 ] || die "screen timeout MS"
      need_tv_free "the screen goes dark after $(( $1 / 1000 )) s"
      screen_save
      adb_dev shell settings put global stay_on_while_plugged_in 0
      adb_dev shell settings put system screen_off_timeout "$1"
      wake_for_real
      echo "timeout $1, stay-on 0; timer started. Copy files before this, not after. It comes back with: screen restore" ;;
    restore) need_tv_free "the screen timeout goes back"; screen_restore ;;
    restore-later) sleep 1800; screen_restore ;;
    *) die "screen show|off|on|timeout MS|restore" ;;
  esac
}

# ---- ready

# What the APK depends on: docs and scripts do not call for a build.
sources_id() {
  { git -C "$build_root" -c safe.directory='*' ls-tree HEAD src src-tauri public index.html package.json package-lock.json vite.config.ts tsconfig.json
    [ -s "$tmdb_key_file" ] && sha1sum "$tmdb_key_file"; } | sha1sum | cut -d' ' -f1
}

abi_of_target() {
  local list
  list="$(dev_q shell getprop ro.product.cpu.abilist)"
  case "$list" in
    x86_64*) echo x86_64 ;;
    x86*) echo i686 ;;
    arm64*) echo aarch64 ;;
    *) echo armv7 ;;
  esac
}

ready() { # [ABI]
  local abi="${1:-}" reachable=1 id
  "$adb_bin" -s "$(serial 2>/dev/null)" get-state >/dev/null 2>&1 || reachable=0
  [ -n "$abi" ] || { [ "$reachable" = 1 ] && abi="$(abi_of_target)" || abi=x86_64; }
  case "$scripts_dir" in /mnt/*) die "ready builds in the copy: from Windows, run it from Git Bash" ;; esac
  mkdir -p "$apk_stash"
  id="$(sources_id)"
  if [ -f "$apk_stash/$abi.apk" ] && [ "$(cat "$apk_stash/$abi.id" 2>/dev/null)" = "$id" ]; then
    echo "build: $abi already made from these sources"
  else
    echo "build: $abi from this tree (minutes)"
    local log="$state/build-$abi.log" started; started="$(date +%s)"
    bash "$scripts_dir/android-bench.sh" build "$abi" > "$log" 2>&1 || { tail -15 "$log" >&2; die "the build failed; all of it in $log"; }
    # A failed build can leave the old APK and still name it, so the file's date decides.
    [ "$(stat -c %Y "$apk_dir/app-universal-debug.apk")" -ge "$started" ] || die "the APK is older than this build: $apk_dir"
    cp "$apk_dir/app-universal-debug.apk" "$apk_stash/$abi.apk"
    echo "$id" > "$apk_stash/$abi.id"
    echo "build: done in $(( $(date +%s) - started )) s"
  fi
  [ "$reachable" = 1 ] || { echo "nothing running to install on; the APK waits in $apk_stash/$abi.apk"; return 0; }
  local want have path output
  want="$(sha1sum "$apk_stash/$abi.apk" | cut -d' ' -f1)"
  path="$(dev_q shell pm path "$PKG" | sed -n 's/^package://p' | head -1)"
  have=""; [ -n "$path" ] && have="$(dev_q shell sha1sum "$path" | cut -d' ' -f1)"
  if [ "$have" = "$want" ]; then
    echo "installed: already this APK ($(installed_version), debug)"
    return 0
  fi
  need_tv_free "Kinema is replaced, and closes if open"
  if ! output="$("$adb_bin" -s "$(serial)" install -r "$apk_stash/$abi.apk" 2>&1)"; then
    case "$output" in
      *UPDATE_INCOMPATIBLE*|*SIGNATURES*)
        [ "$WIPE" = 1 ] || die "debug and release cannot replace each other without an uninstall, which erases Kinema's library there. Ask, then add --wipe."
        adb_dev uninstall "$PKG" >/dev/null
        adb_dev install "$apk_stash/$abi.apk" >/dev/null
        adb_dev shell pm grant "$PKG" android.permission.READ_EXTERNAL_STORAGE >/dev/null 2>&1 || true
        echo "uninstalled first: its library is gone; lib prepare adds a folder again" ;;
      *) die "install failed: $output" ;;
    esac
  fi
  [ "$(dev_q shell sha1sum "$(dev_q shell pm path "$PKG" | sed -n 's/^package://p' | head -1)" | cut -d' ' -f1)" = "$want" ] || die "installed, but the device holds another APK"
  echo "installed: $(installed_version), debug, $abi"
}

# ---- whole checks

passed=0; failed=0
pass() { passed=$(( passed + 1 )); echo "PASS $*"; }
fail() { failed=$(( failed + 1 )); echo "FAIL $*"; }

hooks() { page eval "window.__kinemaSelfTest.$1"; }
js_string() { python3 -I -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"; }
kit_file() { lib_query "select id, path from media_files where path like '%$1%.mkv' and missing=0 limit 1" selftest/data/library.db; }

copy_ready() {
  start_copy
  wait_page "window.__kinemaSelfTest && window.__kinemaSelfTest.screen" || die "the self-test hooks did not come up"
  sleep 3
}

open_film() { # ROW(id|path)
  adb_dev logcat -c
  page eval "window.__kinemaSelfTest.play({path:$(js_string "${1#*|}"),label:'kit',fileId:${1%%|*},titleId:null})" >/dev/null
  wait_first_frame 60
}

# Back to Browse, and no further: one Back too many asks whether to close Kinema.
leave_film() {
  for _ in 1 2 3; do
    [ "$(page eval "!!document.querySelector('.player')" 2>/dev/null)" = true ] || return 0
    page keys Escape >/dev/null 2>&1 || true
    sleep 2
  done
}

position() { hooks 'nowPlaying().then(p => Number(p.position ?? p.time ?? -1))' 2>/dev/null | cut -d. -f1; }

# The share of dark pixels in the lower part of the photo: where subtitles and their box are.
dark_share() { # FILE.png
  local d; d="$(mktemp -d)"
  ffmpeg -hide_banner -loglevel error -y -i "$1" -vf 'crop=iw:ih/4:0:ih*3/4,scale=240:-1,format=gray' -f rawvideo "$d/r" || true
  python3 -I -c 'import sys
b=open(sys.argv[1],"rb").read(); print(round(100*sum(1 for x in b if x<70)/max(1,len(b)),1))' "$d/r"
  rm -rf "$d"
}

check_play() {
  lib_prepare clips
  if bash "$0" play >"$state/check-play.out" 2>&1; then pass "play: $(tr '\n' ' ' < "$state/check-play.out")"
  else fail "play: $(tr '\n' ' ' < "$state/check-play.out")"; fi
}

check_subtitles() {
  local row name box tracks sub share off on
  copy_ready
  for name in "Kit Clip" "Kit Styled"; do
    row="$(kit_file "$name")"; [ -n "$row" ] || { fail "subtitles: $name not in the library"; continue; }
    off=""; on=""
    for box in false true; do
      page eval "window.__TAURI_INTERNALS__.invoke('set_setting',{key:'subtitle_style',value:JSON.stringify({'*':{size:'normal',box:$box}})}).then(()=>'ok')" >/dev/null 2>&1 \
        || hooks "call('setSetting',['subtitle_style',JSON.stringify({'*':{size:'normal',box:$box}})])" >/dev/null
      open_film "$row" || fail "subtitles: $name did not open"
      # A sidecar comes as a track; shown here as the panel would, once per open at most.
      tracks="$(hooks "call('readTracks',[])" 2>/dev/null || true)"
      sub="$(python3 -I -c 'import json,sys
try:
  t=[x for x in json.loads(sys.argv[1]) if x.get("type")=="sub"]
  print(t[0]["id"] if t else "")
except Exception: print("")' "$tracks")"
      if [ -n "$sub" ]; then hooks "call('chooseTrack',['sub',$sub])" >/dev/null 2>&1 || true; fi
      hooks "call('showSubtitles',[true])" >/dev/null 2>&1 || true
      # Past the controls, which draw a dark band of their own.
      sleep 9
      local shot="sub-${name// /}-$box"
      mkdir -p "$shots"; adb_dev exec-out screencap -p > "$shots/$shot.png"
      share="$(dark_share "$shots/$shot.png")"
      if [ "$box" = true ]; then on="$share"; else off="$share"; fi
      leave_film
    done
    if python3 -I -c "import sys; sys.exit(0 if $on >= $off + 1 else 1)"; then
      pass "subtitles $name: dark share lower quarter ${off}% box off, ${on}% box on (track ${sub:-none})"
    else
      fail "subtitles $name: dark share ${off}% box off, ${on}% box on (track ${sub:-none}); photos in $(win_path "$shots")"
    fi
  done
  page eval "window.__TAURI_INTERNALS__.invoke('set_setting',{key:'subtitle_style',value:'{}'}).then(()=>'ok')" >/dev/null 2>&1 || true
}

# The stored position, by file id: the `play` call ignores resumeAt, and below about a
# third of a very short clip it opens at 0, which reads as a fast resume.
check_resume() {
  local row at low high pos line
  copy_ready
  row="$(kit_file "Kit Clip")"; [ -n "$row" ] || { fail "resume: no clip in the library"; return; }
  for at in 59.9 59.9 60.0 60.0; do
    page eval "window.__TAURI_INTERNALS__.invoke('save_progress',{fileId:${row%%|*},positionSecs:$at,durationSecs:120,creditsStart:null,leaving:false}).then(()=>'ok')" >/dev/null
    open_film "$row" || { fail "resume at $at: no first frame"; leave_film; continue; }
    line="$(first_frame_line)"
    sleep 2
    pos="$(position)"
    low=$(python3 -I -c "print(int($at//10*10))"); high=$(( low + 12 ))
    if [ "${pos:-0}" -ge "$low" ] && [ "${pos:-0}" -le "$high" ]; then
      pass "resume at $at: playing at ${pos} s (keyframe $low), first frame: $line"
    else
      fail "resume at $at: playing at ${pos:-?} s, wanted $low to $high; first frame: $line"
    fi
    leave_film
  done
}

check_seeks() {
  local row a b stalls seeks
  copy_ready
  row="$(kit_file "Kit Clip")"; [ -n "$row" ] || { fail "seeks: no clip in the library"; return; }
  open_film "$row" || { fail "seeks: did not open"; return; }
  sleep 3
  # Ten presses fast each way, then one held each way, as a remote holds them: back and
  # forth, because twenty skips forward run a short clip to its end.
  adb_dev shell 'for i in 1 2 3 4 5 6 7 8 9 10; do input keyevent 22; done; for i in 1 2 3 4 5 6 7 8 9 10; do input keyevent 21; done'
  sleep 2
  adb_dev shell input keyevent --longpress 22; sleep 1.2
  adb_dev shell input keyevent --longpress 21; sleep 1.2
  sleep 4
  a="$(position)"; sleep 4; b="$(position)"
  seeks="$(dev_q logcat -d -s KinemaPerf:I | grep -c 'event=seek' || true)"
  stalls="$(dev_q logcat -d -s KinemaPerf:I | grep -c 'event=stall' || true)"
  if [ "${b:-0}" -gt "${a:-0}" ]; then pass "seeks: moving again after the burst ($a s, then $b s), $seeks seeks, $stalls stalls"
  else fail "seeks: stuck after the burst ($a s, then $b s), $seeks seeks, $stalls stalls"; fi
  leave_film
}

check_walk() {
  local row out code=0
  copy_ready
  row="$(kit_file "Kit Clip")"; [ -n "$row" ] || { fail "walk: no clip in the library"; return; }
  # Without a key the clips wait in Needs attention. On the run's copy they are kept as
  # they are, so Movies has cards and a film page.
  page eval "window.__TAURI_INTERNALS__.invoke('list_needs_review',{limit:50}).then(async (l) => { for (const f of l) await window.__TAURI_INTERNALS__.invoke('add_without_match',{fileIds:[f.id],isSeries:false,name:f.path.includes('Styled')?'Kit Styled':'Kit Clip',year:null}); return l.length; })" >/dev/null || true
  page eval "location.reload()" >/dev/null 2>&1 || true
  sleep 3
  wait_page "window.__kinemaSelfTest && window.__kinemaSelfTest.screen" || die "the hooks did not come back after the reload"
  sleep 3
  out="$(page walk "${row#*|}" 2>&1)" || code=$?
  if [ "$code" = 0 ]; then pass "$out"; else fail "$out"; fi
}

# A scan with the screen going off. Copy first, timeout after the copy, a real key last.
check_scan() {
  local count="${1:-8000}" n rows="" end power
  LIB_NO_START=1 lib_prepare names "$count"
  screen_save
  adb_dev shell settings put global stay_on_while_plugged_in 0
  adb_dev shell settings put system screen_off_timeout 15000
  wake_for_real
  front_app
  end=$(( $(date +%s) + 75 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    power="$(wakefulness)"; n="$(parsed_under kitnames)"
    rows="$rows $power:${n:-0}"
    sleep 12
  done
  screen_restore >/dev/null
  wake_for_real
  end=$(( $(date +%s) + 240 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    n="$(parsed_under kitnames)"
    [ "${n:-0}" -ge "$count" ] && break
    sleep 8
  done
  rows="$rows awake:${n:-0}"
  if [ "${n:-0}" -ge "$count" ]; then pass "scan: all $count names read, power state:names read at each row;$rows"
  else fail "scan: ${n:-0} of $count names read;$rows"; fi
  adb_dev shell am force-stop "$PKG"
  dev_sh "rm -rf '$(lib_folder names)/kitnames'" >/dev/null 2>&1 || true
}

# Old WebViews: does the page run, or say what is wrong? Read over the page socket.
check_webview() {
  local version text
  version="$(dev_q shell dumpsys webviewupdate | grep -m1 'Current WebView package' | sed 's/.*(//; s/).*//')"
  start_real || true
  sleep 8
  text="$(page eval "document.body.innerText.slice(0,160).replace(/\s+/g,' ')" 2>&1 || true)"
  picture webview >/dev/null 2>&1 || true
  if [ -n "$text" ]; then pass "webview $version: the screen says: $text"
  else fail "webview $version: nothing on the page; photo $(win_path "$shots/webview.png")"; fi
}

kit_check() {
  local name="${1:-}" started; started="$(date +%s)"
  [ -n "$name" ] || die "check play|subtitles|resume|seeks|walk|scan|webview|all"
  need_tv_free "a check runs: films, keys, and the screen going dark"
  is_debug || die "the check needs a debug build (ready; status says what is installed)"
  [ "$NO_BUILD" = 1 ] || case "$scripts_dir" in /mnt/*) ;; *) ready ;; esac
  trap 'screen_restore >/dev/null 2>&1 || true; end_of_app_test' EXIT
  case "$name" in
    all) check_play; check_subtitles; check_resume; check_seeks; check_walk; check_scan ;;
    scan) check_scan "${2:-8000}" ;;
    play|subtitles|resume|seeks|walk|webview) [ "$name" = play ] || [ "$name" = webview ] || [ -n "$(lib_query "select 1 from media_files where path like '%/kit/%' limit 1")" ] || lib_prepare clips >/dev/null; "check_$name" ;;
    *) die "no check called $name" ;;
  esac
  echo "check $name: $passed passed, $failed failed, $(( $(date +%s) - started )) s; photos in $(win_path "$shots")"
  [ "$failed" = 0 ]
}

cmd="${1:-}"; shift || true

[ "$ON_DEVICE" = 0 ] || connect_device
# Each command that changes what a real device shows asks first; see need_tv_free.
case "$cmd" in
  launch|selftest|leak|key|text|click|tap|scroll|install) need_tv_free "$cmd" ;;
  adb) need_tv_free "an adb command" ;;
esac
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
    t="${1:-${TV_CHOICE:-tv}}"; port="$(port_of "$t")"; s="emulator-$port"
    make_avd "$t"
    mkdir -p "$state"
    if "$adb_bin" -s "$s" get-state >/dev/null 2>&1; then
      echo "$t was already running: another session may be using it (--tv tv2 is a second TV 16)" >&2
    else
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
    t="${1:-${TV_CHOICE:-tv}}"; s="emulator-$(port_of "$t")"
    "$adb_bin" -s "$s" emu kill >/dev/null 2>&1 || true
    if [ -f "$state/$t.pid" ]; then
      pid="$(cat "$state/$t.pid")"
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill "$pid" 2>/dev/null || true
      rm -f "$state/$t.pid"
    fi
    ;;

  build)
    # Run from the repository's root, so npx finds the project's Tauri CLI.
    cd "$build_root"
    . "$HOME/.cargo/env" 2>/dev/null || true
    # Without the debugger's line tables: they made Kinema's library 210 MB of
    # a 430 MB APK, which an old box with 1 GB free could not install over
    # the copy it had. Panics still name their functions.
    export CARGO_PROFILE_DEV_STRIP="${CARGO_PROFILE_DEV_STRIP:-debuginfo}"
    # Optimised, as a release is: unoptimised, the SMB client and its signing
    # read a NAS at about half what a 4K film needs on a 32-bit box, and the
    # film stopped every few seconds to wait. Checks stay on (debug
    # assertions, overflow), so it is still a test build.
    export CARGO_PROFILE_DEV_OPT_LEVEL="${CARGO_PROFILE_DEV_OPT_LEVEL:-2}"
    tmdb_key_for_build
    npx tauri android build --debug --target "${1:-x86_64}" --apk
    echo "$apk_dir/app-universal-debug.apk"
    ;;

  launch)
    [ -f "$apk_dir/app-universal-debug.apk" ] || die "nothing built yet (scripts/android-bench.sh build)"
    adb_dev install -r "$apk_dir/app-universal-debug.apk" >/dev/null
    adb_dev shell am force-stop com.kinema.app
    [ "${1:-}" = --fresh ] && adb_dev shell pm clear com.kinema.app >/dev/null
    adb_dev shell monkey -p com.kinema.app -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1
    # Kinema's own log is beside its library; a debug build lets adb read it:
    #   scripts/android-bench.sh adb shell run-as com.kinema.app cat logs/app.log
    echo started
    ;;

  selftest)
    dir="$(realpath "${1:?selftest DIR}")"; shots="${2:-6,14}"
    [ -f "$dir/plan.json" ] || die "no plan.json in $dir"
    seconds=$(python3 -c "import json,sys; print(int(json.load(open(sys.argv[1]))['seconds']))" "$dir/plan.json")
    pkg=com.kinema.app
    adb_dev shell am force-stop "$pkg"
    # Into the app's private folder through run-as: a folder adb can write
    # (/data/local/tmp) is one the app cannot list.
    adb_dev shell run-as "$pkg" rm -rf selftest
    # Through `shell`, not `exec-in`: Android 9's exec-in gives run-as no
    # stdin. `-o`: the app cannot give the files tar's owners, and need not.
    tar -C "$dir" --exclude=report.json --exclude='*.log' --exclude='*.txt' --exclude='shot-*.png' -cf - . \
      | adb_dev shell "run-as $pkg sh -c 'mkdir -p selftest && cd selftest && tar -xof -'"
    adb_dev shell monkey -p "$pkg" -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1
    started=$(date +%s)
    for t in ${shots//,/ }; do
      while [ $(( $(date +%s) - started )) -lt "$t" ]; do sleep 0.2; done
      adb_dev exec-out screencap -p > "$dir/shot-${t}s.png"
    done
    # The app writes the report and quits when the plan's time is up.
    # `ls`, not `test`: Android 9 has no test program for run-as to start.
    until adb_dev shell run-as "$pkg" ls selftest/report.json >/dev/null 2>&1; do
      [ $(( $(date +%s) - started )) -lt $(( seconds + 90 )) ] || { echo "android-bench: no report after $(( seconds + 90 )) s" >&2; break; }
      sleep 1
    done
    adb_dev exec-out run-as "$pkg" cat selftest/report.json > "$dir/report.json" 2>/dev/null || true
    adb_dev exec-out run-as "$pkg" cat selftest/data/logs/app.log > "$dir/app.log" 2>/dev/null || true
    # So the next start is an ordinary one; the copied library stays for reading.
    adb_dev shell run-as "$pkg" rm -f selftest/plan.json
    echo "$dir/report.json"
    ;;

  mcp)
    need_tv_free "starts Kinema as a self-test"
    start_copy "${1:-9223}"
    echo "port ${1:-9223} (serial $(serial)); when done: kinema_app {action:\"stop\"}, then scripts/android-bench.sh adb forward --remove tcp:${1:-9223}"
    ;;

  leak)
    dir="$(realpath "${1:?leak DIR [EVERY]}")"; every="${2:-20}"
    pkg=com.kinema.app
    csv="$dir/meminfo.csv"
    echo "time_s,java_heap_kb,native_heap_kb,graphics_kb,total_pss_kb,views,webviews,app_pid,app_rss_kb,app_threads,app_fds,renderer_pid,renderer_rss_kb,renderer_threads,renderer_fds" > "$csv"
    started=$(date +%s)
    # The self-test runs in the background; this watches it from the side.
    "$0" selftest "$dir" &
    bench=$!
    next=0
    while kill -0 "$bench" 2>/dev/null; do
      elapsed=$(( $(date +%s) - started ))
      if [ "$elapsed" -ge "$next" ]; then
        app="$(pid_of_app "$pkg")"; renderer="$(pid_of_renderer)"
        echo "$elapsed,$(meminfo_row "$pkg"),$app,$(proc_row "$pkg" "$app"),$renderer,$(proc_row "$pkg" "$renderer")" >> "$csv"
        next=$(( elapsed + every ))
      fi
      sleep 1
    done
    wait "$bench" || echo "android-bench: the self-test ended with an error" >&2
    echo "$csv"
    ;;

  status)
    s="$(serial)"
    "$adb_bin" -s "$s" get-state >/dev/null 2>&1 || die "$s is not running (start, or --device)"
    echo "target: $s, Android $(dev_q shell getprop ro.build.version.release), $(abi_of_target)"
    v="$(installed_version)"
    if [ -z "$v" ]; then echo "kinema: not installed"
    else
      kind=release; is_debug && kind=debug
      echo "kinema: $v $kind, updated $(dev_q shell dumpsys package "$PKG" | sed -n 's/^ *lastUpdateTime=//p' | head -1)"
      [ "$kind" = debug ] && echo "matching: only with a key built in (~/.kinema-tmdb-key) or entered in Settings; page access yes" || echo "matching: its own key; page access no"
      lib_show
    fi
    screen_cmd show
    in_front && echo "front: Kinema" || echo "front: another app"
    ;;

  ready) ready "$@" ;;

  lib)
    case "${1:-show}" in
      show) lib_show ;;
      prepare) need_tv_free "Kinema closes, files are copied, and it opens again"; shift; lib_prepare "$@" ;;
      clean) need_tv_free "Kinema closes"; lib_clean ;;
      *) die "lib prepare [clips|names COUNT] | clean | show" ;;
    esac
    ;;

  picture) picture "${1:-now}" ;;

  play)
    need_tv_free "a film plays"
    by_keys=0; [ "${1:-}" = --keys ] && { by_keys=1; shift; }
    name="${1:-Kit Clip}"
    adb_dev logcat -c
    if [ "$by_keys" = 0 ] && is_debug; then
      start_copy
      wait_page "window.__kinemaSelfTest" || die "the self-test hooks did not come up"
      row="$(lib_query "select id, path from media_files where path like '%$name%.mkv' and missing=0 limit 1")"
      [ -n "$row" ] || die "no file called '$name' in the library: lib prepare"
      page eval "window.__kinemaSelfTest.play({path:$(python3 -I -c 'import json,sys;print(json.dumps(sys.argv[1]))' "${row#*|}"),label:'kit',fileId:${row%%|*},titleId:null})" >/dev/null
    else
      # Search works from anywhere; Kinema reopens on the last screen, not Home, and
      # Home's Play points at whatever is newest.
      start_real
      sleep 8
      adb_dev shell input keyevent 19 19 19 19 19 19 19 19 21 21 21 21 21 21 22 22 22 22 66
      sleep 2
      adb_dev shell input text "$(printf '%s' "${name%% *}" | tr 'A-Z' 'a-z')"
      sleep 3
      # An on-screen keyboard covers the results and takes the keys. Back closes it; only then.
      dev_q shell dumpsys input_method | grep -q 'mInputShown=true' && { adb_dev shell input keyevent 4; sleep 1; }
      adb_dev shell input keyevent 20 20 20 20 20 66
      sleep 2
      adb_dev shell input keyevent 66
    fi
    wait_first_frame 60 || { picture play || true; die "no first frame in 60 s"; }
    echo "player: first frame, $(first_frame_line)"
    sleep 4
    picture play
    ;;

  check) kit_check "$@" ;;

  measure)
    need_tv_free "the measure opens and closes Kinema"
    KINEMA_ANDROID_SERIAL="$(serial)" bash "$scripts_dir/android-measure.sh" "$@"
    ;;

  screen) screen_cmd "$@" ;;

  page) forward_page; page "$@" ;;


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

  share)
    # A network share on this computer (Samba), for netshare.rs's tests and
    # for Kinema in the emulator: share `kinema-test`, folder ~/kinema-test-share,
    # account `kinematest` with a made-up password kept in ~/.kinema-test-share.
    # Videos named here are copied in as a film each. Asks for sudo once.
    folder="$HOME/kinema-test-share"
    login="$HOME/.kinema-test-share"
    command -v smbd >/dev/null || sudo apt-get install -y samba smbclient
    if [ ! -f "$login" ]; then
      (umask 077; head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$login")
    fi
    id kinematest >/dev/null 2>&1 || sudo useradd -M -s /usr/sbin/nologin kinematest
    printf '%s\n%s\n' "$(cat "$login")" "$(cat "$login")" | sudo smbpasswd -a -s kinematest >/dev/null
    mkdir -p "$folder/Films"
    # Samba reads as kinematest: it needs to pass through the home folder.
    chmod o+x "$HOME"
    chmod o+rx "$folder" "$folder/Films"
    for v in "$@"; do
      name="$(basename "${v%.*}")"
      mkdir -p "$folder/Films/$name"
      [ -e "$folder/Films/$name/$(basename "$v")" ] || cp "$v" "$folder/Films/$name/"
    done
    chmod -R o+rX "$folder"
    if ! grep -q '^\[kinema-test\]' /etc/samba/smb.conf; then
      printf '\n[kinema-test]\n   path = %s\n   read only = yes\n   valid users = kinematest\n' "$folder" \
        | sudo tee -a /etc/samba/smb.conf >/dev/null
    fi
    # The same folder for guests, as a NAS that lets anyone in has it
    # (Samba's `map to guest = bad user`, Ubuntu's default, makes one a guest).
    if ! grep -q '^\[kinema-guest\]' /etc/samba/smb.conf; then
      printf '\n[kinema-guest]\n   path = %s\n   read only = yes\n   guest ok = yes\n' "$folder" \
        | sudo tee -a /etc/samba/smb.conf >/dev/null
    fi
    sudo service smbd restart >/dev/null 2>&1 || sudo smbd -D
    echo "share: smb://127.0.0.1/kinema-test (the emulator: smb://10.0.2.2/kinema-test;"
    echo "       a device over adb: 'adb reverse tcp:4450 tcp:445', then smb://127.0.0.1:4450/kinema-test)"
    echo "       smb://127.0.0.1/kinema-guest is the same folder, for a guest"
    echo "tests: KINEMA_TEST_SHARE=smb://127.0.0.1/kinema-test KINEMA_TEST_SHARE_USER=kinematest \\"
    echo "       KINEMA_TEST_GUEST_SHARE=smb://127.0.0.1/kinema-guest \\"
    echo "       KINEMA_TEST_SHARE_PASSWORD=\"\$(cat $login)\" cargo test"
    ;;

  *) sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'; [ -z "$cmd" ] || exit 1 ;;
esac

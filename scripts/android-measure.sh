#!/usr/bin/env bash
# What Kinema costs an Android device, read from the side with adb: nothing runs
# inside the app, so it works on a release build too. Numbers are the device's.
#
#   KINEMA_ANDROID_SERIAL=<address> scripts/android-measure.sh names OUT.tar PREFIX [COUNT]
#       a tar of COUNT (default 4000) tiny files with made-up episode names, under
#       PREFIX/, for a device's library folder. Made-up names ask a provider almost
#       nothing, and reading them needs no provider key.
#   scripts/android-measure.sh sample OUT.csv SECONDS [EVERY]
#       a row every EVERY s (default 5): in front or behind, Kinema's CPU and its
#       renderer's in % of one core, the device's idle %, threads, KB in and out.
#   scripts/android-measure.sh keys OUT.csv COUNT [GAP]
#       Right and Left, timing the first frame Kinema shows after each press.
#   scripts/android-measure.sh away DIR LIBRARY_FOLDER TAR PREFIX
#       the whole check: idle keys, the files copied, Kinema opened (its start scan
#       runs), ten keys, Home, 130 s behind, back, six keys, a summary. Removes the
#       files at the end, and needs a device whose library has that folder.
#   scripts/android-measure.sh home | front
#
# Read this before measuring; each cost a run:
#  - Find the library's folder first, in Settings. Files anywhere else are simply
#    not scanned, and an untouched idle device looks like a good result. A scan
#    that ran shows CPU; a row of zeros from the start means it did not.
#  - Copy the files completely *before* a scan starts (`away` does): a walk during
#    the copy finds part of them, which reads like a bug in the scan.
#  - A blank answer from `keys` is a press that changed nothing on screen (a page
#    with nothing to move to, such as "Reading your library"), not a stall. Measure
#    on a page with something to move to, or the numbers do not compare.
#  - `keys` answers include `input` starting on the device (0.6 s on an old box):
#    compare with the same device idle, never read them as they are.
#  - Device idle is the honest number: a parse worker and other renderers all count.
#    Every row with `dumpsys meminfo` costs the device itself about a third of idle.
#  - KEYCODE_HOME can be swallowed by a launcher's remap; `home` starts the launcher
#    the way the system does, and `sample` says whether Kinema really went behind.
#  - After uninstalling, a debug build has no provider key, so matching and pictures
#    do nothing there: they need a release-signed build, installed over a release.
#    A debug build and a release build cannot replace each other without an
#    uninstall, which erases Kinema's library on the device.
#  - Never `pkill -f name` from a shell whose own command line holds that name: it
#    kills itself first, and whatever comes after never runs.
set -u

ADB="${ANDROID_HOME:-$HOME/Android}/platform-tools/adb"
A=("$ADB" ${KINEMA_ANDROID_SERIAL:+-s "$KINEMA_ANDROID_SERIAL"})
PKG=com.kinema.app
ACTIVITY="$PKG/$PKG.MainActivity"
HZ=100

dev() { "${A[@]}" "$@" 2>/dev/null | tr -d '\r'; }
ticks() { [ -n "$1" ] && dev shell "cat /proc/$1/stat" | sed 's/.*) //' | awk '{print $12+$13}'; }
# Every renderer: a parse worker runs in one, and old ones stay about.
renderer_ticks() {
  local total=0 pid t
  for pid in $(dev shell ps -A -o PID,NAME | awk '$2 ~ /sandboxed_process/ {print $1}'); do
    t=$(ticks "$pid"); total=$((total + ${t:-0}))
  done
  echo "$total"
}
net() { dev shell cat /proc/net/dev | awk -F'[: ]+' '$2=="eth0"||$2=="wlan0" {r+=$3; t+=$11} END {print r+0, t+0}'; }
home() { dev shell am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null; }
front() { dev shell monkey -p "$PKG" -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null; }

sample() {
  local out="$1" secs="$2" every="${3:-5}" cores
  cores=$(dev shell cat /proc/cpuinfo | grep -c '^processor')
  echo "t_s,where,app_cpu,renderer_cpu,device_idle_pct,threads,rx_kb,tx_kb" > "$out"
  local start now el pt="" pa pr pi prx ptx app ta tr id rx tx th where
  start=$(date +%s.%N)
  while :; do
    now=$(date +%s.%N); el=$(echo "$now - $start" | bc)
    [ "$(echo "$el >= $secs" | bc)" = 1 ] && break
    app=$(dev shell pidof "$PKG" | awk '{print $1}')
    ta=$(ticks "$app"); tr=$(renderer_ticks)
    id=$(dev shell head -1 /proc/stat | awk '{print $5}'); read -r rx tx < <(net)
    th=$(dev shell "grep Threads /proc/$app/status" | awk '{print $2}')
    where=$(dev shell dumpsys window | grep -m1 mCurrentFocus | grep -q "$PKG" && echo front || echo behind)
    if [ -n "$pt" ]; then
      local dt; dt=$(echo "$now - $pt" | bc)
      printf '%.0f,%s,%s,%s,%s,%s,%s,%s\n' "$el" "$where" \
        "$(echo "scale=1; 100 * (${ta:-0} - ${pa:-0}) / $HZ / $dt" | bc)" \
        "$(echo "scale=1; 100 * ($tr - $pr) / $HZ / $dt" | bc)" \
        "$(echo "scale=0; 100 * ($id - $pi) / $HZ / $dt / $cores" | bc)" \
        "$th" $(( (rx - prx) / 1024 )) $(( (tx - ptx) / 1024 )) >> "$out"
    fi
    pt=$now; pa=$ta; pr=$tr; pi=$id; prx=$rx; ptx=$tx
    sleep "$every"
  done
}

# Same clock on both sides: logcat's monotonic stamp of a line written just before
# the press, and SurfaceFlinger's present times.
keys() {
  local out="$1" count="$2" gap="${3:-4}" i=0 tag t0 layer
  echo "n,answer_ms" > "$out"
  # The exact name, read from the device: a wrong one answers with nothing, not an error.
  layer=$(dev shell dumpsys SurfaceFlinger --list | grep -m1 "$ACTIVITY")
  [ -n "$layer" ] || { echo "keys: Kinema has no window on the screen; nothing measured" >&2; return 1; }
  while [ "$i" -lt "$count" ]; do
    i=$((i + 1)); tag="KMEASURE$$_$i"
    dev shell "log -t $tag x; input keyevent $(( i % 2 ? 22 : 21 )); sleep 1.5" >/dev/null
    t0=$(dev shell logcat -d -v monotonic -s "$tag" | awk -v t="$tag" 'index($0,t){print $1; exit}')
    dev shell dumpsys SurfaceFlinger --latency "\"$layer\"" | awk -v t0="$t0" -v n="$i" '
      NF==3 && $2>0 && $2<9e18 { s=$2/1e9; if (s>t0 && !f) f=s }
      END { if (f) printf "%d,%.0f\n", n, (f-t0)*1000; else printf "%d,\n", n }' >> "$out"
    sleep "$gap"
  done
  local blank; blank=$(tail -n +2 "$out" | grep -c ',$')
  [ "$blank" -lt $(( (count + 1) / 2 )) ] || echo "keys: $blank of $count changed nothing on screen: a page with nothing to move to, not a stall" >&2
}

names() {
  local out="$1" prefix="$2" count="${3:-4000}" dir show=0 e=0
  dir=$(mktemp -d)
  while [ "$e" -lt "$count" ]; do
    [ $(( e % 500 )) = 0 ] && { show=$(( e / 500 )); mkdir -p "$dir/$prefix/$prefix$show"; }
    : > "$dir/$prefix/$prefix$show/$prefix Hollow $show S$(printf %02d $(( e % 500 / 25 + 1 )))E$(printf %02d $(( e % 25 + 1 ))) 1080p WEB-DL.mkv"
    e=$((e + 1))
  done
  tar -C "$dir" -cf "$out" "$prefix"
  rm -rf "$dir"
}

summary() {
  awk -F, 'NR>2 {k=$2; a[k]+=$3; r[k]+=$4; i[k]+=$5; x[k]+=$7; n[k]++}
    END {print "where app_cpu renderer_cpu idle_pct rx_kb_per_row rows";
         for (k in n) printf "%s %.1f %.1f %.0f %.0f %d\n", k, a[k]/n[k], r[k]/n[k], i[k]/n[k], x[k]/n[k], n[k]}' "$1"
}

away() {
  local d="$1" lib="$2" tar="$3" prefix="$4"
  mkdir -p "$d"
  dev shell am force-stop "$PKG"; front; sleep 45
  keys "$d/keys-idle.csv" 6 2
  dev shell am force-stop "$PKG"
  "${A[@]}" shell "cd '$lib' && tar -xf -" < "$tar" 2>/dev/null
  echo "files on the device: $(dev shell "find '$lib/$prefix' -type f | wc -l")"
  sample "$d/run.csv" 330 & local samp=$!
  front; sleep 15
  keys "$d/keys-scan.csv" 10 2
  home; sleep 130
  front; sleep 3
  keys "$d/keys-back.csv" 6 2
  wait "$samp"
  dev shell am force-stop "$PKG"
  dev shell "rm -rf '$lib/$prefix'"
  front
  for f in keys-idle keys-scan keys-back; do echo "$f: $(tail -n +2 "$d/$f.csv" | cut -d, -f2 | tr '\n' ' ')"; done
  summary "$d/run.csv"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  names|sample|keys|away|home|front|summary) "$cmd" "$@" ;;
  *) sed -n 2,20p "$0"; exit 2 ;;
esac

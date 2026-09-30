#!/usr/bin/env bash
# Run a self-test plan inside a real desktop — KWin or GNOME Shell — nested as
# one window on an X11 display (WSLg's, or any Linux desktop's), send it real
# key presses, and photograph that window alone.
#
#   scripts/nested-selftest.sh <plan.json> [kwin|gnome] [keys] [shots]
#
#   keys   "seconds:key ..." sent into the desktop, e.g. "9:shift 11:space
#          20:Escape" — xdotool key names. The first press after the desktop
#          starts is sometimes taken by the desktop itself: begin with a
#          harmless one (shift).
#   shots  comma-separated seconds for photos (default 6,12); each key also
#          gets one a second after it.
#
# Seconds count from the desktop's start; Kinema starts two or three seconds
# later. Everything else is scripts/selftest.sh's: the plan's data/ folder is
# the library copy, and report.json lands beside the plan, with the photos.
#
# Why nested desktops: whether a window stays on top, which window has the
# keyboard and whether a see-through window shows what is under it are the
# desktop's decisions, and WSLg's own compositor turns each Linux window into
# a separate Windows one, so it cannot show them (docs/GOTCHAS.md).
#
# Needs: kwin-wayland kwin-wayland-backend-x11 (and/or gnome-shell), dbus-x11,
# xdotool, x11-apps, imagemagick. GNOME Shell 46 in WSL runs with --no-x11
# (its Xwayland trips over WSL's /tmp/.X11-unix) and --unsafe-mode, so the
# overview it opens at start can be closed; it still crashes now and then on
# WSL's X server — run it again.
set -u

plan="$(realpath "$1")"
desktop="${2:-kwin}"
keys="${3:-}"
shots="${4:-6,12}"
dir="$(dirname "$plan")"
root="$(cd "$(dirname "$0")/.." && pwd)"
socket="kinema-nested-$$"

[ -n "${DISPLAY:-}" ] || { echo "needs an X11 display to nest the desktop in" >&2; exit 2; }
seconds=$(python3 -c "import json,sys; print(int(json.load(open(sys.argv[1]))['seconds']))" "$plan")

inner="$dir/nested-inner.sh"
cat > "$inner" <<INNER
unset DISPLAY
export GDK_BACKEND=wayland
bash "$root/scripts/selftest.sh" "$plan" > "$dir/nested-inner.log" 2>&1
INNER

# WSL's route to the real graphics card, as selftest.sh sets it (GOTCHAS).
[ -d /usr/lib/wsl/lib ] && export GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}"

if [ "$desktop" = kwin ]; then
  dbus-run-session -- kwin_wayland --x11-display "$DISPLAY" --width 1600 --height 900 \
    --socket "$socket" --exit-with-session "bash $inner" > "$dir/compositor.log" 2>&1 &
else
  dbus-run-session -- bash -c "
    gnome-shell --nested --wayland --no-x11 --unsafe-mode --wayland-display $socket \
      > '$dir/compositor.log' 2>&1 &
    sleep 6
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
      --method org.gnome.Shell.Eval 'Main.overview.hide()' > /dev/null
    WAYLAND_DISPLAY=$socket bash '$inner'
    kill %1" >> "$dir/compositor.log" 2>&1 &
fi
session=$!
started=$(date +%s)

window() {
  local pid
  pid=$(pgrep -n -x kwin_wayland || pgrep -n -x gnome-shell) || return 1
  xdotool search --onlyvisible --pid "$pid" 2>/dev/null | head -1
}
photo() {
  local wid
  wid=$(window) && xwd -id "$wid" -silent 2>/dev/null | convert xwd:- -resize 50% "$dir/$1.png" 2>/dev/null
}

# One timeline of photos and key presses, in order.
events=$( { for s in ${shots//,/ }; do echo "$s shot"; done
            for k in $keys; do echo "${k%%:*} key ${k#*:}"; done; } | sort -n)
while read -r at kind what; do
  [ -z "$at" ] && continue
  now=$(( $(date +%s) - started ))
  [ "$at" -gt "$now" ] && sleep $(( at - now ))
  if [ "$kind" = shot ]; then
    photo "at-${at}s"
  else
    wid=$(window) && xdotool key --window "$wid" "$what"
    echo "$(( $(date +%s) - started ))s sent $what" >> "$dir/keys.log"
    ( sleep 1; photo "after-${what}-${at}s" ) &
  fi
done <<< "$events"

# The plan ends the app, which ends the session; do not wait forever.
( sleep $(( seconds + 30 )); kill "$session" 2>/dev/null ) &
wait "$session" 2>/dev/null
tail -n 1 "$dir/nested-inner.log"

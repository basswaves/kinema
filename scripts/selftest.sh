#!/usr/bin/env bash
# Run the real app, on Linux, through a scripted session: the Linux twin of
# selftest.ps1, and the same plan format (see that file and src/selftest.ts).
#
#   scripts/selftest.sh <plan.json> [exe] [shots]
#
# The app works on a copy of the library in <plan folder>/data and never
# writes the real one. Unlike on Windows, the copy is not made for you when
# the real library lives on another system: put a library.db (and, for
# pictures, its artwork folder) in <plan folder>/data first. A copy of a
# Windows library works — its artwork paths are rewritten at start.
#
# exe defaults to src-tauri/target/release/kinema, which needs
# libmpv-wrapper.so beside it or in lib/ beside it (built from its source:
# CONTRIBUTING, "Checking Linux from Windows").
#
# shots is a comma-separated list of seconds (default 6,14,24). Pictures are
# taken of Kinema's own window only — never the screen — and only when it is
# an X11 window (GDK_BACKEND=x11), because Wayland lets no program read
# another's window. They need xdotool, xwd and ImageMagick's convert.
set -euo pipefail

plan="$(realpath "$1")"
root="$(cd "$(dirname "$0")/.." && pwd)"
exe="${2:-$root/src-tauri/target/release/kinema}"
shots="${3:-6,14,24}"
dir="$(dirname "$plan")"

if [ ! -e "$(dirname "$exe")/libmpv-wrapper.so" ] && [ ! -e "$(dirname "$exe")/lib/libmpv-wrapper.so" ]; then
  echo "No libmpv-wrapper.so beside $exe or in lib/ beside it; the player will not start." >&2
fi
[ -f "$dir/data/library.db" ] || echo "No $dir/data/library.db: the app will start with an empty library." >&2

export KINEMA_SELFTEST="$plan"
"$exe" > "$dir/stdout.log" 2>&1 &
pid=$!

if [ "${GDK_BACKEND:-}" = x11 ] && command -v xdotool > /dev/null; then
  last=0
  for t in ${shots//,/ }; do
    sleep $(( t - last )); last=$t
    kill -0 "$pid" 2> /dev/null || break
    # Tauri's window and some that are never shown share the title; only a
    # mapped one can be read, and the others fail quietly.
    for wid in $(xdotool search --pid "$pid" --name '^Kinema' 2> /dev/null); do
      xwd -id "$wid" -silent 2> /dev/null | convert xwd:- "$dir/shot-${t}s.png" 2> /dev/null && break
    done
  done
fi

status=0
wait "$pid" || status=$?
echo "Report: $dir/report.json (exit $status)"
exit "$status"

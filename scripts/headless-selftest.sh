#!/usr/bin/env bash
# Run a self-test plan inside a headless Sway: a real Wayland desktop with no
# window on any screen, so nothing the person at the computer does — typing,
# moving the mouse — can reach it, and it shows them nothing.
#
#   scripts/headless-selftest.sh <plan.json> [shots]
#
#   shots  comma-separated seconds for photos of the desktop (default 8,16),
#          written beside the plan as shot-<s>s.png, half size.
#
# Input comes from the plan itself. Keys: its `key` actions. The mouse: `mpv`
# actions with mpv's own input commands — `mouse X Y` moves it over mpv's
# window, `keydown MBTN_LEFT` / `keyup MBTN_LEFT` press and release, `keypress
# WHEEL_DOWN` turns the wheel — which reach Kinema's page the way a real mouse
# on mpv's window does (src/player/pageMouse.ts). The screen is 1600×900,
# or KINEMA_HEADLESS_SIZE (e.g. 3840x2160).
#
# Everything else is scripts/selftest.sh's: the plan's data/ folder is the
# library copy, and report.json lands beside the plan.
#
# Needs: sway, grim.
set -u

plan="$(realpath "$1")"
shots="${2:-8,16}"
dir="$(dirname "$plan")"
root="$(cd "$(dirname "$0")/.." && pwd)"
seconds=$(python3 -c "import json,sys; print(int(json.load(open(sys.argv[1]))['seconds']))" "$plan")

cat > "$dir/headless-photos.sh" <<PHOTOS
started=\$(date +%s)
for t in ${shots//,/ }; do
  while [ \$(( \$(date +%s) - started )) -lt "\$t" ]; do sleep 0.2; done
  grim -s 0.5 "$dir/shot-\${t}s.png"
done
PHOTOS
cat > "$dir/headless-sway.conf" <<SWAY
output HEADLESS-1 resolution ${KINEMA_HEADLESS_SIZE:-1600x900}
exec "bash $dir/headless-photos.sh"
exec "GDK_BACKEND=wayland bash $root/scripts/selftest.sh $plan > $dir/headless-inner.log 2>&1; swaymsg exit"
SWAY

# WSL's route to the real graphics card, as selftest.sh sets it (GOTCHAS).
[ -d /usr/lib/wsl/lib ] && export GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}"
unset DISPLAY WAYLAND_DISPLAY
XDG_CURRENT_DESKTOP=sway WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  timeout $(( seconds + 60 )) dbus-run-session -- sway --unsupported-gpu -c "$dir/headless-sway.conf" \
  > "$dir/compositor.log" 2>&1
tail -n 1 "$dir/headless-inner.log"

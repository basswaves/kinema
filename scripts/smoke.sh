#!/usr/bin/env bash
# The real app plays a real file, with nobody watching: a 10-second clip made
# here (ffmpeg's test pattern and a tone), played by the built exe through
# libmpv in a headless Sway (scripts/headless-selftest.sh), and the self-test
# report checked — the player reached the clip's end part, mpv read the
# streams, nothing failed. Run on every push by CI (ci.yml, the Linux x86
# build job), and by hand on Linux or WSL:
#
#   scripts/smoke.sh [exe]      default $KINEMA_EXE, else the release build
#
# Prints one line: PASS or FAIL and why. Exit 0 only on PASS. Everything it
# made — the clip, the report, a photo at 6 s, the logs — stays in the folder
# it names, for reading after a failure.
#
# Needs: sway, grim, dbus, ffmpeg, libmpv, python3, and the plugin's wrapper
# (scripts/build-mpv-wrapper.sh) beside the exe or in src-tauri/lib/.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
exe="${1:-${KINEMA_EXE:-$root/src-tauri/target/release/kinema}}"
[ -x "$exe" ] || { echo "FAIL no exe at $exe"; exit 1; }
# selftest.sh looks for the wrapper beside the exe.
[ -e "$(dirname "$exe")/libmpv-wrapper.so" ] || cp "$root/src-tauri/lib/libmpv-wrapper.so" "$(dirname "$exe")/" 2>/dev/null \
  || { echo "FAIL no libmpv-wrapper.so (scripts/build-mpv-wrapper.sh)"; exit 1; }

dir="$(mktemp -d "${TMPDIR:-/tmp}/kinema-smoke.XXXXXX")"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440 \
  -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$dir/clip.mp4" \
  || { echo "FAIL ffmpeg could not make the clip"; exit 1; }
cat > "$dir/plan.json" <<PLAN
{"path":"$dir/clip.mp4","fileId":null,"titleId":null,"seconds":9,"openAfter":2,
 "mpv":{"vo":"gpu-next,null"},
 "probe":["video-codec","width","height","current-vo"]}
PLAN

# No GPU on CI or in a container: mpv's renderer refuses a software one, and
# that cannot be allowed once mpv runs. So the video output may fall back to
# none (`vo=gpu-next,null`), set before the file opens (openAfter). This
# proves the app, libmpv, the decoders and the player's clock, not the GPU
# path, which needs real hardware (the MCP and self-tests on the owner's
# machines). The run ends at 9 s, mid-clip, so the report reads a playing
# file: about 6.5 s in.

# A runtime folder of its own: Sway refuses to start without one (CI has none).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$dir/xdg}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
KINEMA_EXE="$exe" bash "$root/scripts/headless-selftest.sh" "$dir/plan.json" 6 > "$dir/headless.log" 2>&1

python3 - "$dir" <<'CHECK'
import json, sys
d = sys.argv[1]
try:
    r = json.load(open(f"{d}/report.json"))
except Exception as e:
    print(f"FAIL no report ({e}); see {d}/stdout.log and {d}/data/logs/app.log"); sys.exit(1)
kinds = [e["kind"] for e in r.get("timeline", [])]
bad = [k for k in kinds if k in ("mpv:failed", "play:unavailable", "call:failed")]
pos = (r.get("final") or {}).get("timePos")
p = r.get("probed") or {}
why = []
if bad: why.append(f"timeline has {bad}")
if not isinstance(pos, (int, float)) or pos < 4: why.append(f"time-pos {pos} (expected about 6.5 s into the 10 s clip)")
if not p.get("video-codec"): why.append("mpv read no video codec")
# No sound device on CI: the audio track must be found, not played.
tracks = r.get("tracks") if isinstance(r.get("tracks"), list) else []
audio = [t.get("codec") for t in tracks if t.get("type") == "audio"]
if not audio: why.append(f"no audio track listed ({tracks})")
if why:
    print(f"FAIL {'; '.join(why)} ({d})"); sys.exit(1)
print(f"PASS played to {pos:.1f} s, {p.get('width')}x{p.get('height')} {p.get('video-codec')}, audio {audio[0]}, vo {p.get('current-vo')} ({d})")
CHECK

#!/usr/bin/env bash
# Build the Linux test stick's kit and Ventoy persistence file.
#
#   bash scripts/linux-usb-test/build-kit.sh [out-dir]
#
# Run on Linux (Ubuntu 24.04 in WSL is fine) after scripts/package-linux.sh,
# from a checkout. Produces in out-dir (default ~/kinema-usb):
#   persistence.dat   8 GB ext4, label casper-rw, the kit inside at
#                     /opt/kinema-kit — what Ubuntu's live system sees
#   ventoy.json       the Ventoy setting that pairs it with the Ubuntu ISO
# Copy both to a Ventoy stick: persistence.dat into kinema-linux-test/ on
# the stick, ventoy.json into ventoy/ (merging with one already there).
# See README.md.
#
# Needs: ffmpeg with libx265 (for the test media), e2fsprogs, sudo (the image
# is built as root so the kit's files are root's, as anything under /opt).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:-$HOME/kinema-usb}"
kit="$out/kit"
mkdir -p "$kit/tools" "$out"

deb=$(ls "$root"/dist-linux/kinema_*_amd64.deb 2> /dev/null | head -1)
[ -n "$deb" ] || { echo "no .deb in dist-linux/: run scripts/package-linux.sh first" >&2; exit 1; }

cp "$here/run.sh" "$kit/run.sh"
cp "$here/display.py" "$kit/tools/display.py"
cp "$root/scripts/selftest.sh" "$kit/tools/selftest.sh"
cp "$deb" "$kit/"
[ -d "$kit/media" ] || KIT_MEDIA="$kit/media" bash "$here/make-clips.sh"

sudo bash "$here/make-persistence.sh" "$kit" "$out/persistence.dat"

cat > "$out/ventoy.json" <<'JSON'
{
  "persistence": [
    {
      "image": "/ubuntu-26.04*.iso",
      "backend": "/kinema-linux-test/persistence.dat",
      "autosel": 1,
      "timeout": 5
    }
  ]
}
JSON
echo "built $out/persistence.dat and $out/ventoy.json"

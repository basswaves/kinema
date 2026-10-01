#!/usr/bin/env bash
# Build the Linux test stick's kit and a Ventoy persistence file for it.
#
#   bash scripts/linux-usb-test/build-kit.sh [ubuntu|kubuntu] [out-dir]
#
# Run on Linux (Ubuntu 24.04 in WSL is fine) after scripts/package-linux.sh,
# from a checkout. The kit is the same for every flavour (run.sh tells GNOME
# and KDE Plasma apart itself); each flavour's live system needs a
# persistence file of its own, since what one installs is not the other's
# system. Produces in out-dir (default ~/kinema-usb):
#   persistence.dat           (ubuntu) or persistence-kubuntu.dat (kubuntu):
#                             8 GB ext4, label casper-rw, the kit inside at
#                             /opt/kinema-kit — what the live system sees
#   ventoy.json               the Ventoy setting pairing each ISO with its file
# Copy them to a Ventoy stick: the persistence file into kinema-linux-test/
# on the stick, ventoy.json into ventoy/ (merging with one already there).
# See README.md.
#
# Needs: ffmpeg with libx265 (for the test media), e2fsprogs, sudo (the image
# is built as root so the kit's files are root's, as anything under /opt).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
flavour="${1:-ubuntu}"
out="${2:-$HOME/kinema-usb}"
case "$flavour" in
  ubuntu) image=persistence.dat ;;
  kubuntu) image=persistence-kubuntu.dat ;;
  *) echo "flavour is ubuntu or kubuntu, not '$flavour'" >&2; exit 2 ;;
esac
kit="$out/kit"
mkdir -p "$kit/tools" "$out"

deb=$(ls "$root"/dist-linux/kinema_*_amd64.deb 2> /dev/null | head -1)
[ -n "$deb" ] || { echo "no .deb in dist-linux/: run scripts/package-linux.sh first" >&2; exit 1; }

rm -f "$kit"/kinema_*_amd64.deb
cp "$here/run.sh" "$kit/run.sh"
cp "$here/display.py" "$kit/tools/display.py"
cp "$root/scripts/selftest.sh" "$kit/tools/selftest.sh"
cp "$deb" "$kit/"
[ -d "$kit/media" ] || KIT_MEDIA="$kit/media" bash "$here/make-clips.sh"

sudo bash "$here/make-persistence.sh" "$kit" "$out/$image"

cat > "$out/ventoy.json" <<'JSON'
{
  "persistence": [
    {
      "image": "/ubuntu-26.04*.iso",
      "backend": "/kinema-linux-test/persistence.dat",
      "autosel": 1,
      "timeout": 5
    },
    {
      "image": "/kubuntu-26.04*.iso",
      "backend": "/kinema-linux-test/persistence-kubuntu.dat",
      "autosel": 1,
      "timeout": 5
    }
  ]
}
JSON
echo "built $out/$image and $out/ventoy.json"

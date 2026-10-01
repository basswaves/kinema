#!/usr/bin/env bash
# Build Kinema for Linux and package it three ways, into dist-linux/:
#   kinema_<version>_<arch>.deb       Debian, Ubuntu and their relatives
#   kinema-<version>-1.<arch>.rpm     Fedora and its relatives
#   kinema-<version>-linux-<arch>.tar.gz
#                                     a folder to unpack and run, like the
#                                     Windows ZIP, for every other distribution
# with a .sha256 beside each.
#
# The packages declare mpv (libmpv2 / mpv-libs) and WebKitGTK as
# dependencies, so the system's package manager installs them; the folder
# needs them installed by hand (its README says how). Kinema uses the
# system's mpv — no media libraries of its own to keep patched.
#
# Run on the oldest system the packages should install on (Ubuntu 24.04 in
# CI), on the processor type they are for. Same environment variables as
# the Windows build for the built-in keys (see .github/workflows/release.yml).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
case "$(uname -m)" in
  x86_64) deb_arch=amd64; rpm_arch=x86_64 ;;
  aarch64) deb_arch=arm64; rpm_arch=aarch64 ;;
  *) echo "unknown processor: $(uname -m)" >&2; exit 1 ;;
esac

bash scripts/build-mpv-wrapper.sh
npm run tauri build -- --bundles deb,rpm

out="$root/dist-linux"
rm -rf "$out"; mkdir -p "$out"
bundle="$root/src-tauri/target/release/bundle"
cp "$bundle"/deb/*.deb "$out/kinema_${version}_${deb_arch}.deb"
cp "$bundle"/rpm/*.rpm "$out/kinema-${version}-1.${rpm_arch}.rpm"

# The folder: the program, the wrapper in lib/ beside it (where the plugin
# looks first), and what a person needs to read.
folder="kinema-${version}-linux-${rpm_arch}"
stage="$(mktemp -d)/$folder"
mkdir -p "$stage/lib"
cp src-tauri/target/release/kinema "$stage/kinema"
cp src-tauri/lib/libmpv-wrapper.so "$stage/lib/"
cp LICENSE NOTICE.md "$stage/"
cat > "$stage/README.txt" <<'TXT'
Kinema for Linux — a folder to unpack and run.

It uses your system's mpv and WebKitGTK. Install them once:

  Ubuntu 24.04 or later, Debian 13:  sudo apt install libmpv2 libwebkit2gtk-4.1-0
  Fedora:                            sudo dnf install mpv-libs webkit2gtk4.1
  Arch:                              sudo pacman -S mpv webkit2gtk-4.1

then start it with ./kinema. ffmpeg is optional, as on Windows: with it,
Kinema finds intros and credits itself and shows each file's picture and
sound details.

HDR on Wayland needs mpv 0.40 or later (Ubuntu 26.04, Debian 13, Fedora 43
and Arch have it).
TXT
tar -C "$(dirname "$stage")" -czf "$out/$folder.tar.gz" "$folder"

cd "$out"
for f in *.deb *.rpm *.tar.gz; do sha256sum "$f" > "$f.sha256"; done
ls -la "$out"

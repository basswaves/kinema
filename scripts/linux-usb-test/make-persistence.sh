#!/usr/bin/env bash
# Build Ventoy's persistence file for Ubuntu with the Kinema kit already inside.
# Ubuntu's live system (casper) mounts a file labelled casper-rw and layers its
# upper/ directory over the root filesystem, so upper/opt/kinema-kit appears
# as /opt/kinema-kit in the live session. Run as root (file ownership).
set -eu
kit="$1"          # ~/kinema-kit of the build user
out="$2"          # where persistence.dat goes
stage="$(mktemp -d)"
mkdir -p "$stage/upper/opt" "$stage/work"
cp -r "$kit" "$stage/upper/opt/kinema-kit"
rm -rf "$stage/upper/opt/kinema-kit/results"
chown -R root:root "$stage"
chmod -R a+rX "$stage/upper/opt/kinema-kit"
chmod 755 "$stage/upper/opt/kinema-kit/run.sh" "$stage/upper/opt/kinema-kit/tools/selftest.sh"
rm -f "$out"
truncate -s 8G "$out"
mkfs.ext4 -q -F -L casper-rw -d "$stage" "$out"
rm -rf "$stage"
e2label "$out"
debugfs -R "ls -l /upper/opt/kinema-kit" "$out" 2>/dev/null
du -h --apparent-size "$out"

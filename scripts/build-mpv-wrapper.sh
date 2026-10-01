#!/usr/bin/env bash
# Build the libmpv plugin's wrapper for Linux from its source, and put it
# where the Linux packages and the folder download take it from:
# src-tauri/lib/libmpv-wrapper.so.
#
# From source, not downloaded: Kinema ships no third-party binary it did not
# build (CONTRIBUTING, settled decisions). Pinned to a commit, not a tag —
# v0.1.1 of github.com/nini22P/libmpv-wrapper — so the same source is built
# every time. It links only libc and loads libmpv itself, from the system.
#
# Known flaw in this version: it reads a client message's arguments past their
# end, so nothing in Kinema may cause one (docs/GOTCHAS.md).
set -euo pipefail

REPO=https://github.com/nini22P/libmpv-wrapper.git
COMMIT=7b986564c051c6188ed187787481f6bc99ae8b5a   # v0.1.1

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${WRAPPER_BUILD_DIR:-$root/src-tauri/target/libmpv-wrapper-src}"

if [ ! -d "$work/.git" ]; then
  git clone --quiet "$REPO" "$work"
fi
git -C "$work" fetch --quiet origin "$COMMIT" 2>/dev/null || true
git -C "$work" -c advice.detachedHead=false checkout --quiet "$COMMIT"

cargo build --release --manifest-path "$work/Cargo.toml"

mkdir -p "$root/src-tauri/lib"
cp "$work/target/release/libmpv_wrapper.so" "$root/src-tauri/lib/libmpv-wrapper.so"
echo "built $root/src-tauri/lib/libmpv-wrapper.so from $COMMIT"

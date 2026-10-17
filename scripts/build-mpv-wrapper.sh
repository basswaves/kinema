#!/usr/bin/env bash
# Build the libmpv plugin's wrapper from its source, and put it where the
# builds take it from: src-tauri/lib/libmpv-wrapper.so on Linux, and on
# Windows (Git Bash) src-tauri/lib/libmpv-wrapper.dll, over the one
# `npx tauri-plugin-libmpv-api setup-lib` fetched.
#
# Windows: with Microsoft's C runtime built in (crt-static). The plugin's own
# DLL needs VCRUNTIME140.dll, which a fresh Windows may not have; without it
# the player cannot start at all ("Failed to load libmpv-wrapper", error 126),
# as a clean Windows Sandbox showed (2026-10-17). kinema.exe has its runtime
# built in already (Tauri does that).
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
# A fresh clone every time, in a folder of its own. Kept inside target/ it
# was half restored by CI's build cache — a .git without its objects — and
# the next release failed with "unable to read tree".
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet "$REPO" "$work"
git -C "$work" -c advice.detachedHead=false checkout --quiet "$COMMIT"

mkdir -p "$root/src-tauri/lib"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --manifest-path "$work/Cargo.toml"
    cp "$work/target/release/mpv_wrapper.dll" "$root/src-tauri/lib/libmpv-wrapper.dll"
    echo "built $root/src-tauri/lib/libmpv-wrapper.dll from $COMMIT"
    ;;
  *)
    cargo build --release --manifest-path "$work/Cargo.toml"
    cp "$work/target/release/libmpv_wrapper.so" "$root/src-tauri/lib/libmpv-wrapper.so"
    echo "built $root/src-tauri/lib/libmpv-wrapper.so from $COMMIT"
    ;;
esac

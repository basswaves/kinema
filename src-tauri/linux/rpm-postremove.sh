#!/bin/sh
# Run by rpm after the package's files are removed. The package puts its
# wrapper library in /usr/lib/kinema but does not own the folder itself, so
# it stayed behind empty. rmdir only removes an empty folder: on an upgrade the
# new version's files are already there and it does nothing.
rmdir /usr/lib/kinema 2>/dev/null || true
exit 0

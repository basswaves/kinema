#!/bin/sh
# Run by rpm after the package's files are removed. The package puts its
# wrapper library in /usr/lib/kinema and its licence and notice in
# /usr/share/doc/kinema but does not own either folder itself, so they stayed
# behind empty. rmdir only removes an empty folder: on an upgrade the new
# version's files are already there and it does nothing.
rmdir /usr/lib/kinema 2>/dev/null || true
rmdir /usr/share/doc/kinema 2>/dev/null || true
exit 0

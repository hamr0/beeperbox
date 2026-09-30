#!/usr/bin/env bash
# pinned-beeper-version.sh <file>
#
# Reads the pinned Beeper Desktop version from <file> (normally
# beeper-version.txt), validates it is strictly X.Y.Z, confirms the x86_64 and
# arm64 artifacts for that version both exist (HTTP 200), and prints the version
# on stdout, nothing else. Exits non-zero with a message on stderr if the file is
# missing/unreadable, malformed, or either artifact is not published.
#
# The pin is the single source of the Beeper version for everything that ships
# or is tested as shipping (releases, :edge, the PR gate). See
# resolve-beeper-version.sh for the separate "newest stable" lookup behind :next.
#
# Needs curl.
set -euo pipefail

# shellcheck source=scripts/beeper-artifacts-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/beeper-artifacts-lib.sh"

file="${1:-}"
if [ -z "$file" ]; then
  echo "pinned-beeper-version: usage: pinned-beeper-version.sh <file>" >&2
  exit 2
fi
if [ ! -f "$file" ]; then
  echo "pinned-beeper-version: $file not found" >&2
  exit 1
fi

version="$(<"$file")"   # command substitution strips trailing newlines
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "pinned-beeper-version: $file must contain exactly X.Y.Z (got: '$version')" >&2
  exit 1
fi

beeper_check_artifacts "$version" pinned-beeper-version || exit 1

echo "$version"

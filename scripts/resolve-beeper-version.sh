#!/usr/bin/env bash
# resolve-beeper-version.sh
#
# Prints the current Beeper Desktop "stable" version (X.Y.Z) on stdout, nothing
# else. Exits non-zero, with a message on stderr, if it cannot be resolved.
#
# Why: the Dockerfile's default download URL never changes, so the build cache
# (cache-from: type=gha) kept reusing an old downloaded layer and the weekly
# rebuild shipped a stale Beeper; verify and publish could even build different
# versions. CI resolves the version ONCE per run with this script and passes it
# as --build-arg BEEPER_VERSION, so every job builds the same Beeper and a new
# Beeper busts the cache layer.
#
# Method: follow the x64 stable redirect to the versioned AppImage URL, extract
# the version, then confirm the pinned x86_64 and arm64 artifacts for that SAME
# version both exist (HTTP 200) so a half-published release can't be pinned.
#
# Used by beeper-next.yml (finds the newest stable to offer as :next). Releases,
# :edge and PRs use the pinned beeper-version.txt instead (pinned-beeper-version.sh).
# The artifact check is shared via beeper-artifacts-lib.sh. Needs curl.
set -euo pipefail

# shellcheck source=scripts/beeper-artifacts-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/beeper-artifacts-lib.sh"

STABLE_URL="https://api.beeper.com/desktop/download/linux/x64/stable/com.automattic.beeper.desktop"

final=$(curl -sIL --retry 3 -o /dev/null -w '%{url_effective}' "$STABLE_URL") \
  || { echo "resolve-beeper-version: could not fetch $STABLE_URL" >&2; exit 1; }

if [[ "$final" =~ Beeper-([0-9]+\.[0-9]+\.[0-9]+)-x86_64\.AppImage$ ]]; then
  version="${BASH_REMATCH[1]}"
else
  echo "resolve-beeper-version: stable URL did not redirect to a versioned x86_64 AppImage (got: $final)" >&2
  exit 1
fi

beeper_check_artifacts "$version" resolve-beeper-version || exit 1

echo "$version"

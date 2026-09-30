#!/usr/bin/env bash
# beeper-artifacts-lib.sh — sourced by resolve-beeper-version.sh and
# pinned-beeper-version.sh (not executable on its own).
#
# beeper_check_artifacts <version> <caller-name>
#   Confirms the x86_64 and arm64 AppImages for <version> both exist (HTTP 200),
#   so a half-published release can never be pinned. On failure prints
#   "<caller-name>: <url> returned HTTP <code> (expected 200)" to stderr and
#   returns 1. Needs curl.

BEEPER_BUILDS_URL="https://beeper-desktop.download.beeper.com/builds"

beeper_check_artifacts() {
  local version="$1" who="$2" arch url code
  for arch in x86_64 arm64; do
    url="$BEEPER_BUILDS_URL/Beeper-${version}-${arch}.AppImage"
    code=$(curl -sIL --retry 3 -o /dev/null -w '%{http_code}' "$url") || code=000
    if [ "$code" != "200" ]; then
      echo "$who: $url returned HTTP $code (expected 200)" >&2
      return 1
    fi
  done
}

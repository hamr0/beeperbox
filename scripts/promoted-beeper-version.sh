#!/usr/bin/env bash
# promoted-beeper-version.sh [owner/image]
#
# Prints the newest Beeper Desktop version that has passed the gates: the
# highest X.Y.Z among the GHCR tags named next-beeper-X.Y.Z (beeper-next.yml
# publishes that tag only after both gates pass). Prints nothing and exits 0 if
# there are no such tags. Exits non-zero with a message on stderr on any
# network or parse failure (never prints nothing on a failure). The version is
# then validated with beeper_check_artifacts, like pinned-beeper-version.sh.
#
# owner/image comes from the first argument, else $BEEPERBOX_IMAGE, else
# hamr0/beeperbox. $PROMOTED_TAGS_JSON (a saved tags/list response) replaces the
# network lookup; it exists for tests.
#
# Needs curl and python3.
set -euo pipefail

# shellcheck source=scripts/beeper-artifacts-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/beeper-artifacts-lib.sh"

repo="${1:-${BEEPERBOX_IMAGE:-hamr0/beeperbox}}"
if [[ ! "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$ ]]; then
  echo "promoted-beeper-version: bad image '$repo' (expected owner/image)" >&2
  exit 2
fi

if [ -n "${PROMOTED_TAGS_JSON:-}" ]; then
  tags_json="$PROMOTED_TAGS_JSON"
else
  token_json="$(curl -sfL --retry 3 "https://ghcr.io/token?scope=repository:${repo}:pull")" || {
    echo "promoted-beeper-version: could not get a GHCR token for $repo" >&2
    exit 1
  }
  token="$(printf '%s' "$token_json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)" || {
    echo "promoted-beeper-version: GHCR token response not parseable for $repo" >&2
    exit 1
  }
  tags_json="$(curl -sfL --retry 3 -H "Authorization: Bearer $token" "https://ghcr.io/v2/${repo}/tags/list?n=1000")" || {
    echo "promoted-beeper-version: could not list GHCR tags for $repo" >&2
    exit 1
  }
fi

tags="$(printf '%s' "$tags_json" | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin)["tags"] or []))' 2>/dev/null)" || {
  echo "promoted-beeper-version: GHCR tag list not parseable for $repo" >&2
  exit 1
}

version="$(printf '%s\n' "$tags" | { grep -E '^next-beeper-[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
  | sed 's/^next-beeper-//' | sort -V | tail -n1)"

if [ -z "$version" ]; then
  exit 0
fi

beeper_check_artifacts "$version" promoted-beeper-version || exit 1

echo "$version"

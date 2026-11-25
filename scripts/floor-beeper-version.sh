#!/usr/bin/env bash
# floor-beeper-version.sh <owner/image> <pinfile>
#
# Prints the floor Beeper Desktop version: the io.beeperbox.beeper-version label
# of the GHCR :previous image (the last Beeper that passed the gates before
# :latest). Falls back to `pinned-beeper-version.sh <pinfile>` (beeper-version.txt)
# when :previous can't be read, is unlabelled, or carries a version that fails
# the artifact check. A network or parse failure also falls back, never fails.
# Logs which source won on stderr. Exits non-zero only when the final result is
# empty (the pin file itself unreadable or invalid).
#
# Lookup is anonymous: GHCR token, :previous manifest (an index is narrowed to
# linux/amd64), config blob, Labels. Needs curl and python3.
set -euo pipefail

# shellcheck source=scripts/beeper-artifacts-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/beeper-artifacts-lib.sh"

repo="${1:-}"
pinfile="${2:-}"
if [ -z "$repo" ] || [ -z "$pinfile" ]; then
  echo "floor-beeper-version: usage: floor-beeper-version.sh <owner/image> <pinfile>" >&2
  exit 2
fi
if [[ ! "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$ ]]; then
  echo "floor-beeper-version: bad image '$repo' (expected owner/image)" >&2
  exit 2
fi

TAG=previous
LABEL=io.beeperbox.beeper-version
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

# Prints the label's value (possibly empty) or returns non-zero with a reason on stderr.
read_label() {
  local token_json token manifest digest cfg
  token_json="$(curl -sfL --retry 3 "https://ghcr.io/token?scope=repository:${repo}:pull")" \
    || { echo "no GHCR token" >&2; return 1; }
  token="$(printf '%s' "$token_json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)" \
    || { echo "GHCR token unparseable" >&2; return 1; }
  manifest="$(curl -sfL --retry 3 -H "Authorization: Bearer $token" -H "Accept: $ACCEPT" \
    "https://ghcr.io/v2/${repo}/manifests/${TAG}")" || { echo ":$TAG manifest not readable" >&2; return 1; }
  # Index -> linux/amd64 child manifest digest; plain manifest -> no child.
  digest="$(printf '%s' "$manifest" | python3 -c '
import sys,json
m=json.load(sys.stdin)
if "manifests" in m:
    for c in m["manifests"]:
        p=c.get("platform") or {}
        if p.get("os")=="linux" and p.get("architecture")=="amd64":
            print(c["digest"]); break
    else:
        sys.exit(1)
' 2>/dev/null)" || { echo ":$TAG manifest unparseable or has no linux/amd64" >&2; return 1; }
  if [ -n "$digest" ]; then
    manifest="$(curl -sfL --retry 3 -H "Authorization: Bearer $token" -H "Accept: $ACCEPT" \
      "https://ghcr.io/v2/${repo}/manifests/${digest}")" || { echo "amd64 manifest not readable" >&2; return 1; }
  fi
  cfg="$(printf '%s' "$manifest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["config"]["digest"])' 2>/dev/null)" \
    || { echo "manifest has no config digest" >&2; return 1; }
  curl -sfL --retry 3 -H "Authorization: Bearer $token" "https://ghcr.io/v2/${repo}/blobs/${cfg}" \
    | python3 -c '
import sys,json
c=json.load(sys.stdin)
print((c.get("config") or {}).get("Labels",{}).get("'"$LABEL"'","") if (c.get("config") or {}).get("Labels") else "")
' 2>/dev/null || { echo "config blob not readable" >&2; return 1; }
}

label=""
if label="$(read_label 2>"${TMPDIR:-/tmp}/floor-err.$$")"; then
  reason="unlabelled (no $LABEL)"
else
  reason="$(cat "${TMPDIR:-/tmp}/floor-err.$$")"
  label=""
fi
rm -f "${TMPDIR:-/tmp}/floor-err.$$"

if [ -n "$label" ]; then
  if [[ "$label" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && beeper_check_artifacts "$label" floor-beeper-version; then
    echo "floor-beeper-version: floor $label from :$TAG label ($repo)" >&2
    echo "$label"
    exit 0
  fi
  reason="label '$label' invalid or artifacts missing"
fi

echo "floor-beeper-version: :$TAG of $repo unusable ($reason); falling back to $pinfile" >&2
version="$(bash "$(dirname "${BASH_SOURCE[0]}")/pinned-beeper-version.sh" "$pinfile")"
if [ -z "$version" ]; then
  echo "floor-beeper-version: floor resolved empty" >&2
  exit 1
fi
echo "floor-beeper-version: floor $version from $pinfile" >&2
echo "$version"

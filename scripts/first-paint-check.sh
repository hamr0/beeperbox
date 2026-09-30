#!/usr/bin/env bash
# first-paint-check.sh <image_ref>
#
# Boots the full container from <image_ref> on a FRESH profile and asserts
# Beeper actually draws its first window — i.e. the one-time noVNC login is
# possible. Exits non-zero if the screen is still blank after the timeout.
#
# Why this exists: the API (:23373) comes up even when the renderer never
# paints, so the HEALTHCHECK and the MCP guard matrix both pass on an image
# nobody can log in to. That shipped once (Beeper 4.3.123 stalled on the
# default GL path under Xvfb — issue #27); this is the gate that catches it.
#
# Black-box on purpose: it reads the framebuffer over VNC from the host, so it
# needs nothing inside the image and keeps working against older release tags.
# An unpainted screen is 1 colour; the login screen is thousands.
#
# Single source of truth for the first-paint gate: used by mcp-test.yml
# (PR/dispatch) AND release.yml's publish gate. Needs docker, python3, and
# vnc-paint-probe.py alongside this script.
set -u

IMAGE="${1:?usage: first-paint-check.sh <image_ref>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=first-paint-check
PORT=${FIRST_PAINT_VNC_PORT:-25900}
TIMEOUT=${FIRST_PAINT_TIMEOUT:-120}      # seconds to wait for a painted screen
MIN_COLOURS=${FIRST_PAINT_MIN_COLOURS:-64}

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# No volume: a fresh profile is the case that matters (first-run login).
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5900" "$IMAGE" >/dev/null \
  || { echo "FAIL: container did not start"; exit 1; }

colours=0
deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! docker ps -q --filter "name=^${NAME}$" | grep -q .; then
    echo "FAIL: container exited before painting"; docker logs "$NAME" 2>&1 | tail -40; exit 1
  fi
  colours=$(python3 "$HERE/vnc-paint-probe.py" 127.0.0.1 "$PORT" 2>/dev/null) || colours=0
  [ "$colours" -ge "$MIN_COLOURS" ] && break
  sleep 3
done

if [ "$colours" -ge "$MIN_COLOURS" ]; then
  echo "PASS: beeper painted its first window ($colours colours on screen, waited ${SECONDS}s)"
  echo "=== FIRST PAINT CHECK PASSED ==="
  exit 0
fi
echo "FAIL: screen still blank after ${TIMEOUT}s ($colours colours, need >= $MIN_COLOURS)"
docker logs "$NAME" 2>&1 | grep -v 'dbus/bus.cc' | tail -40
echo "=== FIRST PAINT CHECK FAILED ==="
exit 1

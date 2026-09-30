#!/usr/bin/env bash
# first-paint-check.sh <image_ref>
#
# Boots the full container from <image_ref> on a FRESH profile and asserts
# Beeper actually draws its first window — i.e. the one-time noVNC login is
# possible. Exits non-zero unless two consecutive samples show a painted screen
# before the timeout.
#
# Why this exists: the API (:23373) comes up even when the renderer never
# paints, so the HEALTHCHECK and the MCP guard matrix both pass on an image
# nobody can log in to. That shipped once (Beeper 4.3.123 stalled on the
# default GL path under Xvfb — issue #27); this is the gate that catches it.
#
# Black-box on purpose: it reads the framebuffer over VNC from the host, so it
# needs nothing inside the image and keeps working against older release tags.
# An unpainted screen is 1-2 colours, a mid-paint frame a few hundred, the
# settled login screen ~11,000. So a pass needs TWO CONSECUTIVE samples of at
# least FIRST_PAINT_MIN_COLOURS (default 1000); a sample below resets the streak.
#
# Single source of truth for the first-paint gate: used by mcp-test.yml
# (PR/dispatch) AND release.yml's publish gate. Needs docker, python3, and
# vnc-paint-probe.py alongside this script.
set -u

IMAGE="${1:?usage: first-paint-check.sh <image_ref>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=first-paint-check-$$   # unique per run so concurrent gates don't collide
TIMEOUT=${FIRST_PAINT_TIMEOUT:-120}      # seconds to wait for a painted screen
MIN_COLOURS=${FIRST_PAINT_MIN_COLOURS:-1000}

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# No volume: a fresh profile is the case that matters (first-run login).
# Docker picks a free loopback host port for the VNC socket; read it back.
docker run -d --name "$NAME" -p 127.0.0.1::5900 "$IMAGE" >/dev/null \
  || { echo "FAIL: container did not start"; exit 1; }
PORT=$(docker port "$NAME" 5900/tcp | head -1 | sed 's/.*://')
[ -n "$PORT" ] || { echo "FAIL: could not resolve the published VNC port"; exit 1; }

colours=0
streak=0
probe_err=""   # stderr of the LAST probe attempt, empty if it succeeded
deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! docker ps -q --filter "name=^${NAME}$" | grep -q .; then
    echo "FAIL: container exited before painting"; docker logs "$NAME" 2>&1 | tail -40; exit 1
  fi
  if out=$(python3 "$HERE/vnc-paint-probe.py" 127.0.0.1 "$PORT" 2>&1); then
    colours=$out; probe_err=""
  else
    colours=0; probe_err=$out
  fi
  if [ "$colours" -ge "$MIN_COLOURS" ]; then streak=$((streak + 1)); else streak=0; fi
  [ "$streak" -ge 2 ] && break
  sleep 3
done

if [ "$streak" -ge 2 ]; then
  echo "PASS: beeper painted its first window ($colours colours on screen, 2 consecutive samples, waited ${SECONDS}s)"
  echo "=== FIRST PAINT CHECK PASSED ==="
  exit 0
fi
if [ -n "$probe_err" ]; then
  echo "FAIL: probe could not read the screen after ${TIMEOUT}s: $probe_err"
else
  echo "FAIL: screen still blank after ${TIMEOUT}s (last sample $colours colours, need 2 consecutive >= $MIN_COLOURS)"
fi
docker logs "$NAME" 2>&1 | grep -v 'dbus/bus.cc' | tail -40
echo "=== FIRST PAINT CHECK FAILED ==="
exit 1

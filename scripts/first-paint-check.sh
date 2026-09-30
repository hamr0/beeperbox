#!/usr/bin/env bash
# first-paint-check.sh <image_ref>
#
# Boots the full container from <image_ref> ONCE on a FRESH profile and asserts,
# in order: (1) Beeper actually draws its first window — i.e. the one-time noVNC
# login is possible (two consecutive painted samples before the timeout); then
# (2) Beeper's API answers on the host through the socat forwarder (container
# :23380, published on a loopback port) with a non-empty app.version; and
# (3) the container's own HEALTHCHECK reports healthy. Exits non-zero otherwise.
#
# Stage 2/3 exist because the forwarder -> API path is what every MCP call
# uses, yet nothing else in CI exercised it from outside the container: a
# release with a broken forwarder or API would have passed the gate.
#
# Assumption: on a fresh, never-logged-in profile, current Beeper (4.3.x)
# starts its API without login (observed on 4.3.123). If a future Beeper stops
# doing that, stage 2 fails closed (publish is skipped) — that is the signal to
# revisit this gate, not a flaky test.
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
# Stages 2/3 share the same TIMEOUT budget as the paint wait (whatever remains,
# but at least API_MIN_WAIT, default 30s). The HEALTHCHECK runs every 30s, so
# health can lag the API by up to ~30s.
#
# Single source of truth for the first-paint gate: used by mcp-test.yml
# (PR/dispatch) AND release.yml's publish gate. Needs docker, curl, python3, and
# vnc-paint-probe.py alongside this script.
set -u

IMAGE="${1:?usage: first-paint-check.sh <image_ref>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=first-paint-check-$$   # unique per run so concurrent gates don't collide
TIMEOUT=${FIRST_PAINT_TIMEOUT:-120}      # seconds to wait for a painted screen
MIN_COLOURS=${FIRST_PAINT_MIN_COLOURS:-1000}
API_MIN_WAIT=${FIRST_PAINT_API_MIN_WAIT:-30}   # floor (s) for the API + health stage

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# No volume: a fresh profile is the case that matters (first-run login).
# Docker picks free loopback host ports for the VNC socket and the API
# forwarder; read them back.
docker run -d --name "$NAME" -p 127.0.0.1::5900 -p 127.0.0.1::23380 "$IMAGE" >/dev/null \
  || { echo "FAIL: container did not start"; exit 1; }
PORT=$(docker port "$NAME" 5900/tcp | head -1 | sed 's/.*://')
[ -n "$PORT" ] || { echo "FAIL: could not resolve the published VNC port"; exit 1; }
API_PORT=$(docker port "$NAME" 23380/tcp | head -1 | sed 's/.*://')
[ -n "$API_PORT" ] || { echo "FAIL: could not resolve the published API port"; exit 1; }

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

  # Stage 2/3: API reachable through the forwarder + HEALTHCHECK healthy.
  remaining=$((deadline - SECONDS))
  [ "$remaining" -lt "$API_MIN_WAIT" ] && remaining=$API_MIN_WAIT
  api_deadline=$((SECONDS + remaining))
  api_ver=""
  health=""
  while :; do
    if [ -z "$api_ver" ]; then
      api_ver=$(curl -sf --max-time 5 "http://127.0.0.1:${API_PORT}/v1/info" 2>/dev/null \
        | python3 -c 'import json,sys; v=json.load(sys.stdin)["app"]["version"]; print(v if isinstance(v,str) and v else "")' 2>/dev/null) || api_ver=""
    fi
    health=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || true)
    [ -n "$api_ver" ] && [ "$health" = "healthy" ] && break
    [ "$SECONDS" -ge "$api_deadline" ] && break
    sleep 3
  done
  if [ -n "$api_ver" ] && [ "$health" = "healthy" ]; then
    echo "PASS: beeper API reachable from the host through the forwarder (Beeper $api_ver)"
    echo "PASS: container healthcheck healthy"
    echo "=== FIRST PAINT CHECK PASSED ==="
    exit 0
  fi
  [ -z "$api_ver" ] && echo "FAIL: beeper API unreachable from the host through the forwarder (no app.version from /v1/info on published :23380 after ${remaining}s)"
  [ "$health" != "healthy" ] && echo "FAIL: container healthcheck is '${health:-unknown}', not healthy (after ${remaining}s)"
  docker logs "$NAME" 2>&1 | grep -v 'dbus/bus.cc' | tail -40
  echo "=== FIRST PAINT CHECK FAILED ==="
  exit 1
fi
if [ -n "$probe_err" ]; then
  echo "FAIL: probe could not read the screen after ${TIMEOUT}s: $probe_err"
else
  echo "FAIL: screen still blank after ${TIMEOUT}s (last sample $colours colours, need 2 consecutive >= $MIN_COLOURS)"
fi
docker logs "$NAME" 2>&1 | grep -v 'dbus/bus.cc' | tail -40
echo "=== FIRST PAINT CHECK FAILED ==="
exit 1

#!/bin/bash
set -e

echo "=== beeperbox ==="

eval $(dbus-launch --sh-syntax)

# `docker restart` re-runs this entrypoint but preserves the container's
# writable layer, so Xvfb's lock from the previous boot survives in /tmp.
# A stale /tmp/.X99-lock makes Xvfb see ":99 already active", half-init the
# display, and segfault — wedging the whole stack. Recreate clears /tmp, which
# is why only `docker rm` recovered. Remove the stale lock so restart works.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1024x768x24 -ac &
sleep 1
echo "[ok] xvfb"

openbox &
sleep 1
echo "[ok] openbox"

# VNC auth: set VNC_PASSWORD to require a password on the noVNC/VNC connection
# (x11vnc serves RFB security type 2 instead of None). Unset keeps the
# password-less behavior, which is safe only while :6080 stays loopback-only
# (the documented compose default). Mirrors the opt-in MCP_AUTH_TOKEN pattern.
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vncpass >/dev/null 2>&1
  VNC_AUTH=(-rfbauth /tmp/.vncpass)
  echo "[ok] x11vnc auth: password required (VNC_PASSWORD set)"
else
  VNC_AUTH=(-nopw)
  echo "[!!] x11vnc auth: OPEN — no VNC_PASSWORD set; keep :6080 loopback-only"
fi
x11vnc -display :99 -forever "${VNC_AUTH[@]}" -shared -rfbport 5900 &
sleep 1
echo "[ok] x11vnc"

websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 1
echo "[ok] novnc -> http://localhost:6080/vnc.html"

echo "[..] starting beeper desktop"
# do not pass --disable-gpu: recent beeper builds bail in their crash-reporter
# init when the gpu process is disabled, leaving a black vnc screen. instead
# we ship libgl1-mesa-dri so electron falls back to software gl via mesa.
launch_beeper() {
  /opt/beeper/beepertexts --no-sandbox --disable-dev-shm-usage 2>&1 &
  BEEPER_PID=$!
}
launch_beeper
sleep 5

# beeper api binds to 127.0.0.1:23373 — forward 0.0.0.0:23380 -> 127.0.0.1:23373 so docker can expose it.
# we used to target [::1]:23373 over ipv6, but some hosts (and containers with ipv6 disabled)
# can't reach the v6 loopback, so the forwarder silently dropped traffic. ipv4 works everywhere.
socat TCP4-LISTEN:23380,fork,reuseaddr TCP4:127.0.0.1:23373 &
echo "[ok] socat forwarder 0.0.0.0:23380 -> 127.0.0.1:23373"

# beeperbox-mcp http transport — wraps the beeper api with a normalized,
# opinionated tool surface for ai agent runtimes (claude code, cursor,
# bareagent, etc.). reads BEEPER_TOKEN from env to authenticate against
# the local beeper api.
node /opt/mcp/server.js &
echo "[ok] beeperbox-mcp on 0.0.0.0:23375"

for i in $(seq 1 60); do
  if curl -sf http://localhost:23373/v1/spec > /dev/null 2>&1; then
    echo "[ok] beeper api -> http://localhost:23373"
    break
  fi
  sleep 2
done

if ! curl -sf http://localhost:23373/v1/spec > /dev/null 2>&1; then
  echo "[!!] api not responding — log in via novnc and toggle Settings > Developers > API"
fi

echo ""
echo "=== ready ==="
echo "  novnc: http://localhost:6080/vnc.html (one-time login)"
echo "  api:   http://localhost:23373"

# Forward SIGTERM/SIGINT to Beeper so docker stop triggers a clean shutdown
# (matrix sync flush, sqlite checkpoint) instead of the 10s SIGKILL fallback.
# Bash's `wait` does NOT auto-propagate signals to children, so without this
# trap the container exits but Beeper is killed mid-write.
SHUTTING_DOWN=0
trap 'SHUTTING_DOWN=1; kill -TERM "$BEEPER_PID" 2>/dev/null' TERM INT

# ─── supervise beeper desktop ─────────────────────────────────────
# beepertexts is the one process whose death silently breaks everything: the
# MCP layer (:23375) and forwarder stay up and keep ANSWERING, but every tool
# call fails because the API (:23373) is gone — a "half-dead" container that
# looks healthy to a human while serving nothing, and never self-heals. Worse,
# the Electron launcher can linger after its API/renderer process crashes, so
# watching the top-level PID alone misses it. We supervise on BOTH signals:
# relaunch if the process dies, AND recycle it if the API stays down after we
# have seen it up.
#
# The API_WAS_UP gate is load-bearing. On first run the user has not enabled
# "Start API on launch" yet, so :23373 is down BY DESIGN until they log in via
# noVNC. Recycling beepertexts every interval in that state would make login
# impossible. So we only ever recycle-for-API-down once the API has come up at
# least once this run; a never-logged-in container just runs Beeper steadily
# and waits for the human — exactly the prior behavior.
SUPERVISE=${BEEPERBOX_SUPERVISE:-1}
SUPERVISE_INTERVAL=${BEEPERBOX_SUPERVISE_INTERVAL:-10}    # seconds between checks
SUPERVISE_API_GRACE=${BEEPERBOX_SUPERVISE_API_GRACE:-6}   # consecutive API-down checks (after up) before recycle (~60s)

# Block until Beeper has fully exited, re-waiting because a trap interrupts
# `wait` before the child finishes flushing.
wait_beeper() {
  while kill -0 "$BEEPER_PID" 2>/dev/null; do
    wait "$BEEPER_PID" 2>/dev/null || true
  done
}

if [ "$SUPERVISE" != "1" ]; then
  echo "[ok] supervision disabled (BEEPERBOX_SUPERVISE=$SUPERVISE) — waiting on beepertexts"
  wait_beeper
  exit 0
fi

echo "[ok] supervising beepertexts (interval ${SUPERVISE_INTERVAL}s, api-down grace ${SUPERVISE_API_GRACE})"
API_WAS_UP=0
API_DOWN_STREAK=0
while true; do
  # Clean shutdown requested (docker stop): let Beeper flush, then exit.
  if [ "$SHUTTING_DOWN" = "1" ]; then
    wait_beeper
    break
  fi

  # Process gone entirely → relaunch on the existing display (Xvfb still up).
  if ! kill -0 "$BEEPER_PID" 2>/dev/null; then
    echo "[!!] beepertexts exited — relaunching"
    launch_beeper
    API_DOWN_STREAK=0
    sleep "$SUPERVISE_INTERVAL" || true
    continue
  fi

  # Process alive: watch the API to catch the half-dead case.
  if curl -sf http://127.0.0.1:23373/v1/spec > /dev/null 2>&1; then
    [ "$API_WAS_UP" = "0" ] && echo "[ok] beeper api up — half-dead guard armed"
    API_WAS_UP=1
    API_DOWN_STREAK=0
  elif [ "$API_WAS_UP" = "1" ]; then
    API_DOWN_STREAK=$((API_DOWN_STREAK + 1))
    if [ "$API_DOWN_STREAK" -ge "$SUPERVISE_API_GRACE" ]; then
      echo "[!!] beeper api down ${API_DOWN_STREAK} checks but process alive — recycling beepertexts (half-dead guard)"
      kill -TERM "$BEEPER_PID" 2>/dev/null || true
      for _ in 1 2 3; do kill -0 "$BEEPER_PID" 2>/dev/null || break; sleep 1 || true; done
      kill -KILL "$BEEPER_PID" 2>/dev/null || true
      launch_beeper
      API_DOWN_STREAK=0
    fi
  fi

  sleep "$SUPERVISE_INTERVAL" || true
done

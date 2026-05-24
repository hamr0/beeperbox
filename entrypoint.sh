#!/bin/bash
set -e

echo "=== beeperbox ==="

eval $(dbus-launch --sh-syntax)

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
/opt/beeper/beepertexts --no-sandbox --disable-dev-shm-usage 2>&1 &
BEEPER_PID=$!
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
trap 'kill -TERM "$BEEPER_PID" 2>/dev/null' TERM INT
# Loop: bash interrupts `wait` on trap delivery, so a single wait would return
# before Beeper has finished flushing. Re-wait until the PID is actually gone.
while kill -0 "$BEEPER_PID" 2>/dev/null; do
  wait "$BEEPER_PID" 2>/dev/null || true
done

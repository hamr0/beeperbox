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

x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &
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

wait $BEEPER_PID

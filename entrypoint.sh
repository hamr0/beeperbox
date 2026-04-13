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
/opt/beeper/beepertexts --no-sandbox --disable-gpu --disable-dev-shm-usage 2>&1 &
BEEPER_PID=$!
sleep 5

# beeper api binds to [::1]:23373 only — forward 0.0.0.0:23380 -> [::1]:23373 so docker can expose it
socat TCP4-LISTEN:23380,fork,reuseaddr TCP6:[::1]:23373 &
echo "[ok] socat forwarder 0.0.0.0:23380 -> [::1]:23373"

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

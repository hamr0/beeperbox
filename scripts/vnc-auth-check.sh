#!/usr/bin/env bash
# vnc-auth-check.sh
#
# Asserts the x11vnc auth posture wired by entrypoint.sh: with no password
# x11vnc offers RFB security type None (1); with -rfbauth it offers VNC
# authentication (2) and NOT None. Exits non-zero on any failure.
#
# Single source of truth for the VNC gate: used by vnc-test.yml (PR/dispatch)
# AND release.yml's publish gate. Needs Xvfb, x11vnc, python3, and
# vnc-auth-probe.py alongside this script.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
export DISPLAY=:99
fail=0

# RFB refusal-reason cap: a hostile peer advertising a 4 GiB reason must not be
# buffered. Needs only python3 (runs before Xvfb).
if ! PYTHONDONTWRITEBYTECODE=1 HERE="$HERE" python3 - <<'PYEOF'
import os, socket, sys, threading, time
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["HERE"])
import rfb

srv = socket.socket()
srv.bind(("127.0.0.1", 0))
srv.listen(1)

def serve():
    c, _ = srv.accept()
    try:
        c.sendall(b"RFB 003.008\n")
        c.recv(12)
        c.sendall(b"\x00" + (0xFFFFFFFF).to_bytes(4, "big"))
        chunk = b"A" * 65536
        for _ in range(800):  # ~50 MB
            c.sendall(chunk)
    except OSError:
        pass
    finally:
        c.close()

threading.Thread(target=serve, daemon=True).start()
t0 = time.time()
try:
    rfb.connect("127.0.0.1", srv.getsockname()[1], 5)
    print("no RfbError raised")
    sys.exit(1)
except rfb.RfbError as e:
    msg = str(e)
    if len(msg) >= 5000 or time.time() - t0 > 5:
        print(f"reason not capped: {len(msg)} chars in {time.time()-t0:.1f}s")
        sys.exit(1)
PYEOF
then echo "FAIL: RFB refusal reason must be capped (hostile 4 GiB reason_len)"; fail=1; else echo "PASS: RFB refusal reason is capped"; fi

Xvfb :99 -screen 0 1024x768x24 -ac >/dev/null 2>&1 &
sleep 2

# open mode (mirrors entrypoint.sh with VNC_PASSWORD unset)
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 >/dev/null 2>&1 &
sleep 2
nopw=$(python3 "$HERE/vnc-auth-probe.py" 127.0.0.1 5900)

# password mode (mirrors entrypoint.sh with VNC_PASSWORD set)
x11vnc -storepasswd ci-vnc-pass /tmp/.vncpass >/dev/null 2>&1
x11vnc -display :99 -forever -rfbauth /tmp/.vncpass -shared -rfbport 5901 >/dev/null 2>&1 &
sleep 2
pw=$(python3 "$HERE/vnc-auth-probe.py" 127.0.0.1 5901)

echo "nopw security types=[$nopw]   pw security types=[$pw]"
if echo "$nopw" | grep -qw 1; then echo "PASS: open mode offers None(1)";   else echo "FAIL: open mode should offer 1"; fail=1; fi
if echo "$pw"   | grep -qw 2; then echo "PASS: password offers VNCAuth(2)"; else echo "FAIL: password should offer 2"; fail=1; fi
if echo "$pw"   | grep -qw 1; then echo "FAIL: password mode must NOT offer None(1)"; fail=1; else echo "PASS: password mode does not offer None"; fi

if [ "$fail" -eq 0 ]; then echo "=== VNC AUTH CHECK PASSED ==="; else echo "=== VNC AUTH CHECK FAILED ==="; fi
exit "$fail"

#!/usr/bin/env python3
"""Probe an RFB/VNC server and print the security types it offers.

Used by CI (and locally) to verify x11vnc auth posture without a full VNC
client: a server started with `-nopw` offers security type 1 (None); one
started with `-rfbauth <file>` offers type 2 (VNC authentication).

RFB 3.8 handshake (RFC 6143 §7.1):
  S->C  12 bytes  "RFB 003.008\n"
  C->S  12 bytes  client ProtocolVersion
  S->C  U8 count, then `count` U8 security types  (1=None, 2=VNCAuth)
        if count==0: U32 reason-length + reason  (handshake failure)

Usage:  vnc-auth-probe.py <host> <port>
Prints the offered type numbers space-separated (e.g. "2"); exits non-zero
if the peer isn't an RFB server or refuses the handshake.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rfb  # noqa: E402  (sibling module, shared handshake)


def probe(host: str, port: int) -> list[int]:
    try:
        s, types = rfb.connect(host, port, timeout=5)
    except rfb.RfbError as e:
        print(e, file=sys.stderr)
        sys.exit(2)
    s.close()
    return types


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: vnc-auth-probe.py <host> <port>", file=sys.stderr)
        sys.exit(64)
    print(" ".join(str(t) for t in probe(sys.argv[1], int(sys.argv[2]))))

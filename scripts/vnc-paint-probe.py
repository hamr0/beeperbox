#!/usr/bin/env python3
"""Grab one framebuffer from an open (no-password) RFB/VNC server and print
how many distinct pixel values it contains.

Used by first-paint-check.sh to tell "Beeper drew its window" from "the screen
is a flat, empty root window" without any tooling inside the image: an unpainted
Xvfb screen is exactly 1 colour, the Beeper login screen is thousands.

RFB 3.8 (RFC 6143): version exchange, security type None (1), ClientInit,
ServerInit (width/height/pixel-format), then one non-incremental
FramebufferUpdateRequest answered in Raw encoding (the only one we advertise).

Usage:  vnc-paint-probe.py <host> <port>
Prints the distinct-colour count; exits non-zero if the peer isn't an open RFB
server or the update can't be read.
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rfb  # noqa: E402  (sibling module, shared handshake)


def count_colours(host: str, port: int) -> int:
    try:
        s, types = rfb.connect(host, port, timeout=15)
    except rfb.RfbError as e:
        print(e, file=sys.stderr)
        sys.exit(2)
    with s:
        if 1 not in types:
            print(f"server does not offer None(1) auth: {types}", file=sys.stderr)
            sys.exit(2)
        s.sendall(b"\x01")
        if struct.unpack(">I", rfb.recv_exact(s, 4))[0] != 0:
            print("security handshake failed", file=sys.stderr)
            sys.exit(2)
        s.sendall(b"\x01")  # ClientInit: shared
        width, height = struct.unpack(">HH", rfb.recv_exact(s, 4))
        bpp = rfb.recv_exact(s, 16)[0] // 8
        rfb.recv_exact(s, struct.unpack(">I", rfb.recv_exact(s, 4))[0])  # desktop name

        s.sendall(struct.pack(">BxHi", 2, 1, 0))  # SetEncodings: Raw only
        s.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))

        colours: set[bytes] = set()
        while True:
            msg = rfb.recv_exact(s, 1)[0]
            if msg == 0:  # FramebufferUpdate
                break
            if msg == 2:  # Bell
                continue
            if msg == 3:  # ServerCutText
                rfb.recv_exact(s, struct.unpack(">3xI", rfb.recv_exact(s, 7))[0])
                continue
            print(f"unexpected server message type {msg}", file=sys.stderr)
            sys.exit(2)
        for _ in range(struct.unpack(">xH", rfb.recv_exact(s, 3))[0]):
            _x, _y, w, h, enc = struct.unpack(">HHHHi", rfb.recv_exact(s, 12))
            if enc != 0:
                print(f"unexpected encoding {enc}", file=sys.stderr)
                sys.exit(2)
            data = rfb.recv_exact(s, w * h * bpp)
            colours.update(data[i:i + bpp] for i in range(0, len(data), bpp))
        return len(colours)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: vnc-paint-probe.py <host> <port>", file=sys.stderr)
        sys.exit(64)
    print(count_colours(sys.argv[1], int(sys.argv[2])))

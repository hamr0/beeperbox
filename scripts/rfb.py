"""Shared RFB/VNC (RFC 6143) client handshake for the scripts/ probes.

`connect()` does the version exchange and reads the offered security types in
one call, so vnc-auth-probe.py and vnc-paint-probe.py cannot drift apart on it.

  S->C  12 bytes  "RFB 003.008\n"
  C->S  12 bytes  client ProtocolVersion
  S->C  U8 count, then `count` U8 security types  (1=None, 2=VNCAuth)
        if count==0: U32 reason-length + reason  (handshake failure)
"""
import socket


class RfbError(Exception):
    """The peer is not an RFB server, or refused the handshake."""


def recv_exact(s: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = s.recv(min(65536, n - len(buf)))
        if not chunk:
            raise ConnectionError(f"peer closed after {len(buf)}/{n} bytes")
        buf += chunk
    return bytes(buf)


def connect(host: str, port: int, timeout: float) -> tuple[socket.socket, list[int]]:
    """Open a connection, get past version exchange, return (socket, security types).

    The caller owns the socket. Raises RfbError (message is ready to print) if
    the peer isn't RFB or refuses the handshake; the socket is closed first.
    """
    s = socket.create_connection((host, port), timeout=timeout)
    try:
        version = s.recv(12)
        if not version.startswith(b"RFB "):
            raise RfbError(f"not an RFB server, got: {version!r}")
        s.sendall(b"RFB 003.008\n")
        first = s.recv(1)
        if not first:
            raise RfbError("no security-type count byte received")
        count = first[0]
        if count == 0:
            reason_len = int.from_bytes(s.recv(4), "big")
            reason = s.recv(reason_len)
            raise RfbError(f"server refused handshake: {reason!r}")
        return s, list(recv_exact(s, count))
    except BaseException:
        s.close()
        raise

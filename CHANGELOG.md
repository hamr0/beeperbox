# Changelog

All notable changes to beeperbox are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Typed Node client (`@beeperbox/node`)
- Bootstrap script for first-run OAuth via CLI (no browser required)
- `/health` endpoint for container orchestration
- GitHub Actions workflow publishing image to GHCR on tag
- Python client (`beeperbox` on PyPI)

## [0.1.0] — 2026-04-13

First working proof-of-concept.

### Added
- `Dockerfile` on `debian:12-slim` with Xvfb, openbox, x11vnc, noVNC, websockify, and all Beeper Desktop Electron runtime deps
- `entrypoint.sh` orchestrating virtual display → window manager → VNC → noVNC → Beeper Desktop → API readiness check
- Beeper Desktop AppImage extraction at build time (avoids FUSE requirement at runtime)
- `socat` forwarder bridging Beeper's IPv6-loopback-only API (`[::1]:23373`) to `0.0.0.0:23380` so Docker port mapping can reach it
- `docker-compose.yml` with `restart: unless-stopped`, persistent volume for Beeper config, port mappings `6080` (noVNC) and `23374 → 23380` (API)
- README with quick-start, setup walkthrough, and why/status sections

### Verified
- Image builds clean on Fedora 43 + Docker CE 29.3.1
- Container boots Beeper Desktop headless, Matrix sync loop stable
- Browser-based first-run login via `http://localhost:6080/vnc.html` works
- After enabling **Settings → Developers → Start API on launch**, `curl http://localhost:23374/v1/spec` returns full OpenAPI 3.1.0 document
- Config volume persists login across container restarts

### Known limitations
- POC scope — no typed clients, no bootstrap automation, no health endpoint
- Image size ~1GB, idle RAM ~500MB (Electron + Chromium are the bulk)
- Beeper API binds to `[::1]:23373` inside the container and is not configurable; socat workaround is required
- Some bridges (notably WhatsApp on-device) log harmless `no bridge event found` backup errors during initial sync — safe to ignore
- `23373` host port collides with a native Beeper Desktop install on the same machine — compose uses `23374` by default for dev coexistence; change to `23373:23380` for production

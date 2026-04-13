# Changelog

All notable changes to beeperbox are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **MCP server (POC phase 1b)**: opinionated Model Context Protocol server inside the container, vanilla Node, zero npm deps, ~200 lines in a single `mcp/server.js` file. Speaks JSON-RPC 2.0 over HTTP transport on host port `127.0.0.1:23375` (env-overridable via `BEEPERBOX_MCP_PORT`). Implements the MCP protocol scaffolding (`initialize`, `tools/list`, `tools/call`) plus one real tool — `list_inbox` — which fetches recent chats from the Beeper API, normalizes them into a stable schema (`id`, `title`, `network`, `network_label`, `is_group`, `is_note_to_self`, `last_message_at`, `unread_count`), filters out note-to-self chats, and slices to the user-requested limit. The other 9 tools land incrementally in phase 2.
- `nodejs` added to the Dockerfile so the image can run the MCP server. Adds ~80MB on top of the existing 1.91GB image (~4% growth). No npm dependencies; the server uses Node's built-in `http`, `fetch`, and stdlib only.
- `BEEPER_TOKEN` env var plumbed through `docker-compose.yml` so the MCP server can authenticate against the local Beeper API. Customers create the token once via Beeper Settings → Developers → Approved Connections, save it to a `.env` file next to `docker-compose.yml`, and `docker compose up -d` picks it up. Setup is one-time; the token survives container rebuilds, restarts, and host reboots.
- `docs/GUIDE.md` token-creation section rewritten to cover the actual Beeper Desktop UI path (Settings → Developers → Approved Connections → +), the "allow sensitive actions" + "expiry never" choices, the noVNC-clipboard-doesn't-work-so-use-note-to-self workaround, the `.env` file pattern, the `up -d` vs `restart` gotcha (compose only re-reads env on `up -d`), and a survival table showing which restart paths preserve the token.
- New port published: `127.0.0.1:23375 → 23375` for the MCP HTTP transport, env-overridable via `BEEPERBOX_MCP_PORT`. Added to compose alongside the existing API and noVNC ports.

### Changed
- `docker-compose.yml` host ports are now env-overridable with sensible defaults: `BEEPERBOX_HOST_PORT` (defaults to `23373`, the canonical Beeper port) and `BEEPERBOX_NOVNC_PORT` (defaults to `6080`). Previously the API was hardcoded to host port `23374` because the original test environment had a native Beeper Desktop on `23373`. The new default works for the common case (no native Beeper on the host) without editing the compose file; dev machines that already run native Beeper just pass `BEEPERBOX_HOST_PORT=23374 docker compose up -d`. One file, one toggle, no two-compose-file spaghetti.
- README and `docs/GUIDE.md` audience statement tightened: beeperbox is for **autonomous agents that need messaging reach without a human at a Beeper Desktop** (VPSes, containers, cron jobs, multi-tenant SaaS). Laptop users with Beeper Desktop installed locally already have everything they need from Beeper natively (HTTP API + MCP server) and are explicitly *not* the target audience. This sharpening is doc-only — no behavior change.
- `docs/GUIDE.md` adds two facts customers were likely to trip over: (a) Beeper Desktop syncs the **top ~20 most recently active chats** by default, with workarounds for accessing older history; (b) you can pair beeperbox with a **Beeper account already configured on your phone** by signing in with the same credentials inside noVNC — bridge state lives on Beeper's servers, so all your existing WhatsApp/Signal/etc. bridges show up automatically without re-pairing.
- `docs/GUIDE.md` gains a dedicated `## Ports` section explaining the env-override pattern, container-vs-host port namespaces (why container internal ports never collide with host ports), and `docker port beeperbox` for confirming the running mapping.

### Planned
- Opinionated MCP server inside the container (10 tools: `list_inbox`, `read_chat`, `send_message`, `note_to_self`, `mark_as_read`, `react_to_message`, `search_messages`, `list_unread`, `get_chat`, `list_accounts`) with normalized `Chat` and `Message` schemas carrying stable IDs and a clean `network` field (whatsapp / telegram / imessage / signal / discord / slack / facebook / instagram / linkedin / matrix / beeper). Wraps the raw `/v1/*` HTTP API and adds the multis-style note-to-self vs inbox split so AI agent runtimes (Claude Code, Cursor, Cline, bareagent) can consume beeperbox as a single, language-agnostic tool source.
- Typed Node client (`@beeperbox/node`)
- Bootstrap script for first-run OAuth via CLI (no browser required)
- Python client (`beeperbox` on PyPI)
- Multi-arch image (arm64 for Raspberry Pi and cheap ARM VPSes)

## [0.1.0] — 2026-04-13

First working proof-of-concept. Headless Beeper Desktop in a Debian 12 container, one-time browser login, persistent local HTTP API.

### Added
- `Dockerfile` on `debian:12-slim` with Xvfb, openbox, x11vnc, noVNC, websockify, socat, and all Beeper Desktop Electron runtime deps
- `entrypoint.sh` orchestrating virtual display → window manager → VNC → noVNC → Beeper Desktop → socat forwarder → API readiness check
- Beeper Desktop AppImage extraction at build time (avoids FUSE requirement at runtime)
- `socat` forwarder bridging Beeper's IPv6-loopback-only API (`[::1]:23373`) to `0.0.0.0:23380` so Docker port mapping can reach it
- `docker-compose.yml` with `restart: unless-stopped`, persistent volume for Beeper config, localhost-bound port mappings `127.0.0.1:6080` (noVNC) and `127.0.0.1:23374 → :23380` (API)
- Docker `HEALTHCHECK` directive probing `http://127.0.0.1:23380/v1/info` every 30s with a 90s start-period. Probe goes through the socat forwarder — same path external clients use — so both a crashed Beeper API and a crashed forwarder mark the container unhealthy. Orchestrators (compose, k8s, systemd) can now observe degraded containers; plain Docker needs an autoheal sidecar to auto-restart on unhealthy, Swarm/Kubernetes do it natively. Process-death recovery is already covered by `restart: unless-stopped` + the entrypoint's `wait $BEEPER_PID`.
- `README.md` with architecture diagram, quick-start, port table, and roadmap
- `docs/GUIDE.md`: long-form user guide covering install, first-run login, access token creation (manual + OAuth2 PKCE), API examples in curl / vanilla Node / vanilla Python, VPS deployment patterns (SSH tunnel, Tailscale, Caddy reverse proxy with TLS + basic auth), operating commands, upgrading, a troubleshooting tree for the common symptoms, the two-layer security model, and known limits
- `scripts/smoke-test.sh`: repeatable end-to-end check that builds the image, starts the container, waits for `(healthy)`, and asserts `/v1/info` reports `"status":"running"` — exits non-zero with a clear reason on any failure
- `.github/workflows/release.yml`: GitHub Actions workflow that builds the image on semver tag push (`v*.*.*`) and publishes to GHCR at `ghcr.io/<owner>/beeperbox:<version>` + `:latest`, with buildx layer caching
- `.dockerignore` excluding docs, `.git`, `.github`, `.claude`, and markdown so build contexts stay small
- `LICENSE` (MIT)

### Security
- Published ports bound explicitly to `127.0.0.1` instead of Docker's `0.0.0.0` default. Before this, on a VPS with a public IP both the API and noVNC UI were reachable from the open internet — the Bearer token was the only control on the API and noVNC had no auth at all, so anyone hitting `:6080` could take over Beeper Desktop. After this change, only processes on the same host can reach the ports. Remote access now requires a deliberate opt-in (SSH tunnel, Tailscale/Wireguard, or a TLS-terminating reverse proxy with auth in front) — all three are documented in `docs/GUIDE.md`.

### Verified
- Image builds clean on Fedora 43 + Docker CE 29.3.1
- Container boots Beeper Desktop headless, Matrix sync loop stable, WhatsApp bridge reachable
- Browser-based first-run login via `http://localhost:6080/vnc.html` works
- After enabling **Settings → Developers → Enable API + Start API on launch**, `curl http://localhost:23374/v1/info` returns the Beeper Desktop info payload
- Config volume persists login across container restarts
- Healthcheck transitions `starting → healthy` within the 90s start-period with `FailingStreak: 0`
- All three failure modes (API down, API error, forwarder down) produce non-zero curl exit codes and flip the healthcheck
- Localhost-only port binding: `curl localhost:23374 → 200`, `curl <LAN-IP>:23374 → connection refused`
- `scripts/smoke-test.sh` completes 4/4 checks against a fresh build

### Known limitations
- Image size ~1GB, idle RAM ~500MB (Electron + Chromium are the bulk; Alpine is not a drop-in replacement — musl breaks Chromium)
- Beeper API binds to `[::1]:23373` inside the container and is not configurable; socat workaround is required
- Some bridges (notably WhatsApp on-device) log harmless `no bridge event found` backup errors during initial sync — safe to ignore
- x86_64 only — arm64 multi-arch build is on the roadmap
- Single user per container — multiple Beeper accounts need multiple containers with separate volumes and ports
- No streaming subscriptions — the Beeper Desktop API is request/response; real-time updates require polling or the advanced MCP path

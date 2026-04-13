# Changelog

All notable changes to beeperbox are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Typed Node client (`@beeperbox/node`) — lower priority since MCP already covers language-agnostic consumption
- Python client (`beeperbox` on PyPI) — same rationale
- ~~Multi-tenant per-request token forwarding~~ — **dropped**. Architecturally impossible: Beeper Desktop logs in as one user at a time, so "multi-tenant in one container" would require multi-Beeper-Desktop, at which point you might as well run multiple containers. The multi-instance pattern is documented in GUIDE as of v0.2.1.

## [0.3.1] — 2026-04-13

Fixes the v0.3.0 arm64 cross-build failure. No user-visible behavior change beyond "the arm64 variant now actually builds and publishes".

### Fixed
- Dockerfile no longer runs the Beeper AppImage's launcher (`./file --appimage-extract`) to self-extract. Instead, it finds the embedded squashfs offset and extracts it directly with `unsquashfs -o <offset>`. Type 2 AppImages run their launcher stub as a real ELF binary, and that exec doesn't work cleanly under QEMU user-mode emulation during `docker buildx` cross-arch builds — v0.3.0's arm64 stage failed with `Exec format error` even on GitHub Actions runners, not just on the Fedora dev host.
- The squashfs magic `hsqs` occurs naturally inside the AppImage's ELF code/data too, so the first grep match is often a false positive. The Dockerfile now iterates every candidate offset and picks the first one where `unsquashfs -s` can read a valid superblock.
- Added `squashfs-tools` to the apt install list.

### Verified
- Native amd64 build succeeds via `docker compose build` with the new extraction path; container boots healthy in ~15s; both the raw Beeper API (`/v1/info`) and the MCP server (`tools/list`) return 200.
- Local amd64 test was the minimum sanity check; the arm64 cross-build happens on GHCR via the release workflow as part of this tag push. Previous v0.3.0 release failed at the `--appimage-extract` step during the arm64 stage; this fix removes the AppImage launcher from the build entirely.

## [0.3.0] — 2026-04-13

**Superseded by v0.3.1 due to a cross-build arm64 failure — do not pull `ghcr.io/hamr0/beeperbox:0.3.0`; use `0.3.1` or `latest`.**

Multi-arch image. `ghcr.io/hamr0/beeperbox:0.3.0` and `:latest` are now published as a multi-platform manifest containing both `linux/amd64` and `linux/arm64`, so Raspberry Pi 4/5, Oracle Cloud's free ARM tier, Hetzner CAX-series ARM VPSes, AWS Graviton, and Apple Silicon Macs can pull the native-arch variant automatically with no code changes.

### Added
- `Dockerfile` reads the `TARGETARCH` buildx arg and selects the matching Beeper Desktop AppImage from Beeper's CDN: `TARGETARCH=amd64` → `linux/x64/stable`, `TARGETARCH=arm64` → `linux/arm64/stable`. Both URLs verified live against `api.beeper.com` (HTTP 302 → Beeper-4.2.715-x86_64.AppImage / Beeper-4.2.715-arm64.AppImage). Unknown `TARGETARCH` values fail the build with a clear error message.
- `.github/workflows/release.yml` gains `docker/setup-qemu-action@v3` (with `platforms: linux/amd64,linux/arm64`) and passes `platforms: linux/amd64,linux/arm64` to the `docker/build-push-action` step. Build cache is reused across both platforms via the existing GHA cache backend. GHCR receives a single multi-arch manifest per tag.
- Documentation: new "Architectures" row in the version-compatibility section (GUIDE + context file) noting that `docker pull ghcr.io/hamr0/beeperbox:latest` now works on both amd64 and arm64 hosts automatically.

### Changed
- Image tags `0.3.0`, `0.3`, `0`, and `latest` on GHCR are now multi-arch. Hosts pull the variant matching their CPU architecture with no flags needed. Users who need to force a specific variant can pass `--platform linux/arm64` to `docker pull`.

### Verified
- Local amd64 build via `docker buildx build --platform linux/amd64 --load` completes successfully with the new TARGETARCH switch — proves the Dockerfile change doesn't break the native path for existing users.
- arm64 local build was attempted but blocked by this host's missing `qemu-user-static` package (Fedora default). The real arm64 validation happens in the GHCR release workflow on GitHub Actions runners, which include QEMU by default via `setup-qemu-action@v3`.
- Beeper Desktop's download CDN confirmed to serve a native `ELF 64-bit LSB executable, ARM aarch64` at the arm64 URL (218MB), so the Dockerfile just needs to hit the right URL per architecture.

### Known limitations
- No `linux/arm/v7` (32-bit ARM) — Beeper does not publish a 32-bit ARM AppImage, so Raspberry Pi 2/3 and 32-bit Pi 4 OS installs are not supported. Install Raspberry Pi OS 64-bit on those devices.
- Image size on disk is still ~1.9GB per architecture; the multi-arch manifest doesn't reduce per-platform footprint, it just picks the right one for your host.

## [0.2.1] — 2026-04-13

Docs-only release. No code changes, no image rebuild strictly required (the v0.2.0 image still works), but the GHCR workflow republishes on tag push.

### Added
- `docs/GUIDE.md` gains a "Read-only vs read-write tokens" subsection under "Create an access token" explaining how Beeper Desktop's "Allow sensitive actions" toggle gates write operations at token creation time. Read-only tokens can call the 6 read tools (`list_inbox`, `list_unread`, `read_chat`, `get_chat`, `search_messages`, `list_accounts`); write tools (`send_message`, `note_to_self`, `react_to_message`, `archive_chat`) return `401 Unauthorized`. No beeperbox code needed — scope is enforced inside Beeper Desktop itself.
- `docs/GUIDE.md` gains a new top-level "Running multiple instances on one VPS" section with the `docker compose -p <project> --env-file .env.<n>` pattern, per-instance env-override examples for three customers, a density table (Oracle Cloud free tier fits 20+, Hetzner CAX21 fits 6-8, etc.), orchestration notes (manual for 2-3, shell script for 5+, Swarm/k8s for 20+), and an explicit "why multi-tenant-in-one-container is not a feature" explanation.
- `beeperbox.context.md` gains matching shorter sections: read-only vs read-write token table, multi-tenancy explanation, density rule of thumb.

### Changed
- v0.2.0 CHANGELOG security note corrected — removed the misleading claim that "multi-tenant per-request token forwarding is a v0.3 item". That feature is dropped entirely; the honest architectural answer is "run one container per Beeper account".

## [0.2.0] — 2026-04-13

First release with an opinionated Model Context Protocol server inside the container. beeperbox is now consumable by any AI agent runtime that speaks MCP (Claude Code, Cursor, Cline, Continue, bareagent, etc.) over either HTTP or stdio transport — the LLM sees 10 semantic tools for multi-messenger operations and never has to touch raw Beeper Desktop API endpoints.

### Added

**MCP server**
- Opinionated MCP server inside the container, vanilla Node, zero npm deps, single-file `mcp/server.js` (~400 lines). Wraps Beeper Desktop's raw `/v1/*` HTTP API with 10 semantic tools, 2 normalized schemas (`Chat` and `Message`), and a note-to-self vs inbox split so agents never accidentally pollute customer conversations with command-channel messages.
- **Two transports, interchangeable**, both in the same process, picked at startup via `--stdio` argv flag:
  - **HTTP** (default, always-on): JSON-RPC 2.0 over POST on `127.0.0.1:23375` (env-overridable via `BEEPERBOX_MCP_PORT`). Started by the entrypoint. Use case: remote agents, multi-tenant SaaS, cross-container setups, cloud-hosted agent runtimes.
  - **stdio** (on demand): newline-delimited JSON-RPC over stdin/stdout. Stdout reserved for the protocol; all logging goes to stderr. Invoked via `docker exec -i beeperbox node /opt/mcp/server.js --stdio`. Use case: Claude Code, Cursor, Cline, bareagent, or any MCP client that spawns the server as a local subprocess.

**10 tools** (all verified end-to-end against a live Beeper account during development, one commit per tool for clean rollback):
- `list_accounts` — discover which messaging platforms are connected (returns `network` slug + `network_label` human name per account)
- `list_inbox` — top recently active chats, note-to-self filtered out
- `list_unread` — same as list_inbox but only chats where `unread_count > 0`
- `get_chat` — fetch one chat by ID, same `Chat` schema as list_inbox
- `read_chat` — last N messages from a chat, oldest-first within the page, each message carries `chat_id` + `network` + `network_label` for grounding
- `search_messages` — full-text across all chats; Beeper's response includes a `chats` map so hits resolve their network metadata in one round-trip, no N+1 fetches
- `send_message` — send text to a chat by ID, optional `reply_to_message_id`, returns Beeper's `pendingMessageID`
- `note_to_self` — send to the bot's own note-to-self chat with **auto-resolved chat ID**; the dedicated command/control channel for the agent, cached after first lookup, excluded from inbox views
- `react_to_message` — add an emoji reaction (unicode, shortcode, or custom key)
- `archive_chat` — archive or unarchive a chat; substituted for `mark_as_read` because Beeper Desktop does not expose a mark-as-read endpoint (the description explicitly tells the LLM this and names archive as the closest primitive for the "I am done with this conversation" pattern)

**Normalized schemas** — two shapes the LLM learns once and reuses everywhere:

```
Chat:     { id, title, network, network_label, is_group, is_note_to_self, last_message_at, unread_count }
Message:  { id, chat_id, network, network_label, sender{id, name, is_self}, text, type, timestamp, reply_to }
```

- Every chat and every message carries both `network` (machine slug: `whatsapp`, `telegram`, `discord`, etc.) and `network_label` (human: `"WhatsApp"`, `"Telegram"`, `"Discord"`, etc.)
- Network normalization driven by `/v1/accounts` (which already returns clean human-readable names); chat bridge IDs are parsed as a fallback
- `NETWORK_SLUGS` lookup table maps Beeper's display names to clean lowercase slugs: `whatsapp`, `imessage`, `telegram`, `signal`, `discord`, `slack`, `instagram`, `facebook`, `linkedin`, `gmessages`, `twitter`, `matrix`, `beeper`. Unknown networks fall back to alphanumeric-stripped lowercase of the Beeper label.

**Infrastructure**
- `nodejs` added to the Dockerfile (~80MB image growth, 4% on top of the existing 1.91GB). Zero npm deps; the server uses Node's built-in `http`, `fetch`, `crypto`, and stdlib only. No `package.json`, no `node_modules`, no supply-chain surface.
- `BEEPER_TOKEN` env var plumbed through `docker-compose.yml`. Customers save the token to a `.env` file next to `docker-compose.yml` (gitignored), and `docker compose up -d` picks it up. Setup is one-time — token survives container rebuilds, restarts, and host reboots.
- New port published: `127.0.0.1:23375 → 23375` for the MCP HTTP transport, env-overridable via `BEEPERBOX_MCP_PORT`.

**Documentation**
- `docs/GUIDE.md` gains a new top-level "Quick setup (10 minutes, one-time)" section walking users linearly from `git clone` → noVNC login → enable API → create token → `.env` file → `docker compose up -d` → verify → test MCP.
- Full token-creation walkthrough covering the real Beeper Desktop UI path (Settings → Developers → Approved Connections → +), the "allow sensitive actions" + "expiry never" choices, the noVNC-clipboard-workaround (paste token into Note to self, copy on your phone), the `.env` file pattern, the `up -d` vs `restart` gotcha (compose only re-reads env on `up -d`), and a token-survival matrix.
- New "MCP tools reference" section with all 10 tools, their required parameters, and worked curl + Claude Code + bareagent configuration examples.
- Added facts for common footguns: (a) Beeper Desktop syncs the top ~20 most recently active chats by default — older chats need pinning or search; (b) you can pair beeperbox with a Beeper account already configured on your phone — bridge state lives on Beeper's servers, so existing WhatsApp/Signal/etc. bridges inherit automatically.
- New `## Ports` section explaining the env-override pattern, container-vs-host port namespace separation (why container internal ports never collide with host ports), and `docker port beeperbox` for confirming the running mapping.

### Changed
- `docker-compose.yml` host ports are env-overridable with sensible defaults: `BEEPERBOX_HOST_PORT` (default `23373`, the canonical Beeper port), `BEEPERBOX_NOVNC_PORT` (default `6080`), `BEEPERBOX_MCP_PORT` (default `23375`). Previously the API was hardcoded to `23374` because the original test environment had a native Beeper Desktop on `23373`. The new default works for the common case out of the box; dev machines that already run native Beeper just pass `BEEPERBOX_HOST_PORT=23374 docker compose up -d`. One file, one toggle, no spaghetti.
- README and `docs/GUIDE.md` audience statement tightened: beeperbox is for **autonomous agents that need messaging reach without a human at a Beeper Desktop**. Laptop users with Beeper Desktop installed locally already have Beeper's native HTTP API and MCP server — they are explicitly not the target audience and the docs say so. This sharpening is doc-only — no behavior change.

### Fixed
- Five real-Beeper-API field-shape bugs found by testing the normalizer against live data before committing the initial `list_inbox` implementation:
  - `?limit=N` is ignored by Beeper (returns ~25 minimum) → slice client-side after normalization
  - Network is NOT in the room ID → it lives in `chat.accountID` and maps to `/v1/accounts[].network`; cached on first use
  - `lastActivity` is camelCase, not `last_activity`
  - Group flag is `type === 'group'`, not `isGroup`
  - Note-to-self detection: `participants.total === 1 AND items[0].isSelf === true` (catches both Beeper-native Note to self and each platform's saved-messages chat like Telegram Saved Messages and WhatsApp Send to yourself)
- `send_message` v1 returned empty `message_id` — fixed to read Beeper's `pendingMessageID` field (verified against the OpenAPI `SendMessageOutput` schema) in v2 before commit.
- `beeperFetch` refactored to support `method + body` for POST/DELETE endpoints and to handle empty-body responses (archive returns 200 with no JSON body → return `null` instead of throwing on `r.json()`).
- Stdio transport's `process.exit(0)` on stdin close was eagerly killing pending async tool handlers — removed. The Node event loop now exits naturally once all in-flight `fetch()` calls settle.

### Security
- No changes since v0.1.0. Published ports remain bound to `127.0.0.1` only. The MCP server inherits the same Bearer-token auth model as the raw Beeper API via the `BEEPER_TOKEN` env var. Read-only vs read-write token scoping is available today via Beeper Desktop's own "Allow sensitive actions" toggle — no beeperbox-side flag needed; documented in GUIDE + context file in v0.2.1.

### Verified
- Every MCP tool tested end-to-end against live Beeper data across 4 real accounts (Matrix, Discord, LinkedIn, Telegram)
- Stdio transport: 3 concurrent in-flight requests (initialize + tools/list + tools/call list_accounts) all return correctly via `docker exec -i` pipeline
- HTTP transport: same 3 requests return correctly via `curl -X POST http://localhost:23375`
- Image rebuilds cleanly, container boots, all smoke-test steps pass

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- MEMORY:START -->
@.claude/remember/MEMORY.md
<!-- MEMORY:END -->

<!-- AGENT_RULES:START -->
Consult when building something new or adding a feature — a standards guide, not hot
context like MEMORY.md above:
@.claude/remember/AGENT_RULES.md
<!-- AGENT_RULES:END -->

---

## What this is

beeperbox exposes every network [Beeper](https://www.beeper.com/) bridges (WhatsApp, iMessage,
Signal, Telegram, Discord, Slack, Matrix, …) to an AI agent through **one MCP endpoint** instead of
50 per-platform SDKs. It is *not* a thin proxy over Beeper's raw API — it is an opinionated verb
layer that normalizes everything into one `Chat` / `Message` schema.

There is no build step, no framework, no lint/format/TS config, and no root `package.json`. The
entire product is **one file**: `mcp/server.js` (CommonJS, Node ≥18, zero runtime deps).

## Commands

```sh
# Unit tests (node:test — no framework)
node --test mcp/server.test.js
node --test --test-name-pattern 'assertServableSrcUrl' mcp/server.test.js   # single test

# download_asset / attachments E2E against a stub Beeper API (exit 0 = pass)
node scripts/asset-serve-check.js

# MCP tool-contract + HTTP guard matrix (200/403/413/401) — needs docker
bash scripts/mcp-guard-check.sh beeperbox:dev

# x11vnc auth posture (RFB security types) — needs xvfb + x11vnc
bash scripts/vnc-auth-check.sh

# Container: build from source + wait-for-healthy + probe /v1/info
./scripts/smoke-test.sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Lite mode (no Docker) — same file the container runs
BEEPER_TOKEN=... node mcp/server.js            # HTTP transport on :23375
BEEPER_TOKEN=... node mcp/server.js --stdio    # stdio transport
```

**Live-testing working-tree code.** A healthy `beeperbox` container usually runs locally, but its
image is *older than the tree*. To exercise your edits against the real Beeper API, run the
working-tree server against the container's API on a spare port — never trust the container to be
running your changes:

```sh
BEEPER_API=http://127.0.0.1:23373 BEEPER_TOKEN=$(grep BEEPER_TOKEN .env | cut -d= -f2) \
MCP_PORT=23999 node mcp/server.js
```

## Architecture

### Two run modes, one file — by construction

| | Container | Lite (`npx beeperbox`) |
|---|---|---|
| Beeper Desktop | bundled, headless (Xvfb + Electron) | you supply it, already running |
| What runs | full appliance: Beeper + raw API + MCP | **only** the MCP verb layer |
| Entry | `entrypoint.sh` → `node /opt/mcp/server.js` | `node server.js` |

The Dockerfile just `COPY mcp /opt/mcp`, so both modes execute the *same* `server.js`. This is why
the tool surface and `serverInfo.version` are identical by construction — preserve that property.
`VERSION` is single-sourced from `mcp/package.json`, and `mcp/server.test.js` **pins both the
version parity and the exact 12-verb tool registry**. Adding or renaming a tool intentionally breaks
that test — update the test, `README.md`, and `beeperbox.context.md` together.

### Container port topology (the confusing part)

Beeper's API binds `127.0.0.1:23373` *inside* the container, which a published Docker port cannot
reach. `entrypoint.sh` runs a `socat` forwarder `0.0.0.0:23380 → 127.0.0.1:23373`, and compose
publishes **host `23373` → container `23380`**. So the host-side port matches the raw API's port by
convention, but the container-side port does not. The `HEALTHCHECK` deliberately probes *through*
the forwarder (`:23380`) so a socat crash and an API crash both fail the probe.

### Bind address: the container's `0.0.0.0` is not a bug

`MCP_BIND_ADDR` defaults to **loopback** (`127.0.0.1`) — that is lite mode's only boundary, and a
same-network attacker can spoof the `Host` header past the allowlist if it binds wide. The Dockerfile
bakes `MCP_BIND_ADDR=0.0.0.0` because in the container the loopback *publish*
(`127.0.0.1:23375:23375`) is the boundary, not the bind. Do not "fix" either one. Same reasoning
baked `BEEPERBOX_PREFLIGHT=0` into the image: the entrypoint starts MCP *before* the API is ready, so
the lite-mode boot check would log a misleading failure on every container start.

### The three non-obvious mechanisms in `server.js`

- **Echo-guard** (`recordSent` / `resolveSentId` / `matchSentMessage`). Every API send is written to
  a per-user JSON ledger (`$XDG_CONFIG_HOME/beeperbox/sent-ledger.json`). Messages are tagged
  `source: "api" | "external"` plus an optional `client_tag`, so an agent that polls *and* sends the
  same chat never answers itself. It keys on **`source`, never `is_self`** — the owner's own typed
  Note-to-self commands are also `is_self: true`, and excluding those would kill the primary UX.
  Beeper returns a pending ID on send and a different final bridge ID on read-back, hence the
  resolve step plus a time-boxed text fallback.
- **`poll_messages` cursor** (`encodeCursor` / `isAfterCursor` / `advanceCursor` / `selectDelivery`).
  An opaque, restart-resumable cursor of `{ts, ids-at-that-ts}`; no implicit mark-read.
  `selectDelivery` fetches with headroom over the page size and delivers the oldest page — without
  that, a chat receiving more than `page` messages between polls silently loses the oldest ones.
- **`download_asset` guard** (`assertServableSrcUrl`). Allows `mxc://` / `localmxc://`, and `file://`
  **only inside Beeper's media cache** — real srcURLs are frequently `file://` there, so a blanket
  `file://` block breaks attachment resolution. Blocks traversal (including double-encoded), a
  non-empty `file://` host, and `http(s)://` (SSRF).

### Container supervision (`entrypoint.sh`)

Boots Xvfb → x11vnc → websockify (noVNC) → Beeper (Electron, `--no-sandbox`) → socat → MCP. Two
things it exists to fix: it clears the stale `/tmp/.X99-lock` that survives `docker restart` and
wedges Xvfb (previously only `docker rm` recovered), and it supervises `beepertexts` — if Beeper
dies, MCP and the forwarder stay up and keep *answering* while every tool call fails, so the
supervisor must catch it. It also traps SIGTERM to let Beeper flush Matrix sync / checkpoint SQLite.

## CI and release

`scripts/mcp-guard-check.sh` and `scripts/vnc-auth-check.sh` are the **single source of truth** for
the gates — `mcp-test.yml` / `vnc-test.yml` run them on PRs, and `release.yml` runs the same scripts
in its verify job. What blocks a PR and what blocks a release are identical by design.

- **GHCR** — push a `v*` tag → `release.yml` (prepare → verify → publish), multi-arch amd64+arm64,
  rolls `:latest` → `:previous`. Weekly cron rebuild picks up new Beeper Desktop stable.
- **npm** — `gh workflow run publish.yml --ref master`. OIDC trusted publishing, **no `NPM_TOKEN`**,
  idempotent. There is no npm auth in an agent session; npm publishes *only* through that workflow.

Keep npm == container == `serverInfo.version`.

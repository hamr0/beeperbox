# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- MEMORY:START -->
@.claude/remember/MEMORY.md
<!-- MEMORY:END -->

<!-- AGENT_RULES:START -->
Consult when building something new or adding a feature — a standards guide, not hot
context like MEMORY.md above:
.claude/remember/AGENT_RULES.md
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

# First-paint gate (one boot, fresh profile): login window renders + API reachable through the forwarder + HEALTHCHECK healthy — needs docker, curl + python3
bash scripts/first-paint-check.sh beeperbox:dev

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

### Opt-in webhook (`webhookConfig` / `webhookTick`)

Off unless `BEEPERBOX_WEBHOOK_URL` is set. An in-process loop calls `pollMessages` with its **own** persisted
cursor (`webhook-state.json` beside the sent-ledger) and POSTs one Standard Webhooks request per batch.
At-least-once: the batch is saved as `pending` *before* the POST and the cursor advances only on a 2xx.
Invalid config exits at startup; a corrupt/unreadable state file is moved aside, never silently reseeded over.
User-facing contract lives in `docs/GUIDE.md` ("Webhook").

### Container supervision (`entrypoint.sh`)

Boots Xvfb → x11vnc → websockify (noVNC) → Beeper (Electron, `--no-sandbox`) → socat → MCP. Two
things it exists to fix: it clears the stale `/tmp/.X99-lock` that survives `docker restart` and
wedges Xvfb (previously only `docker rm` recovered), and it supervises `beepertexts` — if Beeper
dies, MCP and the forwarder stay up and keep *answering* while every tool call fails, so the
supervisor must catch it. It also traps SIGTERM to let Beeper flush Matrix sync / checkpoint SQLite.

Beeper is launched with `--use-angle=swiftshader`: from Beeper 4.3.123 Chromium's default GL
fallback stalls the renderer under Xvfb (window never maps, login screen never paints) while the API
still comes up and the healthcheck stays green. `--disable-gpu` does not help. Do not remove the
flag; `scripts/first-paint-check.sh` is the gate.

## CI and release

`scripts/mcp-guard-check.sh`, `scripts/first-paint-check.sh` and `scripts/vnc-auth-check.sh` are the
**single source of truth** for the gates — `mcp-test.yml` runs the first two, `vnc-test.yml` the
third, and `release.yml` runs all three in its verify job (plus the first-paint gate again on a native arm64
runner, `verify-arm64`). The two VNC probes share the RFB handshake in `scripts/rfb.py`. What blocks a PR and what blocks a release are identical by design.

- **GHCR** — push a `v*` tag → `release.yml` (prepare → verify → publish), multi-arch amd64+arm64,
  rolls `:latest` → `:previous`. The **floor** Beeper is the one inside GHCR `:previous` (its `io.beeperbox.beeper-version` label, read anonymously by `scripts/floor-beeper-version.sh`); `beeper-version.txt` (read via `scripts/pinned-beeper-version.sh`) is only the last resort when `:previous` can't be read or is unlabelled. Releases read the file from the release ref (a ref without it fails `prepare`); `:edge` and the PR gate read it from the tree. All three, like `prepare`, use the promoted version when it is >= the floor (`scripts/promoted-beeper-version.sh`). For releases, `prepare` uses the **promoted** version instead when it is >= the floor: the newest `next-beeper-*` GHCR tag, i.e. a Beeper that passed the gates (`scripts/promoted-beeper-version.sh`; a failed lookup fails `prepare`, no silent fallback). It is passed as `BEEPER_VERSION` (otherwise the GHA build cache reuses a stale download). `publish` labels the image `io.beeperbox.beeper-version` and an explicit `org.opencontainers.image.revision` (the release ref's commit, not `github.sha`, which is master HEAD on cron/dispatch), and rolls `:latest` → `:previous` **only when the Beeper version or revision changed** (a missing label counts as changed).
  **`:next`** — `beeper-next.yml` (weekly + manual) builds master with the newest stable Beeper (`scripts/resolve-beeper-version.sh`) when it differs from the effective version (the greater of the pin and the promoted tag), runs the gates, publishes `:next` / `:next-beeper-<ver>`, opens a `beeper-update` issue, and its `promote` job dispatches `release.yml` (GITHUB_TOKEN `workflow_dispatch` does start runs). That rebuilds the newest release tag with the promoted Beeper and re-gates it; failed gates mean no dispatch and `:latest`/`:previous` don't move. No commit, PR or version bump is needed to promote a Beeper; raise `beeper-version.txt` only to raise the last-resort floor.
  **Escape routes.** If a promoted Beeper fails the release gates on released code, tag a release from `master`. That's the code that passed the gates with it. To pause a bad Beeper, delete its GHCR package version, either in the web UI (package settings) or with `gh api` after `gh auth refresh -s read:packages,delete:packages`. GHCR deletes the whole version, so this also removes `:next` when that tag points at the same image. The next weekly `beeper-next` re-promotes it if it still passes on `master`, so shipping from `master` is the real fix.
  A failed run (gate or publish) opens or comments on a `release-gate-failed` issue assigned to the owner (`notify-failure`).
- **npm** — `gh workflow run publish.yml --ref master`. OIDC trusted publishing, **no `NPM_TOKEN`**,
  idempotent. There is no npm auth in an agent session; npm publishes *only* through that workflow.

Keep npm == container == `serverInfo.version`.

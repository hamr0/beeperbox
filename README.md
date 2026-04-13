# beeperbox

Headless [Beeper Desktop](https://www.beeper.com/) in a container. One-time browser login, then a persistent local HTTP API on `127.0.0.1:23373` that **autonomous agents running on servers, VPSes, or in containers** can hit to send and receive messages across **every bridge Beeper supports** — WhatsApp, iMessage, Signal, Discord, Slack, Telegram, Facebook Messenger, Instagram, LinkedIn, and more.

Built for the case where there is **no human at a desktop running Beeper**: cron jobs that need to message you, AI agents on a VPS that handle customer chats, multi-tenant SaaS that fans out notifications across messengers, headless servers that need messaging reach. If you are a laptop user with Beeper Desktop already installed locally, you do not need beeperbox — Beeper's native MCP and API already serve you. beeperbox is for everyone else.

> **Status**: v0.2.0. Ten-tool MCP server inside the container, consumable over stdio or HTTP by any AI agent runtime that speaks Model Context Protocol (Claude Code, Cursor, Cline, bareagent, ...). Not production-hardened yet. See [CHANGELOG.md](CHANGELOG.md).

**Docs:**
- [**docs/GUIDE.md**](docs/GUIDE.md) — human setup walkthrough (install, first-run login, `.env` file, troubleshooting, VPS deployment)
- [**beeperbox.context.md**](beeperbox.context.md) — AI / developer integration guide (MCP tool reference, schemas, wiring snippets for Claude Code / Cursor / Cline / bareagent, error codes, patterns). Drop this into an agent's context window when you want the LLM to learn beeperbox quickly.

## Why

Most agent and bot frameworks default to Telegram because the BotFather workflow is frictionless. That's fine — until you need to reach users on WhatsApp, iMessage, or Signal. Then your options are:

| Approach | Reality |
|---|---|
| **Telegram bot only** | Free and instant, but one platform |
| **Self-hosted Matrix + mautrix bridges** | Hours of setup, fragile, locale + config footguns |
| **Beeper Matrix HTTP API** | Blocked — Megolm keys withheld from third-party clients, bridges stay encrypted |
| **Beeper Desktop local API** | Works with every bridge, but Beeper Desktop needs a GUI |
| **beeperbox** | Headless Beeper Desktop in Docker — local API survives without a display |

beeperbox runs Beeper Desktop inside a Debian 12 container with Xvfb + openbox + noVNC. You log in once through a browser (the VNC view is exposed on `:6080`), enable the local API, and from then on any agent on the same host can hit `http://localhost:23374/v1/*` to do messaging across every Beeper-supported platform.

## Quick start

Prerequisites: Docker engine + compose plugin (or compatible runtime like Podman with docker shim). ~1GB disk, ~600MB RAM idle, a Beeper account.

```sh
git clone https://github.com/hamr0/beeperbox.git
cd beeperbox
docker compose up -d
docker compose logs -f
```

Then:

1. Open **`http://localhost:6080/vnc.html`** in any browser → click **Connect** → log into Beeper Desktop as normal
2. In Beeper: **Settings → Developers**
   - Enable **API**
   - Enable **Start API on launch** (so it comes up automatically after container restarts)
3. Verify from the host:

```sh
curl http://localhost:23374/v1/spec
```

You should get the Beeper Desktop OpenAPI 3.1.0 spec. You're done.

The Beeper login and config persist in a Docker named volume (`beeperbox_config`), so subsequent container restarts do not require re-login.

## Architecture

```
┌──────────────────────── host ────────────────────────┐
│                                                      │
│   browser ──► :6080 ─┐                               │
│                      │                               │
│   agent  ──► :23374 ─┤                               │
│                      │                               │
│  ┌─── container ─────▼───────────────────────────┐   │
│  │                                               │   │
│  │   noVNC :6080 ──► x11vnc :5900 ──► Xvfb :99   │   │
│  │                                      ▲        │   │
│  │                                      │        │   │
│  │                               openbox (WM)    │   │
│  │                                      ▲        │   │
│  │                                      │        │   │
│  │                               Beeper Desktop  │   │
│  │                                      │        │   │
│  │                                      ▼        │   │
│  │                              API [::1]:23373  │   │
│  │                                      ▲        │   │
│  │                                      │ socat  │   │
│  │                              0.0.0.0 :23380 ──┘   │
│  │                                                │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**Why the `socat` shim**: Beeper Desktop's local API binds only to `[::1]:23373` (IPv6 loopback) and doesn't expose a flag to change that. Docker port mapping can't forward external traffic to a loopback-only socket, so a tiny socat process inside the container listens on `0.0.0.0:23380` and forwards to `[::1]:23373`. Docker then maps the host to `:23380`, not `:23373`.

**Why noVNC**: Beeper Desktop requires a one-time interactive OAuth login, and the "Start API on launch" toggle is only reachable via the GUI. noVNC gives you a browser-based view of that GUI without needing a real display.

## Ports

| Host | Container | Purpose | Notes |
|---|---|---|---|
| `6080` | `6080` | noVNC web UI | Only needed for first-run login + settings; can be closed after |
| `23373` | `23380` | Beeper Desktop API (via socat) | Default. Override with `BEEPERBOX_HOST_PORT=23374` if a native Beeper Desktop on the same host already owns `:23373`. |

Both ports are env-overridable so you never need to edit the compose file:

```sh
# default — most customers
docker compose up -d

# dev machine that already runs native Beeper Desktop on :23373
BEEPERBOX_HOST_PORT=23374 docker compose up -d

# noVNC clash too (rare)
BEEPERBOX_NOVNC_PORT=16080 BEEPERBOX_HOST_PORT=23374 docker compose up -d
```

## Persistent data

The `beeperbox_config` named volume maps to `/root/.config` inside the container. This contains the Beeper session, bridges, and cached state. Do not delete it unless you want to re-login from scratch.

```sh
docker volume inspect beeperbox_beeperbox_config
```

## Notes and caveats

- **Image size**: ~1GB. Electron + Chromium are the bulk. Alpine is not a drop-in replacement (musl breaks Chromium).
- **Idle RAM**: ~500MB. Active usage ~700MB. Fits on a $5/month VPS alongside one small agent.
- **Sandbox flags**: Beeper runs with `--no-sandbox --disable-gpu --disable-dev-shm-usage` because Docker containers don't expose the kernel namespaces Chromium normally relies on. This is standard for headless Electron.
- **WhatsApp on-device bridge**: emits `no bridge event found` errors in logs during initial sync. These are harmless — the Matrix SDK is trying to back up message receipts but lacks corresponding local events. Ignore them.
- **ToS**: You're running your own Beeper account in a container. Using it to spam or run abusive automation will likely get the account flagged. Build respectful agents.
- **This is not a Beeper product.** It is an independent wrapper around the official Beeper Desktop AppImage. No affiliation with Beeper / Automattic.

## Roadmap

- [x] **v0.1.0** POC: debian slim + Xvfb + Beeper AppImage + noVNC + socat
- [x] **v0.1.0** Container `HEALTHCHECK` via socat-forwarded `/v1/info`
- [x] **v0.1.0** GitHub Actions workflow publishing image to GHCR on tag
- [x] **v0.2.0** Opinionated MCP server with 10 semantic tools (list_inbox, read_chat, send_message, note_to_self, list_unread, search_messages, react_to_message, archive_chat, get_chat, list_accounts) over both HTTP and stdio transports
- [x] **v0.2.1** Read-only vs read-write tokens documented, multi-instance VPS pattern documented + verified
- [x] **v0.3.0** Multi-arch image (linux/amd64 + linux/arm64) for Raspberry Pi, Oracle Cloud free ARM tier, Hetzner CAX, AWS Graviton, Apple Silicon Macs
- [ ] **v0.4.0** Typed Node client (`@beeperbox/node`)
- [ ] **v0.5.0** Python client on PyPI

## License

MIT. See [LICENSE](LICENSE) when added.

## Related

- [Beeper Desktop](https://www.beeper.com/) — the upstream app this containerizes
- [Beeper Desktop API docs](https://developers.beeper.com/) — official API reference
- [multis](https://github.com/hamr0/multis) — the personal-assistant project that drove beeperbox's extraction

```
                ╭──────────────────────────────────╮
                │  ╔╗ ╔═╗╔═╗╔═╗╔═╗╦═╗╔╗ ╔═╗ ╦ ╦    │
                │  ╠╩╗╠╣ ╠╣ ╠═╝╠╣ ╠╦╝╠╩╗║ ║ ╚╦╝    │
                │  ╚═╝╚═╝╚═╝╩  ╚═╝╩╚═╚═╝╚═╝ ╩ ╩    │
                │   one agent ──→ 50+ messengers   │
                ╰──────────────────────────────────╯
```

<p align="center">
  <a href="https://github.com/hamr0/beeperbox/actions/workflows/mcp-test.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/beeperbox/mcp-test.yml?label=mcp-test" alt="mcp-test"></a>
  <a href="https://github.com/hamr0/beeperbox/actions/workflows/vnc-test.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/beeperbox/vnc-test.yml?label=vnc-test" alt="vnc-test"></a>
  <img src="https://img.shields.io/github/v/tag/hamr0/beeperbox?sort=semver&label=version&color=2a4f8c" alt="version (auto from latest git tag)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Plug your AI agent into 50+ messengers through a single MCP endpoint — in Docker, or as a one-line `npx`.**

WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix — everything [Beeper](https://www.beeper.com/) bridges, reachable from one HTTP or MCP endpoint instead of 50 per-platform SDKs, OAuth dances, and rate-limit quirks. If you only need Telegram, this is overkill — use [openclaw](https://github.com/openclaw/openclaw) or any BotFather library. If you need reach across many networks from one agent, keep reading.

## Two ways to run

Both modes run the [same single file](mcp/server.js), so they have the same 12 tools and the same `serverInfo.version`. Pick by where Beeper lives:

| | **Container** | **Lite** (`npx`) |
|---|---|---|
| Beeper Desktop | bundled, headless, in Docker | yours, already open on this machine |
| Needs | Docker + compose, ~1 GB disk, ~600 MB RAM | Node 18+ |
| Best for | always-on, VPS, headless | a laptop already running Beeper |
| First login | once, in noVNC at `:6080` | already done in your Beeper |
| Restart on crash | Docker restart policy | yours (`systemd` / `pm2`) |

Both need a Beeper access token: **Settings → Developers** → enable the API → create a token.

### Container

```sh
curl -LO https://raw.githubusercontent.com/hamr0/beeperbox/master/docker-compose.yml
docker compose up -d
# open http://localhost:6080/vnc.html, sign in to Beeper, create the token, then:
echo "BEEPER_TOKEN=abc123..." > .env
docker compose up -d
```

The image is `ghcr.io/hamr0/beeperbox:latest`, built for amd64 and arm64. Pin a version with `BEEPERBOX_IMAGE_TAG=0.10.0`. `:edge` tracks master and may break. `:next` is master built with the newest stable Beeper Desktop, published once it passes the release gates. `:latest` uses the newest stable Beeper that passed those gates, promoted automatically every week; if a new Beeper fails them, `:latest` stays where it is. `:previous` is the prior `:latest`. Your login is kept in a named volume, and `docker restart` recovers cleanly.

> `:previous` rolls back beeperbox, not Beeper's data. Once a newer Beeper has opened your volume, it upgrades the database and an older Beeper can't open it again. To keep a guaranteed way back, back up the volume before pulling a new `:latest`:

```sh
mkdir -p ~/beeperbox-backups && chmod 700 ~/beeperbox-backups
docker compose stop
docker run --rm -v beeperbox_beeperbox_config:/data -v ~/beeperbox-backups:/backup:Z alpine tar czf /backup/beeperbox-config-$(date +%F).tar.gz -C /data .
ls -l ~/beeperbox-backups
docker compose start
```

The volume name is `<compose project>_beeperbox_config`; check it with `docker volume ls`. `:Z` lets the container write on SELinux hosts (Fedora, RHEL) by relabelling the folder for container use, so keep backups in a folder of their own, never your home folder itself. To restore, stop the container, empty the volume (or use a fresh one), and run:

```sh
docker run --rm -v beeperbox_beeperbox_config:/data -v ~/beeperbox-backups:/backup:Z alpine tar xzf /backup/beeperbox-config-YYYY-MM-DD.tar.gz -C /data
```

| Host port | Purpose | Override |
|---|---|---|
| `6080` | noVNC, first login only | `BEEPERBOX_NOVNC_PORT` |
| `23373` | raw Beeper Desktop API | `BEEPERBOX_HOST_PORT` |
| `23375` | MCP server | `BEEPERBOX_MCP_PORT` |

All three are bound to `127.0.0.1`. For remote access, use an SSH tunnel, Tailscale or a TLS reverse proxy. Never drop the `127.0.0.1` prefix.

### Lite

```sh
BEEPER_TOKEN=abc123... npx beeperbox          # HTTP on 127.0.0.1:23375
BEEPER_TOKEN=abc123... npx beeperbox --stdio  # stdio
```

On boot it logs one line, so a bad token or an unreachable API shows up right away: `preflight OK: http://127.0.0.1:23373 reachable, token accepted, 4 account(s)`.

| Env | Default | |
|---|---|---|
| `BEEPER_TOKEN` | — | required |
| `BEEPER_API` | `http://127.0.0.1:23373` | your Beeper Desktop API |
| `MCP_PORT` | `23375` | |
| `MCP_BIND_ADDR` | `127.0.0.1` | see the warning below |
| `MCP_AUTH_TOKEN` | unset | bearer guard on the MCP endpoint |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` | Host/Origin allowlist |

Lite mode binds loopback on purpose. Do **not** just set `MCP_BIND_ADDR=0.0.0.0`: anyone on your network could then spoof the `Host` header, read every message and send on every network. To expose it, also set `MCP_AUTH_TOKEN` and put a tunnel in front. (The container binds `0.0.0.0` safely because Docker publishes the port only on `127.0.0.1`.)

### Connect a client

```sh
curl -X POST http://localhost:23375 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For stdio from the container, use `docker exec -i beeperbox node /opt/mcp/server.js --stdio`. It works with Claude Code, Cursor, Cline, Continue, [bareagent](https://github.com/hamr0/bareagent) or any other MCP client.

## The MCP

This is not a thin proxy over Beeper's API. It is 12 verbs built for an LLM to use. Every tool returns the same normalized `Chat` / `Message` schema, and every message includes its `chat_id` and `network`.

| | Tool | What it does |
|---|---|---|
| **read** | `list_accounts` | connected networks, with connection `status` |
| | `list_inbox` | most recently active chats, with unread counts |
| | `list_unread` | only chats with `unread_count > 0` |
| | `get_chat` | one chat's metadata |
| | `read_chat` | a chat's recent messages, oldest first |
| | `search_messages` | full-text search across every chat |
| | `download_asset` | an attachment's bytes (base64), by `src_url` or `chat_id` + `message_id` |
| **write** | `send_message` | reply or start a chat; markdown, `reply_to_message_id`, optional `client_tag` |
| | `note_to_self` | the agent's private command channel, hidden from inbox views |
| | `react_to_message` | an emoji reaction, visible on every network |
| | `archive_chat` | marks a chat done (Beeper has no mark-as-read) |
| **watch** | `poll_messages` | new messages since a cursor; restart-safe, no side effects, reports `gaps` |
| **push** | webhook *(opt-in, experimental)* | beeperbox POSTs to you when messages arrive, so you don't have to poll |

Each message has a `source` field: `"api"` for messages beeperbox sent, `"external"` for everything else. An agent that both sends and watches a chat can use it to skip its own messages.

**Webhook.** It is off by default and doesn't change the 12 tools. When you set `BEEPERBOX_WEBHOOK_URL`, beeperbox runs its own `poll_messages` loop and saves its cursor, so it picks up where it left off after a restart. Each batch is sent as one signed Standard Webhooks POST. Delivery is at-least-once, so dedupe by message id. `ping` sends message ids and counts; `full` also sends the messages, up to 64 KiB per batch. If the receiver is down while more than 100 messages arrive in one chat, older ones can be skipped. That chat is then marked `possible_gap: true`; use `read_chat` to catch up.

```sh
BEEPERBOX_WEBHOOK_URL=https://bot.example/hook   # https, or http to loopback only
BEEPERBOX_WEBHOOK_SECRET=whsec_...               # required unless loopback
BEEPERBOX_WEBHOOK_MODE=ping                      # or full
BEEPERBOX_WEBHOOK_INTERVAL_MS=10000              # floor 1000
```

The full contract (payload, headers, state file, retries) is in [GUIDE.md → Webhook](docs/GUIDE.md#webhook-opt-in-experimental).

## Build from source

Only if you're hacking on the image itself or running air-gapped:

```sh
git clone https://github.com/hamr0/beeperbox.git && cd beeperbox
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Docs

- [**docs/GUIDE.md**](docs/GUIDE.md) — human walkthrough: first-run login, multi-instance VPS pattern, read-only vs read-write tokens, troubleshooting
- [**beeperbox.context.md**](beeperbox.context.md) — drop-in integration guide for AI assistants: MCP tools, schemas, wiring snippets for Claude Code / Cursor / Cline / bareagent, error codes
- [Beeper Desktop](https://www.beeper.com/) — upstream app this containerizes
- [Beeper Desktop API](https://developers.beeper.com/) — official API reference
- [multis](https://github.com/hamr0/multis) — personal-assistant project that drove beeperbox's extraction

## bare suite

- **Hands** · [barebrowse](https://github.com/hamr0/barebrowse) · [baremobile](https://github.com/hamr0/baremobile) · **beeperbox**
- **Rails** · [bareagent](https://github.com/hamr0/bareagent) · [bareguard](https://github.com/hamr0/bareguard) · [barebox](https://github.com/hamr0/barebox) · [litectx](https://github.com/hamr0/litectx)
- **Apps** · [fwdloop](https://github.com/hamr0/fwdloop) · [bareloop](https://github.com/hamr0/bareloop)

Pairs well with [bareguard](https://github.com/hamr0/bareguard) (ask before anything is sent). → [The whole suite](https://github.com/hamr0)

## License

[Apache-2.0](LICENSE). Independent wrapper around Beeper Desktop, no affiliation with Beeper / Automattic.

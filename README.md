# beeperbox

Headless [Beeper Desktop](https://www.beeper.com/) in a container. One config, one command, 50+ messengers — **WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Facebook Messenger, Instagram, LinkedIn, Google Messages, Matrix**, and every other bridge Beeper supports.

Autonomous agents running on servers, VPSes, or in containers get a single MCP-speaking endpoint that reaches every chat network the user is logged into, through one account, with zero per-platform setup.

> **Status**: v0.3.1. Multi-arch (linux/amd64 + linux/arm64). Ten-tool MCP server over stdio + HTTP, consumable by Claude Code, Cursor, Cline, Continue, [bareagent](https://github.com/hamr0/bareagent), or any other runtime that speaks Model Context Protocol. Not production-hardened. See [CHANGELOG.md](CHANGELOG.md).

**Docs:**
- [**docs/GUIDE.md**](docs/GUIDE.md) — human setup walkthrough: install, first-run login, `.env` file, multi-instance VPS pattern, troubleshooting
- [**beeperbox.context.md**](beeperbox.context.md) — AI / dev integration guide: MCP tools, schemas, wiring snippets, error codes, patterns. Drop it into an agent's context window.

## When to use beeperbox — and when not to

**Don't use beeperbox if you only need Telegram.** Telegram is a solved problem with a thousand free frameworks — [openclaw](https://github.com/openclaw/openclaw) and every BotFather-based library work well for single-platform bots. beeperbox is more container, more complexity, and more resources than Telegram-only bots need.

**Use beeperbox when you need reach across many messengers at once.** One Beeper account connects WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Facebook Messenger, Instagram, LinkedIn, Google Messages, and more. beeperbox makes all of them reachable through one local MCP endpoint your agent can hit from anywhere:

- Free (MIT) and self-hosted
- Docker-contained — no per-platform SDK, no per-platform pairing per agent
- Works headlessly on any VPS / Pi / ARM box (no GUI required at runtime)
- Stdio and HTTP MCP transports for any agent runtime
- Read-only and read-write token scopes via Beeper's native permission model
- Per-user isolation via one container per Beeper account

If a human-attended Beeper Desktop is already running on your laptop, Beeper ships its own HTTP API and MCP server natively — you don't need beeperbox. beeperbox is for the opposite case: servers, cron jobs, cloud agents, anywhere a GUI is not an option.

## Quick start

Prerequisites: Docker engine + compose plugin, ~1GB disk, ~600MB RAM, a Beeper account.

```sh
curl -LO https://raw.githubusercontent.com/hamr0/beeperbox/master/docker-compose.yml
docker compose up -d
```

This pulls the pre-built multi-arch image from GHCR (`ghcr.io/hamr0/beeperbox:latest`). No clone, no build. Pin to a specific version with `BEEPERBOX_IMAGE_TAG=0.3.1 docker compose up -d`, or track master with `:edge` (bleeding-edge, may break).

Prefer to build from source? Clone the repo and overlay the dev compose file:

```sh
git clone https://github.com/hamr0/beeperbox.git && cd beeperbox
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Then follow the 10-step quick setup in [docs/GUIDE.md](docs/GUIDE.md#quick-setup-10-minutes-one-time):
1. Open `http://localhost:6080/vnc.html` and log in to Beeper Desktop once
2. Settings → Developers → enable API + create an access token
3. Save the token in a `.env` file
4. `docker compose up -d` again to pick up the token
5. Test with curl against `http://localhost:23373/v1/info` or against the MCP server on `http://localhost:23375`

The login and config persist in a Docker named volume, so subsequent restarts do not require re-login.

## Ports (defaults)

| Host | Purpose |
|---|---|
| `6080` | noVNC web UI — first-run login only |
| `23373` | Raw Beeper Desktop HTTP API |
| `23375` | Opinionated MCP server (stdio also supported) |

All three are bound to `127.0.0.1` and env-overridable via `BEEPERBOX_NOVNC_PORT`, `BEEPERBOX_HOST_PORT`, `BEEPERBOX_MCP_PORT`. See [docs/GUIDE.md#ports](docs/GUIDE.md#ports).

## Roadmap

- [x] **v0.1.0** POC — Debian 12 slim + Xvfb + Beeper AppImage + noVNC + socat + healthcheck + GHCR release workflow
- [x] **v0.2.0** MCP server with 10 semantic tools over stdio + HTTP, note-to-self vs inbox split, normalized Chat / Message schemas
- [x] **v0.2.1** Read-only vs read-write tokens documented, multi-instance-on-one-VPS pattern verified
- [x] **v0.3.1** Multi-arch image (linux/amd64 + linux/arm64) for Raspberry Pi, Oracle Cloud free ARM tier, Hetzner CAX, AWS Graviton, Apple Silicon Macs
- [ ] Whatever the first real user issue asks for

The original roadmap had typed Node and Python clients as v0.4 / v0.5 items. Dropped — the MCP layer already covers every language-agnostic consumer (Claude Code, Cursor, Cline, bareagent, and anything else that speaks MCP), and non-agent HTTP clients in Node or Python can call `http://localhost:23373/v1/*` directly with ~5 lines of vanilla `fetch` or `urllib`. Revisit only if someone files an issue.

## License

[MIT](LICENSE). Independent wrapper around Beeper Desktop, no affiliation with Beeper / Automattic.

## Related

- [Beeper Desktop](https://www.beeper.com/) — the upstream app this containerizes
- [Beeper Desktop API docs](https://developers.beeper.com/) — official API reference
- [bareagent](https://github.com/hamr0/bareagent) — lightweight agent orchestration library; consumes beeperbox via its MCP bridge
- [multis](https://github.com/hamr0/multis) — personal-assistant project that drove beeperbox's extraction

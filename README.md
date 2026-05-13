```
                ╭──────────────────────────────────╮
                │  ╔╗ ╔═╗╔═╗╔═╗╔═╗╦═╗╔╗ ╔═╗ ╦ ╦    │
                │  ╠╩╗╠╣ ╠╣ ╠═╝╠╣ ╠╦╝╠╩╗║ ║ ╚╦╝    │
                │  ╚═╝╚═╝╚═╝╩  ╚═╝╩╚═╚═╝╚═╝ ╩ ╩    │
                │   one agent ──→ 50+ messengers   │
                ╰──────────────────────────────────╯
```

<p align="center">
  <a href="https://github.com/hamr0/beeperbox/releases"><img src="https://img.shields.io/github/v/tag/hamr0/beeperbox?sort=semver&label=version&color=2a4f8c" alt="version (auto from latest git tag)"></a>
  <a href="https://www.npmjs.com/package/beeperbox-mcp"><img src="https://img.shields.io/npm/v/beeperbox-mcp?label=npm%3A%20beeperbox-mcp&color=2a4f8c" alt="npm: beeperbox-mcp"></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**One Docker container that plugs your AI agent into 50+ messengers through a single MCP endpoint.**

WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix — everything [Beeper](https://www.beeper.com/) bridges, reachable from one HTTP or MCP endpoint instead of 50 per-platform SDKs, OAuth dances, and rate-limit quirks. If you only need Telegram, this is overkill — use [openclaw](https://github.com/openclaw/openclaw) or any BotFather library. If you need reach across many networks from one agent, keep reading.

## Quick start

Prereqs: Docker + compose plugin, ~1 GB disk, ~600 MB RAM, a Beeper account.

**1. Pull and run**

```sh
curl -LO https://raw.githubusercontent.com/hamr0/beeperbox/master/docker-compose.yml
docker compose up -d
```

Pulls the pre-built multi-arch image (`ghcr.io/hamr0/beeperbox:latest`, `linux/amd64` + `linux/arm64`). No clone, no build. Pin a version with `BEEPERBOX_IMAGE_TAG=0.3.3 docker compose up -d`, or track master with `:edge` (may break).

**2. Log in once**

Open `http://localhost:6080/vnc.html`, sign into Beeper, then **Settings → Developers** → enable the API and create an access token. Save it:

```sh
echo "BEEPER_TOKEN=abc123..." > .env
docker compose up -d
```

Login and bridge state persist in a named volume — you won't log in again after restarts.

**3. Talk to it**

```sh
# Raw Beeper Desktop API
curl -H "Authorization: Bearer $BEEPER_TOKEN" http://localhost:23373/v1/info

# MCP server (HTTP transport)
curl -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For stdio MCP, point any MCP client at `docker exec -i beeperbox node /opt/mcp/server.js --stdio`, or run the wrapper on the host with `npx -y beeperbox-mcp --stdio` (same server, no `docker exec`; reads `BEEPER_API` + `BEEPER_TOKEN` from env). Works with Claude Code, Cursor, Cline, Continue, [bareagent](https://github.com/hamr0/bareagent), or anything that speaks Model Context Protocol.

Done.

## Ports

| Host | Purpose | Bound to |
|---|---|---|
| `6080` | noVNC web UI — first-run login only | `127.0.0.1` |
| `23373` | Raw Beeper Desktop HTTP API | `127.0.0.1` |
| `23375` | Opinionated 10-tool MCP server | `127.0.0.1` |

All three are env-overridable (`BEEPERBOX_NOVNC_PORT`, `BEEPERBOX_HOST_PORT`, `BEEPERBOX_MCP_PORT`) so you can run multiple instances on one VPS. For remote access use SSH tunnel, Tailscale, or a TLS reverse proxy — never drop the `127.0.0.1` prefix.

## Build from source

Only if you're hacking on the image itself or running air-gapped:

```sh
git clone https://github.com/hamr0/beeperbox.git && cd beeperbox
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Docs

- [**docs/GUIDE.md**](docs/GUIDE.md) — human walkthrough: first-run login, multi-instance VPS pattern, read-only vs read-write tokens, troubleshooting
- [**beeperbox.context.md**](beeperbox.context.md) — drop-in integration guide for AI assistants: MCP tools, schemas, wiring snippets for Claude Code / Cursor / Cline / bareagent, error codes
- [**CHANGELOG.md**](CHANGELOG.md) — version history and [versioning policy](CHANGELOG.md#versioning). tl;dr **MINOR** = new runtime behavior (new MCP tool, new architecture, new transport), **PATCH** = bug fixes + packaging + docs. `MAJOR` held at `0` until the MCP tool set and HTTP API are declared stable.

## License

[Apache-2.0](LICENSE). Independent wrapper around Beeper Desktop, no affiliation with Beeper / Automattic.

## Related

- [Beeper Desktop](https://www.beeper.com/) — upstream app this containerizes
- [Beeper Desktop API](https://developers.beeper.com/) — official API reference
- [bareagent](https://github.com/hamr0/bareagent) — lightweight agent orchestration that consumes beeperbox via MCP
- [multis](https://github.com/hamr0/multis) — personal-assistant project that drove beeperbox's extraction

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

**One Docker container that plugs your AI agent into 50+ messengers through a single MCP endpoint.**

WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix — everything [Beeper](https://www.beeper.com/) bridges, reachable from one HTTP or MCP endpoint instead of 50 per-platform SDKs, OAuth dances, and rate-limit quirks. If you only need Telegram, this is overkill — use [openclaw](https://github.com/openclaw/openclaw) or any BotFather library. If you need reach across many networks from one agent, keep reading.

## Quick start

Prereqs: Docker + compose plugin, ~1 GB disk, ~600 MB RAM, a Beeper account.

**1. Pull and run**

```sh
curl -LO https://raw.githubusercontent.com/hamr0/beeperbox/master/docker-compose.yml
docker compose up -d
```

Pulls the pre-built multi-arch image (`ghcr.io/hamr0/beeperbox:latest`, `linux/amd64` + `linux/arm64`). No clone, no build. Pin a version with `BEEPERBOX_IMAGE_TAG=0.7.0 docker compose up -d`, or track master with `:edge` (may break).

**2. Log in once**

Open `http://localhost:6080/vnc.html`, sign into Beeper, then **Settings → Developers** → enable the API and create an access token. Save it:

```sh
echo "BEEPER_TOKEN=abc123..." > .env
docker compose up -d
```

Login and bridge state persist in a named volume — you won't log in again after restarts, and `docker restart` recovers cleanly (the entrypoint clears the stale display lock that used to wedge a restarted container).

**3. Talk to it**

```sh
# Raw Beeper Desktop API
curl -H "Authorization: Bearer $BEEPER_TOKEN" http://localhost:23373/v1/info

# MCP server (HTTP transport)
curl -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For stdio MCP, point any MCP client at `docker exec -i beeperbox node /opt/mcp/server.js --stdio`. Works with Claude Code, Cursor, Cline, Continue, [bareagent](https://github.com/hamr0/bareagent), or anything that speaks Model Context Protocol.

Done.

## Ports

| Host | Purpose | Bound to |
|---|---|---|
| `6080` | noVNC web UI — first-run login only | `127.0.0.1` |
| `23373` | Raw Beeper Desktop HTTP API | `127.0.0.1` |
| `23375` | Opinionated 12-tool MCP server | `127.0.0.1` |

All three are env-overridable (`BEEPERBOX_NOVNC_PORT`, `BEEPERBOX_HOST_PORT`, `BEEPERBOX_MCP_PORT`) so you can run multiple instances on one VPS. For remote access use SSH tunnel, Tailscale, or a TLS reverse proxy — never drop the `127.0.0.1` prefix.

## Lite mode

Two ways to run beeperbox, same verb layer:

| | **Container** (above) | **Lite mode** |
|---|---|---|
| Beeper Desktop | bundled, headless, in Docker | **you** supply it (already open on your machine) |
| Needs | Docker | just Node 18+ |
| Best for | always-on, VPS, headless | laptop users with Beeper already running |

Lite mode runs only the MCP verb server against a Beeper Desktop you already run locally — no Docker, no Electron, no Xvfb. It's the same single file the container runs, so the tool surface and `serverInfo.version` are identical by construction.

**Prereqs:** Beeper Desktop running locally, with the Developer API enabled — **Settings → Developers** → enable the API and create an access token (the same token the container uses).

**Run it:**

```sh
BEEPER_TOKEN=your-token-here npx beeperbox
```

MCP HTTP server comes up on `http://127.0.0.1:23375`, pointed at the local Beeper API on `http://127.0.0.1:23373`. On boot it logs a one-line reachability verdict so a bad token or unreachable API is obvious immediately:

```
[beeperbox-mcp] preflight OK: http://127.0.0.1:23373 reachable, token accepted, 4 account(s)
```

For stdio transport (Claude Code, Cursor, Cline, Continue, bareagent), add `--stdio`:

```sh
BEEPER_TOKEN=your-token-here npx beeperbox --stdio
```

**Env contract:**

| Env | Meaning | Default |
|---|---|---|
| `BEEPER_API` | Local Beeper Desktop API base | `http://127.0.0.1:23373` |
| `BEEPER_TOKEN` | Beeper dev token (Settings → Developers) | — (required) |
| `MCP_PORT` | MCP HTTP port | `23375` |
| `MCP_AUTH_TOKEN` | Optional bearer guard on the MCP endpoint | unset (open on loopback) |
| `MCP_ALLOWED_HOSTS` | Host/Origin allowlist | `localhost,127.0.0.1,::1` |
| `MCP_BIND_ADDR` | Interface the MCP server binds | `127.0.0.1` (loopback) |

**Security:** lite mode binds **loopback only** (`127.0.0.1`) by default, so it's safe with no auth — only processes on your machine (your agent, Claude Code) can reach it. Do **not** just flip it to `0.0.0.0`: a same-network attacker can spoof the `Host` header past the allowlist and reach the full tool surface (read every message, send across every network) unauthenticated. To expose it deliberately, set `MCP_BIND_ADDR=0.0.0.0` **and** `MCP_AUTH_TOKEN`, and front it with a tunnel (SSH / Tailscale / TLS reverse proxy) — never raw on a public interface. (The container binds `0.0.0.0` on purpose because Docker publishes it on `127.0.0.1` — that loopback *publish* is its boundary; lite mode has no such layer, which is why its *bind* is loopback.)

**Supervision:** no Docker restart policy here — for an always-on lite setup, run it under `systemd` or `pm2`.

**What lite mode is *not*:** it does not bundle or headless-run Beeper (that's the container's job). No new verbs, no transport changes — it's the same server, packaged and safe to run standalone.

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

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

## License

[Apache-2.0](LICENSE). Independent wrapper around Beeper Desktop, no affiliation with Beeper / Automattic.

## Related

- [Beeper Desktop](https://www.beeper.com/) — upstream app this containerizes
- [Beeper Desktop API](https://developers.beeper.com/) — official API reference
- [bareagent](https://github.com/hamr0/bareagent) — lightweight agent orchestration that consumes beeperbox via MCP
- [multis](https://github.com/hamr0/multis) — personal-assistant project that drove beeperbox's extraction

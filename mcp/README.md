```
                ╭──────────────────────────────────╮
                │  ╔╗ ╔═╗╔═╗╔═╗╔═╗╦═╗╔╗ ╔═╗ ╦ ╦    │
                │  ╠╩╗╠╣ ╠╣ ╠═╝╠╣ ╠╦╝╠╩╗║ ║ ╚╦╝    │
                │  ╚═╝╚═╝╚═╝╩  ╚═╝╩╚═╚═╝╚═╝ ╩ ╩    │
                │   one agent ──→ 50+ messengers   │
                ╰──────────────────────────────────╯
```

<p align="center">
  <a href="https://www.npmjs.com/package/beeperbox"><img src="https://img.shields.io/npm/v/beeperbox?label=npm&color=2a4f8c" alt="npm version"></a>
  <a href="https://github.com/hamr0/beeperbox"><img src="https://img.shields.io/badge/source-github-2a4f8c" alt="source on GitHub"></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Run beeperbox's MCP verb server against a Beeper Desktop you already have open — no Docker, no Electron, no Xvfb.**

This is the *lite* half of [beeperbox](https://github.com/hamr0/beeperbox). The full project ships a Docker image with a headless Beeper Desktop inside; lite mode is the same single-file, zero-dependency MCP server pointed at a Beeper Desktop **you** run on your laptop. Identical verb surface, identical version — you just supply Beeper.

- **Always-on / VPS / no local Beeper?** Use the [Docker image](https://github.com/hamr0/beeperbox#quick-start-container).
- **Beeper already open on your machine?** Use this.

## Quick start

**Prereqs:** Beeper Desktop running locally, with the Developer API enabled — Beeper → **Settings → Developers** → enable the API and create an access token (the same token the container uses).

```sh
BEEPER_TOKEN=your-token-here npx beeperbox
```

That starts the MCP HTTP server on `http://127.0.0.1:23375`, pointed at the local Beeper Desktop API on `http://127.0.0.1:23373`. On boot it logs a one-line reachability verdict (`preflight OK: … N account(s)` or `preflight FAIL: …`) so a misconfigured token or API is obvious immediately.

For stdio transport (Claude Code, Cursor, Cline, Continue, [bareagent](https://npmjs.com/package/bare-agent)):

```sh
BEEPER_TOKEN=your-token-here npx beeperbox --stdio
```

## The 12 tools

One opinionated MCP verb layer over Beeper — every tool returns a normalized `Chat` / `Message` schema, propagates `chat_id` + `network` onto every message, and is documented in-schema for the model. Reach across all 50+ networks without knowing which bridge you're talking to.

- **Read / triage** — `list_accounts` · `list_inbox` · `list_unread` · `get_chat` · `read_chat` · `search_messages`
- **Write / act** — `send_message` · `note_to_self` · `react_to_message` · `archive_chat`
- **Watch / reach** — `poll_messages` (read-only watch primitive, restart-safe cursor, `source` echo-guard) · `download_asset` (attachment bytes; every message carries `attachments[]`)

Full schemas and usage in the [main README](https://github.com/hamr0/beeperbox#the-mcp).

## Config

| Env | Meaning | Default |
|---|---|---|
| `BEEPER_API` | Local Beeper Desktop API base | `http://127.0.0.1:23373` |
| `BEEPER_TOKEN` | Beeper dev token (Settings → Developers) | — (required) |
| `MCP_PORT` | MCP HTTP port | `23375` |
| `MCP_AUTH_TOKEN` | Optional bearer guard on the MCP endpoint | unset (open on loopback) |
| `MCP_ALLOWED_HOSTS` | Host/Origin allowlist | `localhost,127.0.0.1,::1` |
| `MCP_BIND_ADDR` | Interface the MCP server binds | `127.0.0.1` (loopback) |

## Security

The server binds **loopback only** (`127.0.0.1`) by default, so it's safe with no auth — only processes on your own machine can reach it. Don't just set it to `0.0.0.0`: a same-network attacker can spoof the `Host` header past the allowlist and reach the full tool surface (read every message, send across every network) unauthenticated. To expose it deliberately, set `MCP_BIND_ADDR=0.0.0.0` **and** `MCP_AUTH_TOKEN`, and put it behind a tunnel (SSH / Tailscale / TLS reverse proxy) — never raw on a public interface.

## Supervision

There's no Docker restart policy in lite mode. For an always-on setup, run it under `systemd` or `pm2`.

See the [full README](https://github.com/hamr0/beeperbox#the-mcp) and [docs/GUIDE.md](https://github.com/hamr0/beeperbox/blob/master/docs/GUIDE.md) for the complete tool reference and the container build.

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout — mix and match, each module works standalone.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.*
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.*
- **[litectx](https://npmjs.com/package/litectx)** — code + memory graph with activation decay. *Query in → ranked context out.*
- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.*
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.*
- **beeperbox** *(this)* — 50+ messaging networks via one MCP server. *Chat in → unified message stream out.*

## License

[Apache-2.0](https://github.com/hamr0/beeperbox/blob/master/LICENSE). Independent wrapper around Beeper Desktop, no affiliation with Beeper / Automattic.

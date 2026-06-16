# beeperbox (lite mode)

**Run beeperbox's MCP verb server against a Beeper Desktop you already have open — no Docker, no Electron, no Xvfb.**

This is the *lite* half of [beeperbox](https://github.com/hamr0/beeperbox). The full project ships a Docker image with a headless Beeper Desktop inside; lite mode is the same single-file, zero-dependency MCP server pointed at a Beeper Desktop **you** run on your laptop. Identical verb surface, identical version — you just supply Beeper.

- **Always-on / VPS / no local Beeper?** Use the [Docker image](https://github.com/hamr0/beeperbox#quick-start).
- **Beeper already open on your machine?** Use this.

## Prerequisites

1. **Beeper Desktop** running locally.
2. **Developer API enabled:** Beeper → **Settings → Developers** → enable the API and create an access token (the same token the container uses).

## Run

```sh
BEEPER_TOKEN=your-token-here npx beeperbox
```

That starts the MCP HTTP server on `http://127.0.0.1:23375`, pointed at the local Beeper Desktop API on `http://127.0.0.1:23373`. On boot it logs a one-line reachability verdict (`preflight OK: … N account(s)` or `preflight FAIL: …`) so a misconfigured token or API is obvious immediately.

For stdio transport (Claude Code, Cursor, Cline, Continue, bareagent):

```sh
BEEPER_TOKEN=your-token-here npx beeperbox --stdio
```

## Config

| Env | Meaning | Default |
|---|---|---|
| `BEEPER_API` | Local Beeper Desktop API base | `http://127.0.0.1:23373` |
| `BEEPER_TOKEN` | Beeper dev token (Settings → Developers) | — (required) |
| `MCP_PORT` | MCP HTTP port | `23375` |
| `MCP_AUTH_TOKEN` | Optional bearer guard on the MCP endpoint | unset (open on loopback) |
| `MCP_ALLOWED_HOSTS` | Host/Origin allowlist | `localhost,127.0.0.1,::1` |

## Security

The server binds `0.0.0.0` but is meant to stay loopback-only: it's safe on `127.0.0.1` with no auth. To expose it beyond your machine, set `MCP_AUTH_TOKEN` **and** `MCP_ALLOWED_HOSTS`, and put it behind a tunnel (SSH / Tailscale / TLS reverse proxy) — never raw on a public interface.

## Supervision

There's no Docker restart policy in lite mode. For an always-on setup, run it under `systemd` or `pm2`.

See the [full README](https://github.com/hamr0/beeperbox#lite-mode) and [docs/GUIDE.md](https://github.com/hamr0/beeperbox/blob/master/docs/GUIDE.md) for the complete tool reference and the container build.

[Apache-2.0](https://github.com/hamr0/beeperbox/blob/master/LICENSE)

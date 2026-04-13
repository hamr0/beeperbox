# beeperbox user guide

This is the long-form walkthrough. For a quick pitch, see the [README](../README.md).

## Table of contents

1. [What it is](#what-it-is)
2. [What you get at the end](#what-you-get-at-the-end)
3. [**Quick setup (10 minutes, one-time)**](#quick-setup-10-minutes-one-time) ← start here
4. [Prerequisites](#prerequisites)
5. [Install](#install)
6. [First-run setup](#first-run-setup)
7. [Create an access token](#create-an-access-token)
8. [Verify the API works](#verify-the-api-works)
9. [Use it — real examples](#use-it--real-examples)
10. [MCP tools reference](#mcp-tools-reference)
11. [Deploy to a VPS](#deploy-to-a-vps)
12. [Operating it](#operating-it)
13. [Ports](#ports)
14. [Upgrading](#upgrading)
15. [Troubleshooting](#troubleshooting)
16. [Security notes](#security-notes)
17. [Limits and caveats](#limits-and-caveats)

---

## What it is

beeperbox runs **Beeper Desktop** inside a Docker container, headlessly. Beeper Desktop is the official cross-platform Beeper app, and it exposes a local HTTP API (Beeper's own "Developer mode" feature) for reading chats and sending messages across every bridge Beeper supports: WhatsApp, iMessage, Signal, Discord, Slack, Telegram, Facebook Messenger, Instagram, LinkedIn, and more.

Normally Beeper Desktop needs a real screen, keyboard, and a human pressing buttons. beeperbox wraps it in a virtual display (`Xvfb`), a window manager (`openbox`), and a browser-accessible VNC view (`noVNC`) so you can run it on a server, log in from anywhere via a web browser, and then use the API from any programming language that can speak HTTP.

### Who it is for (and who it is not for)

beeperbox is built for one specific situation: **autonomous agents that need messaging reach without a human at a Beeper Desktop**.

Concretely:

- AI agents running on a VPS that need to reply to customer messages
- Cron jobs that fan out notifications to your phone across multiple messengers
- Multi-tenant SaaS where each customer needs their own Beeper account behind their own agent
- Headless servers that need to send alerts to humans on whichever messenger they prefer
- Anything in a container, on a Raspberry Pi, in CI, on a remote box where you cannot keep a Desktop GUI session running

If you are a **laptop user** with Beeper Desktop installed locally, you do not need beeperbox. Beeper already provides:

- A native HTTP API on `localhost:23373` (the same one beeperbox exposes inside the container)
- A built-in MCP server for AI agent runtimes like Claude Desktop and Claude Code
- A real GUI you can interact with directly

beeperbox is the same machinery, packaged for environments where running Beeper Desktop on the host is not an option.

It is **not** a bot framework, **not** an agent runtime, and **not** a general-purpose messaging gateway. It is the messaging substrate other software plugs into.

## What you get at the end

A single HTTP endpoint on your host:

```
http://localhost:23373
```

(Or `:23374` if you set `BEEPERBOX_HOST_PORT=23374` because a native Beeper Desktop on the same host already owns `:23373` — see [Ports](#ports) below.)

That endpoint:

- Speaks the [Beeper Desktop API](https://developers.beeper.com/) — an OpenAPI 3.1 spec documenting ~20 operations (list chats, get messages, send message, search, contacts, reactions, reminders, assets)
- Requires a `Authorization: Bearer <token>` header on all real operations (only `/v1/info` is public)
- Covers every messaging network you have connected to your Beeper account

Anything that can make an HTTP request can use it. Your agent framework, your Python script, your cron job, a Zapier-like no-code tool, `curl` from a terminal — they all look the same to beeperbox.

### What "every messaging network" actually means

Beeper Desktop syncs the **top ~20 most recently active chats** by default. If your beeperbox-driven agent doesn't see a chat that exists in your account, it's almost certainly because:

- The chat is older than the top-20 cutoff
- The chat is archived
- The chat hasn't received messages in long enough that Beeper deprioritized it from the live sync

Workaround: open Beeper Desktop in noVNC (`http://localhost:6080/vnc.html`), find the chat in the sidebar, and pin it. Pinned chats stay in the live sync regardless of activity. Or scroll to the chat once and Beeper will start syncing it.

For long-tail history (chats from years ago), Beeper has a separate search backend — use `/v1/messages/search` rather than `/v1/chats` to find them.

### Pairing with an existing Beeper account on your phone

You don't have to go through the bridge-pairing flow inside the container. **Bridge state lives on Beeper's servers, not on your device.** If you already have a Beeper account configured on your phone (with WhatsApp, Signal, etc. all paired), all you need to do inside beeperbox is:

1. Open noVNC
2. Sign in with the same Beeper credentials your phone uses
3. All your existing bridges show up automatically — no QR codes, no re-pairing

This means you can leave your phone as the "primary" Beeper client (where you do your normal pairing) and treat beeperbox as a read/write API replica. Both stay in sync because they're both talking to the same upstream Matrix homeserver.

## Quick setup (10 minutes, one-time)

This is the linear walkthrough from a clean machine to a working beeperbox + MCP server. Every step is mandatory, in order. After this, the rest of the guide is reference material you can dip into when you hit a specific question.

You will need: Docker installed, a Beeper account, a web browser, and ~10 minutes of attention.

### Step 1 — clone and build

```sh
git clone https://github.com/hamr0/beeperbox.git
cd beeperbox
docker compose up -d
```

First build takes ~2 minutes. When it finishes, the container is running but Beeper Desktop inside it has no login yet.

### Step 2 — open noVNC in your browser

```
http://localhost:6080/vnc.html
```

Click **Connect**. You should see a Linux desktop with Beeper Desktop starting up. If the window is grey for the first 30 seconds, that's normal — Electron is slow to start.

### Step 3 — log in to Beeper

Inside the noVNC view, log in to Beeper Desktop with your Beeper account credentials (email code, etc.). When login completes, your chat list should appear.

If you already have Beeper set up on your phone, **use the same credentials** — all your existing bridges (WhatsApp, Signal, etc.) will inherit automatically. No re-pairing.

### Step 4 — enable the local API

Inside Beeper Desktop: **Settings → Developers**

Toggle on:
- **Enable Beeper Desktop API**
- **Start API on launch** ← critical, otherwise you must repeat this step after every container restart

### Step 5 — create an access token

Still in **Settings → Developers**, scroll to **Approved Connections** and click **+** to create a new connection.

In the dialog:
- **Name** — `beeperbox-mcp` (or anything memorable)
- **Permissions** — **Allow sensitive actions** (the MCP server needs read + write)
- **Expiry** — **Never** (unless you have a token-rotation policy)

Click create. Beeper shows you a long random token string.

### Step 6 — get the token out of noVNC

noVNC clipboard sharing is unreliable. The fastest workaround: inside Beeper Desktop, **paste the token into your "Note to self" chat**. Then on your host machine, open Beeper on your phone (or any other Beeper client) and copy the token from there.

### Step 7 — save the token to a `.env` file

On your host machine, in the beeperbox directory:

```sh
printf 'BEEPER_TOKEN=PASTE-TOKEN-HERE\n' > .env
```

`.env` is in `.gitignore`, so it will not be committed accidentally.

### Step 8 — recreate the container so it picks up the token

```sh
docker compose up -d
```

**Use `up -d`, not `restart`.** `restart` does not re-read environment variables. Only `up -d` recreates the container with the new env from your `.env` file.

### Step 9 — verify everything is wired up

```sh
docker compose logs beeperbox 2>&1 | grep "beeper token"
```

You want to see:

```
[beeperbox-mcp] beeper token: set
```

If it says `NOT SET`, your `.env` file is in the wrong directory or has a typo. Re-check step 7.

### Step 10 — test the MCP server end-to-end

This is the moment of truth. Call the `list_inbox` tool through the MCP HTTP transport from your host:

```sh
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_inbox","arguments":{"limit":3}}}
EOF
```

You should get back JSON with three of your most recently active chats, each carrying its `network` (whatsapp / telegram / discord / etc.), `title`, `last_message_at`, and `unread_count`. Note-to-self chats are filtered out automatically.

If you see real chats: **you are done**. beeperbox is running, the MCP server is reachable, and any AI agent runtime that speaks MCP can now consume it.

If you see an error, jump to [Troubleshooting](#troubleshooting).

### What you can do next

- **Point an AI agent runtime at it**: Claude Code, Cursor, Cline, bareagent — any MCP client that supports HTTP transport can use `http://localhost:23375` as a tool source. Configure it once and the LLM will see all the beeperbox tools (currently `list_inbox`, more coming in v0.2.0+).
- **Build something custom**: hit the raw Beeper API on `http://localhost:23373/v1/*` from any language with an HTTP client and your `BEEPER_TOKEN`. See [Use it — real examples](#use-it--real-examples) for curl / Node / Python snippets.
- **Deploy to a VPS**: same steps work on any Linux box with Docker. SSH-tunnel noVNC for the one-time login. See [Deploy to a VPS](#deploy-to-a-vps).

---

## Prerequisites

- **A Beeper account** — sign up at [beeper.com](https://www.beeper.com/). Free tier connects 5 platforms. No affiliation; you bring your own account.
- **Docker engine** with the Compose plugin, or a compatible runtime (Podman with `podman-docker` shim works).
- **~2 GB free disk** for the image, volume, and Beeper data.
- **~1 GB free RAM** for the running container. A $5/month VPS has enough.
- **Ports `6080` and `23373` free** on the host. If a native Beeper Desktop already runs on `:23373`, override with `BEEPERBOX_HOST_PORT=23374` — no compose edit needed (see [Ports](#ports)).
- **A web browser** reachable to the host for the one-time login step.

## Install

```sh
git clone https://github.com/hamr0/beeperbox.git
cd beeperbox
docker compose up -d
docker compose logs -f
```

First build takes ~2 minutes (downloading Debian, installing X server packages, downloading the Beeper AppImage). Subsequent builds are cached.

When you see lines like `[ok] beeper api -> http://localhost:23373` in the logs, the container is ready for step-one of the human side. You can `Ctrl-C` out of `logs -f` at any time — the container keeps running.

## First-run setup

This is the only part that needs a human at a browser. It happens **once**.

### 1. Open the noVNC web UI

In any browser:

```
http://localhost:6080/vnc.html
```

Click **Connect**. You will see a Linux desktop with Beeper Desktop starting up.

If you are running on a VPS, replace `localhost` with the VPS's IP. **If the VPS is public, see the [security notes](#security-notes) below first** — do not expose `6080` to the open internet without protecting it.

### 2. Log in to Beeper

Beeper Desktop will show its login screen. Log in with your Beeper account as you normally would — email code, or whatever method you use. When login completes, you should see your chat list.

### 3. Turn on the local API

Inside Beeper Desktop: **Settings → Developers**

Enable these two toggles:

- **Enable Beeper Desktop API**
- **Start API on launch** (crucial — otherwise you must repeat this step after every container restart)

## Create an access token

All API operations except `/v1/info` require an `Authorization: Bearer <token>` header. The MCP server inside the container also needs this token to call the local Beeper API. **You create the token once and forget it** — it persists across container rebuilds and host reboots.

### Option A — create a token manually in Beeper Desktop (recommended)

Still inside Beeper Desktop in noVNC: **Settings → Developers → Approved Connections → +**

In the dialog:

1. **Name** — call it whatever helps you remember (e.g. `beeperbox-mcp`)
2. **Permissions** — select **Allow sensitive actions** (the MCP server needs read + write to do anything useful)
3. **Expiry** — pick **Never** unless you have a specific rotation policy
4. Click create

Beeper will display the token string. It is a long random value — treat it like a password.

**Note**: noVNC clipboard sharing is famously unreliable. If you cannot copy the token directly out of the noVNC view, the simplest workaround is to send the token to yourself in **Note to self** inside Beeper Desktop, then copy it from there. (Or set up real noVNC clipboard integration, but the workaround is faster.)

Once you have the token on your host machine, save it to a `.env` file next to `docker-compose.yml`:

```sh
cd ~/PycharmProjects/beeperbox
printf 'BEEPER_TOKEN=PASTE-TOKEN-HERE\n' > .env
```

`.env` is in `.gitignore`, so it will not be committed accidentally. Now recreate the container so docker compose picks the new env var up:

```sh
docker compose up -d
```

(`up -d` recreates the container if its env changed. `restart` does NOT pick up new env vars — you must use `up -d`.)

Verify the MCP server now sees the token:

```sh
docker compose logs beeperbox 2>&1 | grep "beeper token"
```

You should see:

```
[beeperbox-mcp] beeper token: set
```

If it still says `NOT SET`, check that `.env` is in the same directory as `docker-compose.yml` and that the file has the literal text `BEEPER_TOKEN=...` with no quotes around the value.

**This is a one-time setup.** The token in Beeper persists until you revoke it from the same Approved Connections panel. The `.env` file persists on disk. Together they survive every kind of restart:

| Action | Token survives? |
|---|---|
| `docker compose restart` | yes |
| `docker compose down && docker compose up -d` | yes |
| `docker compose up -d --build` (image rebuild) | yes |
| Reboot the host | yes |
| Rebuild the host OS | no — recreate the `.env` file with the same token |

### Option B — OAuth2 PKCE flow (for distributable apps)

If you are building something other people will run — e.g. an installable agent, a multi-user app, a hosted SaaS — you want the OAuth2 Authorization Code flow with PKCE so each user can grant their own access without you ever seeing their token. The endpoints are discoverable at:

```sh
curl http://localhost:23373/v1/info | python3 -m json.tool
```

See `endpoints.oauth` in the response. This path is beyond the scope of this guide — see Beeper's own docs at [developers.beeper.com](https://developers.beeper.com/).

## Verify the API works

Three calls. If all three succeed, you're done and everything else in this guide is just examples.

**1. Public health probe (no token needed):**

```sh
curl -s http://localhost:23373/v1/info | python3 -m json.tool
```

Expected: JSON with `app.name: "Beeper"`, `server.status: "running"`.

**2. Authenticated call — list accounts:**

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     http://localhost:23373/v1/accounts | python3 -m json.tool
```

Expected: a JSON array of your connected Beeper accounts (one per bridge — WhatsApp, iMessage, etc).

**3. List the 5 most recent chats:**

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     "http://localhost:23373/v1/chats?limit=5" | python3 -m json.tool
```

Expected: a JSON array of five chats with titles, last-message timestamps, network IDs.

If **1** works but **2/3** return `401 Unauthorized`, your token is wrong — go back and regenerate it.

If **1** returns a connection error, the container isn't running or the host port isn't mapped. See [troubleshooting](#troubleshooting).

## Use it — real examples

All examples assume `BEEPER_TOKEN` is set and beeperbox is on `localhost:23373`.

### curl — send a message

First find a chat ID:

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     "http://localhost:23373/v1/chats?limit=1" \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])'
```

Then send:

```sh
curl -s -X POST \
     -H "Authorization: Bearer $BEEPER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text": "hello from beeperbox"}' \
     "http://localhost:23373/v1/chats/<chatID>/messages"
```

### Node (vanilla, no deps)

```js
const TOKEN = process.env.BEEPER_TOKEN;
const BASE = 'http://localhost:23373/v1';

async function listChats(limit = 10) {
  const r = await fetch(`${BASE}/chats?limit=${limit}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function send(chatID, text) {
  const r = await fetch(`${BASE}/chats/${chatID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const chats = await listChats(5);
console.log(chats.map(c => c.title));
await send(chats[0].id, 'hi from node');
```

### Python (vanilla stdlib, no deps)

```python
import json, os, urllib.request

TOKEN = os.environ['BEEPER_TOKEN']
BASE = 'http://localhost:23373/v1'

def request(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body else None,
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

chats = request('GET', '/chats?limit=5')
print([c['title'] for c in chats])
request('POST', f'/chats/{chats[0]["id"]}/messages', {'text': 'hi from python'})
```

### Search messages

```sh
curl -s -G -H "Authorization: Bearer $BEEPER_TOKEN" \
     --data-urlencode 'query=invoice' \
     http://localhost:23373/v1/messages/search | python3 -m json.tool
```

### Full endpoint list

```sh
curl -s http://localhost:23373/v1/spec \
     | python3 -c 'import json,sys; [print(p) for p in sorted(json.load(sys.stdin)["paths"])]'
```

As of Beeper Desktop 4.2.715, the endpoints are:

```
/v1/accounts
/v1/accounts/{accountID}/contacts
/v1/accounts/{accountID}/contacts/list
/v1/assets/download
/v1/assets/serve
/v1/assets/upload
/v1/assets/upload/base64
/v1/chats
/v1/chats/search
/v1/chats/{chatID}
/v1/chats/{chatID}/archive
/v1/chats/{chatID}/messages
/v1/chats/{chatID}/messages/{messageID}
/v1/chats/{chatID}/messages/{messageID}/reactions
/v1/chats/{chatID}/reminders
/v1/focus
/v1/info
/v1/messages/search
/v1/search
/v1/spec
```

## MCP tools reference

beeperbox exposes 10 semantic tools over Model Context Protocol on two interchangeable transports. Any AI agent runtime that speaks MCP (Claude Code, Cursor, Cline, Continue, bareagent, etc.) can consume them.

### The 10 tools

| Tool | Required | Returns | Use case |
|---|---|---|---|
| `list_accounts` | — | Array of accounts with `network` slug + `network_label` | Discover which platforms are reachable at session start |
| `list_inbox` | — | Array of `Chat` | Triage: what's happening right now |
| `list_unread` | — | Array of `Chat` (unread only) | "What needs my attention?" — primary inbox check |
| `get_chat` | `chat_id` | `Chat` | Refresh one chat's state before replying |
| `read_chat` | `chat_id` | Array of `Message` (oldest first) | Pull conversation context for the LLM to reason about |
| `search_messages` | `query` | Array of `Message` | Follow-up lookups, historical context, "what did X say about Y" |
| `send_message` | `chat_id`, `text` | `{chat_id, message_id, status}` | The headline reply/notify tool |
| `note_to_self` | `text` | same | Agent self-notes, debug output, scheduled reminders — auto-resolves chat ID |
| `react_to_message` | `chat_id`, `message_id`, `emoji` | `{...status: reacted}` | Lightweight ack, no full reply needed |
| `archive_chat` | `chat_id` | `{chat_id, archived}` | Clean handled chats out of inbox (closest primitive to mark-as-read that Beeper exposes) |

### Schemas the LLM learns once and reuses everywhere

```
Chat:
  id               stable chat identifier
  title            human-readable chat name
  network          machine slug ("whatsapp", "telegram", "discord", ...)
  network_label    human name ("WhatsApp", "Telegram", "Discord", ...)
  is_group         true if this is a multi-participant chat
  is_note_to_self  true if this is the user's own self chat (filtered from list_inbox)
  last_message_at  ISO 8601 timestamp of the most recent activity
  unread_count     integer

Message:
  id               stable message identifier
  chat_id          the chat this message belongs to (always present, no second lookup)
  network          machine slug (same as Chat)
  network_label    human name (same as Chat)
  sender           { id, name, is_self }
  text             message body (or "[MEDIA]" / "[non-text]" for non-text types)
  type             "TEXT" | "MEDIA" | ...
  timestamp        ISO 8601
  reply_to         parent message id if this is a reply, else null
```

### Calling a tool via HTTP (from any host/language)

All calls are JSON-RPC 2.0 POST to `http://localhost:23375`. The method is always `tools/call`. Three worked examples:

**1. List your top 5 inbox chats**

```sh
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_inbox","arguments":{"limit":5}}}
EOF
```

**2. Send a WhatsApp reply**

```sh
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'EOF'
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"chat_id":"!xxx:beeper.local","text":"on my way 👍"}}}
EOF
```

**3. Full-text search**

```sh
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'EOF'
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_messages","arguments":{"query":"invoice","limit":10}}}
EOF
```

### Wiring an agent runtime to beeperbox

**Stdio transport (Claude Code, Cursor, Cline, bareagent)** — add to your MCP client config (e.g. `~/.claude/mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "beeperbox": {
      "command": "docker",
      "args": ["exec", "-i", "beeperbox", "node", "/opt/mcp/server.js", "--stdio"]
    }
  }
}
```

The client spawns a fresh server process per session; stdio becomes the protocol channel and the MCP server inherits the container's `BEEPER_TOKEN` env automatically.

**HTTP transport (remote agents, web, no-code tools)** — point your client at `http://localhost:23375` (or the appropriate host/IP if you've tunneled it). No configuration needed beyond the URL — the same server handles both transports out of one file.

### Testing tools without an agent

```sh
# tools/list — see all registered tools with their schemas
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}' \
  | python3 -m json.tool

# any tool via stdio from the host
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | docker exec -i beeperbox node /opt/mcp/server.js --stdio
```

---

## Deploy to a VPS

Everything above works identically on a VPS. Differences:

### Pick a VPS with 1 GB+ RAM

beeperbox idles around 500 MB and peaks around 700–900 MB when Matrix sync is busy. A $5/month Hetzner/RackNerd/DigitalOcean box with 1 GB RAM is enough for beeperbox plus one small agent alongside it. A 512 MB VPS is too tight.

### Install Docker + compose plugin

```sh
# Debian/Ubuntu
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out/in after this
```

### Clone and start

Same as the laptop install:

```sh
git clone https://github.com/hamr0/beeperbox.git
cd beeperbox
docker compose up -d
```

### Do the one-time login

You need to reach noVNC from your laptop's browser to log in. Three options, from least to most secure:

**A — SSH port-forward (recommended)**

On your laptop:

```sh
ssh -L 6080:localhost:6080 -L 23373:localhost:23373 user@vps.example.com
```

Leave this running. Open `http://localhost:6080/vnc.html` in your browser — it tunnels through SSH to the VPS. When setup is done, close the SSH tunnel. The API continues running on the VPS locally.

This is the right default: you never open extra ports on the VPS, and you only need the tunnel for the one-time setup.

**B — Tailscale / Wireguard**

Put the VPS on your private mesh, browse `http://<tailscale-ip>:6080/vnc.html` directly. Also good; slightly more setup.

**C — Expose `6080` to the public internet**

**Do not do this naively.** noVNC has no authentication by default, which means anyone who knows your IP can open Beeper Desktop, read your chats, and send messages. If you must expose it, put a reverse proxy with HTTP basic auth or a Cloudflare Access rule in front. And close the port again after setup.

### Point your agent at it

If your agent runs on the same VPS, it uses `http://localhost:23373`. If your agent runs elsewhere, you need to either:

- SSH tunnel `23373` to wherever the agent runs, or
- Put the API behind a reverse proxy with TLS + auth (nginx, Caddy, Traefik — any of them work), or
- Put the agent and the VPS on the same private network (Tailscale, Wireguard).

**The API has no TLS, no rate limiting, and no firewall of its own.** Do not expose `23373` to the public internet. The Bearer token is the only access control, and it is a single shared secret you pasted in your code.

### Reverse proxy with TLS (Caddy example)

`Caddyfile`:

```
api.example.com {
    reverse_proxy localhost:23373
    basicauth {
        beeperbox <bcrypt-hash>
    }
}
```

Caddy handles TLS certificates via Let's Encrypt automatically. Basic auth adds a second layer in front of your Bearer token.

## Ports

beeperbox publishes two host ports, both bound to `127.0.0.1` only:

| Default host port | Container port | Purpose | Override env var |
|---|---|---|---|
| `23373` | `23380` | Beeper Desktop API (via socat forwarder) | `BEEPERBOX_HOST_PORT` |
| `6080` | `6080` | noVNC web UI for first-run login | `BEEPERBOX_NOVNC_PORT` |

The defaults assume a clean host. If you're running on a dev machine that already has a **native Beeper Desktop** installed (which itself binds to `:23373`), override the API port:

```sh
BEEPERBOX_HOST_PORT=23374 docker compose up -d
```

You can put the override in a `.env` file next to `docker-compose.yml` to make it sticky:

```
BEEPERBOX_HOST_PORT=23374
```

The container's **internal** port (`23380` after the socat forwarder) never changes regardless of what you override on the host side. Container internal ports live in their own network namespace and cannot conflict with anything on the host — only the **host-side** mapping is at risk of collision. Read the [troubleshooting section on ports](#port-23373-or-6080-address-already-in-use) below if you're confused about why this works.

After starting the container, confirm which host port you actually got with:

```sh
docker port beeperbox
```

## Operating it

### See logs

```sh
docker compose logs -f           # follow live
docker compose logs --tail=100   # last 100 lines
```

### Restart

```sh
docker compose restart
```

### Stop / start

```sh
docker compose down     # stop and remove the container (volume is kept)
docker compose up -d    # start fresh
```

### Check health

```sh
docker ps --filter name=beeperbox --format 'table {{.Names}}\t{{.Status}}'
```

You want to see `Up X minutes (healthy)`. If you see `(unhealthy)`, the API is not responding to `/v1/info` — see [troubleshooting](#troubleshooting).

```sh
docker inspect beeperbox --format '{{json .State.Health}}' | python3 -m json.tool
```

Gives the full health log including the last 5 probe results.

### Survive reboots

beeperbox already has `restart: unless-stopped` in `docker-compose.yml`, so the container restarts itself if Docker is running. Make sure Docker itself starts at boot:

```sh
sudo systemctl enable docker
```

Combined with Beeper's **Start API on launch** setting (see [first-run setup](#first-run-setup)), the full chain is automatic: boot → Docker → beeperbox container → Beeper Desktop → API.

## Upgrading

### Get the latest beeperbox

```sh
cd ~/beeperbox
git pull
docker compose up -d --build
```

This rebuilds the image and recreates the container. The `beeperbox_config` volume is preserved, so you stay logged in to Beeper.

### Update Beeper Desktop itself

The Dockerfile downloads the latest Beeper Desktop stable AppImage at build time. To pick up a new Beeper version, rebuild the image without cache:

```sh
docker compose build --no-cache
docker compose up -d
```

## Troubleshooting

### `docker compose up` fails with "Cannot connect to the Docker daemon"

Docker isn't running. Start it:

```sh
sudo systemctl start docker
```

Add yourself to the docker group so you don't need sudo:

```sh
sudo usermod -aG docker $USER
newgrp docker
```

### Port `23373` (or `6080`) "address already in use"

Something on your host is already bound to that port. The most common case is that you have a **native Beeper Desktop** installed on the same machine — its API also binds to `:23373`. Don't kill native Beeper; just give beeperbox a different host port via the env override (no compose edit needed):

```sh
BEEPERBOX_HOST_PORT=23374 docker compose up -d
```

For the noVNC port:

```sh
BEEPERBOX_NOVNC_PORT=16080 docker compose up -d
```

You can stack both:

```sh
BEEPERBOX_HOST_PORT=23374 BEEPERBOX_NOVNC_PORT=16080 docker compose up -d
```

Or put them in a `.env` file next to `docker-compose.yml` to make them sticky.

To check which host ports the running container actually owns:

```sh
docker port beeperbox
```

### noVNC shows "failed to connect to server"

Container probably didn't start. Check:

```sh
docker compose ps
docker compose logs --tail=50
```

Look for Xvfb or openbox errors. If you see Electron sandbox errors, make sure `--no-sandbox` is still in the entrypoint.

### Beeper Desktop in noVNC is a grey screen / never loads

Wait 30 seconds. Electron apps are slow to start in a container. If it stays grey past a minute, restart:

```sh
docker compose restart
```

If that still fails, check the container logs for `[SDK]` lines. No lines at all means Beeper Desktop never launched (usually a missing lib — report it as an issue).

### `curl http://localhost:23373/v1/info` returns "Connection reset by peer"

Either the socat forwarder didn't start, or Beeper's API isn't up yet. Check:

```sh
docker exec beeperbox curl -sf http://[::1]:23373/v1/info > /dev/null && echo API OK || echo API DOWN
```

- If that prints `API OK`: socat is the problem. Restart the container.
- If it prints `API DOWN`: Beeper API isn't running. You probably haven't enabled it yet — go back to [first-run setup](#first-run-setup) step 3, or you forgot to turn on **Start API on launch**.

### `401 Unauthorized` on every call except `/v1/info`

Your token is missing or wrong. Confirm:

```sh
echo $BEEPER_TOKEN
```

If empty, you didn't export it in the current shell. If set, re-create the token in Beeper Desktop settings and try again. Tokens do not rotate but they can be revoked from the same settings panel.

### Container keeps going `unhealthy`

Beeper API is down or returning errors. Inspect the probe log:

```sh
docker inspect beeperbox --format '{{json .State.Health}}' | python3 -m json.tool
```

Look at the `Output` fields of failed probes. Common cause: you haven't enabled the API at all yet, or you restarted the container without enabling **Start API on launch**.

### "no bridge event found" spam in logs

Harmless. The Matrix SDK is trying to back up message receipts that it doesn't have local events for (usually after a fresh login while history is still catching up). Ignore it.

### I want to start fresh

```sh
docker compose down -v     # -v removes the volume too — you will lose your Beeper login
docker compose up -d --build
```

## Security notes

The Beeper Desktop API is a **single-user, local-trust** surface. It was designed to be accessed from the same machine as Beeper Desktop by software you control. beeperbox does not change that — it just moves the "same machine" into a container.

Things you must do:

- **Treat the Bearer token like a password.** Do not commit it, do not paste it in chat, do not put it in a repo.
- **Do not expose port 23373 (or whichever you've remapped it to) to the public internet.** If you need remote access, use an SSH tunnel, Tailscale/Wireguard, or a reverse proxy with TLS + authentication.
- **Do not expose port 6080 (noVNC) to the public internet without auth.** noVNC has no built-in login. Anyone who can reach it can open Beeper Desktop and read your chats. Use the reverse proxy or SSH tunnel for login, and close it when done.
- **The container runs as root.** Standard for Docker development, fine on a personal VPS, not appropriate for shared hosting. If you need better isolation, run under Podman rootless or add a non-root user in the Dockerfile.
- **Beeper's own ToS applies.** You are using a real Beeper account. Automation that violates Beeper's or the underlying platforms' terms of service (spam, mass marketing, abuse) can and will get the account flagged or banned.

Things beeperbox deliberately does not do:

- Rate limiting
- Per-user permissions (there is one user — you)
- Audit logging (beyond whatever Beeper Desktop itself logs)
- Encryption at rest for the config volume

If you need those, put them in front of beeperbox (reverse proxy, governance middleware, volume encryption) — beeperbox is the messaging backend, not the security perimeter.

## Limits and caveats

- **Image size**: ~1 GB. Electron + Chromium are the bulk. Do not expect this to shrink dramatically — musl-libc Alpine builds break Chromium, and stripping X server components breaks Electron.
- **Idle RAM**: ~500 MB. Not suitable for sub-512 MB VPS plans.
- **Single user**: one Beeper account per container. If you need multiple accounts, run multiple containers with different ports and volumes.
- **Desktop API binds to `[::1]:23373`** inside the container. beeperbox uses `socat` to make it reachable externally. If Beeper ever adds a flag to bind `0.0.0.0` directly, socat will go away — it is a workaround, not a feature.
- **WhatsApp on-device bridge** sometimes logs `no bridge event found` warnings during backup. Harmless, ignore.
- **Not multi-arch yet**: the Docker image is x86_64 only. Raspberry Pi / arm64 support is on the roadmap but not shipped.
- **No streaming subscriptions in the API**: the Beeper Desktop API is request/response. For realtime updates you poll `/v1/chats` or hook into the Beeper Desktop MCP server (advanced).
- **This is a POC (v0.1.0)**. It works, it is tested end-to-end, but it has not been hardened for production. Running it on a personal VPS for your own agents is fine. Running it as a shared service is not.

---

Questions, bugs, improvements: [github.com/hamr0/beeperbox/issues](https://github.com/hamr0/beeperbox/issues).

# beeperbox user guide

This is the long-form walkthrough. For a quick pitch, see the [README](../README.md).

## Table of contents

1. [What it is](#what-it-is)
2. [What you get at the end](#what-you-get-at-the-end)
3. [Prerequisites](#prerequisites)
4. [Install](#install)
5. [First-run setup](#first-run-setup)
6. [Create an access token](#create-an-access-token)
7. [Verify the API works](#verify-the-api-works)
8. [Use it — real examples](#use-it--real-examples)
9. [Deploy to a VPS](#deploy-to-a-vps)
10. [Operating it](#operating-it)
11. [Upgrading](#upgrading)
12. [Troubleshooting](#troubleshooting)
13. [Security notes](#security-notes)
14. [Limits and caveats](#limits-and-caveats)

---

## What it is

beeperbox runs **Beeper Desktop** inside a Docker container, headlessly. Beeper Desktop is the official cross-platform Beeper app, and it exposes a local HTTP API (Beeper's own "Developer mode" feature) for reading chats and sending messages across every bridge Beeper supports: WhatsApp, iMessage, Signal, Discord, Slack, Telegram, Matrix, and more.

Normally Beeper Desktop needs a real screen, keyboard, and a human pressing buttons. beeperbox wraps it in a virtual display (`Xvfb`), a window manager (`openbox`), and a browser-accessible VNC view (`noVNC`) so you can run it on a server, log in from anywhere via a web browser, and then use the API from any programming language that can speak HTTP.

It is not a bot framework. It is not an agent runtime. It is the messaging substrate agents and bots can plug into.

## What you get at the end

A single HTTP endpoint on your host:

```
http://localhost:23374
```

That endpoint:

- Speaks the [Beeper Desktop API](https://developers.beeper.com/) — an OpenAPI 3.1 spec documenting ~20 operations (list chats, get messages, send message, search, contacts, reactions, reminders, assets)
- Requires a `Authorization: Bearer <token>` header on all real operations (only `/v1/info` is public)
- Covers every messaging network you have connected to your Beeper account

Anything that can make an HTTP request can use it. Your agent framework, your Python script, your cron job, a Zapier-like no-code tool, `curl` from a terminal — they all look the same to beeperbox.

## Prerequisites

- **A Beeper account** — sign up at [beeper.com](https://www.beeper.com/). Free tier connects 5 platforms. No affiliation; you bring your own account.
- **Docker engine** with the Compose plugin, or a compatible runtime (Podman with `podman-docker` shim works).
- **~2 GB free disk** for the image, volume, and Beeper data.
- **~1 GB free RAM** for the running container. A $5/month VPS has enough.
- **Ports `6080` and `23374` free** on the host (change them in `docker-compose.yml` if not).
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

All API operations except `/v1/info` require an `Authorization: Bearer <token>` header. There are two ways to get a token.

### Option A — create a token manually in Beeper Desktop (simplest)

Still in **Settings → Developers**, there is a section for access tokens. Create one, give it a name (e.g. `beeperbox-local`), and copy the token string. It will be a long random string — treat it like a password.

Save it in your environment:

```sh
export BEEPER_TOKEN='paste-the-token-here'
```

Or put it in a `.env` file your code reads. Do not commit it to git.

### Option B — OAuth2 PKCE flow (for distributable apps)

If you are building something other people will run — e.g. an MCP server, an installable CLI, a multi-user app — you want the OAuth2 Authorization Code flow with PKCE so each user can grant their own access without pasting tokens. The endpoints are discoverable at:

```sh
curl http://localhost:23374/v1/info | python3 -m json.tool
```

See `endpoints.oauth` in the response. This path is beyond the scope of this guide — see Beeper's own docs at [developers.beeper.com](https://developers.beeper.com/).

## Verify the API works

Three calls. If all three succeed, you're done and everything else in this guide is just examples.

**1. Public health probe (no token needed):**

```sh
curl -s http://localhost:23374/v1/info | python3 -m json.tool
```

Expected: JSON with `app.name: "Beeper"`, `server.status: "running"`.

**2. Authenticated call — list accounts:**

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     http://localhost:23374/v1/accounts | python3 -m json.tool
```

Expected: a JSON array of your connected Beeper accounts (one per bridge — WhatsApp, iMessage, etc).

**3. List the 5 most recent chats:**

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     "http://localhost:23374/v1/chats?limit=5" | python3 -m json.tool
```

Expected: a JSON array of five chats with titles, last-message timestamps, network IDs.

If **1** works but **2/3** return `401 Unauthorized`, your token is wrong — go back and regenerate it.

If **1** returns a connection error, the container isn't running or the host port isn't mapped. See [troubleshooting](#troubleshooting).

## Use it — real examples

All examples assume `BEEPER_TOKEN` is set and beeperbox is on `localhost:23374`.

### curl — send a message

First find a chat ID:

```sh
curl -s -H "Authorization: Bearer $BEEPER_TOKEN" \
     "http://localhost:23374/v1/chats?limit=1" \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])'
```

Then send:

```sh
curl -s -X POST \
     -H "Authorization: Bearer $BEEPER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text": "hello from beeperbox"}' \
     "http://localhost:23374/v1/chats/<chatID>/messages"
```

### Node (vanilla, no deps)

```js
const TOKEN = process.env.BEEPER_TOKEN;
const BASE = 'http://localhost:23374/v1';

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
BASE = 'http://localhost:23374/v1'

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
     http://localhost:23374/v1/messages/search | python3 -m json.tool
```

### Full endpoint list

```sh
curl -s http://localhost:23374/v1/spec \
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
ssh -L 6080:localhost:6080 -L 23374:localhost:23374 user@vps.example.com
```

Leave this running. Open `http://localhost:6080/vnc.html` in your browser — it tunnels through SSH to the VPS. When setup is done, close the SSH tunnel. The API continues running on the VPS locally.

This is the right default: you never open extra ports on the VPS, and you only need the tunnel for the one-time setup.

**B — Tailscale / Wireguard**

Put the VPS on your private mesh, browse `http://<tailscale-ip>:6080/vnc.html` directly. Also good; slightly more setup.

**C — Expose `6080` to the public internet**

**Do not do this naively.** noVNC has no authentication by default, which means anyone who knows your IP can open Beeper Desktop, read your chats, and send messages. If you must expose it, put a reverse proxy with HTTP basic auth or a Cloudflare Access rule in front. And close the port again after setup.

### Point your agent at it

If your agent runs on the same VPS, it uses `http://localhost:23374`. If your agent runs elsewhere, you need to either:

- SSH tunnel `23374` to wherever the agent runs, or
- Put the API behind a reverse proxy with TLS + auth (nginx, Caddy, Traefik — any of them work), or
- Put the agent and the VPS on the same private network (Tailscale, Wireguard).

**The API has no TLS, no rate limiting, and no firewall of its own.** Do not expose `23374` to the public internet. The Bearer token is the only access control, and it is a single shared secret you pasted in your code.

### Reverse proxy with TLS (Caddy example)

`Caddyfile`:

```
api.example.com {
    reverse_proxy localhost:23374
    basicauth {
        beeperbox <bcrypt-hash>
    }
}
```

Caddy handles TLS certificates via Let's Encrypt automatically. Basic auth adds a second layer in front of your Bearer token.

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

### Port `23374` (or `6080`) "address already in use"

Something else on your host is bound to that port. Either stop it, or remap beeperbox to a different host port in `docker-compose.yml`:

```yaml
ports:
  - "16080:6080"
  - "13374:23380"
```

A common case: you already have Beeper Desktop installed natively on the same machine for dev use — the native one binds to `23373`. beeperbox defaults to host port `23374` for exactly this reason, so this should not happen out of the box.

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

### `curl http://localhost:23374/v1/info` returns "Connection reset by peer"

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
- **Do not expose port 23374 to the public internet.** If you need remote access, use an SSH tunnel, Tailscale/Wireguard, or a reverse proxy with TLS + authentication.
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

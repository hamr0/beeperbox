# beeperbox — Product Requirements Document

> **This is the grounding document for beeperbox: what it is, what it is *not*, and why.**
> When a feature, a release, or a "wouldn't it be cool if…" idea is on the table, it gets measured against this doc. Anything that contradicts the "Non-goals" section is rejected by default unless this document is changed first.

- **Status:** shipped and in use. Current release **v0.7.0** (2026-06-16); rolling changes tracked in [`CHANGELOG.md`](../CHANGELOG.md).
- **Distribution:** pre-built multi-arch image on GHCR — `ghcr.io/hamr0/beeperbox` (`linux/amd64` + `linux/arm64`).
- **License:** [Apache-2.0](../LICENSE). Independent wrapper around Beeper Desktop; **no affiliation** with Beeper / Automattic.
- **Related deep-dive docs:** [`GUIDE.md`](GUIDE.md) (human operator walkthrough), [`../beeperbox.context.md`](../beeperbox.context.md) (AI-assistant integration guide).

---

## 1. Purpose

An AI agent that needs to *message people* across the networks people actually use faces a wall: WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix — each is its own SDK, its own OAuth dance, its own rate-limit quirks, several with no usable API at all. Wiring an agent to even a handful is weeks of integration that rots constantly.

[Beeper](https://www.beeper.com/) already solves the hard half: it bridges 50+ networks into one account. But Beeper Desktop is a GUI app meant for a human at a laptop, and its local HTTP API only exists while that app is running.

**beeperbox runs Beeper Desktop headless in a container and exposes it as one endpoint an agent can talk to** — over a raw HTTP API or an opinionated Model Context Protocol (MCP) server. One container, one login, reach across every network Beeper bridges, with no human and no desktop in the loop.

**The one-line pitch:** *one agent → 50+ messengers, through a single MCP endpoint.*

---

## 2. What beeperbox is

A single Docker container that bundles, in one image:

1. **Headless Beeper Desktop** — the real Electron app, run under a virtual display (Xvfb + openbox), no GPU, no human.
2. **A first-run login surface** — a noVNC web UI (`:6080`) used exactly once, to sign into Beeper and mint an API token. Not part of the steady-state runtime path.
3. **The raw Beeper Desktop HTTP API** (`:23373`), made reachable from outside the container's loopback-only Electron binding via a `socat` forwarder.
4. **An opinionated MCP server** (`:23375`) — vanilla Node, zero npm dependencies, a single `mcp/server.js` — wrapping the raw API in **12 semantic tools** and **2 normalized schemas** so an LLM never touches raw Beeper endpoints.

State (login, bridge sync, token) lives in a named Docker volume, so the login survives restarts, rebuilds, and host reboots. The image is published pre-built and multi-arch; the common path is *pull and run*, not clone-and-build.

**Two modes, one verb layer.** The above is the **container** (the default, for always-on / headless / VPS). The same `mcp/server.js` also runs as **lite mode** — published to npm as `beeperbox` (`npx beeperbox`), it serves *only* the MCP verb layer against a Beeper Desktop the user already runs locally (no Docker, no Electron, no Xvfb). Identical tool surface and `serverInfo.version` by construction — lite mode is the *packaging*, not a fork. Use the container when there's no human/desktop in the loop; use lite mode when Beeper is already open on the machine. See §8.

---

## 3. What beeperbox is NOT (non-goals)

These are deliberate, load-bearing boundaries. Each was considered and rejected for a concrete reason; reversing one is a product decision, not a patch.

- **Not a single-network bot framework.** If you only need Telegram (or one network), beeperbox is overkill — use a network-native library (BotFather, [openclaw](https://github.com/openclaw/openclaw), etc.). beeperbox earns its weight only when you need *reach across many networks from one agent*.
- **The *container* is not for humans who already run Beeper Desktop — but *lite mode* is.** A person at a laptop with Beeper installed already has Beeper's native HTTP API and MCP server, so they don't need the headless **container**. They may still want beeperbox's *opinionated 12-tool surface* — the two normalized schemas, the `source` echo-guard, the `poll_messages` watch primitive — over Beeper's raw API. **Lite mode** (§8) serves exactly that: the same `mcp/server.js`, run standalone against the user's own Beeper Desktop, no container. The container remains the answer for **autonomous agents that need messaging reach without a human at a desktop** — typically on a server or VPS.
- **Not multi-tenant.** Beeper Desktop logs in as exactly one user at a time. Per-request token forwarding is architecturally impossible, not unbuilt. The supported pattern for N accounts is **N containers**, each with its own volume and ports (env-overridable for density on one host).
- **Not a typed client library.** A typed Node client (`@beeperbox/node`) and a Python client (`beeperbox` on PyPI) were both dropped. MCP is the language-agnostic consumption layer; a non-agent caller can hit the raw HTTP API in ~5 lines of vanilla `fetch`/`urllib`. Revisit only on a real issue.
- **An npm package, but *only* lite mode — and it bundles no Beeper.** An earlier `beeperbox-mcp` publish was built then reverted (commit `670f8c9`) as premature: at the time it duplicated the Docker channel with no audience. The audience has since materialized — [multis](https://github.com/hamr0/multis) and other pure MCP clients whose users already run Beeper Desktop on a laptop and want the verbs without the whole container. So `mcp/server.js` is now published to npm as **`beeperbox`** (`npx beeperbox`) for **lite mode only** (§8). The boundary holds: the npm package is *just the verb server* — it does **not** bundle or headless-run Beeper Desktop (that stays the container's job, and lite mode requires the user to supply their own running Beeper).
- **Not a real-time / streaming system.** The Beeper Desktop API is request/response. There are no push subscriptions; agents poll.
- **Not auto-updated in place.** There is no in-container update job. The image only changes when it is rebuilt (weekly cron, or a release). This is intentional — see §7.
- **Not affiliated with Beeper / Automattic.** Independent wrapper, Apache-2.0.

---

## 4. Target users

| User | Fit |
|---|---|
| An autonomous agent / agent runtime that must read & send across many networks, running on a server with no human present | **Primary.** This is who beeperbox is for. |
| A developer wiring an MCP client (Claude Code, Cursor, Cline, Continue, [bareagent](https://github.com/hamr0/bareagent)) to messaging | **Primary.** Point the client at the MCP server. |
| A SaaS / multi-customer operator running many Beeper accounts | **Supported** via one-container-per-account on one VPS (density pattern in [`GUIDE.md`](GUIDE.md)). |
| A developer whose MCP client / agent runs on a laptop where Beeper Desktop is already open, and who wants beeperbox's opinionated verb surface (not Beeper's raw API) | **Supported** via **lite mode** (`npx beeperbox`) — same verbs, no container (§8). |
| A human who wants a nicer Beeper on their laptop | **Not the audience.** Use Beeper Desktop directly. |
| Someone who needs exactly one network | **Not the audience.** Use a network-native library. |

---

## 5. Architecture

### 5.1 Container internals

Built on `debian:12-slim` (Alpine is not viable — musl breaks Chromium). The entrypoint orchestrates a boot chain:

```
Xvfb (virtual display)
  → openbox (window manager)
    → x11vnc → noVNC/websockify  (:6080, first-run login UI)
    → Beeper Desktop (Electron, --no-sandbox)
      → raw HTTP API on 127.0.0.1:23373  (Beeper's own loopback bind)
        → socat forwarder: 0.0.0.0:23380 ⇄ 127.0.0.1:23373
    → MCP server (node /opt/mcp/server.js)  (:23375 HTTP transport)
```

- **AppImage extraction at build time.** The Beeper Desktop AppImage's squashfs payload is extracted directly with `unsquashfs -o <offset>` (the launcher stub is bypassed because it fails under QEMU during arm64 cross-builds). The image carries the extracted app, not a runtime FUSE mount.
- **Why socat exists.** Beeper Desktop binds its API to loopback only; a Docker published port DNATs to the container interface and can't reach a loopback-bound process. `socat` bridges loopback ⇄ `0.0.0.0:23380`, and `:23380` is what the host port maps to.
- **Multi-arch.** The Dockerfile reads buildx's `TARGETARCH` and pulls the matching Beeper AppImage (`linux/x64/stable` vs `linux/arm64/stable`). GHCR holds one multi-arch manifest per tag. No `linux/arm/v7` — Beeper publishes no 32-bit ARM build.

### 5.2 Ports

| Host port (default) | Purpose | Bound to | Env override |
|---|---|---|---|
| `6080` | noVNC web UI — **first-run login only** | `127.0.0.1` | `BEEPERBOX_NOVNC_PORT` |
| `23373` | Raw Beeper Desktop HTTP API (via socat `:23380`) | `127.0.0.1` | `BEEPERBOX_HOST_PORT` |
| `23375` | Opinionated 12-tool MCP server (HTTP transport) | `127.0.0.1` | `BEEPERBOX_MCP_PORT` |

All three publish to `127.0.0.1` by design. Remote access is a deliberate opt-in (SSH tunnel, Tailscale/Wireguard, or a TLS-terminating reverse proxy with auth) — never by dropping the loopback prefix. The container name is also env-overridable (`BEEPERBOX_CONTAINER_NAME`) so multiple instances can coexist on one host.

### 5.3 Configuration surface (env vars)

| Var | Default | Effect |
|---|---|---|
| `BEEPER_TOKEN` | unset | Bearer token minted in Beeper Desktop; authenticates raw-API and MCP calls upstream. |
| `BEEPERBOX_IMAGE_TAG` | `latest` | Which GHCR tag to run (`0.7.0`, `0.7`, `0`, `latest`, `previous`, `edge`, or a `@sha256:` digest). |
| `BEEPERBOX_HOST_PORT` / `_NOVNC_PORT` / `_MCP_PORT` | `23373` / `6080` / `23375` | Host-side port remapping for multi-instance hosts. |
| `BEEPERBOX_CONTAINER_NAME` | `beeperbox` | Container name, for running multiple instances. |
| `MCP_AUTH_TOKEN` | unset | When set, every MCP HTTP request must carry `Authorization: Bearer <token>` or get `401`. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]` | Host/Origin allowlist (DNS-rebinding defense); set when a reverse proxy fronts a custom hostname. |
| `MCP_MAX_BODY` | 1 MiB | Request body cap on the MCP HTTP transport; over-cap ⇒ `413`. |
| `BEEPERBOX_SENT_LEDGER` | `$XDG_CONFIG_HOME/beeperbox/sent-ledger.json` → `~/.config/beeperbox/sent-ledger.json` | Path to the echo-guard sent-message ledger. The per-user XDG default is one code path for both modes — `os.homedir()` is `/root` in the container (so it lands on the persisted config volume) and the real user's home in lite mode (so a non-root host process can actually write it; the old hardcoded `/root` default silently failed to persist on a normal host). Parent dir auto-created. Best-effort; a failed write degrades the `source` guard to in-memory for that run, never fails a send. |
| `BEEPERBOX_PREFLIGHT` / `_PREFLIGHT_TIMEOUT_MS` | `1` (on) / `5000` | Startup preflight: one bounded `/v1/accounts` probe on boot logs a clear reachable-and-token-accepted / unreachable-or-rejected verdict to stderr (matters most in lite mode, which has no Docker `HEALTHCHECK`). Best-effort and non-fatal — an unset token or down API never blocks boot. Set `BEEPERBOX_PREFLIGHT=0` to disable. |
| `BEEPERBOX_RESOLVE_RETRIES` / `_DELAY_MS` / `_TIMEOUT_MS` | `4` / `250` / `3000` | Echo-guard id resolution after a send: attempts to resolve `pendingMessageID` → final bridge id, delay between attempts, and per-attempt fetch timeout. Worst-case added send latency is bounded at `retries × (timeout + delay)`. Set retries `0` to disable resolution (falls back to text matching). |
| `BEEPERBOX_SUPERVISE` / `_SUPERVISE_INTERVAL` / `_SUPERVISE_API_GRACE` | `1` / `10` / `6` | Backend supervision: enable (`0` = old forward-signal-and-wait), seconds between checks, and consecutive API-down checks (after the API has been up once) before recycling beepertexts. Non-numeric values fall back to the default. |
| `VNC_PASSWORD` | unset | When set, the noVNC/x11vnc session requires a password (RFB security type *VNC auth*). |
| `BEEPER_VERSION` / `BEEPER_SHA256` | unset (build args) | Pin & hash-verify an exact Beeper AppImage for a reproducible build; unset ⇒ rolling auto-update. |

---

## 6. Capabilities

### 6.1 Raw Beeper Desktop HTTP API

The full upstream `/v1/*` API, reachable on `:23373` with `Authorization: Bearer $BEEPER_TOKEN`. For callers that want everything Beeper exposes and don't need the agent-shaped surface. Read-only vs read-write scope is enforced **inside Beeper Desktop** via its "Allow sensitive actions" toggle at token-creation time — no beeperbox-side flag.

### 6.2 MCP server — the opinionated agent surface

A single-file, zero-dependency Node server wrapping the raw API. Two interchangeable transports in one process, selected at startup:

- **HTTP** (default, always on): JSON-RPC 2.0 over POST on `:23375`. For remote agents, cross-container setups, cloud runtimes.
- **stdio** (on demand): newline-delimited JSON-RPC over stdin/stdout (stdout reserved for protocol, logs to stderr), via `docker exec -i beeperbox node /opt/mcp/server.js --stdio` (here `beeperbox` is the default container name — use your `BEEPERBOX_CONTAINER_NAME` if you overrode it for a multi-instance host). For local MCP clients (Claude Code, Cursor, Cline, Continue, bareagent).

Both transports also run **standalone in lite mode** — `npx beeperbox` (HTTP) or `npx beeperbox --stdio` — against a Beeper Desktop the user supplies, with no container. It is the same file, so the tool surface and version are identical; a startup preflight (§5.3) replaces the container's healthcheck as the boot sanity check.

**The 12 tools:**

| Tool | What it does | Access |
|---|---|---|
| `list_accounts` | Which networks are connected (`network` slug + `network_label`) | read |
| `list_inbox` | Top recently active chats; note-to-self filtered out | read |
| `list_unread` | Like `list_inbox`, only chats with `unread_count > 0` | read |
| `poll_messages` | Passive cursor-based "what's new since I last looked?" feed (the watch primitive); read-only, restart-resumable, echo-guarded | read |
| `get_chat` | One chat by ID (`Chat` schema) | read |
| `read_chat` | Last N messages from a chat, oldest-first in page, each grounded with `chat_id`/`network` | read |
| `search_messages` | Full-text across all chats; hits resolve network metadata in one round-trip | read |
| `send_message` | Send text to a chat, optional `reply_to_message_id` + `client_tag`; returns `pendingMessageID` | write |
| `note_to_self` | Send to the agent's own note-to-self chat (auto-resolved, Beeper-native matrix), the dedicated command/control channel — excluded from inbox views | write |
| `react_to_message` | Add an emoji reaction (unicode, shortcode, or custom key) | write |
| `archive_chat` | Archive/unarchive (stands in for mark-as-read, which Beeper exposes no endpoint for) | write |
| `download_asset` | Fetch a message attachment's bytes (base64) by `src_url` or `chat_id`+`message_id`; capped at `BEEPERBOX_MAX_ASSET_BYTES` | read |

**Two normalized schemas** the LLM learns once and reuses everywhere:

```
Chat:    { id, title, network, network_label, is_group, is_note_to_self, last_message_at, unread_count }
Message: { id, chat_id, network, network_label, sender{id,name,is_self}, text, type, attachments[], timestamp, reply_to, source, client_tag }
```

Every chat and message carries both `network` (machine slug: `whatsapp`, `telegram`, …) and `network_label` (human: `"WhatsApp"`, …), normalized off `/v1/accounts` with chat-bridge-ID parsing as fallback. The **note-to-self vs inbox split** is a core design invariant: the agent's command channel must never pollute customer conversations, and customer inbox views must never surface the agent's own notes.

**`poll_messages` — the watch primitive.** A passive, cursor-based new-messages-since feed so integrators stop reinventing the seed/poll/dedup loop against the raw API. Read-only (never marks read / archives / mutates); first call seeds "from now", subsequent calls return only messages newer than an opaque cursor the caller persists (restart-resumable, with same-millisecond id dedup). This is *ability, not policy* — beeperbox provides the mechanism; poll interval and "handled" state stay with the caller. It does **not** make beeperbox a streaming system (§3) — it's a better-shaped poll, not a push subscription.

**`source` echo-guard.** On one Beeper account, both the owner's own typed messages and the agent's API replies are `sender.is_self === true`, so `is_self` can't stop an agent from answering its own sends. Every `Message` therefore carries `source` (`"api"` if *this* beeperbox sent it via `send_message`/`note_to_self`, else `"external"`) plus an echoed `client_tag`. The send tools record what they send to a ledger persisted in the config volume (`BEEPERBOX_SENT_LEDGER`); read-back tags the match. Match is best-effort and **unverified against a live account** (the standing CI-gate limitation); documented conservatively so a human re-typing identical text is never mis-tagged.

### 6.3 Operational properties

- **One-time login, persistent state.** Named volume holds login + bridge state; survives restart/rebuild/reboot. Bridges configured on an existing Beeper account (e.g. on a phone) inherit automatically — bridge state lives on Beeper's servers.
- **Healthcheck.** Docker `HEALTHCHECK` probes the API through the same socat path external clients use, so a crashed API *or* forwarder marks the container unhealthy. Paired with `restart: unless-stopped`.
- **Supervised backend.** The entrypoint supervises beepertexts: it relaunches the process if it dies, and recycles it if the API (`:23373`) stays down after having been up — closing the "half-dead" failure where the launcher lingers after its API process crashes, the MCP layer keeps answering, and every tool call fails. An `API_WAS_UP` gate protects first-run login (the API is down by design until the user enables it). Tunable via `BEEPERBOX_SUPERVISE*` env; the healthcheck surfaces a dead backend, supervision recovers it.
- **Clean shutdown.** The entrypoint traps SIGTERM/SIGINT and forwards to Beeper Desktop, waiting for full reap so matrix sync / sqlite checkpoint flush before exit (no partial writes on `docker stop`).
- **Restart-survivable display.** `docker restart` preserves the container's writable layer, so the entrypoint clears the stale Xvfb lock (`/tmp/.X99-lock`, `/tmp/.X11-unix/X99`) before starting Xvfb — otherwise the surviving lock makes Xvfb half-initialize `:99` and segfault, wedging the stack until a full recreate. `docker restart` (the natural op after a config change) now recovers cleanly.
- **Multi-instance density.** Env-overridable ports + container name let many single-tenant instances share one VPS (density guidance in [`GUIDE.md`](GUIDE.md)).

---

## 7. Security model

beeperbox is a single-tenant container that holds a credential (`BEEPER_TOKEN`) granting read/send across every connected network. The threat model treats that token, and the noVNC session that can mint it, as the crown jewels.

**Baseline (since v0.1.0):** all published ports bind `127.0.0.1`. On a public-IP VPS this is the difference between "reachable only from the host" and "open to the internet."

**v0.5.0 hardening** — the full audit punchlist (3 HIGH + actionable MEDIUM/LOW). All additions are opt-in and back-compatible, with one called-out exception (always-on Host/Origin validation):

- **MCP bearer auth (opt-in)** — `MCP_AUTH_TOKEN`; unset keeps the transport open (back-compat) and relies on the loopback publish.
- **DNS-rebinding / cross-origin defense (always on)** — `Host` and `Origin` validated against a loopback allowlist (`MCP_ALLOWED_HOSTS`); non-match ⇒ `403`. Native clients (no `Origin`, loopback `Host`) are unaffected; reverse-proxy deployments set the allowlist.
- **Request body cap** — `MCP_MAX_BODY` (1 MiB) ⇒ `413`, closing an unbounded-buffer memory-exhaustion vector.
- **VNC password (opt-in)** — `VNC_PASSWORD` switches x11vnc from RFB *None* to *VNC auth*, gating GUI takeover on `:6080`.
- **Privilege-escalation hardening** — `security_opt: [no-new-privileges:true]`, shrinking the blast radius of Beeper running as root with `--no-sandbox`.
- **Reproducible/verified builds (opt-in)** — `BEEPER_VERSION` + `BEEPER_SHA256` pin and hash-check the AppImage; default stays rolling auto-update.

**v0.7.0 hardening** — alongside `download_asset` (see CHANGELOG):

- **`download_asset` src_url confinement (defense-in-depth)** — the tool proxies Beeper's `serve` endpoint, which accepts `file://` paths. Beeper independently restricts these (`403` outside its media dir, `400` for a non-`mxc`/`localmxc`/`file` scheme — confirmed live), but `download_asset` is the network-reachable MCP surface and does not rely on that undocumented upstream guard: it allows `mxc://` / `localmxc://`, allows `file://` only inside the media cache (`BEEPERBOX_ASSET_FILE_ROOT`), and refuses any other path, scheme, URL host, or encoded-`../` traversal **before** the fetch — for both a caller-supplied and a message-resolved `src_url`. Not a patched live exploit; a second in-repo boundary that survives an upstream regression.

**Load-bearing decisions (do not relitigate without changing this doc):**

- **In-container listeners bind `0.0.0.0` on purpose.** A loopback bind inside the container is unreachable through a Docker published port. The defense is auth + Host/Origin + the loopback *publish*, not the bind address. (A "bind loopback" fix was proposed, tested, and rejected because it silently breaks the published port.)
- **Beeper auto-update is the default and stays the default.** Pinning is opt-in; the weekly rebuild depends on the rolling URL.

**Accepted residuals (documented, auditable, not bugs):**

- The default AppImage download is TLS-authenticated only — Beeper publishes no independent signature/checksum. Use `BEEPER_VERSION` + `BEEPER_SHA256` when integrity guarantees are required.
- The MCP `-32001` error passes the upstream Beeper body verbatim *by design* — it helps the agent self-correct, the consumer is the agent (not a browser), and the token is never echoed.
- Beeper Desktop runs as root with `--no-sandbox`; a full non-root + Chromium-sandbox rebuild was rejected as too fragile for a single-tenant container that already trusts Beeper Desktop. `no-new-privileges` is the chosen mitigation.

---

## 8. Distribution & release model

**Pull, don't build.** The default path is `curl -LO …/docker-compose.yml && docker compose up -d`, which pulls the pre-built multi-arch image. `build:` is dev-only (`docker-compose.dev.yml` overlay) for hacking on the image or air-gapped installs.

**GHCR tags:**

| Tag | Meaning |
|---|---|
| `:X.Y.Z` | exact release (rebuilt by weekly cron only while it's the newest — *not* immutable; pin a `@sha256:` digest for bit-exact) |
| `:X.Y` / `:X` | rolling within a minor / major (`:0` today) |
| `:latest` | newest gated release; rebuilt weekly to pick up upstream Beeper AppImage drift |
| `:previous` | the prior `:latest` — instant rollback via `BEEPERBOX_IMAGE_TAG=previous` |
| `:edge` | every push to `master`; **ungated, may break** |

**CI-gated releases with rollback (safe rolling releases).** The release pipeline is `prepare → verify → publish`:

- `verify` builds the image and runs the shared guard scripts (`scripts/mcp-guard-check.sh` — MCP tool contract + `200`/`403`/`413`/`401` matrix; `scripts/vnc-auth-check.sh` + `vnc-auth-probe.py` — RFB security-type probe) against it.
- `publish` runs **only if `verify` is green**. It first rolls the current `:latest` → `:previous` (server-side manifest copy, no rebuild), then builds & pushes the multi-arch tags. A failed gate **skips publish** (last-known-good `:latest` stays live) and flags the run.
- The guard scripts are the **single source of truth** shared by the PR workflows (`mcp-test`, `vnc-test`) and the release gate, so "what the PR tests" and "what blocks a release" cannot drift. The gate sources scripts from the **latest workflow ref** (not the release ref), so the weekly rebuild of an older tag that predates the scripts still runs current checks.

**Why not Watchtower / in-place auto-update?** Rejected as a default: a stateful, login-bearing app + the `docker.sock` attack surface, with no auto-rollback, outweighs the convenience. CI-gated publish + `:previous` is the chosen substitute.

**Lite mode — the npm channel.** Alongside the Docker image, `mcp/server.js` publishes to npm as **`beeperbox`** (a zero-dependency package whose only `bin` is `beeperbox`), so the supported lite-mode install is `BEEPER_TOKEN=… npx beeperbox` (HTTP) or `npx beeperbox --stdio`. The npm `version` is the single source of truth — `serverInfo.version` reads it, and the container `COPY`s the same `package.json` into the image, so the two channels cannot report different versions (asserted by a unit test). The release publish is **specified** to run on **tag push only** (npm versions are immutable, so the weekly cron / dispatch rebuilds must not re-publish), gated on the same `verify` job as the GHCR push, asserting the tag matches `package.json` before publishing; wiring that job into `release.yml` is pending an `NPM_TOKEN` secret and is not yet live (publish is manual until then). This is *packaging a second consumption path for an existing audience*, not a new product surface — it reverses the earlier "not an npm package" stance (§3) precisely because that audience now exists.

---

## 9. Versioning policy

[Semantic Versioning 2.0.0](https://semver.org/), scoped to what's *inside* the container (not how you get it). `MAJOR` is held at `0` until the MCP tool set, HTTP API surface, and default ports are declared stable.

- **MAJOR** (`X.0.0`) — breaking change to the runtime contract (removed tool, renamed `Chat`/`Message` field, reassigned default port). `1.0.0` is an explicit "we commit to this API" event.
- **MINOR** (`0.X.0`) — new runtime behavior: new tool, endpoint, transport, schema field, or architecture (e.g. arm64). May carry breaking changes while `MAJOR == 0` (semver §4) — called out loudly when it happens.
- **PATCH** (`0.0.X`) — bug fixes, docs, packaging, release-workflow/build tweaks. The image digest may differ, but an agent on the HTTP/MCP surface can't tell two PATCH releases apart except for fixed bugs.

---

## 10. Release history (grounding)

| Version | Date | Headline |
|---|---|---|
| 0.1.0 | 2026-04-13 | POC: headless Beeper Desktop in Debian 12, noVNC login, persistent local HTTP API, loopback-bound ports. |
| 0.2.0 | 2026-04-13 | MCP server: 10 tools, 2 normalized schemas, HTTP + stdio transports. Default API port `23374`→`23373`. |
| 0.2.1 | 2026-04-13 | Docs: read-only vs read-write tokens, multi-instance-per-VPS pattern. |
| 0.3.0 | 2026-04-13 | Multi-arch image (`linux/amd64` + `linux/arm64`). *(Superseded by 0.3.1.)* |
| 0.3.1 | 2026-04-13 | Fix arm64 cross-build: extract squashfs directly, bypass AppImage launcher. |
| 0.3.2 | 2026-04-14 | Pull-by-default from GHCR; `:edge` from master; weekly rebuild cron. |
| 0.3.3 | 2026-05-13 | Fix black-VNC-on-boot (GPU) and IPv6-socat first-install bugs. |
| 0.4.0 | 2026-05-18 | Deterministic `note_to_self` routing (off third-party saved-messages); clean SIGTERM shutdown; MCP smoke probe. |
| 0.5.0 | 2026-05-24 | Security hardening: MCP auth + Host/Origin + body cap, VNC password, `no-new-privileges`, opt-in pinned builds. |
| 0.5.1 | 2026-05-25 | CI-gated releases + `:previous` rollback; shared guard scripts as single source of truth. |
| 0.6.0 | 2026-06-15 | `poll_messages` watch primitive + exact-id echo-guard (`source`/`client_tag`); supervised backend + restart-survivable display. |
| 0.7.0 | 2026-06-16 | Attachment reach: `attachments[]` on every `Message` + `download_asset` tool (bytes as base64 via `/v1/assets/serve`, byte-capped, src_url-confined). |

---

## 11. Roadmap / open items

Nothing is committed; beeperbox is feature-driven by real usage. Delivered from this list once a real user asked:

- **Lite mode — `npx beeperbox` against a local Beeper Desktop** *(delivered, pending release)* — multis's laptop users already run Beeper Desktop and wanted beeperbox's verb surface without the whole container. Lite mode makes the standalone `mcp/server.js` a first-class, supported path: an npm package + `bin`, a startup preflight (replacing the container's healthcheck), and a one-fix bug — the echo-guard sent-ledger defaulted to a container-only `/root` path that silently failed to persist on a normal host, now a per-user XDG path. Same verb server, no new verbs; it reverses two §3 non-goals (the npm one, and "not for local-Beeper humans"), updated above because the audience materialized. Validated live: the full send → restart → poll echo-guard round-trip against a real Beeper account on the host, across HTTP, the installed `npx` bin, and stdio.
- **Attachment reach — `attachments[]` + `download_asset`** *(shipped 0.7.0)* — multis needed to index files customers and the admin send (e.g. a PDF → FAQ). A normalized `Message` now surfaces each attachment's `src_url`, and `download_asset` returns the bytes (base64) through beeperbox's own `:23375` — so an MCP-only / remote deployment that doesn't publish the raw Beeper API on `:23373` can still read files. Boundary-correct: it proxies `GET /v1/assets/serve`, byte-capped to keep the JSON-RPC result bounded; it does not turn beeperbox into a file store.
- **`poll_messages` watch primitive + `source` echo-guard** *(shipped 0.6.0)* — the first consumer-driven feature. [multis](https://github.com/hamr0/multis) was hand-rolling seed/poll/dedup against the raw API; beeperbox now exposes the cursor-based new-messages primitive and a send-origin marker natively. Boundary-correct: it adds the *ability* to watch, not a *policy* about when to poll, and it does not make beeperbox a streaming system (§3) — it's a better-shaped poll.

Candidates discussed, not built:

- **Renovate/Dependabot** to bump the pinned Beeper digest via tested PRs.
- **Louder failure alerts** (e.g. Slack) beyond the default GitHub Actions email on a failed release gate.
- **A live-Beeper normalizer test** — would catch Beeper API-shape drift breaking the normalizers, which the standalone CI gate cannot. Needs a real account; impractical in CI today. `:previous` is the current safety net for this class of failure.
- Otherwise: *whatever the first real user issue asks for.*

---

## 12. Known limitations

- Image ~1.9 GB per arch, idle RAM ~500–600 MB (Electron + Chromium); Alpine/musl is not a drop-in base.
- No 32-bit ARM (`linux/arm/v7`) — Beeper publishes no such build.
- Single Beeper account per container (see §3, multi-tenant).
- No streaming/push — request/response only; agents poll.
- Beeper Desktop syncs ~20 most-recently-active chats by default; older chats need pinning or search.
- The CI release gate runs the MCP server **standalone (no live Beeper account)** — it catches build/startup/guard regressions but **not** Beeper API-shape drift breaking the normalizers. `:edge` is ungated by design.

---

## 13. References

- [Beeper Desktop](https://www.beeper.com/) — the upstream app this containerizes
- [Beeper Desktop API](https://developers.beeper.com/) — official API reference
- [`GUIDE.md`](GUIDE.md) — operator walkthrough (login, tokens, multi-instance, troubleshooting)
- [`../beeperbox.context.md`](../beeperbox.context.md) — AI-assistant integration guide (tools, schemas, client wiring, error codes)
- [`../CHANGELOG.md`](../CHANGELOG.md) — full version history + versioning policy
- [bareagent](https://github.com/hamr0/bareagent) — agent orchestration that consumes beeperbox via MCP
- [multis](https://github.com/hamr0/multis) — the personal-assistant project that drove beeperbox's extraction

# beeperbox — Integration Guide

> For AI assistants and developers wiring beeperbox into an agent project.
> v0.6.0 | Docker (linux/amd64 + linux/arm64) + vanilla Node >= 18 | 0 runtime deps | Apache-2.0
>
> Full human setup walkthrough (noVNC login, token creation, `.env` file, troubleshooting): [docs/GUIDE.md](docs/GUIDE.md)

## What this is

beeperbox is a headless [Beeper Desktop](https://www.beeper.com/) in a Docker container that exposes **two things to agents**:

1. **Raw Beeper Desktop HTTP API** on `127.0.0.1:23373` — the unmodified `/v1/*` endpoints for callers who want full control.
2. **Opinionated Model Context Protocol server** on `127.0.0.1:23375` (HTTP) or stdio — 12 semantic tools, normalized `Chat` / `Message` schemas, note-to-self isolation, clean network slugs. Consume from Claude Code, Cursor, Cline, Continue, bareagent, or any other MCP-speaking runtime.

Agents that consume beeperbox get read/write access to **every bridge the user's Beeper account has connected**: WhatsApp, iMessage, Signal, Discord, Slack, Telegram, Facebook Messenger, Instagram, LinkedIn, Google Messages, Matrix, and any future Beeper bridge. One config, every messenger.

**Who this is for:** autonomous agents running on servers, VPSes, or in containers — anywhere a human is not sitting at a Beeper Desktop GUI. If you're a laptop user with Beeper Desktop installed locally, Beeper ships its own HTTP API and MCP server natively and you do not need beeperbox.

```
docker run -d \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:23373:23380 \
  -p 127.0.0.1:23375:23375 \
  -v beeperbox_config:/root/.config \
  -e BEEPER_TOKEN=<token> \
  --name beeperbox \
  ghcr.io/hamr0/beeperbox:latest
```

## Which tool do I need?

| I want to... | MCP tool |
|---|---|
| See which platforms are connected (WhatsApp, Telegram, ...) | `list_accounts` |
| See the most recently active chats | `list_inbox` |
| Find chats with unread messages | `list_unread` |
| Poll for new messages since I last looked (watch loop) | `poll_messages` |
| Read recent messages in one chat | `read_chat` |
| Fetch one chat's metadata (unread count, title, etc.) | `get_chat` |
| Send a reply or notification to a chat | `send_message` |
| Ack a message without sending a reply | `react_to_message` |
| Search all chats for a keyword | `search_messages` |
| Record a self-note that doesn't pollute the inbox | `note_to_self` |
| Move a handled chat out of the inbox | `archive_chat` |

The raw HTTP API (`http://localhost:23373/v1/*`) exposes ~20 more operations — reminders, asset upload/download, contacts, chat search, edit/delete messages, focus control. Use the MCP tools for everything that has one; fall back to raw HTTP for the long tail.

## Minimal wiring: stdio transport (recommended for agent runtimes)

Stdio is the canonical MCP transport for clients that spawn the server as a subprocess. Each client gets its own fresh process with the container's env automatically inherited.

### Claude Code / Claude Desktop

Add to `~/.claude/mcp.json` (or `~/.config/claude/mcp.json`):

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

### Cursor / Cline / Continue

Same shape — most MCP clients expose a "command + args" config field. Use the same `docker exec -i` invocation.

### bareagent

bareagent's `src/mcp-bridge.js` auto-discovers MCP servers from standard IDE config locations and spawns them via `child_process.spawn`. Add beeperbox to `.mcp.json` in your project root:

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

Then wire the bridge:

```javascript
const { Loop } = require('bare-agent');
const { createMCPBridge } = require('bare-agent/mcp');

const bridge = await createMCPBridge({ servers: ['beeperbox'] });
const loop = new Loop({ provider, system: bridge.systemContext });

try {
  await loop.run(messages, bridge.tools);
} finally {
  await bridge.close();
}
```

Tool names in bareagent are namespaced `beeperbox_*` (e.g. `beeperbox_list_inbox`). You can also pass `tools` into the `Loop` constructor instead of `run()` — either works. On first run, bareagent writes `.mcp-bridge.json` with every discovered tool set to `allow`; edit it and set unwanted tools to `deny` to restrict the surface.

## HTTP transport (remote agents, multi-tenant, web/no-code)

Same server, same protocol, different framing. POST JSON-RPC 2.0 requests to `http://localhost:23375`:

```sh
curl -s -X POST http://localhost:23375 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_inbox","arguments":{"limit":5}}}'
```

Use this when the agent runs outside the beeperbox container (different host, different container, remote VPS) and cannot `docker exec`. The same code handles both transports at once — the entrypoint starts HTTP by default; stdio is only spawned on demand.

## Tool reference

All tools are called via JSON-RPC 2.0 `tools/call` with `{name, arguments}`. Required params listed — any unlisted field is optional.

### `list_accounts`

Discover which messaging platforms are connected.

**Arguments:** none.
**Returns:** array of `{account_id, network, network_label, user: {id, display_name}}`.
**Use at session start** to see which networks are reachable before making branching decisions.

### `list_inbox`

Top recently active chats. Excludes note-to-self.

**Arguments:** `{limit?: integer(1..100) = 20}`.
**Returns:** array of `Chat`.

### `list_unread`

Same as `list_inbox` but only chats where `unread_count > 0`.

**Arguments:** `{limit?: integer(1..100) = 20}`.
**Returns:** array of `Chat`.
**Primary triage tool** — call this first to see what needs attention.

### `get_chat`

Refresh one chat's metadata.

**Arguments:** `{chat_id: string}` (required).
**Returns:** `Chat`.

### `read_chat`

Fetch the most recent messages from one chat. Messages are ordered oldest-first within the page.

**Arguments:** `{chat_id: string, limit?: integer(1..100) = 20}`.
**Returns:** array of `Message`.

### `search_messages`

Full-text search across all messages in all chats. Hits include `chat_id` + `network` so no second lookup is needed to know which conversation a result belongs to.

**Arguments:** `{query: string, limit?: integer(1..100) = 20}`.
**Returns:** array of `Message`.
**Caveat:** Beeper Desktop only live-syncs the top ~20 most active chats. Older chats may not be searchable until they're pinned or scrolled into view.

### `poll_messages`

The **watch primitive** — a passive "what's new since I last looked?" feed for a poll loop. Returns every message that arrived after an opaque `cursor`, across all recent chats (or one chat if `chat_id` is given). **Read-only: it never marks anything read, never archives, never mutates** — call it as often as you like with zero side effects.

**Arguments:** `{cursor?: string, chat_id?: string, limit?: integer(1..100) = 50}`.
**Returns:** `{cursor: string, messages: Message[], has_more: boolean, seeded?: true}`.

How the loop works:

1. **Seed.** First call, omit `cursor`. You get back `{cursor, messages: [], seeded: true}` — an empty backlog and a starting cursor meaning *"from now"*. (The single most-recent existing message may surface once on the next poll — a documented seed-boundary effect, never a miss.)
2. **Poll.** Pass the cursor back. You receive only messages newer than it, oldest-first, plus a fresh cursor. Persist the new cursor.
3. **Repeat.** Sleep your chosen interval (the *policy* is yours — beeperbox only provides the *ability*), then poll again with the latest cursor.

```javascript
let cursor = (await mcp.callTool('poll_messages', {})).cursor;   // seed: from now
while (true) {
  const { cursor: next, messages, has_more } = await mcp.callTool('poll_messages', { cursor });
  cursor = next;                          // persist this to disk — it's restart-safe
  for (const m of messages) {
    if (m.source === 'api') continue;     // skip our own programmatic sends (echo-guard)
    await handle(m);                       // m.sender.is_self may be true: the owner's own Note-to-self command
  }
  if (!has_more) await sleep(POLL_INTERVAL_MS);  // has_more ⇒ poll again immediately, more is pending
}
```

**Restart-resumable.** The cursor is opaque and fully stateless server-side — save it to disk and resume across a process or container restart with no missed or duplicated messages. Same-millisecond messages are deduplicated by id, so the classic seed/poll/dedup off-by-ones don't apply.

**Includes your own messages on purpose.** `sender.is_self` may be `true` — the owner messaging themselves in Note to self is a real inbound signal (often the command channel for an assistant). **To stop an agent from answering its own sends, branch on `source`, not `is_self`** (see the Message schema below): `source: "api"` means *this* beeperbox sent it via `send_message`/`note_to_self` — skip it; `source: "external"` is everything else, the human owner's own messages included.

**Bounds (same as the rest of the API):** the inbox scan only sees Beeper's live-synced ~20 most-active chats (pin or `search_messages` for the long tail). `has_more: true` means there are *immediately fetchable* messages beyond this page — keep polling (the cursor advances) until it's `false`, then sleep. **Residual:** beeperbox fetches up to the newest 100 messages per chat per poll; if a single chat receives **more than 100** messages between two of your polls, the oldest of that burst can be missed (Beeper's messages endpoint returns only the newest N with no backward paging). Poll often enough that no chat exceeds ~100 between polls, or backfill that chat with `read_chat` / `search_messages`.

### `send_message`

Send a text message to a chat. Markdown supported.

**Arguments:** `{chat_id: string, text: string, reply_to_message_id?: string, client_tag?: string}`.
**Returns:** `{chat_id, message_id, pending_message_id, resolved, client_tag, status: "sent"}`.
**Note:** `message_id` is the **final bridge id** when beeperbox could resolve it (`resolved: true`), else the `pendingMessageID` (`resolved: false`). `pending_message_id` is always the raw pending id. Use `message_id` for downstream `react_to_message`. The resolution is what lets the echo-guard match read-backs by **exact id**, not text (see the Message schema caveat).
**`client_tag` (echo-guard):** optional idempotency/echo key. beeperbox records it against this send and echoes it back on the message — marked `source: "api"` — when it reappears in `poll_messages` / `read_chat`. Lets an agent recognize and skip its own programmatic sends without a brittle text-prefix hack (see `poll_messages` and the Message schema).

### `note_to_self`

Send a message to the bot's own Beeper-native Note to self chat. Auto-resolves the correct chat ID, so no `chat_id` parameter needed.

**Arguments:** `{text: string, client_tag?: string}`.
**Returns:** `{chat_id, message_id, pending_message_id, resolved, client_tag, status: "sent"}` — same shape as `send_message` (`message_id` is the resolved final id when `resolved: true`).
**`client_tag`:** same echo-guard semantics as `send_message` — recorded and echoed back as `source: "api"` on read-back, so a `poll_messages` loop can skip the agent's own self-notes.
**Use for:** agent self-notes ("processed 5 customer messages"), debug output, scheduled reminders, anything you want recorded but NOT seen by anyone else. The note-to-self chat is excluded from `list_inbox` / `list_unread` / `search_messages`, so messages here will not pollute customer views.

**Routing:** the resolver requires the target chat to live on the Beeper-native matrix account, so self-notes will not accidentally land in a third-party network's saved-messages chat (e.g. Telegram Saved Messages). Falls back to any single-self chat only if no matrix one exists, and writes a warning to stderr when it does — check the container logs (`docker logs beeperbox`) if you suspect routing is going to the wrong chat.

### `react_to_message`

Add an emoji reaction to a specific message.

**Arguments:** `{chat_id: string, message_id: string, emoji: string}`.
**Returns:** `{chat_id, message_id, emoji, status: "reacted"}`.
**Use for:** lightweight ack ("I saw it") without sending a full reply. Works on every supported network.

### `archive_chat`

Archive or unarchive a chat. Archived chats are removed from `list_inbox` but history is preserved.

**Arguments:** `{chat_id: string, archived?: boolean = true}`.
**Returns:** `{chat_id, archived}`.
**Note:** Beeper does not expose a `mark_as_read` endpoint. `archive_chat` is the closest primitive for the "I am done with this conversation" pattern. Pass `archived: false` to unarchive.

### `download_asset`

Download a message attachment's bytes and return them base64-encoded — the MCP-only way to reach a media/PDF/document file, without touching the raw Beeper API on `:23373`. Reference the attachment by its `src_url` (off a `Message.attachments[]` entry), or by `chat_id` + `message_id` (+ `index`) and beeperbox resolves the `src_url` and returns the file's `file_name` / `mime_type` / `size`.

**Arguments:** `{src_url?: string}` **or** `{chat_id: string, message_id: string, index?: number = 0}`.
**Returns:** `{src_url, content_type, bytes, encoding: "base64", data_base64, file_name?, mime_type?, size?}`.
**Note:** The bytes ride base64 inside the JSON-RPC result, so the asset is capped at `BEEPERBOX_MAX_ASSET_BYTES` (default 8 MiB) — an oversized file returns a clear error, not a truncated body. Internally proxies `GET /v1/assets/serve?url=…`, so a remote deployment publishing only `:23375` can still read attachments. Raise the cap or hit `serve` directly for larger files.

## Schemas

Two normalized shapes. Learn them once and every tool returns the same thing.

### `Chat`

```json
{
  "id": "!abc123:bridge.beeper.local-whatsapp.localhost",
  "title": "Sara Smith",
  "network": "whatsapp",
  "network_label": "WhatsApp",
  "is_group": false,
  "is_note_to_self": false,
  "last_message_at": "2026-04-13T09:30:00Z",
  "unread_count": 2
}
```

| Field | Purpose |
|---|---|
| `id` | Stable opaque identifier. Pass back verbatim in subsequent calls — never construct or mutate. |
| `title` | Human-readable chat name. Use for grounding, not lookup. |
| `network` | Machine slug for branching logic (e.g. `if network === 'whatsapp'`). |
| `network_label` | Human name for UI/LLM output ("I sent that to Sara on WhatsApp"). |
| `is_group` | True for multi-participant chats. Affects addressing, tone, @mentions. |
| `is_note_to_self` | Always `false` in `list_inbox` / `list_unread` output (they filter). Use `note_to_self` tool for the self chat. |
| `last_message_at` | ISO 8601. Use for recency sorting. |
| `unread_count` | Integer. Prioritization signal. |

### `Message`

```json
{
  "id": "123",
  "chat_id": "!abc123:...",
  "network": "whatsapp",
  "network_label": "WhatsApp",
  "sender": {
    "id": "@sara:bridge.beeper.local-whatsapp.localhost",
    "name": "Sara Smith",
    "is_self": false
  },
  "text": "are we still meeting tomorrow?",
  "type": "TEXT",
  "attachments": [],
  "timestamp": "2026-04-13T09:30:00Z",
  "reply_to": null,
  "source": "external",
  "client_tag": null
}
```

| Field | Purpose |
|---|---|
| `id` | Message ID. Needed for `react_to_message`. |
| `chat_id` | Parent chat ID. **Always present on every Message**, even in `search_messages` hits — no second lookup to ground. |
| `network` / `network_label` | Same as `Chat`. Propagated so the LLM can branch per-platform without re-fetching the chat. |
| `sender.is_self` | True if the **Beeper account** sent this message — **from any client**, including the human owner typing on their phone. Distinguishes "from my account" from "from someone else". **Not an echo-guard** (see `source`). |
| `text` | Message body. For non-text messages (media, voice, etc.) this is `"[MEDIA]"` or `"[<type>]"`. |
| `type` | `"TEXT"`, `"MEDIA"`, etc. |
| `attachments` | Array of the message's files, `[]` when none. Each: `{type, file_name, mime_type, src_url, size, is_voice_note}`. `src_url` (an `mxc://` / `localmxc://` URL, or a `file://` URL inside Beeper's media cache once the file is downloaded locally) is the download reference — pass it to `download_asset` to pull the bytes. For a `MEDIA` message this is the only way to reach the file (`text` is just `"[MEDIA]"`). |
| `reply_to` | Parent message ID if this is a reply, else `null`. |
| `source` | **`"api"`** if *this* beeperbox sent the message via `send_message` / `note_to_self`; **`"external"`** otherwise. This — not `is_self` — is the echo-guard: on one account both the owner's own typed messages and the agent's API replies are `is_self: true`, so only `source` can tell "I sent this programmatically" from "the human owner sent this". Skip `source === "api"` in a poll loop; process `"external"` (the owner's own Note-to-self commands included). |
| `client_tag` | The `client_tag` passed to `send_message` / `note_to_self` for this message, echoed back, else `null`. An idempotency key the agent can correlate to a specific send. |

> **`source` matching is primarily by exact id; best-effort and unverified against a live Beeper account** (CI has none). On send, beeperbox resolves the `pendingMessageID` to the **final bridge id** Beeper assigns on ack (it GETs the message back until the id swaps) and records both, so a read-back matches by **exact id** whether or not the swap happened. A content-based fallback survives only as a last-ditch net, and **only for sends whose final id could not be resolved** — matching the account's own (`is_self`) messages in the same chat within a 15-minute window. Once a send is resolved, its text fallback is retired, so a human re-typing identical text is **not** mis-tagged as the agent's own and dropped. The ledger is persisted to the config volume so the guard survives restarts. Validate against your own account before relying on it for a high-stakes auto-responder, and keep a secondary guard if a missed echo would be costly.

## Raw `/v1/` contract (for direct-API consumers)

The MCP tools are the supported surface, but you can hit Beeper's raw `/v1/*` API on `:23373` directly (see the curl/Node/Python snippets in [docs/GUIDE.md](docs/GUIDE.md)). If you do, you are responsible for the same quirks the MCP layer absorbs for you. These are the canonical rules — match them and a raw consumer behaves identically to the MCP tools.

### Pagination floor — `?limit=N` is a *lower* bound, not an upper one

`GET /v1/chats?limit=N` and `GET /v1/chats/{chatID}/messages?limit=N` return **~25 items minimum regardless of `N`**. Asking for `limit=3` still returns ~25. The MCP layer over-fetches `max(N, 25)` then **slices to `N` client-side**; a raw consumer that trusts the count will over-read. Always slice yourself after the fetch.

### Enumerating new messages — the cursor pattern (what `poll_messages` does)

There is **no server-side cursor or `since=` param** on the raw API; it is request/response only. `poll_messages` synthesizes a cursor client-side, and a raw consumer can reproduce it exactly:

1. **Discover changed chats.** `GET /v1/chats?limit=100`, read each chat's `lastActivity` (ISO 8601). Only chats whose `lastActivity` is `>=` your last high-water timestamp can hold new messages — skip the rest.
2. **Page each candidate.** `GET /v1/chats/{chatID}/messages?limit=50` (newest-first). Keep messages whose `timestamp` is **strictly after** your cursor.
3. **Dedup same-millisecond ties by id.** Track the message ids seen *at* your high-water timestamp; a message is new iff `timestamp > cursorTs` **or** (`timestamp === cursorTs` **and** its id wasn't already seen). This is the off-by-one that bites hand-rolled pollers — without the id set, two messages in the same millisecond will drop one or replay one.
4. **Advance the cursor** to the newest `(timestamp, ids@timestamp)` you delivered. Persist it; it's restart-safe.

This is bounded by Beeper's ~20-chat live sync (step 1 only sees live-synced chats) — the same bound the MCP tools have. **Prefer the `poll_messages` MCP tool**; this is only the recipe if you're consuming raw `/v1/` and can't use MCP.

### Canonical field heuristics (raw shapes → normalized meaning)

The MCP normalizers (`Chat` / `Message`) apply these; a raw consumer must apply them too to agree:

| Concept | Raw rule |
|---|---|
| **Network** | NOT in the room id. Resolve `chat.accountID` against `GET /v1/accounts` → `account.network` (human label), then slug it. Cache the accounts map — it's stable per session. |
| **Note-to-self** | `chat.participants.total === 1 && chat.participants.items[0].isSelf === true`. Catches both Beeper-native Note to self **and** each platform's saved-messages chat (Telegram "Saved Messages", WhatsApp "Send to yourself"). `list_inbox` / `list_unread` filter these out. |
| **Group** | `chat.type === 'group'` (and not note-to-self) — there is no `isGroup` field. |
| **Last activity** | `chat.lastActivity` (camelCase ISO 8601), not `last_activity`. |
| **Message sender-is-self** | `message.isSender === true`. True for **anything the account sent from any client** — this is *not* an "I sent it via the API" signal (the MCP layer adds `source` for that, which the raw API has no equivalent of — it's a beeperbox-side ledger). |
| **Sent message id** | `POST .../messages` returns `pendingMessageID`, a local pending id that the bridge **replaces with a real id on ack**. Don't treat it as a stable delivered id; poll the chat to see the real one. |

## Network slugs

Clean lowercase identifiers the LLM can pattern-match on:

`whatsapp`, `imessage`, `telegram`, `signal`, `discord`, `slack`, `instagram`, `facebook`, `linkedin`, `gmessages`, `twitter`, `matrix`, `beeper`

Unknown networks fall back to the Beeper display name lowercased with non-alphanumerics stripped. Don't branch on `network_label` — it's human-readable and may change between Beeper versions. Branch on `network`.

## Error codes

beeperbox MCP extends the JSON-RPC 2.0 error codes with Beeper-specific codes in the `-32000` to `-32099` range.

| Code | Meaning |
|---|---|
| `-32700` | JSON parse error (malformed request body) |
| `-32600` | Invalid request (missing/wrong `jsonrpc` version) |
| `-32601` | Method not found / tool not found |
| `-32602` | Invalid params (missing required arg, or wrong type) |
| `-32603` | Internal error (unhandled exception) |
| `-32000` | `BEEPER_TOKEN` not set — token missing from container env |
| `-32001` | Beeper API returned an HTTP error; the message includes the Beeper status + response body verbatim so the LLM can self-correct |
| `-32002` | Note-to-self chat not found in the top 100 chats (open Beeper Desktop and verify) |

Tool errors are returned as JSON-RPC error objects, not thrown. The LLM should read `error.message` for the actionable part.

## Auth model

- Container reads `BEEPER_TOKEN` from env at startup (typically set via `.env` file next to `docker-compose.yml`).
- MCP server forwards the token to the raw Beeper API on every call.
- **One container, one Beeper account, any number of tokens.** Each token can have its own scope (read-only or read + write), and you can revoke them individually from Beeper Desktop's Approved Connections panel.
- Token creation: **Settings → Developers → Approved Connections → +** with `expiry: never`. See [docs/GUIDE.md](docs/GUIDE.md) for the full UI walkthrough.

### MCP HTTP transport hardening

`BEEPER_TOKEN` authenticates beeperbox *to Beeper* — it is **not** a credential callers present to the MCP HTTP transport. By default the HTTP transport on `:23375` accepts any well-formed request and relies on the `127.0.0.1` publish to keep it local. Three optional env vars harden that surface (all unset = prior behavior; the stdio transport is local-only and unaffected):

| Env var | Effect | Default |
|---|---|---|
| `MCP_AUTH_TOKEN` | When set, every HTTP request must send `Authorization: Bearer <token>` or get `401`. | unset (open) |
| `MCP_ALLOWED_HOSTS` | Comma-separated `Host`/`Origin` allowlist. Blocks DNS-rebinding (`403` on a non-allowlisted `Host`) and cross-origin browser calls (`403` on a non-allowlisted `Origin`). Set this to your hostname when running behind a reverse proxy. | `localhost,127.0.0.1,::1,[::1]` |
| `MCP_MAX_BODY` | Max request body bytes; larger bodies abort `413`. | `1048576` (1 MiB) |

The listener stays bound to `0.0.0.0` inside the container on purpose — a Docker published port is unreachable if the in-container process binds `127.0.0.1`. Auth + Host/Origin validation are the defense, not the bind address. For an agent that reaches the HTTP transport across hosts, set `MCP_AUTH_TOKEN` and send it as a bearer header.

### Read-only vs read-write tokens

Beeper's token creation UI has an **"Allow sensitive actions"** toggle that gates write operations — you do not need a special beeperbox flag for this, the scope is enforced inside Beeper Desktop itself.

| Token scope | Allowed tools | Denied tools |
|---|---|---|
| **Read + write** (Allow sensitive actions: **on**) | all 11 | none |
| **Read only** (Allow sensitive actions: **off**) | `list_accounts`, `list_inbox`, `list_unread`, `poll_messages`, `get_chat`, `read_chat`, `search_messages` | `send_message`, `note_to_self`, `react_to_message`, `archive_chat` (all return `-32001` / `401 Unauthorized`) |

Use this for least-privilege agents: give a monitoring or summarization agent a read-only token so a prompt-injection attack cannot make it send messages.

### Multi-tenancy

**beeperbox is single-tenant by design** — one container, one Beeper account, period. Beeper Desktop is an Electron GUI with exactly one logged-in user; multiple accounts in one container would require multiple Beeper Desktops, which would require multiple Xvfb/openbox/noVNC stacks, which is exactly what running multiple containers gives you without inventing a new primitive.

For serving multiple accounts on one VPS, **spawn one container per account** using `docker compose -p <project>` for namespacing and the existing `BEEPERBOX_HOST_PORT` / `BEEPERBOX_NOVNC_PORT` / `BEEPERBOX_MCP_PORT` env overrides for port offset. See the "Running multiple instances on one VPS" section in [docs/GUIDE.md](docs/GUIDE.md) for the exact pattern.

Density rule of thumb: ~500MB RAM idle + ~800MB active per instance. 1GB VPS fits 1, 4GB fits 3–4, 8GB fits 6–8. Oracle Cloud's free 24GB ARM tier fits 20+.

## Gotchas

**Top ~20 active chats only.** Beeper Desktop live-syncs the top 20 or so most active chats by default. If `list_inbox` doesn't include a chat the user expects, it's probably deprioritized. Workarounds:
- Pin the chat in Beeper Desktop (via noVNC) — pinned chats stay in live sync regardless of activity
- Use `search_messages` for older history — Beeper has a separate search backend that covers more ground than the live sync

**`?limit=N` is lower-bounded.** Beeper's raw API returns ~25 items minimum from `/v1/chats` regardless of the `limit` param. beeperbox's MCP tools slice client-side to honor your requested limit — no workaround needed at the MCP layer.

**Note-to-self detection is heuristic for inbox filtering, deterministic for sending.** Inbox-side, a chat is classified as note-to-self when `participants.total === 1` AND `participants.items[0].isSelf === true` — this catches both Beeper-native Note to self and per-platform saved-messages chats (Telegram Saved Messages, WhatsApp "Send to yourself", etc.), so any single-self chat is correctly filtered out of `list_inbox` / `list_unread`. The `note_to_self` write tool is stricter: it requires the resolved chat to live on the Beeper-native matrix account so agent self-notes can't accidentally post into Telegram Saved Messages. If no matrix single-self chat exists (unusual setup), it falls back to any single-self chat rather than failing — open Beeper Desktop and verify the Beeper-native "Note to self" chat exists if you see unexpected routing.

**`send_message` returns Beeper's `pendingMessageID`.** Not a stable delivered ID. If you need confirmation the message was actually delivered (not just queued locally), poll `read_chat` for the new message — Beeper replaces the pending ID with a real one once the bridge acks.

**Stdout is reserved for the protocol in stdio mode.** If you write your own MCP client, do not log to `server.js`'s stdout — only stderr. The MCP server's own logs go to stderr automatically.

**Container rebuilds need `up -d`, not `restart`.** Environment variables (including `BEEPER_TOKEN`) are only re-read on container recreation. `docker compose restart` keeps the old env.

**`archive_chat` is not `mark_as_read`.** Beeper's API doesn't expose mark-as-read. Archiving moves a chat out of the inbox but doesn't clear the unread badge in Beeper Desktop. If an agent needs to clear unread, the honest answer is: there is no way via this API, full stop.

## Patterns

### Pattern 1: triage-and-reply loop

```javascript
const unread = await mcp.callTool('list_unread', { limit: 10 });
for (const chat of unread) {
  const messages = await mcp.callTool('read_chat', { chat_id: chat.id, limit: 5 });
  const draft = await llm.draft(messages);
  await mcp.callTool('send_message', { chat_id: chat.id, text: draft });
  await mcp.callTool('archive_chat', { chat_id: chat.id });
}
```

Triage, reply, clean up. Repeats forever as new unread arrives.

### Pattern 2: notification fan-out

```javascript
// Cron job: "CI failed on main"
const accounts = await mcp.callTool('list_accounts', {});
const reachable = accounts.filter(a => ['whatsapp', 'telegram', 'signal'].includes(a.network));

for (const acct of reachable) {
  // find the user's own primary chat on each platform (note-to-self equivalent)
  // for now: send to note_to_self on the Beeper-native account
}

await mcp.callTool('note_to_self', { text: '🔴 CI failed on main — see GitHub Actions' });
```

Sends to the Beeper-native self chat, which shows up on every connected Beeper client (phone, laptop, beeperbox).

### Pattern 3: agent self-log to command channel

```javascript
// At the end of every loop iteration
await mcp.callTool('note_to_self', {
  text: `processed ${count} messages, replied ${replied}, errors ${errors}`,
});
```

The note-to-self chat becomes the agent's persistent log, readable from any Beeper client. Filtered from `list_inbox` so it never pollutes customer views.

### Pattern 4: react-then-reply (lightweight ack)

```javascript
const messages = await mcp.callTool('read_chat', { chat_id, limit: 1 });
const latest = messages[messages.length - 1];

// Immediate ack so the sender knows we saw it
await mcp.callTool('react_to_message', {
  chat_id,
  message_id: latest.id,
  emoji: '👀',
});

// Then draft and send a real reply
const draft = await llm.draft(messages);
await mcp.callTool('send_message', { chat_id, text: draft });
```

Gives the sender immediate feedback ("seen") before the longer reply lands. Works on every bridge that supports reactions.

### Pattern 5: historical lookup with grounding

```javascript
const hits = await mcp.callTool('search_messages', {
  query: 'invoice Q3',
  limit: 10,
});

// Each hit already carries chat_id + network + network_label, so we can
// immediately tell the LLM which conversation each result came from without
// a second round-trip.
const summary = hits.map(h =>
  `[${h.network_label}] ${h.sender.name}: ${h.text}`
).join('\n');

const answer = await llm.answer('What was the agreed Q3 invoice amount?', summary);
```

No N+1 chat fetches — search returns the chat metadata inline.

### Pattern 6: passive watch loop (react to new messages)

```javascript
// Persist `cursor` to disk (e.g. a file or KV) so a restart resumes cleanly.
let cursor = loadCursor() || (await mcp.callTool('poll_messages', {})).cursor; // seed once

while (running) {
  const { cursor: next, messages, has_more } = await mcp.callTool('poll_messages', { cursor });
  cursor = next;
  saveCursor(cursor);

  for (const m of messages) {
    if (m.source === 'api') continue;             // skip our own programmatic sends — NOT is_self
    // m.sender.is_self may be true: the owner's own Note-to-self command is a real signal
    const reply = await llm.handle(m);
    if (reply) await mcp.callTool('send_message', { chat_id: m.chat_id, text: reply, client_tag: m.id });
  }

  if (!has_more) await sleep(POLL_INTERVAL_MS);    // has_more ⇒ keep polling, don't sleep yet
}
```

This replaces the hand-rolled "diff `list_inbox` against last-seen, dedup, track what I've replied to" loop with one cursor the server keeps honest. The poll interval is your call — beeperbox supplies the watch *ability*, not the cadence *policy*. Passing the inbound message id as `client_tag` on the reply makes the reply self-identifying in the next poll (it comes back `source: "api"`, so the guard skips it even if the content-match heuristic misses).

## Transport summary

| Feature | HTTP transport | Stdio transport |
|---|---|---|
| **Default?** | Yes — always on via entrypoint | No — on demand |
| **Where server lives** | Container background process on port 23375 | Spawned per-client via `docker exec -i` |
| **Auth** | Optional `MCP_AUTH_TOKEN` bearer + Host/Origin allowlist (see Auth model) | Local-only; inherits container env |
| **Multi-client** | Many concurrent clients fine | One server per client process |
| **Works across hosts** | Yes (expose the port) | No (requires `docker exec`) |
| **Latency** | ~2ms local loopback | ~50ms process spawn + steady-state low |
| **Best for** | Remote agents, multi-tenant SaaS, web UIs | Claude Code, Cursor, Cline, bareagent, local single-user agents |

Both run in the same `mcp/server.js` file. The transport is picked at startup: default HTTP, `--stdio` argv flag switches to stdio. No duplicated handlers.

## Production usage

beeperbox v0.4.x is a POC → early product. Real-world usage notes:

- **Single tenant.** One Beeper account per container. For multi-tenant deployments, run one container per user with separate volumes and ports.
- **No rate limiting.** Your code is responsible for pacing. Beeper's underlying bridges have their own rate limits (WhatsApp is the strictest — expect 429s under heavy sending).
- **No message delivery guarantees.** `send_message` returns a `pendingMessageID` immediately — actual delivery depends on the bridge. Poll `read_chat` or wait a few seconds before reacting to assume success.
- **Persistent login.** The container's `/root/.config` volume holds the Beeper Desktop session. Back it up if you care about not re-logging in.
- **Restart behavior.** The compose file sets `restart: unless-stopped` + a healthcheck that probes through the socat forwarder. Process death triggers restart immediately; API hangs are caught by the healthcheck within ~100s.
- **Security.** Published ports are bound to `127.0.0.1` only by default. For remote access use SSH tunneling, Tailscale/Wireguard, or a TLS reverse proxy with auth. The MCP HTTP transport additionally validates `Host`/`Origin` (DNS-rebinding defense, always on) and can require a bearer token via `MCP_AUTH_TOKEN` — set it before exposing `:23375` beyond loopback. noVNC (`:6080`) can require a password via `VNC_PASSWORD` (unset = password-less, in which case it must stay loopback-only). The container runs with `no-new-privileges` to block setuid escalation. See [docs/GUIDE.md](docs/GUIDE.md) for patterns.

## Version compatibility

| beeperbox | Beeper Desktop | MCP protocol | Architectures |
|---|---|---|---|
| `0.6.0` | latest at build time (`4.2.860`+, auto-updated) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.4.0` | `4.2.715` (built into image) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.3.3` | `4.2.715` (built into image) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.3.2` | `4.2.715` (built into image) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.3.1` | `4.2.715` (built into image) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.3.0` | `4.2.715` (built into image) | `2025-03-26` | `linux/amd64`, `linux/arm64` |
| `0.2.1` | `4.2.715` | `2025-03-26` | `linux/amd64` |
| `0.2.0` | `4.2.715` | `2025-03-26` | `linux/amd64` |
| `0.1.0` | `4.2.715` | — | `linux/amd64` |

Published tags: `:latest` (newest release, rebuilt weekly and **test-gated** — a build that fails the MCP/VNC guard checks is not published), `:previous` (the prior `:latest`, kept as a known-good fallback — `BEEPERBOX_IMAGE_TAG=previous` to roll back), `:X.Y.Z` (a release; note it is re-pushed by the weekly cron while it's the newest, so it is *not* immutable). For a bit-exact, frozen image, pin the **digest** (`ghcr.io/hamr0/beeperbox@sha256:…`).

Beeper Desktop is frozen at build time in the image. Rebuilding with `docker compose build --no-cache` pulls whatever Beeper Desktop is current at that moment. API schema changes in newer Beeper versions may break normalizers — open an issue if you hit one. For a reproducible, hash-verified build, pass `--build-arg BEEPER_VERSION=<ver> --build-arg BEEPER_SHA256=<sha256>`; without them the build auto-updates to the latest stable Beeper (the default).

Starting with v0.3.0, `docker pull ghcr.io/hamr0/beeperbox:latest` gives you the variant that matches your CPU architecture automatically. Supported hosts: any amd64 Linux (x86/x64) or arm64 Linux (Raspberry Pi 4/5 64-bit, Oracle Cloud Ampere A1, Hetzner CAX-series, AWS Graviton, Apple Silicon under Docker Desktop). No `linux/arm/v7` — Beeper doesn't publish a 32-bit ARM AppImage, so 32-bit Pi OS installs need to upgrade to 64-bit.

## Source and issues

- Repo: https://github.com/hamr0/beeperbox
- Issues: https://github.com/hamr0/beeperbox/issues
- Raw Beeper Desktop API docs (upstream): https://developers.beeper.com/

beeperbox is an independent wrapper around Beeper Desktop. No affiliation with Beeper / Automattic.

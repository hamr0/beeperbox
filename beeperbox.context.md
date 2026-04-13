# beeperbox — Integration Guide

> For AI assistants and developers wiring beeperbox into an agent project.
> v0.2.0 | Docker + vanilla Node >= 18 | 0 runtime deps | MIT
>
> Full human setup walkthrough (noVNC login, token creation, `.env` file, troubleshooting): [docs/GUIDE.md](docs/GUIDE.md)

## What this is

beeperbox is a headless [Beeper Desktop](https://www.beeper.com/) in a Docker container that exposes **two things to agents**:

1. **Raw Beeper Desktop HTTP API** on `127.0.0.1:23373` — the unmodified `/v1/*` endpoints for callers who want full control.
2. **Opinionated Model Context Protocol server** on `127.0.0.1:23375` (HTTP) or stdio — 10 semantic tools, normalized `Chat` / `Message` schemas, note-to-self isolation, clean network slugs. Consume from Claude Code, Cursor, Cline, Continue, bareagent, or any other MCP-speaking runtime.

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

bareagent's `src/mcp-bridge.js` discovers and spawns MCP servers via `child_process.spawn`. Give it the same command:

```javascript
const { Loop } = require('bare-agent');
const { discoverMcpServers } = require('bare-agent/mcp');

const mcpTools = await discoverMcpServers({
  beeperbox: {
    command: 'docker',
    args: ['exec', '-i', 'beeperbox', 'node', '/opt/mcp/server.js', '--stdio'],
  },
});

const loop = new Loop({ provider, tools: mcpTools });
```

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

### `send_message`

Send a text message to a chat. Markdown supported.

**Arguments:** `{chat_id: string, text: string, reply_to_message_id?: string}`.
**Returns:** `{chat_id, message_id, status: "sent"}`.
**Note:** `message_id` is Beeper's `pendingMessageID` — use it for downstream `react_to_message` on the just-sent message.

### `note_to_self`

Send a message to the bot's own Note to self chat. Auto-resolves the correct chat ID, so no `chat_id` parameter needed.

**Arguments:** `{text: string}`.
**Returns:** `{chat_id, message_id, status: "sent"}`.
**Use for:** agent self-notes ("processed 5 customer messages"), debug output, scheduled reminders, anything you want recorded but NOT seen by anyone else. The note-to-self chat is excluded from `list_inbox` / `list_unread` / `search_messages`, so messages here will not pollute customer views.

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
  "timestamp": "2026-04-13T09:30:00Z",
  "reply_to": null
}
```

| Field | Purpose |
|---|---|
| `id` | Message ID. Needed for `react_to_message`. |
| `chat_id` | Parent chat ID. **Always present on every Message**, even in `search_messages` hits — no second lookup to ground. |
| `network` / `network_label` | Same as `Chat`. Propagated so the LLM can branch per-platform without re-fetching the chat. |
| `sender.is_self` | True if the Beeper account sent this message. Use to distinguish "my replies" from "their replies" in a thread. |
| `text` | Message body. For non-text messages (media, voice, etc.) this is `"[MEDIA]"` or `"[<type>]"`. |
| `type` | `"TEXT"`, `"MEDIA"`, etc. |
| `reply_to` | Parent message ID if this is a reply, else `null`. |

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
- **One token, one container, one Beeper account.** Multi-tenant per-request token forwarding is a v0.3 item.
- The token is created in Beeper Desktop: **Settings → Developers → Approved Connections → +** with `allow sensitive actions` and `expiry: never`. See [docs/GUIDE.md](docs/GUIDE.md) for the full flow.

## Gotchas

**Top ~20 active chats only.** Beeper Desktop live-syncs the top 20 or so most active chats by default. If `list_inbox` doesn't include a chat the user expects, it's probably deprioritized. Workarounds:
- Pin the chat in Beeper Desktop (via noVNC) — pinned chats stay in live sync regardless of activity
- Use `search_messages` for older history — Beeper has a separate search backend that covers more ground than the live sync

**`?limit=N` is lower-bounded.** Beeper's raw API returns ~25 items minimum from `/v1/chats` regardless of the `limit` param. beeperbox's MCP tools slice client-side to honor your requested limit — no workaround needed at the MCP layer.

**Note-to-self detection is heuristic.** A chat is classified as note-to-self when `participants.total === 1` AND `participants.items[0].isSelf === true`. This catches both Beeper-native Note to self and per-platform saved-messages chats (Telegram Saved Messages, WhatsApp "Send to yourself", etc.). If a user has an unusual Beeper setup, some saved-messages chats could leak into `list_inbox`.

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

## Transport summary

| Feature | HTTP transport | Stdio transport |
|---|---|---|
| **Default?** | Yes — always on via entrypoint | No — on demand |
| **Where server lives** | Container background process on port 23375 | Spawned per-client via `docker exec -i` |
| **Auth** | Shared `BEEPER_TOKEN` env | Same (inherited from container) |
| **Multi-client** | Many concurrent clients fine | One server per client process |
| **Works across hosts** | Yes (expose the port) | No (requires `docker exec`) |
| **Latency** | ~2ms local loopback | ~50ms process spawn + steady-state low |
| **Best for** | Remote agents, multi-tenant SaaS, web UIs | Claude Code, Cursor, Cline, bareagent, local single-user agents |

Both run in the same `mcp/server.js` file. The transport is picked at startup: default HTTP, `--stdio` argv flag switches to stdio. No duplicated handlers.

## Production usage

beeperbox v0.2.0 is a POC → early product. Real-world usage notes:

- **Single tenant.** One Beeper account per container. For multi-tenant deployments, run one container per user with separate volumes and ports.
- **No rate limiting.** Your code is responsible for pacing. Beeper's underlying bridges have their own rate limits (WhatsApp is the strictest — expect 429s under heavy sending).
- **No message delivery guarantees.** `send_message` returns a `pendingMessageID` immediately — actual delivery depends on the bridge. Poll `read_chat` or wait a few seconds before reacting to assume success.
- **Persistent login.** The container's `/root/.config` volume holds the Beeper Desktop session. Back it up if you care about not re-logging in.
- **Restart behavior.** The compose file sets `restart: unless-stopped` + a healthcheck that probes through the socat forwarder. Process death triggers restart immediately; API hangs are caught by the healthcheck within ~100s.
- **Security.** Published ports are bound to `127.0.0.1` only by default. For remote access use SSH tunneling, Tailscale/Wireguard, or a TLS reverse proxy with auth. See [docs/GUIDE.md](docs/GUIDE.md) for patterns.

## Version compatibility

| beeperbox | Beeper Desktop | MCP protocol |
|---|---|---|
| `0.2.0` | `4.2.715` (built into image) | `2025-03-26` |

Beeper Desktop is frozen at build time in the image. Rebuilding with `docker compose build --no-cache` pulls whatever Beeper Desktop is current at that moment. API schema changes in newer Beeper versions may break normalizers — open an issue if you hit one.

## Source and issues

- Repo: https://github.com/hamr0/beeperbox
- Issues: https://github.com/hamr0/beeperbox/issues
- Raw Beeper Desktop API docs (upstream): https://developers.beeper.com/

beeperbox is an independent wrapper around Beeper Desktop. No affiliation with Beeper / Automattic.

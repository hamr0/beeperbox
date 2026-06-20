#!/usr/bin/env node
// beeperbox MCP server — POC phase 1
// Single-file, vanilla Node, zero deps. Requires Node 18+ for global fetch.
//
// Speaks Model Context Protocol over HTTP transport (POST JSON-RPC 2.0).
// Stdio transport will be added once HTTP is solid.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

// Single source of truth for the version: the sibling package.json — so the
// lite-mode npm package, the container (which COPYs this dir to /opt/mcp), and
// serverInfo can never report different versions. Falls back only if the
// manifest is somehow absent (e.g. server.js copied alone).
const VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0.0.0-dev'; }
})();

const PORT = parseInt(process.env.MCP_PORT || '23375', 10);
const BEEPER_API = process.env.BEEPER_API || 'http://127.0.0.1:23373';
const BEEPER_TOKEN = process.env.BEEPER_TOKEN || '';

// Bind address. Defaults to LOOPBACK (127.0.0.1) — the safe default for lite
// mode (`npx beeperbox` on a laptop), where the process listens directly on the
// host with no Docker loopback publish in front of it. Binding 0.0.0.0 there
// would put the full tool surface (read every message, send across every
// network) on the LAN, reachable unauthenticated by anyone who can spoof the
// `Host` header — a non-browser attacker trivially can. The container needs
// 0.0.0.0 (a Docker published port can't reach a loopback-bound process) and
// sets MCP_BIND_ADDR=0.0.0.0 via the image ENV; there the loopback *publish*
// (`127.0.0.1:23375:23375`), not the bind, is the boundary. To expose lite mode
// deliberately, set MCP_BIND_ADDR=0.0.0.0 AND MCP_AUTH_TOKEN AND a tunnel.
const BIND_ADDR = process.env.MCP_BIND_ADDR || '127.0.0.1';

// ─── http transport hardening ─────────────────────────────────────
// The HTTP transport is the network-exposed surface (stdio is local-only).
// Three guards, all configurable so they don't break the documented
// loopback publish or a reverse-proxy deployment:
//   MCP_AUTH_TOKEN    — if set, every HTTP request must send
//                       `Authorization: Bearer <token>`; unset = open
//                       (back-compat; relies on the loopback publish).
//   MCP_ALLOWED_HOSTS — Host/Origin allowlist (comma-separated). Blocks
//                       DNS-rebinding and cross-origin browser access.
//                       Defaults to loopback; set it for reverse proxies.
//   MCP_MAX_BODY      — max request body bytes (default 1 MiB) so a large
//                       POST can't grow the in-memory buffer unbounded.
// The bind address is MCP_BIND_ADDR (see above): loopback by default (safe for
// lite mode), 0.0.0.0 in the container (where the loopback PUBLISH is the
// boundary). In the container, Auth + Host/Origin are the in-container defense;
// in lite mode the loopback BIND is, because a non-browser client can spoof the
// Host header past the allowlist.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const MCP_ALLOWED_HOSTS = new Set(
  (process.env.MCP_ALLOWED_HOSTS || 'localhost,127.0.0.1,::1,[::1]')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const MCP_MAX_BODY = parseInt(process.env.MCP_MAX_BODY || String(1024 * 1024), 10);

// Echo-guard id resolution. A send returns a `pendingMessageID`, but Beeper
// swaps it for the real bridge id once the message is acked — so the id we'd
// record at send time never matches the id the same message reappears under in
// poll_messages / read_chat. We resolve it: GET the message back until its id
// differs from the pending one, then store the FINAL id so the echo-guard
// matches on exact id instead of falling back to fragile text matching. The
// ack is asynchronous, so this is bounded + best-effort (retry a few times,
// then give up and keep the text fallback as the safety net). Tunable so a
// latency-sensitive deployment can shrink or disable it (RETRIES=0).
// Clamp to a non-negative integer, falling back to the default on a malformed
// value. Without this a typo (e.g. RETRIES="four" → NaN) would silently pass
// the `<= 0` / loop guards and DISABLE resolution — degrading the echo-guard to
// text-only with no error. `0` stays a valid, intentional disable.
function envIntNonNeg(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
const RESOLVE_RETRIES = envIntNonNeg('BEEPERBOX_RESOLVE_RETRIES', 4);
const RESOLVE_DELAY_MS = envIntNonNeg('BEEPERBOX_RESOLVE_DELAY_MS', 250);
// Per-attempt fetch timeout so a hung Beeper API can't stall a send unbounded:
// worst-case added send latency is RETRIES × (TIMEOUT + DELAY), not infinite.
const RESOLVE_TIMEOUT_MS = envIntNonNeg('BEEPERBOX_RESOLVE_TIMEOUT_MS', 3000);

// download_asset ships the bytes base64-encoded inside the JSON-RPC result, so
// a large attachment would bloat the response (base64 inflates ~33%) and the
// in-memory buffer. Cap it; tunable for a deployment that needs bigger files.
// FAQ/doc attachments — the driving use case — are well under this.
const MAX_ASSET_BYTES = envIntNonNeg('BEEPERBOX_MAX_ASSET_BYTES', 8 * 1024 * 1024);
// Per-call timeout on the asset-serve fetch so a hung or slow-drip source can't
// stall the request forever and the buffer can't grow unbounded behind it.
const ASSET_TIMEOUT_MS = envIntNonNeg('BEEPERBOX_ASSET_TIMEOUT_MS', 30000);
// Startup preflight: one bounded probe of the Beeper API on boot so a bad
// BEEPER_API / token is obvious in the logs immediately, not at first tool call.
// Container has a Docker HEALTHCHECK + supervises beepertexts; lite mode has
// neither, so this is its boot sanity check. Opt out with BEEPERBOX_PREFLIGHT=0.
const PREFLIGHT_TIMEOUT_MS = envIntNonNeg('BEEPERBOX_PREFLIGHT_TIMEOUT_MS', 5000);

// The accountID -> network map is cached so chat normalizers don't re-fetch
// /v1/accounts on every call. But an UNBOUNDED cache is a resilience bug: an
// account added at runtime (e.g. WhatsApp via noVNC) would render network
// "unknown" in every chat verb until the MCP *process* restarts, and an empty/
// partial map captured during the backend's post-restart sync window would
// freeze for the whole process life — so a plain `docker restart` re-poisons it
// from a still-syncing backend and the account list stays wrong (the exact wedge
// multis reported). Bound it with a TTL, and never cache an EMPTY result. Set to
// 0 to disable caching (always read live).
const ACCOUNT_CACHE_TTL_MS = envIntNonNeg('BEEPERBOX_ACCOUNT_CACHE_TTL_MS', 60000);

// Injectable clock — overridable in tests so the TTL is verifiable without a
// real sleep. Production reads the wall clock.
let nowFn = () => Date.now();

// Real attachment src_urls come in two shapes: remote Matrix content
// (mxc:// / localmxc://) and, once Beeper caches the file locally,
// file:///root/.config/BeeperTexts/media/... — verified against a live account.
// Beeper's own /v1/assets/serve already guards this (it 403s a file:// outside
// its media dir and 400s a non-mxc/localmxc/file scheme — observed live). We do
// NOT lean on that undocumented upstream behavior: download_asset is the
// network-reachable MCP surface, so it independently allows mxc:// / localmxc://,
// allows file:// ONLY when it resolves inside the media cache, and refuses
// everything else BEFORE the fetch — defense in depth, plus a clear error
// instead of a raw Beeper 4xx. The file:// path is decoded + normalized and any
// authority/host or double-encoded dot/slash refused, so a caller can't smuggle
// ../ or a UNC host past the prefix check. Applied to BOTH the caller-supplied
// src_url and a src_url resolved off a message (a hostile sender could craft a
// file:// attachment pointing elsewhere).
const ASSET_FILE_ROOT = (() => {
  const r = process.env.BEEPERBOX_ASSET_FILE_ROOT || '/root/.config/BeeperTexts/media/';
  return r.endsWith('/') ? r : r + '/';
})();

function fileUrlInsideMediaCache(srcURL) {
  let u;
  try { u = new URL(srcURL); } catch { return false; }
  // A file:// authority/host (file://host/path) is a network/UNC semantic the
  // pathname check would miss — and we forward the ORIGINAL url, host and all.
  // Legit local attachments have no host (file:///… ; even file://localhost
  // normalizes the host away), so refuse any non-empty host.
  if (u.host) return false;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return false; }
  // One decode matches Beeper serve's own single-decode (observed: it 404s a
  // double-encoded path as a literal, never re-decodes). Any %2e/%2f still
  // present after that decode is a DOUBLE-encoded dot/slash — an attempt to
  // smuggle ../ past normalize() — so refuse rather than forward it. (A plain
  // literal %25 in a real filename decodes to a bare % here, not %2e/%2f, so
  // this doesn't over-reject normal names.)
  if (/%2[ef]/i.test(p)) return false;
  return path.posix.normalize(p).startsWith(ASSET_FILE_ROOT);
}

function assertServableSrcUrl(srcURL) {
  const s = String(srcURL);
  if (/^(?:mxc|localmxc):\/\//i.test(s)) return;
  if (/^file:\/\//i.test(s)) {
    if (fileUrlInsideMediaCache(s)) return;
    throw rpcError(-32602, `file:// src_url must resolve inside the Beeper media cache (${ASSET_FILE_ROOT}); other paths are refused`);
  }
  throw rpcError(-32602, 'src_url must be an mxc://, localmxc://, or Beeper-cache file:// URL — other schemes are refused');
}

// Strip the port from a Host header value ("127.0.0.1:23375" -> "127.0.0.1",
// "[::1]:23375" -> "[::1]").
function hostFromHeader(value) {
  if (!value) return '';
  const h = value.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || h;
  const c = h.indexOf(':');
  return c >= 0 ? h.slice(0, c) : h;
}

// Returns null when the request may proceed, else { status, message }.
function httpGuard(req) {
  // DNS-rebinding guard: the browser sends the attacker's domain as Host.
  const host = hostFromHeader(req.headers.host);
  if (host && !MCP_ALLOWED_HOSTS.has(host)) {
    return { status: 403, message: `host not allowed: ${host}` };
  }
  // Cross-origin browser guard: native clients (curl, MCP runtimes) send no
  // Origin, so this only ever rejects browser-initiated cross-site requests.
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = new URL(origin).hostname.toLowerCase(); } catch { oh = null; }
    if (!oh || !(MCP_ALLOWED_HOSTS.has(oh) || MCP_ALLOWED_HOSTS.has(`[${oh}]`))) {
      return { status: 403, message: `origin not allowed: ${origin}` };
    }
  }
  // Bearer-token guard: only enforced when a token is configured.
  if (MCP_AUTH_TOKEN && req.headers.authorization !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return { status: 401, message: 'unauthorized' };
  }
  return null;
}

// ─── beeper api helper ────────────────────────────────────────────

async function beeperFetch(path, opts = {}) {
  if (!BEEPER_TOKEN) throw rpcError(-32000, 'BEEPER_TOKEN env var not set — create a token in Beeper Settings > Developers and set the BEEPER_TOKEN environment variable');
  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${BEEPER_TOKEN}` },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  // Opt-in per-call timeout (opts.timeoutMs). Default callers are unbounded as
  // before; the resolve path passes one so a hung API can't stall a send.
  let timer = null;
  if (opts.timeoutMs) {
    const ac = new AbortController();
    init.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  }
  try {
    const r = await fetch(`${BEEPER_API}${path}`, init);
    if (!r.ok) throw rpcError(-32001, `beeper api ${r.status}: ${(await r.text()).slice(0, 200)}`);
    // Binary mode (opts.raw): return the bytes + content-type instead of
    // parsing JSON — used by download_asset to serve attachment bytes. Enforce
    // the byte cap twice: the Content-Length header (reject before buffering a
    // well-behaved large response) and the actual buffered length (in case the
    // header is absent or lies). Decoding these bytes as text would corrupt
    // them, so this path never touches r.text()/JSON.parse.
    if (opts.raw) {
      const max = opts.maxBytes || 0;
      const declared = parseInt(r.headers.get('content-length') || '', 10);
      if (max && Number.isFinite(declared) && declared > max) {
        throw rpcError(-32005, `asset is ${declared} bytes, over the ${max}-byte cap — raise BEEPERBOX_MAX_ASSET_BYTES or fetch /v1/assets/serve directly`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (max && buf.length > max) {
        throw rpcError(-32005, `asset is ${buf.length} bytes, over the ${max}-byte cap — raise BEEPERBOX_MAX_ASSET_BYTES or fetch /v1/assets/serve directly`);
      }
      return { bytes: buf, content_type: r.headers.get('content-type') || '' };
    }
    // Some POST/DELETE endpoints return empty body — return null instead of throwing on r.json()
    const text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── network normalization ────────────────────────────────────────
// Beeper's /v1/accounts endpoint already returns a human-readable
// network name per account ("Discord", "WhatsApp", "Beeper (Matrix)").
// We cache the accountID -> {network, network_label} map at first use
// and look up each chat by its accountID. Chat objects do NOT encode
// the network in the room ID — that's an accountID lookup.

const NETWORK_SLUGS = {
  'WhatsApp':           'whatsapp',
  'iMessage':           'imessage',
  'Telegram':           'telegram',
  'Signal':             'signal',
  'Discord':            'discord',
  'Slack':              'slack',
  'Instagram':          'instagram',
  'Facebook Messenger': 'facebook',
  'LinkedIn':           'linkedin',
  'Google Messages':    'gmessages',
  'X (Twitter)':        'twitter',
  'Beeper (Matrix)':    'matrix',
  'Matrix':             'matrix',
};

function networkSlug(label) {
  return NETWORK_SLUGS[label] || String(label || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

let accountCache = null;
let noteToSelfChatID = null;

async function getNoteToSelfChatID() {
  if (noteToSelfChatID) return noteToSelfChatID;
  // The "single participant who is self" heuristic also matches each platform's
  // saved-messages chat (Telegram "Saved Messages", WhatsApp "Send to yourself",
  // etc.). To avoid leaking agent self-notes onto a third-party network, require
  // the chat live on the Beeper-native matrix account. Fall back to any single-
  // self chat only if no matrix one exists (preserves prior behavior for users
  // without a Beeper-native account, with a clearer error if nothing matches).
  const [accounts, raw] = await Promise.all([
    getAccountMap(),
    beeperFetch('/v1/chats?limit=100'),
  ]);
  const list = raw.items || raw.chats || (Array.isArray(raw) ? raw : []);
  let fallback = null;
  for (const c of list) {
    const participants = c.participants?.items || [];
    if (c.participants?.total !== 1 || participants[0]?.isSelf !== true) continue;
    if (accounts[c.accountID]?.network === 'matrix') {
      noteToSelfChatID = c.id;
      return noteToSelfChatID;
    }
    if (!fallback) fallback = c.id;
  }
  if (fallback) {
    // Defeats the matrix-preferred routing but is better than failing for users
    // without a Beeper-native account. Log loudly so the behavior isn't silent
    // — if a user expects matrix-native routing and sees this, something is
    // misconfigured (matrix bridge offline, account just removed, etc.).
    process.stderr.write(`[beeperbox-mcp] note_to_self: no Beeper-native matrix chat found; falling back to non-matrix single-self chat ${fallback} — agent self-notes will route to this platform's saved-messages chat\n`);
    noteToSelfChatID = fallback;
    return noteToSelfChatID;
  }
  throw rpcError(-32002, 'note-to-self chat not found in top 100 chats — open Beeper Desktop and verify a "Note to self" chat exists');
}

// Unwrap /v1/accounts into a bare array — Beeper returns a bare array today, but
// tolerate a {items:[...]} envelope. One place so list_accounts, getAccountMap,
// and preflight agree.
function accountList(accounts) {
  return Array.isArray(accounts) ? accounts : (accounts?.items || []);
}

// accountCache: { map, at } | null. Bounded by ACCOUNT_CACHE_TTL_MS and NEVER
// populated from an empty result — see ACCOUNT_CACHE_TTL_MS above for why the old
// unbounded cache wedged after a runtime account-add / post-restart sync window.
async function getAccountMap() {
  const now = nowFn();
  const cacheValid =
    accountCache &&
    ACCOUNT_CACHE_TTL_MS > 0 &&
    (now - accountCache.at) < ACCOUNT_CACHE_TTL_MS;
  if (cacheValid) return accountCache.map;

  const list = accountList(await beeperFetch('/v1/accounts'));
  const map = {};
  for (const a of list) {
    map[a.accountID] = { network: networkSlug(a.network), network_label: a.network };
  }
  // An empty /v1/accounts is almost always the backend mid-sync (just after a
  // restart or an account-add), not a real "no accounts" state. Caching it would
  // freeze every chat verb's network labels until the *process* restarts. Serve
  // it for THIS call (the verb still returns, just with "unknown" labels) but
  // leave the cache empty so the very next call re-reads and self-heals the
  // moment the backend populates. Log it so a recurrence is diagnosable, not silent.
  if (list.length === 0) {
    process.stderr.write('[beeperbox-mcp] /v1/accounts returned 0 accounts — Beeper may still be syncing; not caching, will re-read next call\n');
    accountCache = null;
    return map;
  }
  accountCache = { map, at: now };
  return map;
}

// Map one raw /v1/accounts entry into the list_accounts shape. `status` is the
// backend's per-account connection state ("connected" / "connecting" / …) —
// surfaced (not dropped) so a caller can tell a still-syncing bridge from a real
// one instead of reading a transient as "gone".
function normalizeAccount(a) {
  return {
    account_id: a.accountID,
    network: networkSlug(a.network),
    network_label: a.network,
    status: a.status || null,
    user: {
      id: a.user?.id || null,
      display_name: a.user?.fullName || a.user?.displayText || a.user?.username || null,
    },
  };
}

// ─── chat normalizer ──────────────────────────────────────────────
// Map Beeper's raw chat object into the schema MCP clients consume.
// One shape, returned everywhere — `list_inbox`, `list_unread`, `get_chat`.
//
// Real Beeper fields (verified against /v1/chats response):
//   id            → room ID (matrix-style)
//   accountID     → maps to /v1/accounts[].network
//   title         → chat title
//   type          → "group" | "single"
//   participants  → { items: [{isSelf}], total: N }
//   lastActivity  → ISO timestamp
//   unreadCount   → integer

// ─── message normalizer ───────────────────────────────────────────
// Map Beeper's raw message object into the second canonical shape
// MCP clients consume. Carries chat_id and network on every message
// so agents never need a second lookup for grounding.
//
// Real Beeper message fields (from /v1/chats/<id>/messages):
//   id            → message ID
//   chatID        → parent chat id
//   senderID      → sender Matrix-style ID
//   senderName    → human name
//   isSender      → true iff this user sent it
//   timestamp     → ISO 8601
//   text          → message body (when type === 'TEXT')
//   type          → 'TEXT' | 'MEDIA' | etc.
//   replyTo       → optional, parent message id

// Map Beeper's raw message `attachments[]` into a normalized shape MCP clients
// can act on. Pure passthrough of the fields that already ride the raw message
// — no extra fetch. `src_url` is the download reference (an mxc:// / localmxc://
// Matrix content URL, or a file:// URL into Beeper's media cache once the file
// is downloaded locally) that download_asset takes. `size` carries the byte
// length (raw `fileSize`) when present. Returns [] when
// there are no attachments, so the field is always an array.
function normalizeAttachments(raw) {
  const list = Array.isArray(raw?.attachments) ? raw.attachments : [];
  return list.map((a) => ({
    type: a.type || null,
    file_name: a.fileName || null,
    mime_type: a.mimeType || null,
    src_url: a.srcURL || null,
    size: typeof a.fileSize === 'number' ? a.fileSize : null,
    is_voice_note: !!a.isVoiceNote,
  }));
}

function normalizeMessage(raw, chat) {
  return {
    id: String(raw.id),
    chat_id: raw.chatID || chat?.id || null,
    network: chat?.network || 'unknown',
    network_label: chat?.network_label || 'Unknown',
    sender: {
      id: raw.senderID || null,
      name: raw.senderName || null,
      is_self: !!raw.isSender,
    },
    text: raw.text || (raw.type === 'TEXT' ? '' : `[${raw.type || 'non-text'}]`),
    type: raw.type || 'TEXT',
    // Media reach: a MEDIA message carries no usable `text`, so without this an
    // agent could see "[MEDIA]" but never reach the file. Always an array.
    attachments: normalizeAttachments(raw),
    timestamp: raw.timestamp || null,
    reply_to: raw.replyTo || raw.reply_to || null,
    // Echo-guard origin. Defaults assume "not sent through this beeperbox";
    // applyEchoTags() upgrades to source:'api' (+ client_tag) for messages
    // the send_message / note_to_self tools recorded. See the sent-ledger
    // section below for why is_self alone can't tell these apart.
    source: 'external',
    client_tag: null,
  };
}

function normalizeChat(raw, accounts) {
  const acct = accounts[raw.accountID] || { network: 'unknown', network_label: 'Unknown' };
  const participants = raw.participants?.items || [];
  // Note-to-self = chat with exactly one participant who is yourself.
  // Catches Beeper's native Note-to-self AND each platform's saved-messages
  // chat (Telegram "Saved Messages", WhatsApp "Send to yourself", etc.).
  const isNoteToSelf = raw.participants?.total === 1 && participants[0]?.isSelf === true;
  return {
    id: raw.id,
    title: raw.title || '(untitled)',
    network: acct.network,
    network_label: acct.network_label,
    is_group: raw.type === 'group' && !isNoteToSelf,
    is_note_to_self: isNoteToSelf,
    last_message_at: raw.lastActivity || null,
    unread_count: raw.unreadCount || 0,
  };
}

// ─── poll cursor (pure, stateless, restart-resumable) ─────────────
// The cursor is an opaque base64 of {ts, ids}: ts is the high-water
// message timestamp delivered so far, ids are the message ids seen at
// EXACTLY that ts. A message is "after" the cursor iff its ts is
// strictly greater, OR equal-ts but its id was not already in `ids`.
// The {ids} half is what makes same-millisecond messages dedup
// correctly instead of one silently swallowing the other — the exact
// seed/poll/dedup bug-class this primitive exists to retire. The caller
// persists the opaque string and passes it back; because no state lives
// server-side, resuming after a process/container restart is automatic.

function encodeCursor(state) {
  return Buffer
    .from(JSON.stringify({ ts: state.ts || '', ids: state.ids || [] }), 'utf8')
    .toString('base64');
}

// A legitimate cursor only ever carries the ids sharing one high-water
// millisecond — at most a single poll page (≤100). Anything beyond this is a
// crafted/corrupt cursor; reject it rather than pay O(n) per message scanning
// `cur.ids.includes(...)` on attacker-chosen length.
const CURSOR_IDS_MAX = 4096;

function decodeCursor(cursor) {
  if (!cursor) return null; // absent → seed mode (start from now)
  let s;
  try {
    s = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
  } catch {
    s = undefined;
  }
  if (!s || typeof s.ts !== 'string' || !Array.isArray(s.ids)) {
    throw rpcError(-32602, 'poll_messages: malformed cursor — pass back the exact cursor string from the previous response, or omit it to re-seed from now');
  }
  if (s.ids.length > CURSOR_IDS_MAX) {
    throw rpcError(-32602, `poll_messages: cursor too large (${s.ids.length} ids) — it was not produced by this server; omit the cursor to re-seed`);
  }
  return { ts: s.ts, ids: s.ids.map(String) };
}

// ISO-8601 timestamps (Beeper emits `...Z`) sort lexicographically, so a
// plain string compare is also a chronological compare.
function isAfterCursor(msg, cur) {
  if (!cur) return true;            // defensive; seed path returns early elsewhere
  if (!msg.timestamp) return false; // unorderable → never enters the feed (can't advance past it)
  if (msg.timestamp > cur.ts) return true;
  if (msg.timestamp === cur.ts) return !cur.ids.includes(String(msg.id));
  return false;
}

// Advance the cursor over the set we actually delivered (already filtered
// as after `prev`). New high-water ts resets the id set to that ts; more
// messages at the existing high-water ts accumulate into it.
function advanceCursor(prev, delivered) {
  let ts = prev ? prev.ts : '';
  let ids = prev ? prev.ids.slice() : [];
  for (const m of delivered) {
    if (!m.timestamp) continue;
    if (m.timestamp > ts) { ts = m.timestamp; ids = [String(m.id)]; }
    else if (m.timestamp === ts) { ids.push(String(m.id)); }
  }
  return { ts, ids: [...new Set(ids)] };
}

// Pure: from the union of fresh (after-cursor) messages across all scanned
// chats, hand back the OLDEST `page` and advance the cursor over EXACTLY
// those. Delivering oldest-first (not newest) is what makes an over-`page`
// burst recoverable: the cursor moves forward only past what the caller
// actually received, so the newer remainder arrives on the next poll instead
// of being skipped. `hasMore` is true iff there is an immediately-fetchable
// remainder — i.e. re-polling now will return more.
function selectDelivery(fresh, cur, page) {
  const sorted = fresh.slice().sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hasMore = sorted.length > page;
  const delivered = hasMore ? sorted.slice(0, page) : sorted;
  return { delivered, next: advanceCursor(cur, delivered), hasMore };
}

// ─── sent-message ledger (echo-guard) ─────────────────────────────
// Distinguishes "this message was sent THROUGH beeperbox's own send API"
// from "this message is from my Beeper account" (sender.is_self). On ONE
// account both the human owner's own typed messages AND the agent's API
// replies are is_self === true, so is_self cannot guard against an agent
// re-processing its own sends. We record every message send_message /
// note_to_self emits and tag it source:'api' (with any caller client_tag)
// on read-back; everything else stays source:'external'. The ledger is
// persisted to the config volume so the guard survives a restart — the
// brittle text-prefix guard this replaces was restart-durable too.
//
// PRIMARY match is exact id. The send only knows the pendingMessageID, which
// Beeper swaps for a real bridge id on ack — so we resolve the final id right
// after sending (resolveSentId) and record BOTH against the entry. A read-back
// then matches by exact id whether or not the swap happened. The content
// fallback survives only as a last-ditch safety net, and ONLY for entries we
// could NOT resolve a final id for: it matches our own (is_self) messages, in
// the same chat, inside a short window. Once an entry IS resolved, exact id is
// authoritative for it and the text fallback is deliberately disabled — that is
// what stops a human re-typing identical text from being mis-tagged as ours.
//
// CAVEAT (unverifiable in CI — no live Beeper account; validate against a real
// account before relying on it): the resolution and content fallback both
// depend on Beeper's live id/ack behavior.

const LEDGER_MAX = 500;
const LEDGER_TEXT_WINDOW_MS = 15 * 60 * 1000;
// Bound a caller-supplied client_tag so it can't bloat the persisted ledger
// (the tag is an idempotency key — 256 chars is far more than any real one).
const CLIENT_TAG_MAX = 256;

// Where the echo-guard ledger persists. BEEPERBOX_SENT_LEDGER overrides
// explicitly; otherwise a per-user XDG path under the config home. This is one
// code path for BOTH deployments — no container-detection — because os.homedir()
// is /root in the container (so the file lands on the persisted /root/.config
// volume) and the real user's home in lite mode (so a non-root host process can
// actually write it). The old hardcoded /root/.config/... default silently
// failed to persist on any normal host, degrading the echo-guard across
// restarts; this is the fix.
function ledgerPath() {
  if (process.env.BEEPERBOX_SENT_LEDGER) return process.env.BEEPERBOX_SENT_LEDGER;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'beeperbox', 'sent-ledger.json');
}

let ledger = null; // lazily loaded array of { chat_id, sent_ids[], resolved, text_hash, client_tag, ts }

function textHash(text) {
  return crypto.createHash('sha256')
    .update(String(text == null ? '' : text).trim())
    .digest('hex')
    .slice(0, 16);
}

function loadLedger() {
  if (ledger) return ledger;
  ledger = [];
  try {
    const fs = require('fs');
    const arr = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    if (Array.isArray(arr)) ledger = arr.slice(-LEDGER_MAX);
  } catch { /* best-effort: no ledger yet, unreadable, or bad json → start empty */ }
  return ledger;
}

let ledgerPersistWarned = false;
function persistLedger() {
  try {
    const fs = require('fs');
    const p = ledgerPath();
    // The per-user XDG dir (~/.config/beeperbox) won't exist on a fresh host —
    // create it (recursive, ignores already-exists) so the very first send can
    // persist instead of degrading the guard to in-memory.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger.slice(-LEDGER_MAX)), { mode: 0o600 });
  } catch (e) {
    // Swallow — a degraded echo-guard must never take down a send. Warn once.
    if (!ledgerPersistWarned) {
      ledgerPersistWarned = true;
      process.stderr.write(`[beeperbox-mcp] sent-ledger persist failed (${e.code || e.message}) — echo-guard degrades to in-memory for this run\n`);
    }
  }
}

function recordSent({ chat_id, sent_id, text, client_tag }) {
  loadLedger();
  const entry = {
    chat_id,
    // Carries every id this send is known by — the pendingMessageID now, the
    // resolved bridge id once addResolvedId() lands it. `resolved` flips true
    // when we have the authoritative final id (retires the text fallback).
    sent_ids: sent_id ? [String(sent_id)] : [],
    resolved: false,
    text_hash: textHash(text),
    client_tag: client_tag ? String(client_tag).slice(0, CLIENT_TAG_MAX) : null,
    ts: Date.now(),
  };
  ledger.push(entry);
  if (ledger.length > LEDGER_MAX) ledger = ledger.slice(-LEDGER_MAX);
  persistLedger();
  return entry; // so the caller can attach the resolved id (addResolvedId)
}

// Attach the resolved final bridge id to a ledger entry and mark it exact-id
// authoritative, then persist so the resolution survives a restart. Idempotent.
function addResolvedId(entry, finalID) {
  if (!entry || !finalID) return;
  const s = String(finalID);
  if (!entry.sent_ids) entry.sent_ids = [];
  if (!entry.sent_ids.includes(s)) entry.sent_ids.push(s);
  entry.resolved = true;
  persistLedger();
}

// Best-effort resolve a pendingMessageID to the final bridge id Beeper assigns
// on ack. The ack is asynchronous, so GET the message back a few times until
// its id differs from the pending one. Returns the final id, or null if it
// never swapped within the retry budget (caller keeps the pending id + text
// fallback). Never throws — a degraded echo-guard must never fail a send.
async function resolveSentId(chatID, pendingMessageID) {
  const pend = pendingMessageID ? String(pendingMessageID) : '';
  if (!pend || !chatID || RESOLVE_RETRIES <= 0) return null;
  for (let attempt = 0; attempt < RESOLVE_RETRIES; attempt++) {
    try {
      const m = await beeperFetch(
        `/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(pend)}`,
        { timeoutMs: RESOLVE_TIMEOUT_MS },
      );
      // GET is by id → a single message object. Only trust that shape: a
      // list/other response would let us read an arbitrary message's id and
      // store the WRONG final id, which would mis-tag an unrelated read-back.
      const id = m && m.id != null ? String(m.id) : null;
      if (id && id !== pend) return id; // swapped to the real bridge id
    } catch { /* not acked yet, timed out, or transient — retry */ }
    if (attempt < RESOLVE_RETRIES - 1 && RESOLVE_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, RESOLVE_DELAY_MS));
    }
  }
  return null;
}

// Pure: decide api-vs-external origin + echoed client_tag for one message
// given the ledger entries and a `now`. Exact id match first (high
// confidence); content fallback only for our own recent same-chat sends.
function matchSentMessage(msg, entries, now) {
  const mid = String(msg.id);
  // 1. Exact id match — high confidence. Checks every id the send is known by:
  //    the pendingMessageID and (once resolved) the final bridge id, so a
  //    read-back matches whether or not Beeper swapped the id on ack. Tolerates
  //    the legacy single-`sent_id` entry shape for ledgers written pre-upgrade.
  for (const e of entries) {
    if (e.chat_id !== msg.chat_id) continue;
    const ids = e.sent_ids || (e.sent_id ? [e.sent_id] : []);
    for (const id of ids) {
      if (id && String(id) === mid) return { source: 'api', client_tag: e.client_tag || null };
    }
  }
  // 2. Last-ditch text fallback — ONLY for our own (is_self) messages, same
  //    chat, recent window, AND only against entries whose final id we could
  //    NOT resolve (resolved !== true). Once an entry is resolved, step 1 is
  //    authoritative for it; skipping its text match is what keeps a human
  //    re-typing identical text from being mis-tagged as ours and dropped.
  if (msg.is_self) {
    const h = textHash(msg.text);
    for (const e of entries) {
      if (e.chat_id !== msg.chat_id) continue;
      if (e.resolved === true) continue;
      if (e.text_hash === h && (now - e.ts) <= LEDGER_TEXT_WINDOW_MS) {
        return { source: 'api', client_tag: e.client_tag || null };
      }
    }
  }
  return { source: 'external', client_tag: null };
}

// Stamp source/client_tag onto already-normalized messages.
function applyEchoTags(messages, now) {
  const entries = loadLedger();
  return messages.map((m) => {
    const meta = matchSentMessage(
      { id: m.id, chat_id: m.chat_id, text: m.text, is_self: m.sender.is_self },
      entries,
      now,
    );
    return { ...m, source: meta.source, client_tag: meta.client_tag };
  });
}

// ─── tool registry ────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_accounts',
    description: 'List all messaging accounts (networks) connected to this Beeper account. Each account corresponds to one platform — WhatsApp, Telegram, Discord, etc. Use this to see which platforms are reachable before calling other tools, or to discover what kinds of chats exist. Returns network slug (machine-readable, e.g. "whatsapp"), network label (human, e.g. "WhatsApp"), the underlying account ID, the bridge connection `status` ("connected", "connecting", etc. — lets you tell a still-syncing account from a real one rather than reading a transient as "gone"), and the user\'s display name on that platform.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_chat',
    description: 'Fetch metadata for one specific chat by ID. Returns the same Chat schema as list_inbox so the caller does not need to learn a second shape. Use this when you have a chat ID from a previous call (e.g. from list_inbox or search_messages) and need its current state — most often to check unread_count, last_message_at, or title before replying.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID to fetch (the `id` field from any Chat object returned by list_inbox or get_chat).' },
      },
      required: ['chat_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_chat',
    description: 'Fetch the most recent messages from one chat. Returns messages in chronological order (oldest to newest within the page) with normalized sender info, network, and chat_id propagated to every message. Use this to read context before replying, or to pull the last few messages of a conversation for the LLM to reason about.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID to read from (the `id` field from any Chat object).' },
        limit: { type: 'integer', description: 'Max messages to return (default 20)', default: 20, minimum: 1, maximum: 100 },
      },
      required: ['chat_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'archive_chat',
    description: 'Archive or unarchive a chat. Archived chats are moved out of the active inbox (list_inbox no longer returns them) but messages and history are preserved. Use this to clean up handled chats after replying or processing them. Beeper does not expose a mark-as-read endpoint, so archiving is the closest primitive for the "I am done with this conversation" pattern. Pass archived=false to unarchive.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID to archive (the `id` field from any Chat object).' },
        archived: { type: 'boolean', description: 'true to archive (default), false to unarchive', default: true },
      },
      required: ['chat_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_inbox',
    description: 'List the most recently active chats from the user\'s connected messaging accounts. Excludes the bot\'s own note-to-self chat (use note_to_self for that). Returns chat metadata including network (whatsapp/telegram/imessage/etc.), title, unread count, and last activity timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max chats to return (default 20)', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description: 'Full-text search across all messages in all chats. Returns matching messages with chat_id and network propagated so the LLM can immediately tell which conversation each hit belongs to without a second lookup. Use this for follow-up questions ("what did Sara say about the contract?"), historical lookups, or finding old context the agent does not have in its current window. Older history may not be indexed if Beeper has not synced it — see the "top 20 active chats" caveat in the GUIDE.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to search for. Plain text — no special operators.', minLength: 1 },
        limit: { type: 'integer', description: 'Max messages to return (default 20)', default: 20, minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_to_self',
    description: 'Send a message to the bot\'s own Note to self chat — the dedicated command/control channel for the agent itself. Use this for agent self-notes ("processed 5 customer messages"), debugging output, scheduled reminders to self, or anything you want recorded but NOT seen by anyone else. Auto-resolves the correct chat ID, so no chat_id parameter needed. The note-to-self chat is excluded from list_inbox / list_unread / search_messages, so messages here will not pollute customer inbox views.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text. Markdown supported.', minLength: 1 },
        client_tag: { type: 'string', description: 'Optional idempotency/echo tag. Recorded against this send and echoed back on the message as `client_tag` when it reappears in poll_messages / read_chat (where it is also marked source:"api"), so an agent can recognize and skip its own programmatic sends.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a text message to a chat. The headline write operation. Use this to reply to a customer, send a notification, or initiate a conversation. The chat must already exist (use a chat_id from list_inbox / list_unread / search_messages / get_chat). Markdown is supported in the text. To reply specifically to one message rather than just adding to the conversation, pass reply_to_message_id. Returns the new message ID for downstream operations like react_to_message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID to send to (the `id` field from any Chat object).' },
        text: { type: 'string', description: 'The message body. Markdown supported.', minLength: 1 },
        reply_to_message_id: { type: 'string', description: 'Optional. Pass a message_id to send this as a reply to that specific message instead of as a new conversation entry.' },
        client_tag: { type: 'string', description: 'Optional idempotency/echo tag. Recorded against this send and echoed back on the message as `client_tag` when it reappears in poll_messages / read_chat (where it is also marked source:"api"), so an agent can recognize and skip its own programmatic sends.' },
      },
      required: ['chat_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'react_to_message',
    description: 'Add an emoji reaction to a specific message. The lightest possible "I saw it" or "ack" signal — use this when you want to acknowledge a message without sending a full reply. Pass the unicode emoji directly (e.g. "👍", "❤️", "✅"). Reactions are visible to the message sender on every supported network (WhatsApp, iMessage, Telegram, Discord, Slack, Signal, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID containing the message (the `chat_id` field from any Message object).' },
        message_id: { type: 'string', description: 'The message ID to react to (the `id` field from any Message object).' },
        emoji: { type: 'string', description: 'The unicode emoji to react with (e.g. "👍", "❤️", "✅").' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_unread',
    description: 'List chats that have one or more unread messages. Same Chat schema as list_inbox, filtered to only chats where unread_count > 0. Use this as the primary "what needs my attention right now?" tool — agents typically call this first to triage, then read_chat on each result to fetch the actual unread messages.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max chats to return (default 20)', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'poll_messages',
    description: 'Passive "what is new since I last looked?" feed — the watch primitive for a poll loop. Returns every message that arrived after an opaque cursor, across all recent chats (or one chat if chat_id is given), each as the normalized Message schema. It is READ-ONLY: it never marks anything read, never archives, never mutates — call it as often as you like with zero side effects. First call (omit cursor) SEEDS: it returns {cursor, messages: [], seeded: true} — an empty backlog and a starting cursor meaning "from now". Persist that cursor; pass it back next call to receive only messages newer than it, plus a fresh cursor. The cursor is restart-safe: save it to disk and resume across process/container restarts with no missed or duplicated messages. Includes the account\'s own messages (sender.is_self may be true) on purpose — the owner messaging themselves in Note to self is a real inbound signal. To avoid an agent answering its own sends, branch on the `source` field, NOT is_self: source is "api" for messages this beeperbox sent via send_message / note_to_self (skip these), "external" for everything else (the human owner\'s own messages included). If has_more is true, more messages are waiting beyond this page — poll again immediately with the returned cursor before sleeping.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Opaque cursor from a previous poll_messages response. Omit on the first call to seed from now. Pass back verbatim — never construct or parse it.' },
        chat_id: { type: 'string', description: 'Optional. Restrict the feed to one chat (the `id` from any Chat object). Omit to watch all recent chats.' },
        limit: { type: 'integer', description: 'Max messages to return this call (default 50). If more are pending, has_more is true and they come on the next poll.', default: 50, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'download_asset',
    description: 'Download the bytes of a message attachment (image, PDF, document, voice note, etc.) and return them base64-encoded. This is the MCP-only way to reach an attachment\'s actual content — use it after read_chat / poll_messages surfaces a message whose `attachments[]` carries a `src_url`. Reference the attachment EITHER by passing its `src_url` directly (the value from a normalized attachment — an mxc:// / localmxc:// URL, or a file:// URL inside Beeper\'s local media cache; arbitrary file:// paths and other schemes are refused), OR by `chat_id` + `message_id` (+ optional `index` to pick one of several attachments), in which case beeperbox resolves the src_url for you and also returns the attachment\'s file_name / mime_type / size. Returns { content_type, bytes, encoding: "base64", data_base64, ... }. Large files are capped (default 8 MiB) to keep the JSON-RPC result bounded — raise BEEPERBOX_MAX_ASSET_BYTES if you need bigger.',
    inputSchema: {
      type: 'object',
      properties: {
        src_url: { type: 'string', description: 'The attachment\'s `src_url` from a normalized Message attachment — an mxc:// / localmxc:// URL or a file:// URL inside Beeper\'s media cache. Arbitrary file:// paths and other schemes are refused. Provide this, OR chat_id + message_id.' },
        chat_id: { type: 'string', description: 'The chat containing the message. Required if src_url is omitted (used with message_id to resolve the attachment).' },
        message_id: { type: 'string', description: 'The message whose attachment to download. Required if src_url is omitted.' },
        index: { type: 'integer', description: 'Which attachment to download when resolving by message_id and the message has more than one (default 0).', default: 0, minimum: 0 },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'list_accounts': {
      const list = accountList(await beeperFetch('/v1/accounts'));
      // A live read, so a 0 here is the backend's current truth — but that is far
      // more often "Beeper still syncing after a restart/account-add" than a real
      // empty account set. Log it so the operator can tell the difference instead
      // of silently relaying an ambiguous empty list.
      if (list.length === 0) {
        process.stderr.write('[beeperbox-mcp] list_accounts: backend /v1/accounts returned 0 accounts — Beeper may still be syncing (retry shortly)\n');
      }
      return list.map(normalizeAccount);
    }

    case 'get_chat': {
      if (!args.chat_id) throw rpcError(-32602, 'get_chat requires chat_id');
      const [accounts, raw] = await Promise.all([
        getAccountMap(),
        beeperFetch(`/v1/chats/${encodeURIComponent(args.chat_id)}`),
      ]);
      return normalizeChat(raw, accounts);
    }

    case 'read_chat': {
      if (!args.chat_id) throw rpcError(-32602, 'read_chat requires chat_id');
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      // Same Beeper-side minimum-page-size workaround as list_inbox: the API
      // returns ~25 items regardless of ?limit=, so over-fetch then slice.
      const [accounts, chatRaw, msgRaw] = await Promise.all([
        getAccountMap(),
        beeperFetch(`/v1/chats/${encodeURIComponent(args.chat_id)}`),
        beeperFetch(`/v1/chats/${encodeURIComponent(args.chat_id)}/messages?limit=${Math.max(limit, 25)}`),
      ]);
      const chat = normalizeChat(chatRaw, accounts);
      const list = msgRaw.items || msgRaw.messages || (Array.isArray(msgRaw) ? msgRaw : []);
      // Beeper returns newest first; reverse so oldest comes first within the page
      // (more natural for an LLM building a conversation thread).
      const msgs = list.slice(0, limit).map((m) => normalizeMessage(m, chat)).reverse();
      return applyEchoTags(msgs, Date.now());
    }

    case 'archive_chat': {
      if (!args.chat_id) throw rpcError(-32602, 'archive_chat requires chat_id');
      const archived = args.archived !== false; // default true
      await beeperFetch(`/v1/chats/${encodeURIComponent(args.chat_id)}/archive`, {
        method: 'POST',
        body: { archived },
      });
      return { chat_id: args.chat_id, archived };
    }

    case 'list_inbox': {
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      // Beeper returns ~25 items minimum regardless of ?limit=, so we fetch
      // at least that many, then slice client-side after note-to-self filter.
      const [accounts, raw] = await Promise.all([
        getAccountMap(),
        beeperFetch(`/v1/chats?limit=${Math.max(limit, 25)}`),
      ]);
      const list = raw.items || raw.chats || (Array.isArray(raw) ? raw : []);
      return list
        .map((c) => normalizeChat(c, accounts))
        .filter((c) => !c.is_note_to_self)
        .slice(0, limit);
    }

    case 'search_messages': {
      if (!args.query) throw rpcError(-32602, 'search_messages requires query');
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      const [accounts, raw] = await Promise.all([
        getAccountMap(),
        beeperFetch(`/v1/messages/search?query=${encodeURIComponent(args.query)}&limit=${limit}`),
      ]);
      const items = raw?.items || [];
      const chatsMap = raw?.chats || {};
      // Pre-normalize the chat map so each hit can carry network info cheaply.
      const normalizedChats = {};
      for (const [id, c] of Object.entries(chatsMap)) {
        normalizedChats[id] = normalizeChat(c, accounts);
      }
      const msgs = items.slice(0, limit).map((m) => {
        const chat = normalizedChats[m.chatID] || { network: 'unknown', network_label: 'Unknown' };
        return normalizeMessage(m, chat);
      });
      return applyEchoTags(msgs, Date.now());
    }

    case 'note_to_self': {
      if (!args.text) throw rpcError(-32602, 'note_to_self requires text');
      const chatID = await getNoteToSelfChatID();
      const sent = await beeperFetch(
        `/v1/chats/${encodeURIComponent(chatID)}/messages`,
        { method: 'POST', body: { text: args.text } },
      );
      const pendingID = String(sent?.pendingMessageID || '');
      // Echo-guard: record so poll_messages / read_chat can tag this
      // self-note source:'api' and the agent won't re-process its own note.
      const entry = recordSent({ chat_id: chatID, sent_id: pendingID, text: args.text, client_tag: args.client_tag });
      // Resolve the pending id to the final bridge id so the guard matches the
      // read-back by exact id, not fragile text. Best-effort — null on timeout.
      const finalID = await resolveSentId(chatID, pendingID);
      if (finalID) addResolvedId(entry, finalID);
      return {
        chat_id: chatID,
        message_id: finalID || pendingID,
        pending_message_id: pendingID,
        resolved: !!finalID,
        client_tag: args.client_tag || null,
        status: 'sent',
      };
    }

    case 'send_message': {
      if (!args.chat_id) throw rpcError(-32602, 'send_message requires chat_id');
      if (!args.text) throw rpcError(-32602, 'send_message requires text');
      const body = { text: args.text };
      if (args.reply_to_message_id) body.replyToMessageID = args.reply_to_message_id;
      const sent = await beeperFetch(
        `/v1/chats/${encodeURIComponent(args.chat_id)}/messages`,
        { method: 'POST', body },
      );
      const chatID = sent?.chatID || args.chat_id;
      const pendingID = String(sent?.pendingMessageID || '');
      // Echo-guard: record so a poll_messages loop can skip the bot's own
      // reply (source:'api') instead of treating it as a new inbound message.
      const entry = recordSent({ chat_id: chatID, sent_id: pendingID, text: args.text, client_tag: args.client_tag });
      // Resolve the pending id to the final bridge id so the guard matches the
      // read-back by exact id, not fragile text. Best-effort — null on timeout.
      const finalID = await resolveSentId(chatID, pendingID);
      if (finalID) addResolvedId(entry, finalID);
      return {
        chat_id: chatID,
        message_id: finalID || pendingID,
        pending_message_id: pendingID,
        resolved: !!finalID,
        client_tag: args.client_tag || null,
        status: 'sent',
      };
    }

    case 'react_to_message': {
      if (!args.chat_id) throw rpcError(-32602, 'react_to_message requires chat_id');
      if (!args.message_id) throw rpcError(-32602, 'react_to_message requires message_id');
      if (!args.emoji) throw rpcError(-32602, 'react_to_message requires emoji');
      await beeperFetch(
        `/v1/chats/${encodeURIComponent(args.chat_id)}/messages/${encodeURIComponent(args.message_id)}/reactions`,
        { method: 'POST', body: { reactionKey: args.emoji } },
      );
      return { chat_id: args.chat_id, message_id: args.message_id, emoji: args.emoji, status: 'reacted' };
    }

    case 'list_unread': {
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      // Pull a wider page than the user's limit so the unread filter has
      // headroom — most chats will be already-read so we need to over-fetch.
      const [accounts, raw] = await Promise.all([
        getAccountMap(),
        beeperFetch(`/v1/chats?limit=100`),
      ]);
      const list = raw.items || raw.chats || (Array.isArray(raw) ? raw : []);
      return list
        .map((c) => normalizeChat(c, accounts))
        .filter((c) => !c.is_note_to_self && c.unread_count > 0)
        .slice(0, limit);
    }

    case 'poll_messages': {
      const cur = decodeCursor(args.cursor); // null ⇒ seed mode
      const page = Math.min(Math.max(args.limit || 50, 1), 100);
      const accounts = await getAccountMap();

      // Resolve which chats to scan: one if chat_id given, else the inbox.
      let chats;
      if (args.chat_id) {
        const raw = await beeperFetch(`/v1/chats/${encodeURIComponent(args.chat_id)}`);
        chats = [normalizeChat(raw, accounts)];
      } else {
        const raw = await beeperFetch('/v1/chats?limit=100');
        const list = raw.items || raw.chats || (Array.isArray(raw) ? raw : []);
        chats = list.map((c) => normalizeChat(c, accounts));
      }

      // Seed (no cursor): return the current high-water mark and NO backlog,
      // so the caller "starts watching from now". This is the half of the
      // bug-class that integrators get wrong — there's now one right answer.
      if (!cur) {
        let maxTs = '';
        for (const c of chats) {
          if (c.last_message_at && c.last_message_at > maxTs) maxTs = c.last_message_at;
        }
        return { cursor: encodeCursor({ ts: maxTs, ids: [] }), messages: [], has_more: false, seeded: true };
      }

      // Only chats whose last activity is at/after the cursor can hold new
      // messages — skip the rest so the per-chat fan-out stays bounded.
      const candidates = args.chat_id
        ? chats
        : chats.filter((c) => !c.last_message_at || c.last_message_at >= cur.ts);

      // Fetch the Beeper max (100) per chat, NOT `page`: the fetch window must
      // exceed the delivery page so that a chat with more than `page` new
      // messages is delivered across successive polls via the cursor, rather
      // than the cursor jumping to the newest and stranding the older ones.
      // (Residual: a single chat receiving >100 messages between two polls can
      // still lose the oldest of that burst — Beeper's messages endpoint only
      // returns the newest N with no backward paging. Documented in the GUIDE.)
      const fetchLimit = 100;
      const fresh = [];
      for (const c of candidates) {
        const msgRaw = await beeperFetch(`/v1/chats/${encodeURIComponent(c.id)}/messages?limit=${fetchLimit}`);
        const mlist = msgRaw.items || msgRaw.messages || (Array.isArray(msgRaw) ? msgRaw : []);
        for (const m of mlist.map((x) => normalizeMessage(x, c))) {
          if (isAfterCursor(m, cur)) fresh.push(m);
        }
      }

      const { delivered, next, hasMore } = selectDelivery(fresh, cur, page);
      const tagged = applyEchoTags(delivered, Date.now());
      return { cursor: encodeCursor(next), messages: tagged, has_more: hasMore };
    }

    case 'download_asset': {
      // Two ways to reference the attachment: a src_url directly (cheapest —
      // multis already has it from the normalized message), or chat_id +
      // message_id (+ index), where we fetch the message and read the src_url
      // off attachments[index] — which also lets us return its file metadata.
      let srcURL = args.src_url ? String(args.src_url) : '';
      let meta = {};
      if (!srcURL) {
        if (!args.chat_id || !args.message_id) {
          throw rpcError(-32602, 'download_asset requires src_url, or both chat_id and message_id');
        }
        const raw = await beeperFetch(
          `/v1/chats/${encodeURIComponent(args.chat_id)}/messages/${encodeURIComponent(args.message_id)}`,
        );
        const atts = normalizeAttachments(raw);
        const idx = Math.max(parseInt(args.index, 10) || 0, 0);
        const att = atts[idx];
        if (!att) throw rpcError(-32602, `message has no attachment at index ${idx} (found ${atts.length})`);
        if (!att.src_url) throw rpcError(-32004, `attachment ${idx} has no src_url to download`);
        srcURL = att.src_url;
        meta = { file_name: att.file_name, mime_type: att.mime_type, size: att.size };
      }
      // Confine the src_url to a real attachment (mxc/localmxc, or file:// inside
      // the media cache) BEFORE the fetch — defense-in-depth over Beeper serve's
      // own path guard, covering both ref paths. See assertServableSrcUrl.
      assertServableSrcUrl(srcURL);
      // /v1/assets/serve streams the bytes for an mxc:// / localmxc:// URL.
      // beeperFetch raw-mode returns the buffer + content-type, enforces the
      // byte cap (header pre-check + buffered post-check), and the timeout
      // bounds a hung/slow-drip source.
      const { bytes, content_type } = await beeperFetch(
        `/v1/assets/serve?url=${encodeURIComponent(srcURL)}`,
        { raw: true, maxBytes: MAX_ASSET_BYTES, timeoutMs: ASSET_TIMEOUT_MS },
      );
      return {
        src_url: srcURL,
        ...meta,
        content_type: content_type || meta.mime_type || null,
        bytes: bytes.length,
        encoding: 'base64',
        data_base64: bytes.toString('base64'),
      };
    }
    default:
      throw rpcError(-32601, `unknown tool: ${name}`);
  }
}

// ─── jsonrpc dispatch ─────────────────────────────────────────────

function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

async function handleRequest(req) {
  // Notifications carry no id; the spec says no response is sent.
  const isNotification = req.id === undefined;

  if (req.jsonrpc !== '2.0') {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32600, message: 'jsonrpc must be "2.0"' } };
  }

  try {
    let result;
    switch (req.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'beeperbox', version: VERSION },
          capabilities: { tools: {} },
        };
        break;

      case 'notifications/initialized':
        // Client tells us it finished initializing. No response.
        return null;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const params = req.params || {};
        const name = params.name;
        const args = params.arguments || {};
        if (!name) throw rpcError(-32602, 'tools/call requires params.name');
        const data = await callTool(name, args);
        // MCP wraps tool results in a content array of typed parts.
        result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        break;
      }

      default:
        throw rpcError(-32601, `unknown method: ${req.method}`);
    }

    if (isNotification) return null;
    return { jsonrpc: '2.0', id: req.id, result };
  } catch (err) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: { code: err.rpcCode || -32603, message: err.message },
    };
  }
}

// ─── startup preflight ────────────────────────────────────────────
// Fire-and-forget boot probe. Calls /v1/accounts once (token-gated, so it
// proves reachability AND that the token is accepted in a single hit) and logs
// one clear verdict. Best-effort and non-fatal: a down API or unset token must
// NOT stop the server from booting (the container's first run has no token /
// no login yet, by design). Always logs to stderr — never the protocol channel
// — so it's safe under both HTTP and stdio transports.
async function preflight() {
  if (process.env.BEEPERBOX_PREFLIGHT === '0') return;
  const say = (m) => process.stderr.write(`[beeperbox-mcp] ${m}\n`);
  if (!BEEPER_TOKEN) {
    say('preflight: BEEPER_TOKEN not set — skipping reachability check (tool calls will fail until it is set)');
    return;
  }
  try {
    const list = accountList(await beeperFetch('/v1/accounts', { timeoutMs: PREFLIGHT_TIMEOUT_MS }));
    say(`preflight OK: ${BEEPER_API} reachable, token accepted, ${list.length} account(s)`);
  } catch (e) {
    say(`preflight FAIL: ${BEEPER_API} unreachable or token rejected — ${e.message}`);
  }
}

// ─── http transport ───────────────────────────────────────────────

function startHttpTransport() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const denied = httpGuard(req);
    if (denied) {
      res.writeHead(denied.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: denied.message } }));
      return;
    }

    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      body += chunk;
      if (body.length > MCP_MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `request body exceeds ${MCP_MAX_BODY} bytes` } }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }

      const response = await handleRequest(parsed);
      if (response === null) {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    });
  });

  server.listen(PORT, BIND_ADDR, () => {
    console.log(`[beeperbox-mcp] listening on http://${BIND_ADDR}:${PORT}${BIND_ADDR === '0.0.0.0' ? ' (all interfaces — rely on a loopback publish or set MCP_AUTH_TOKEN)' : ' (loopback only)'}`);
    console.log(`[beeperbox-mcp] beeper api: ${BEEPER_API}`);
    console.log(`[beeperbox-mcp] beeper token: ${BEEPER_TOKEN ? 'set' : 'NOT SET (set BEEPER_TOKEN env var)'}`);
    console.log(`[beeperbox-mcp] http auth: ${MCP_AUTH_TOKEN ? 'required (MCP_AUTH_TOKEN set)' : 'OPEN — set MCP_AUTH_TOKEN to require a bearer token'}`);
    console.log(`[beeperbox-mcp] allowed hosts: ${[...MCP_ALLOWED_HOSTS].join(', ')}`);
    preflight();
  });
}

// ─── stdio transport ──────────────────────────────────────────────
// Newline-delimited JSON-RPC over stdin/stdout. Used when the MCP
// client (Claude Code, Cursor, Cline, bareagent) spawns the server
// as a subprocess — typically via `docker exec -i beeperbox node
// /opt/mcp/server.js --stdio`. Stdout is reserved for the protocol;
// all logging goes to stderr.

function startStdioTransport() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      const response = await handleRequest(req);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    }
  });
  // Do NOT process.exit() on stdin end — Node's event loop will exit
  // naturally once all pending async handlers settle. Exiting eagerly
  // drops in-flight tool responses (async fetch() to the Beeper API).
  // Stderr — stdout is the protocol channel and must not carry chatter.
  process.stderr.write('[beeperbox-mcp] stdio transport ready\n');
  process.stderr.write(`[beeperbox-mcp] beeper api: ${BEEPER_API}\n`);
  process.stderr.write(`[beeperbox-mcp] beeper token: ${BEEPER_TOKEN ? 'set' : 'NOT SET'}\n`);
  preflight();
}

// ─── pick transport ───────────────────────────────────────────────

// Only boot a transport when run as the entrypoint (`node server.js` /
// `--stdio`). When require()'d — by the unit tests — skip the listeners and
// just expose the pure helpers below.
if (require.main === module) {
  if (process.argv.includes('--stdio')) {
    startStdioTransport();
  } else {
    startHttpTransport();
  }
}

// Test surface — only the pure logic the unit suite exercises (the
// seed/poll/dedup bug-class core + the echo-guard matcher). The HTTP/stdio
// handlers and normalizers are covered black-box by the guard/smoke scripts.
module.exports = {
  // Parity surface — lite mode and the container run THIS file, so asserting the
  // version + tool names here is what guarantees the two builds can't drift.
  VERSION,
  TOOL_NAMES: TOOLS.map((t) => t.name),
  BIND_ADDR,
  ledgerPath,
  encodeCursor,
  decodeCursor,
  isAfterCursor,
  advanceCursor,
  selectDelivery,
  textHash,
  normalizeAttachments,
  normalizeAccount,
  assertServableSrcUrl,
  matchSentMessage,
  recordSent,
  addResolvedId,
  loadLedger,
  // test hook: drop the in-memory ledger so a test can re-load from a fresh path
  _resetLedger: () => { ledger = null; ledgerPersistWarned = false; },
  // account-map cache surface (resilience): the map + its TTL/empty-cache rules.
  getAccountMap,
  _resetAccountCache: () => { accountCache = null; },
  _setNow: (fn) => { nowFn = fn || (() => Date.now()); },
};

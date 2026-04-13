#!/usr/bin/env node
// beeperbox MCP server — POC phase 1
// Single-file, vanilla Node, zero deps. Requires Node 18+ for global fetch.
//
// Speaks Model Context Protocol over HTTP transport (POST JSON-RPC 2.0).
// Stdio transport will be added once HTTP is solid.

const http = require('http');

const PORT = parseInt(process.env.MCP_PORT || '23375', 10);
const BEEPER_API = process.env.BEEPER_API || 'http://[::1]:23373';
const BEEPER_TOKEN = process.env.BEEPER_TOKEN || '';

// ─── beeper api helper ────────────────────────────────────────────

async function beeperFetch(path) {
  if (!BEEPER_TOKEN) throw rpcError(-32000, 'BEEPER_TOKEN env var not set — create a token in Beeper Settings > Developers and pass it to the container');
  const r = await fetch(`${BEEPER_API}${path}`, {
    headers: { Authorization: `Bearer ${BEEPER_TOKEN}` },
  });
  if (!r.ok) throw rpcError(-32001, `beeper api ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
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

async function getAccountMap() {
  if (accountCache) return accountCache;
  const accounts = await beeperFetch('/v1/accounts');
  accountCache = {};
  for (const a of (Array.isArray(accounts) ? accounts : (accounts.items || []))) {
    accountCache[a.accountID] = {
      network: networkSlug(a.network),
      network_label: a.network,
    };
  }
  return accountCache;
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

// ─── tool registry ────────────────────────────────────────────────
// Phase 1b: one real tool. The other 9 land in phase 2, one at a time,
// each with its own commit so we can roll back any single regression.

const TOOLS = [
  {
    name: 'list_accounts',
    description: 'List all messaging accounts (networks) connected to this Beeper account. Each account corresponds to one platform — WhatsApp, Telegram, Discord, etc. Use this to see which platforms are reachable before calling other tools, or to discover what kinds of chats exist. Returns network slug (machine-readable, e.g. "whatsapp"), network label (human, e.g. "WhatsApp"), the underlying account ID, and the user\'s display name on that platform.',
    inputSchema: {
      type: 'object',
      properties: {},
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
];

async function callTool(name, args) {
  switch (name) {
    case 'list_accounts': {
      const accounts = await beeperFetch('/v1/accounts');
      const list = Array.isArray(accounts) ? accounts : (accounts.items || []);
      return list.map((a) => ({
        account_id: a.accountID,
        network: networkSlug(a.network),
        network_label: a.network,
        user: {
          id: a.user?.id || null,
          display_name: a.user?.fullName || a.user?.displayText || a.user?.username || null,
        },
      }));
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
  if (req.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32600, message: 'jsonrpc must be "2.0"' } };
  }

  // Notifications carry no id; the spec says no response is sent.
  const isNotification = req.id === undefined;

  try {
    let result;
    switch (req.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'beeperbox', version: '0.2.0-poc' },
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

// ─── http transport ───────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[beeperbox-mcp] listening on http://0.0.0.0:${PORT}`);
  console.log(`[beeperbox-mcp] beeper api: ${BEEPER_API}`);
  console.log(`[beeperbox-mcp] beeper token: ${BEEPER_TOKEN ? 'set' : 'NOT SET (set BEEPER_TOKEN env var)'}`);
});

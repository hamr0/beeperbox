// Unit tests for the pure cursor / dedup / echo-guard logic in server.js.
// Run: node --test mcp/server.test.js
//
// These cover exactly the seed/poll/dedup bug-class poll_messages exists to
// retire, plus the source:'api'-vs-'external' echo-guard matcher. They need
// NO live Beeper account — the I/O wiring around these helpers is exercised
// end-to-end by the guard/smoke scripts against the real image instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// beeperFetch refuses to run without a token (read at module load), and the
// account-map tests below drive it through a stubbed global.fetch.
process.env.BEEPER_TOKEN = process.env.BEEPER_TOKEN || 'test-token';

const S = require('./server.js');

// ── cursor encode/decode ──────────────────────────────────────────
test('encode/decode is a round-trip', () => {
  const state = { ts: '2026-06-15T10:00:00.000Z', ids: ['a', 'b'] };
  assert.deepEqual(S.decodeCursor(S.encodeCursor(state)), state);
});

test('absent cursor decodes to null (seed mode)', () => {
  assert.equal(S.decodeCursor(undefined), null);
  assert.equal(S.decodeCursor(''), null);
});

test('malformed cursor is rejected with -32602, not silently treated as seed', () => {
  // A silent fall-through to seed would re-deliver nothing and lose the
  // caller's place — worse than a loud error. Garbage base64 (bad JSON):
  assert.throws(() => S.decodeCursor('not-valid-base64-json!!!'), /malformed cursor/);
  // Valid base64 but wrong shape (missing ids):
  const badShape = Buffer.from(JSON.stringify({ ts: 'x' }), 'utf8').toString('base64');
  assert.throws(() => S.decodeCursor(badShape), /malformed cursor/);
});

test('decodeCursor rejects an oversized ids array (crafted cursor, CPU-amplification guard)', () => {
  // A real cursor only holds the ids sharing one high-water millisecond (a
  // handful); anything large is crafted/corrupt and must not be paid for.
  const big = S.encodeCursor({ ts: '2026-06-15T10:00:00.000Z', ids: Array.from({ length: 5000 }, (_, i) => 'i' + i) });
  assert.throws(() => S.decodeCursor(big), /cursor too large/);
});

test('decodeCursor still accepts a normal-sized ids array', () => {
  const ok = S.encodeCursor({ ts: '2026-06-15T10:00:00.000Z', ids: ['a', 'b', 'c'] });
  assert.equal(S.decodeCursor(ok).ids.length, 3);
});

// ── isAfterCursor ─────────────────────────────────────────────────
test('isAfterCursor: strictly-newer ts is after', () => {
  const cur = { ts: '2026-06-15T10:00:00.000Z', ids: [] };
  assert.equal(S.isAfterCursor({ id: '1', timestamp: '2026-06-15T10:00:01.000Z' }, cur), true);
  assert.equal(S.isAfterCursor({ id: '1', timestamp: '2026-06-15T09:59:59.000Z' }, cur), false);
});

test('isAfterCursor: same ts dedups on id — seen id is NOT after, unseen id IS', () => {
  const cur = { ts: '2026-06-15T10:00:00.000Z', ids: ['seen'] };
  assert.equal(S.isAfterCursor({ id: 'seen', timestamp: '2026-06-15T10:00:00.000Z' }, cur), false);
  assert.equal(S.isAfterCursor({ id: 'fresh', timestamp: '2026-06-15T10:00:00.000Z' }, cur), true);
});

test('isAfterCursor: null timestamp never enters the feed (cannot be cursor-ordered)', () => {
  const cur = { ts: '2026-06-15T10:00:00.000Z', ids: [] };
  assert.equal(S.isAfterCursor({ id: '1', timestamp: null }, cur), false);
});

// ── advanceCursor ─────────────────────────────────────────────────
test('advanceCursor: a newer ts resets the id set to that ts', () => {
  const prev = { ts: '2026-06-15T10:00:00.000Z', ids: ['old'] };
  const next = S.advanceCursor(prev, [{ id: 'new', timestamp: '2026-06-15T10:05:00.000Z' }]);
  assert.deepEqual(next, { ts: '2026-06-15T10:05:00.000Z', ids: ['new'] });
});

test('advanceCursor: messages at the high-water ts accumulate (and dedup) into ids', () => {
  const prev = { ts: '2026-06-15T10:00:00.000Z', ids: ['a'] };
  const next = S.advanceCursor(prev, [
    { id: 'b', timestamp: '2026-06-15T10:00:00.000Z' },
    { id: 'b', timestamp: '2026-06-15T10:00:00.000Z' }, // duplicate
  ]);
  assert.equal(next.ts, '2026-06-15T10:00:00.000Z');
  assert.deepEqual([...next.ids].sort(), ['a', 'b']);
});

// ── end-to-end cursor walk: seed → poll → dedup → restart-resume ───
test('a full poll walk delivers each message exactly once, even across a "restart"', () => {
  // Simulate a chat's newest-first message history growing between polls.
  const round1 = [
    { id: 'm2', timestamp: '2026-06-15T10:00:02.000Z' },
    { id: 'm1', timestamp: '2026-06-15T10:00:01.000Z' },
  ];
  // Seed from "now" = newest existing message.
  let cur = S.decodeCursor(S.encodeCursor({ ts: '2026-06-15T10:00:02.000Z', ids: [] }));
  // Seed boundary: the message exactly at the seed ts surfaces once; older does not.
  let fresh = round1.filter((m) => S.isAfterCursor(m, cur));
  assert.deepEqual(fresh.map((m) => m.id), ['m2']);
  cur = S.advanceCursor(cur, fresh);

  // New messages arrive, including two sharing a millisecond.
  const round2 = [
    { id: 'm4', timestamp: '2026-06-15T10:00:05.000Z' },
    { id: 'm3b', timestamp: '2026-06-15T10:00:03.000Z' },
    { id: 'm3a', timestamp: '2026-06-15T10:00:03.000Z' },
    { id: 'm2', timestamp: '2026-06-15T10:00:02.000Z' }, // already delivered
  ];
  fresh = round2.filter((m) => S.isAfterCursor(m, cur));
  assert.deepEqual(fresh.map((m) => m.id).sort(), ['m3a', 'm3b', 'm4']);

  // Persist the cursor as a string, drop everything (process restart), reload.
  const persisted = S.encodeCursor(S.advanceCursor(cur, fresh));
  const resumed = S.decodeCursor(persisted);

  // Re-poll the same history after restart: nothing is re-delivered.
  const again = round2.filter((m) => S.isAfterCursor(m, resumed));
  assert.deepEqual(again, []);
});

// ── selectDelivery: over-page bursts must not lose or duplicate ───
test('selectDelivery: a burst larger than the page is delivered fully across polls, no loss/no dupes', () => {
  // 120 fresh messages, strictly increasing timestamps; page = 50.
  const base = Date.parse('2026-06-15T10:00:00.000Z');
  const all = Array.from({ length: 120 }, (_, i) => ({
    id: 'm' + String(i).padStart(3, '0'),
    timestamp: new Date(base + i * 1000).toISOString(),
  }));

  let cur = { ts: '', ids: [] };  // everything is "after" an empty cursor
  const seen = new Set();
  let polls = 0;
  let hasMore = true;
  while (hasMore && polls < 10) {
    // Re-derive fresh from the full set each poll (what the handler does after
    // re-fetching) — the cursor, not a server-side queue, is the only state.
    const fresh = all.filter((m) => S.isAfterCursor(m, cur));
    const r = S.selectDelivery(fresh, cur, 50);
    for (const m of r.delivered) {
      assert.ok(!seen.has(m.id), `duplicate delivery of ${m.id}`);
      seen.add(m.id);
    }
    cur = r.next;
    hasMore = r.hasMore;
    polls++;
  }
  assert.equal(seen.size, 120, 'every message delivered exactly once');
  assert.equal(polls, 3, '120 / page 50 = 3 polls');  // catches a cursor that jumps past undelivered msgs
});

test('selectDelivery: a single under-page batch delivers all at once with hasMore=false', () => {
  const base = Date.parse('2026-06-15T10:00:00.000Z');
  const fresh = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, timestamp: new Date(base + i * 1000).toISOString() }));
  const r = S.selectDelivery(fresh, { ts: '', ids: [] }, 50);
  assert.equal(r.delivered.length, 10);
  assert.equal(r.hasMore, false);
});

// ── normalizeAttachments (pure passthrough of raw attachments[]) ──
test('normalizeAttachments: maps a raw attachment to the normalized shape', () => {
  const raw = {
    attachments: [{
      type: 'file',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      srcURL: 'mxc://beeper.com/abc123',
      fileSize: 20480,
      isVoiceNote: false,
    }],
  };
  assert.deepEqual(S.normalizeAttachments(raw), [{
    type: 'file',
    file_name: 'invoice.pdf',
    mime_type: 'application/pdf',
    src_url: 'mxc://beeper.com/abc123',
    size: 20480,
    is_voice_note: false,
  }]);
});

test('normalizeAttachments: a message with no attachments yields [] (always an array)', () => {
  assert.deepEqual(S.normalizeAttachments({ text: 'hi', type: 'TEXT' }), []);
  assert.deepEqual(S.normalizeAttachments({}), []);
  assert.deepEqual(S.normalizeAttachments(null), []);
  // Defensive: a non-array attachments field must not throw or pass through.
  assert.deepEqual(S.normalizeAttachments({ attachments: 'oops' }), []);
});

test('normalizeAttachments: missing optional fields become null / false, not undefined', () => {
  // A media attachment that only carries a src_url — file_name/mime_type/size
  // absent. They must normalize to null (not undefined) so the JSON shape is
  // stable, and is_voice_note to a real boolean.
  const [att] = S.normalizeAttachments({ attachments: [{ srcURL: 'mxc://h/x' }] });
  assert.deepEqual(att, {
    type: null, file_name: null, mime_type: null,
    src_url: 'mxc://h/x', size: null, is_voice_note: false,
  });
});

test('normalizeAttachments: a non-numeric fileSize does not leak through as size', () => {
  // Guards the byte cap / consumers from a stray string sneaking into `size`.
  const [att] = S.normalizeAttachments({ attachments: [{ srcURL: 'mxc://h/x', fileSize: '20480' }] });
  assert.equal(att.size, null);
});

test('normalizeAttachments: preserves order and maps every entry of a multi-attachment message', () => {
  const out = S.normalizeAttachments({ attachments: [
    { srcURL: 'mxc://h/1', fileName: 'a.png', type: 'image' },
    { srcURL: 'mxc://h/2', fileName: 'b.pdf', type: 'file' },
  ] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((a) => a.file_name), ['a.png', 'b.pdf']);
  assert.deepEqual(out.map((a) => a.src_url), ['mxc://h/1', 'mxc://h/2']);
});

// ── assertServableSrcUrl (download_asset local-file-read guard) ───
// Real attachment src_urls (verified live) are mxc:// / localmxc:// for remote
// media, and file:///root/.config/BeeperTexts/media/... once Beeper caches the
// file locally. The guard must serve all three yet refuse file:// outside that
// cache (and other schemes) — else an MCP caller reads arbitrary local files.
const MEDIA = 'file:///root/.config/BeeperTexts/media/';

test('assertServableSrcUrl: allows mxc:// and localmxc:// (remote attachment schemes)', () => {
  assert.doesNotThrow(() => S.assertServableSrcUrl('mxc://beeper.com/abc'));
  assert.doesNotThrow(() => S.assertServableSrcUrl('localmxc://beeper.com/cached'));
  assert.doesNotThrow(() => S.assertServableSrcUrl('MXC://BEEPER.COM/ABC')); // scheme is case-insensitive
});

test('assertServableSrcUrl: allows file:// INSIDE the Beeper media cache (the cached-attachment case)', () => {
  assert.doesNotThrow(() => S.assertServableSrcUrl(MEDIA + 'local.beeper.com/x.pdf'));
  assert.doesNotThrow(() => S.assertServableSrcUrl(MEDIA + 'a/b/c/deep.bin'));
});

test('assertServableSrcUrl: refuses file:// OUTSIDE the cache — the arbitrary-local-file-read vector', () => {
  // The load-bearing security assertion: these would read secrets via serve.
  assert.throws(() => S.assertServableSrcUrl('file:///etc/passwd'), /refused/);
  assert.throws(() => S.assertServableSrcUrl('file:///root/.config/beeperbox-sent-ledger.json'), /refused/);
  // A sibling dir that shares the prefix but isn't the cache (trailing-slash guard).
  assert.throws(() => S.assertServableSrcUrl('file:///root/.config/BeeperTexts/mediahack/x'), /refused/);
});

test('assertServableSrcUrl: refuses ../ and percent-encoded traversal out of the cache', () => {
  // new URL() does NOT collapse ../, so the guard decodes + path.normalize()s
  // before the prefix check. These must NOT escape to /etc or the config dir.
  assert.throws(() => S.assertServableSrcUrl(MEDIA + '../../../etc/passwd'), /refused/);
  assert.throws(() => S.assertServableSrcUrl(MEDIA + '..%2f..%2f..%2fetc/passwd'), /refused/);
  assert.throws(() => S.assertServableSrcUrl(MEDIA + '%2e%2e/%2e%2e/beeperbox-sent-ledger.json'), /refused/);
});

test('assertServableSrcUrl: refuses DOUBLE-encoded traversal (%252e) without re-decoding it open', () => {
  // %252e -> one decode -> %2e (a literal dot-encoding). The guard refuses any
  // residual %2e/%2f after a single decode rather than forwarding it — serve
  // single-decodes too, so this never reaches the filesystem either way.
  assert.throws(() => S.assertServableSrcUrl(MEDIA + '%252e%252e/%252e%252e/etc/passwd'), /refused/);
  assert.throws(() => S.assertServableSrcUrl(MEDIA + 'a%252fb'), /refused/);
});

test('assertServableSrcUrl: refuses a file:// URL with a non-empty host (authority is forwarded, not path-checked)', () => {
  // file://attacker/<media-path> has a valid-looking pathname but a host the
  // pathname check would miss; the original url (host and all) is what we
  // forward, so reject any authority. file://localhost/… is fine (host empties).
  assert.throws(() => S.assertServableSrcUrl('file://attacker/root/.config/BeeperTexts/media/x'), /refused/);
  assert.doesNotThrow(() => S.assertServableSrcUrl('file://localhost/root/.config/BeeperTexts/media/x'));
});

test('assertServableSrcUrl: refuses http(s):// (SSRF) and other non-Matrix schemes', () => {
  assert.throws(() => S.assertServableSrcUrl('http://169.254.169.254/latest/meta-data/'), /refused/);
  assert.throws(() => S.assertServableSrcUrl('https://evil.example/x'), /refused/);
  assert.throws(() => S.assertServableSrcUrl('ftp://h/x'), /refused/);
  assert.throws(() => S.assertServableSrcUrl(''), /refused/);
});

// ── echo-guard matcher (pure) ─────────────────────────────────────
const NOW = 1_750_000_000_000;
test('matchSentMessage: exact id match is source:api and echoes client_tag', () => {
  const entries = [{ chat_id: 'c1', sent_id: 'p99', text_hash: S.textHash('hi'), client_tag: 'job-7', ts: NOW }];
  const got = S.matchSentMessage({ id: 'p99', chat_id: 'c1', text: 'anything', is_self: true }, entries, NOW);
  assert.deepEqual(got, { source: 'api', client_tag: 'job-7' });
});

test('matchSentMessage: content fallback tags our own recent same-chat send', () => {
  // id was swapped on bridge-ack, so id no longer matches — content does.
  const entries = [{ chat_id: 'c1', sent_id: 'pendingX', text_hash: S.textHash('on my way'), client_tag: null, ts: NOW }];
  const got = S.matchSentMessage({ id: 'realY', chat_id: 'c1', text: 'on my way', is_self: true }, entries, NOW);
  assert.equal(got.source, 'api');
});

test('matchSentMessage: identical text from someone else (not is_self) stays external', () => {
  // Asymmetric-risk guard: never drop a human message just because its text
  // collides with something we sent.
  const entries = [{ chat_id: 'c1', sent_id: 'p1', text_hash: S.textHash('ok'), client_tag: null, ts: NOW }];
  const got = S.matchSentMessage({ id: 'other', chat_id: 'c1', text: 'ok', is_self: false }, entries, NOW);
  assert.equal(got.source, 'external');
});

test('matchSentMessage: content match outside the time window stays external', () => {
  const stale = NOW - (16 * 60 * 1000); // 16 min ago > 15 min window
  const entries = [{ chat_id: 'c1', sent_id: 'p1', text_hash: S.textHash('ping'), client_tag: null, ts: stale }];
  const got = S.matchSentMessage({ id: 'other', chat_id: 'c1', text: 'ping', is_self: true }, entries, NOW);
  assert.equal(got.source, 'external');
});

test('matchSentMessage: same text but different chat stays external', () => {
  const entries = [{ chat_id: 'c1', sent_id: 'p1', text_hash: S.textHash('hello'), client_tag: null, ts: NOW }];
  const got = S.matchSentMessage({ id: 'x', chat_id: 'c2', text: 'hello', is_self: true }, entries, NOW);
  assert.equal(got.source, 'external');
});

test('matchSentMessage: no match is external with no tag', () => {
  const got = S.matchSentMessage({ id: 'z', chat_id: 'c1', text: 'novel', is_self: false }, [], NOW);
  assert.deepEqual(got, { source: 'external', client_tag: null });
});

// ── Ask A: reliable echo via resolved bridge id ───────────────────
test('matchSentMessage: a read-back is tagged by its RESOLVED final bridge id', () => {
  // After send, pendingMessageID 'p1' was resolved to final id 'b908'; the
  // ledger holds both. The message reappears under the final id → exact match.
  const entries = [{ chat_id: 'c1', sent_ids: ['p1', 'b908'], resolved: true, text_hash: S.textHash('hey'), client_tag: 'job-9', ts: NOW }];
  const got = S.matchSentMessage({ id: 'b908', chat_id: 'c1', text: 'hey', is_self: true }, entries, NOW);
  assert.deepEqual(got, { source: 'api', client_tag: 'job-9' });
});

test('matchSentMessage: once resolved, a human re-typing identical text is NOT mis-tagged (Ask A acceptance)', () => {
  // The load-bearing acceptance criterion. The bot sent "on my way" (resolved
  // to final id b908). The human owner later types the exact same words. Exact
  // id is authoritative for the resolved entry, so its text fallback is OFF —
  // the human message stays external instead of being swallowed as our echo.
  const entries = [{ chat_id: 'c1', sent_ids: ['p1', 'b908'], resolved: true, text_hash: S.textHash('on my way'), client_tag: null, ts: NOW }];
  assert.equal(S.matchSentMessage({ id: 'b908', chat_id: 'c1', text: 'on my way', is_self: true }, entries, NOW).source, 'api');
  assert.equal(S.matchSentMessage({ id: 'human1', chat_id: 'c1', text: 'on my way', is_self: true }, entries, NOW).source, 'external');
});

test('matchSentMessage: two identical-text sends are each matched by their OWN resolved id', () => {
  // Identical text, two separate sends — exact-id keeps them distinct so each
  // read-back echoes its own client_tag (text matching alone could not).
  const entries = [
    { chat_id: 'c1', sent_ids: ['pA', 'bA'], resolved: true, text_hash: S.textHash('ok'), client_tag: 'a', ts: NOW },
    { chat_id: 'c1', sent_ids: ['pB', 'bB'], resolved: true, text_hash: S.textHash('ok'), client_tag: 'b', ts: NOW },
  ];
  assert.deepEqual(S.matchSentMessage({ id: 'bA', chat_id: 'c1', text: 'ok', is_self: true }, entries, NOW), { source: 'api', client_tag: 'a' });
  assert.deepEqual(S.matchSentMessage({ id: 'bB', chat_id: 'c1', text: 'ok', is_self: true }, entries, NOW), { source: 'api', client_tag: 'b' });
});

test('matchSentMessage: a legacy {sent_id} entry (pre-upgrade ledger) still id-matches AND text-falls-back', () => {
  // Back-compat: ledgers written before this change have `sent_id` (no
  // `sent_ids[]`, no `resolved`). Both echo paths must still work for them.
  const entries = [{ chat_id: 'c1', sent_id: 'legacyP', text_hash: S.textHash('hi there'), client_tag: 'old', ts: NOW }];
  // exact id via the legacy single field
  assert.deepEqual(S.matchSentMessage({ id: 'legacyP', chat_id: 'c1', text: 'hi there', is_self: true }, entries, NOW), { source: 'api', client_tag: 'old' });
  // id swapped & never resolved (resolved is undefined → not true) → text fallback still fires
  assert.equal(S.matchSentMessage({ id: 'swapped', chat_id: 'c1', text: 'hi there', is_self: true }, entries, NOW).source, 'api');
});

test('matchSentMessage: an UNRESOLVED entry keeps the text fallback as a safety net', () => {
  // Resolution failed (slow ack) so we only have the pending id and the read-
  // back uses a swapped id we never learned. The text fallback (resolved:false)
  // still catches our own send — preserving today's behavior when resolution
  // is unavailable, which is exactly when the net is needed.
  const entries = [{ chat_id: 'c1', sent_ids: ['pending-only'], resolved: false, text_hash: S.textHash('ping'), client_tag: 'j1', ts: NOW }];
  const got = S.matchSentMessage({ id: 'swapped-unknown', chat_id: 'c1', text: 'ping', is_self: true }, entries, NOW);
  assert.deepEqual(got, { source: 'api', client_tag: 'j1' });
});

test('addResolvedId attaches the final id, retires the text fallback, and persists', () => {
  const file = path.join(os.tmpdir(), `bb-resolve-test-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* not there */ }
  process.env.BEEPERBOX_SENT_LEDGER = file;
  try {
    S._resetLedger();
    const entry = S.recordSent({ chat_id: 'c1', sent_id: 'pending1', text: 'hi', client_tag: 't' });
    assert.equal(entry.resolved, false);
    S.addResolvedId(entry, 'final1');

    // Matches by the resolved id AND still by the original pending id (covers a
    // platform/read path that never swapped).
    assert.equal(S.matchSentMessage({ id: 'final1', chat_id: 'c1', text: 'hi', is_self: true }, S.loadLedger(), Date.now()).source, 'api');
    assert.equal(S.matchSentMessage({ id: 'pending1', chat_id: 'c1', text: 'hi', is_self: true }, S.loadLedger(), Date.now()).source, 'api');

    // Reload from disk → the resolution survived a "restart".
    S._resetLedger();
    const reloaded = S.loadLedger();
    assert.equal(reloaded[0].resolved, true);
    assert.deepEqual([...reloaded[0].sent_ids].sort(), ['final1', 'pending1']);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    delete process.env.BEEPERBOX_SENT_LEDGER;
    S._resetLedger();
  }
});

test('recordSent caps an oversized client_tag (ledger-bloat guard)', () => {
  const file = path.join(os.tmpdir(), `bb-cap-test-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* not there */ }
  process.env.BEEPERBOX_SENT_LEDGER = file;
  try {
    S._resetLedger();
    S.recordSent({ chat_id: 'c1', sent_id: 'p1', text: 'hi', client_tag: 'y'.repeat(5000) });
    const led = S.loadLedger();
    assert.equal(led[0].client_tag.length, 256);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    delete process.env.BEEPERBOX_SENT_LEDGER;
    S._resetLedger();
  }
});

// ── lite/container parity (gap 6) ─────────────────────────────────
// Lite mode and the Docker build run THIS same file, so the only way they can
// diverge is the version string or the tool set. Pin both to a single source.
test('serverInfo version is single-sourced from package.json (no drift)', () => {
  const pkg = require('./package.json');
  assert.equal(S.VERSION, pkg.version);
});

test('the tool registry is exactly the 12 documented verbs', () => {
  const expected = [
    'list_accounts', 'list_inbox', 'list_unread', 'get_chat', 'read_chat',
    'search_messages', 'send_message', 'note_to_self', 'react_to_message',
    'archive_chat', 'poll_messages', 'download_asset',
  ].sort();
  assert.deepEqual([...S.TOOL_NAMES].sort(), expected);
});

// ── lite-mode bind is loopback by default (security) ──────────────
// The MCP server used to bind 0.0.0.0 unconditionally; in lite mode (no Docker
// loopback publish in front) that put the full tool surface on the LAN. The
// default must be loopback so `npx beeperbox` is safe out of the box; the
// container opts back into 0.0.0.0 via MCP_BIND_ADDR in the image ENV.
test('BIND_ADDR defaults to loopback (127.0.0.1), not 0.0.0.0', () => {
  // No MCP_BIND_ADDR is set in the test env, so this asserts the safe default.
  assert.equal(process.env.MCP_BIND_ADDR, undefined);
  assert.equal(S.BIND_ADDR, '127.0.0.1');
});

// ── ledgerPath: per-user default, not /root (gap 2) ───────────────
// The container-only /root default silently failed to persist on any normal
// host. The default must now be a writable per-user XDG path, with the env
// override still winning.
test('ledgerPath: XDG default, homedir fallback, and explicit override', () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origLedger = process.env.BEEPERBOX_SENT_LEDGER;
  try {
    delete process.env.BEEPERBOX_SENT_LEDGER;

    // XDG_CONFIG_HOME honored when set.
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-test';
    assert.equal(S.ledgerPath(), path.join('/tmp/xdg-test', 'beeperbox', 'sent-ledger.json'));

    // Without XDG → ~/.config/beeperbox/sent-ledger.json (per-user, never a bare
    // hardcoded /root on a non-root host).
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(S.ledgerPath(), path.join(os.homedir(), '.config', 'beeperbox', 'sent-ledger.json'));

    // Explicit override always wins.
    process.env.BEEPERBOX_SENT_LEDGER = '/tmp/custom-ledger.json';
    assert.equal(S.ledgerPath(), '/tmp/custom-ledger.json');
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
    if (origLedger === undefined) delete process.env.BEEPERBOX_SENT_LEDGER; else process.env.BEEPERBOX_SENT_LEDGER = origLedger;
  }
});

test('persistLedger creates the parent dir on a fresh host (no pre-existing config dir)', () => {
  const dir = path.join(os.tmpdir(), `bb-mkdir-test-${process.pid}`, 'nested', 'beeperbox');
  const file = path.join(dir, 'sent-ledger.json');
  try { fs.rmSync(path.join(os.tmpdir(), `bb-mkdir-test-${process.pid}`), { recursive: true, force: true }); } catch { /* not there */ }
  process.env.BEEPERBOX_SENT_LEDGER = file;
  try {
    S._resetLedger();
    assert.ok(!fs.existsSync(dir), 'precondition: dir does not exist yet');
    S.recordSent({ chat_id: 'c1', sent_id: 'p1', text: 'hi', client_tag: null });
    assert.ok(fs.existsSync(file), 'ledger persisted into a freshly-created dir');
  } finally {
    try { fs.rmSync(path.join(os.tmpdir(), `bb-mkdir-test-${process.pid}`), { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.BEEPERBOX_SENT_LEDGER;
    S._resetLedger();
  }
});

// ── ledger persistence round-trip (real temp file) ────────────────
test('recordSent persists and loadLedger restores across a "restart"', () => {
  const file = path.join(os.tmpdir(), `bb-ledger-test-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* not there yet */ }
  process.env.BEEPERBOX_SENT_LEDGER = file;
  try {
    S._resetLedger();
    S.recordSent({ chat_id: 'c1', sent_id: 'p1', text: 'persist me', client_tag: 'tag-1' });
    assert.ok(fs.existsSync(file), 'ledger file should be written');

    // Simulate a fresh process: forget the in-memory ledger, reload from disk.
    S._resetLedger();
    const reloaded = S.loadLedger();
    assert.equal(reloaded.length, 1);
    const got = S.matchSentMessage({ id: 'p1', chat_id: 'c1', text: 'persist me', is_self: true }, reloaded, Date.now());
    assert.deepEqual(got, { source: 'api', client_tag: 'tag-1' });
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    delete process.env.BEEPERBOX_SENT_LEDGER;
    S._resetLedger();
  }
});

// ── account-map cache resilience ──────────────────────────────────
// The multis "added WhatsApp via noVNC → it didn't show, and a plain docker
// restart didn't fix it, it recovered later" wedge. Root cause: getAccountMap
// cached the accountID->network map for the whole process life with no TTL and
// happily froze an EMPTY map captured during the backend's post-restart sync
// window. These prove the bound + never-cache-empty behavior; each is written
// to FAIL against the old unbounded cache.
const REAL_FETCH = global.fetch;

function stubAccounts(seq) {
  let i = 0, calls = 0;
  global.fetch = async () => {
    calls++;
    const body = seq[Math.min(i++, seq.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return () => calls;
}
function acct(id, network, status = 'connected') {
  return { accountID: id, network, status, user: { fullName: id } };
}

test('getAccountMap: an empty /v1/accounts is NOT cached (sync-window self-heals next call)', async () => {
  S._resetAccountCache();
  S._setNow(() => 1000);
  const calls = stubAccounts([ [], [acct('matrix', 'Beeper')] ]);
  try {
    const first = await S.getAccountMap();          // backend mid-sync returns []
    assert.deepEqual(first, {});                     // serve empty for THIS call
    const second = await S.getAccountMap();          // must re-read, not freeze []
    assert.ok(second.matrix, 'second call picks up the now-synced account');
    assert.equal(calls(), 2, 'empty result forced a re-read instead of freezing');
  } finally { S._setNow(null); global.fetch = REAL_FETCH; }
});

test('getAccountMap: a populated map IS cached within the TTL (one fetch for rapid calls)', async () => {
  S._resetAccountCache();
  S._setNow(() => 5000);
  const calls = stubAccounts([ [acct('matrix', 'Beeper')] ]);
  try {
    await S.getAccountMap();
    await S.getAccountMap();
    assert.equal(calls(), 1, 'second call within TTL served from cache');
  } finally { S._setNow(null); global.fetch = REAL_FETCH; }
});

test('getAccountMap: a runtime-added account becomes visible after the TTL, no process restart', async () => {
  // The headline regression: old code froze the first map forever, so a WhatsApp
  // account added via noVNC stayed network:"unknown" until the process restarted.
  S._resetAccountCache();
  let t = 10000;
  S._setNow(() => t);
  const calls = stubAccounts([
    [acct('matrix', 'Beeper')],
    [acct('matrix', 'Beeper'), acct('local-whatsapp_x', 'WhatsApp')],
  ]);
  try {
    const before = await S.getAccountMap();
    assert.ok(!before['local-whatsapp_x'], 'whatsapp not present yet');
    t += 60001;                                       // advance past the 60s TTL — NO restart
    const after = await S.getAccountMap();
    assert.ok(after['local-whatsapp_x'], 'whatsapp visible after TTL without a restart');
    assert.equal(after['local-whatsapp_x'].network, 'whatsapp');
    assert.equal(calls(), 2);
  } finally { S._setNow(null); global.fetch = REAL_FETCH; }
});

test('normalizeAccount surfaces the backend connection status (observability)', () => {
  const out = S.normalizeAccount(acct('telegram', 'Telegram', 'connecting'));
  assert.equal(out.status, 'connecting', 'status must be relayed so connecting != connected is visible');
  assert.equal(out.network, 'telegram');
  assert.equal(out.account_id, 'telegram');
});

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
  let cur;
  // Seed marks the existing message(s) at the high-water ts as seen (the real
  // seed returns their ids), so nothing existing surfaces on the first poll.
  cur = S.decodeCursor(S.encodeCursor({ ts: '2026-06-15T10:00:02.000Z', ids: ['m2'] }));
  let fresh = round1.filter((m) => S.isAfterCursor(m, cur));
  assert.deepEqual(fresh.map((m) => m.id), []);
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

// ── poll_messages seed: existing high-water messages are marked seen ──
// Old code seeded {ts: maxTs, ids: []}, so the first poll redelivered EVERY
// existing message sharing the high-water ts (live: 5 old WhatsApp messages).
function stubBeeper(state) {
  global.fetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('/v1/accounts')) body = [acct('matrix', 'Beeper')];
    else if (/\/v1\/chats\/[^/?]+\/messages/.test(u)) {
      const id = decodeURIComponent(u.match(/\/v1\/chats\/([^/?]+)\/messages/)[1]);
      body = { items: state.msgs[id] || [] };
    } else if (/\/v1\/chats\/[^/?]+$/.test(u)) {
      const id = decodeURIComponent(u.match(/\/v1\/chats\/([^/?]+)$/)[1]);
      body = state.chats.find((c) => c.id === id);
    } else if (u.includes('/v1/chats')) body = { items: state.chats };
    else body = {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}
const T0 = '2026-06-15T10:00:00.000Z';
const T1 = '2026-06-15T10:00:05.000Z';
const pm = (id, ts) => ({ id, chatID: 'c1', timestamp: ts, text: id, type: 'TEXT' });

for (const mode of ['inbox', 'chat_id']) {
  test(`pollMessages seed (${mode}): no redelivery of existing high-water msgs; a new same-ts msg is still delivered`, async () => {
    S._resetAccountCache();
    const state = {
      chats: [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: T1 }],
      msgs: { c1: [pm('b', T1), pm('a', T1), pm('old', T0)] },
    };
    stubBeeper(state);
    const base = mode === 'chat_id' ? { chat_id: 'c1' } : {};
    try {
      const seed = await S.pollMessages({ ...base });
      assert.equal(seed.seeded, true);
      assert.deepEqual(seed.messages, []);
      assert.equal(seed.has_more, false);
      const sc = S.decodeCursor(seed.cursor);
      assert.equal(sc.ts, T1);
      assert.deepEqual([...sc.ids].sort(), ['a', 'b']);

      // Same data again: zero messages (old code: a and b both redelivered).
      const p1 = await S.pollMessages({ ...base, cursor: seed.cursor });
      assert.deepEqual(p1.messages, []);

      // A genuinely new message in the SAME second must still arrive (never-miss).
      state.msgs.c1 = [pm('new', T1), pm('b', T1), pm('a', T1), pm('old', T0)];
      const p2 = await S.pollMessages({ ...base, cursor: p1.cursor });
      assert.deepEqual(p2.messages.map((m) => m.id), ['new']);
    } finally { global.fetch = REAL_FETCH; S._resetAccountCache(); }
  });
}

test('pollMessages seed (multi-chat): ids from every chat tied at the high-water ts; older chats are not fetched; no redelivery', async () => {
  S._resetAccountCache();
  const mk = (chat, id, ts) => ({ id, chatID: chat, timestamp: ts, text: id, type: 'TEXT' });
  const state = {
    chats: [
      { id: 'A', title: 'a', accountID: 'matrix', lastActivity: T1 },
      { id: 'B', title: 'b', accountID: 'matrix', lastActivity: T1 },
      { id: 'C', title: 'c', accountID: 'matrix', lastActivity: T0 },
    ],
    msgs: {
      A: [mk('A', 'a-new', T1), mk('A', 'a-old', T0)],
      B: [mk('B', 'b-new', T1), mk('B', 'b-old', T0)],
      C: [mk('C', 'c-old', T0)],
    },
  };
  stubBeeper(state);
  const stub = global.fetch;
  const msgFetches = [];
  global.fetch = async (url, ...rest) => {
    const m = String(url).match(/\/v1\/chats\/([^/?]+)\/messages/);
    if (m) msgFetches.push(decodeURIComponent(m[1]));
    return stub(url, ...rest);
  };
  try {
    const seed = await S.pollMessages({});
    assert.equal(seed.seeded, true);
    const sc = S.decodeCursor(seed.cursor);
    assert.equal(sc.ts, T1);
    assert.deepEqual([...sc.ids].sort(), ['a-new', 'b-new']);
    assert.deepEqual([...msgFetches].sort(), ['A', 'B'], 'seed must fetch only chats tied at maxTs (not C)');
    assert.ok(!msgFetches.includes('C'));

    const p1 = await S.pollMessages({ cursor: seed.cursor });
    assert.deepEqual(p1.messages, []);
  } finally { global.fetch = REAL_FETCH; S._resetAccountCache(); }
});

test('pollMessages seed (fetch failure): a 5xx on a tied chat rejects the seed — no partial cursor; retry succeeds', async () => {
  S._resetAccountCache();
  const mk = (chat, id, ts) => ({ id, chatID: chat, timestamp: ts, text: id, type: 'TEXT' });
  const state = {
    chats: [
      { id: 'A', title: 'a', accountID: 'matrix', lastActivity: T1 },
      { id: 'B', title: 'b', accountID: 'matrix', lastActivity: T1 },
    ],
    msgs: { A: [mk('A', 'a-new', T1)], B: [mk('B', 'b-new', T1)] },
  };
  stubBeeper(state);
  const stub = global.fetch;
  let failB = true;
  global.fetch = async (url, ...rest) => {
    if (failB && /\/v1\/chats\/B\/messages/.test(String(url))) {
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    return stub(url, ...rest);
  };
  try {
    await assert.rejects(() => S.pollMessages({}), /500/);
    // "Call it again to retry": once the chat recovers, the seed is complete.
    failB = false;
    const seed = await S.pollMessages({});
    assert.equal(seed.seeded, true);
    assert.deepEqual([...S.decodeCursor(seed.cursor).ids].sort(), ['a-new', 'b-new']);
  } finally { global.fetch = REAL_FETCH; S._resetAccountCache(); }
});

// ── bearer-token guard: accept/reject matrix over real HTTP ────────
// Pins the accept/reject behaviour of the MCP_AUTH_TOKEN check (exact match on
// `Bearer <token>`, nothing else) so swapping the comparison for a
// constant-time one cannot change who gets in. Real child server, no stubs.
test('bearer guard: only the exact `Bearer <token>` header is accepted (401 for everything else, incl. other lengths and no header)', async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, MCP_PORT: String(port), MCP_AUTH_TOKEN: 'ci-secret', BEEPERBOX_PREFLIGHT: '0', BEEPER_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bearer-guard test server never logged "listening"')), 5000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (c) => reject(new Error(`bearer-guard test server exited early (${c})`)));
    });
    const status = async (headers) => (await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })).status;
    const cases = [
      ['correct token', { Authorization: 'Bearer ci-secret' }, 200],
      ['no header', {}, 401],
      ['empty header', { Authorization: '' }, 401],
      ['wrong, same length', { Authorization: 'Bearer ci-secreX' }, 401],
      ['wrong, shorter', { Authorization: 'Bearer ci-' }, 401],
      ['wrong, longer', { Authorization: 'Bearer ci-secret-and-more' }, 401],
      ['bare token, no scheme', { Authorization: 'ci-secret' }, 401],
      ['lowercase scheme', { Authorization: 'bearer ci-secret' }, 401],
      ['scheme only', { Authorization: 'Bearer ' }, 401],
    ];
    for (const [name, headers, want] of cases) {
      assert.equal(await status(headers), want, name);
    }
  } finally { child.kill(); }
});

// ── webhook (opt-in ping mode) ────────────────────────────────────
const WH_KEY_B64 = Buffer.from('super-secret-key-bytes').toString('base64');
const whEnv = (o) => ({ BEEPERBOX_WEBHOOK_URL: 'https://hooks.example.com/x?token=abc', BEEPERBOX_WEBHOOK_SECRET: 'whsec_' + WH_KEY_B64, ...o });

test('webhook config: unset or empty URL is off', () => {
  assert.equal(S.webhookConfig({}).enabled, false);
  assert.equal(S.webhookConfig({ BEEPERBOX_WEBHOOK_URL: '' }).enabled, false);
});

test('webhook config: http to a non-loopback host is rejected', () => {
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_URL: 'http://hooks.example.com/x' })), /https/);
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_URL: 'not a url' })), /valid URL/);
});

test('webhook config: URL with userinfo credentials is rejected without echoing it', () => {
  for (const u of ['https://user:pw@host/hook', 'https://user@host/hook']) {
    let err;
    try { S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_URL: u })); } catch (e) { err = e; }
    assert.ok(err, `expected throw for ${u}`);
    assert.match(err.message, /must not contain credentials/);
    assert.ok(!/pw|user|hook/.test(err.message.replace(/BEEPERBOX_WEBHOOK_(SECRET|URL)|user:pass@/g, '')), err.message);
  }
  assert.equal(S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_URL: 'https://host.example.com/hook' })).enabled, true);
});

test('webhook config: https without a secret is rejected; loopback http without one is allowed', () => {
  assert.throws(() => S.webhookConfig({ BEEPERBOX_WEBHOOK_URL: 'https://hooks.example.com/x' }), /SECRET is required/);
  for (const u of ['http://127.0.0.1:9/x', 'http://localhost:9/x', 'http://[::1]:9/x']) {
    const c = S.webhookConfig({ BEEPERBOX_WEBHOOK_URL: u });
    assert.equal(c.enabled, true);
    assert.equal(c.key, null);
  }
});

test('webhook config: secret is base64-decoded (prefix optional); empty decode is invalid', () => {
  const k = Buffer.from('super-secret-key-bytes');
  assert.ok(S.webhookConfig(whEnv({})).key.equals(k));
  assert.ok(S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: WH_KEY_B64 })).key.equals(k));
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: 'whsec_' })), /SECRET/);
});

test('webhook config: interval default, clamp to 1000, non-numeric -> default; host hides path/query', () => {
  assert.equal(S.webhookConfig(whEnv({})).interval, 10000);
  const c = S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_INTERVAL_MS: '50' }));
  assert.equal(c.interval, 1000);
  assert.equal(c.notes.length, 1);
  assert.equal(S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_INTERVAL_MS: 'abc' })).interval, 10000);
  assert.equal(c.host, 'https://hooks.example.com');
});

test('webhook config: mode defaults to ping; a bad mode is rejected', () => {
  assert.equal(S.webhookConfig(whEnv({})).mode, 'ping');
  assert.equal(S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_MODE: 'full' })).mode, 'full');
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_MODE: 'loud' })), /MODE/);
});

test('webhook state path: override env, else next to the sent-ledger', () => {
  const sv = { s: process.env.BEEPERBOX_WEBHOOK_STATE, l: process.env.BEEPERBOX_SENT_LEDGER };
  try {
    delete process.env.BEEPERBOX_WEBHOOK_STATE;
    process.env.BEEPERBOX_SENT_LEDGER = '/tmp/zz/sent-ledger.json';
    assert.equal(S.webhookStatePath(), '/tmp/zz/webhook-state.json');
    process.env.BEEPERBOX_WEBHOOK_STATE = '/tmp/other/s.json';
    assert.equal(S.webhookStatePath(), '/tmp/other/s.json');
  } finally {
    for (const [k, v] of [['BEEPERBOX_WEBHOOK_STATE', sv.s], ['BEEPERBOX_SENT_LEDGER', sv.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// Harness: scripted pollMessages results, recorded posts/saves.
function whHarness({ polls = [], statuses = [], mode = 'ping' } = {}) {
  const h = { posts: [], saves: [], logs: [], polls: [...polls], statuses: [...statuses], clock: 1_700_000_000_000 };
  h.deps = {
    mode, interval: 1000, host: 'https://hooks.example.com',
    pollMessages: async (a) => { h.pollArgs = a; const r = h.polls.shift(); if (r instanceof Error) throw r; return r; },
    post: async (p) => {
      h.posts.push({ ...p });
      const s = h.statuses.shift();
      if (s instanceof Error) throw s;
      return s === undefined ? 200 : s;
    },
    save: (s) => h.saves.push(JSON.parse(JSON.stringify(s))),
    now: () => h.clock,
    log: (m) => h.logs.push(m),
  };
  return h;
}
const wm = (id, chat, ts, extra) => ({ id, chat_id: chat, network: 'whatsapp', text: 'SECRET TEXT', timestamp: ts, source: 'external', attachments: [{ src_url: 'file:///x' }], sender: { id: 's', name: 'Bob', is_self: false }, ...extra });

test('webhook seed: saves the cursor and POSTs nothing', async () => {
  const h = whHarness({ polls: [{ cursor: 'C0', messages: [], seeded: true }] });
  const st = { cursor: null, pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.pollArgs, {});
  assert.equal(h.saves.at(-1).cursor, 'C0');
});

test('webhook seed error: cursor stays unset and the next tick re-seeds (no empty-cursor fallback)', async () => {
  const h = whHarness({ polls: [new Error('boom'), { cursor: 'C0', messages: [] }] });
  const st = { cursor: null, pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, null);
  assert.equal(h.posts.length, 0);
  assert.equal(h.saves.length, 0);
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.deepEqual(h.pollArgs, {});
});

test('webhook ping: new messages -> exactly one POST, ids/counts only, no text', async () => {
  const msgs = [wm('a', 'c1', '2026-01-01T00:00:01Z'), wm('b', 'c1', '2026-01-01T00:00:05Z'), wm('c', 'c2', '2026-01-01T00:00:03Z')];
  const h = whHarness({ polls: [{ cursor: 'C1', messages: msgs, has_more: false }] });
  const st = { cursor: 'C0', pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.pollArgs, { cursor: 'C0', limit: 100 });
  const body = JSON.parse(h.posts[0].body);
  assert.equal(body.type, 'messages.new');
  assert.equal(body.timestamp, new Date(h.clock).toISOString());
  assert.deepEqual(body.data.chats, [
    { chat_id: 'c1', network: 'whatsapp', count: 2, latest_at: '2026-01-01T00:00:05Z', message_ids: ['a', 'b'] },
    { chat_id: 'c2', network: 'whatsapp', count: 1, latest_at: '2026-01-01T00:00:03Z', message_ids: ['c'] },
  ]);
  assert.equal(body.data.messages, undefined);
  assert.ok(!h.posts[0].body.includes('SECRET TEXT'));
  assert.ok(!h.posts[0].body.includes('"text"'));
  assert.ok(!h.posts[0].body.includes('Bob'));
  assert.match(h.posts[0].id, /^msg_/);
  assert.equal(st.cursor, 'C1');
  assert.equal(st.pending, null);
});

test('webhook full: data.messages carries the normalized messages', async () => {
  const msgs = [wm('a', 'c1', '2026-01-01T00:00:01Z')];
  const h = whHarness({ mode: 'full', polls: [{ cursor: 'C1', messages: msgs }] });
  await S.webhookTick({ cursor: 'C0', pending: null, failures: 0 }, h.deps);
  assert.deepEqual(JSON.parse(h.posts[0].body).data.messages, msgs);
});

test('webhook echo-guard: an api-only batch POSTs nothing but advances the cursor; api msgs are dropped from mixed batches', async () => {
  const h = whHarness({ polls: [
    { cursor: 'C1', messages: [wm('a', 'c1', 't', { source: 'api' })] },
    { cursor: 'C2', messages: [wm('b', 'c1', 't', { source: 'api' }), wm('c', 'c1', 't')] },
  ] });
  const st = { cursor: 'C0', pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 0);
  assert.equal(st.cursor, 'C1');
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(JSON.parse(h.posts[0].body).data.chats[0].message_ids, ['c']);
});

test('webhook retry: 500 then 200 reuses the same webhook-id, holds the cursor, grows the backoff', async () => {
  const h = whHarness({ polls: [{ cursor: 'C1', messages: [wm('a', 'c1', 't')] }], statuses: [500, 500, 200] });
  const st = { cursor: 'C0', pending: null, failures: 0 };
  const d1 = await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.ok(st.pending);
  assert.equal(d1, 2000);
  const d2 = await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.equal(d2, 4000);
  const d3 = await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 3);
  assert.equal(new Set(h.posts.map((p) => p.id)).size, 1);
  assert.equal(new Set(h.posts.map((p) => p.body)).size, 1);
  assert.equal(st.cursor, 'C1');
  assert.equal(st.pending, null);
  assert.equal(st.failures, 0);
  assert.equal(d3, 1000);
  // pending was persisted BEFORE the first POST
  assert.ok(h.saves[0].pending);
});

test('webhook backoff is capped at 300000ms', async () => {
  const h = whHarness({ statuses: [500] });
  const st = { cursor: 'C0', pending: { id: 'msg_x', body: '{}', next_cursor: 'C1' }, failures: 30 };
  assert.equal(await S.webhookTick(st, h.deps), 300000);
});

test('webhook: a 3xx redirect and a network error are failures', async () => {
  const h = whHarness({ statuses: [302, new Error('ECONNREFUSED')] });
  const st = { cursor: 'C0', pending: { id: 'msg_x', body: '{}', next_cursor: 'C1' }, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.ok(st.pending);
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, 'C0');
  assert.equal(st.failures, 2);
  assert.ok(h.logs.every((l) => !l.includes('/x')));
});

test('webhook restart: a persisted pending is retried under the same id without polling', async () => {
  const h = whHarness({});
  const st = { cursor: 'C0', pending: { id: 'msg_persisted', body: '{"a":1}', next_cursor: 'C9' }, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts[0].id, 'msg_persisted');
  assert.equal(h.pollArgs, undefined);
  assert.equal(st.cursor, 'C9');
});

test('webhook has_more: next tick is immediate after a successful POST', async () => {
  const h = whHarness({ polls: [{ cursor: 'C1', messages: [wm('a', 'c1', 't')], has_more: true }] });
  assert.equal(await S.webhookTick({ cursor: 'C0', pending: null, failures: 0 }, h.deps), 0);
});

test('webhook signature matches an independent HMAC-SHA256 over id.ts.body', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const id = 'msg_1', ts = '1700000000', body = '{"x":1}';
  const expect = 'v1,' + require('node:crypto').createHmac('sha256', key).update(id + '.' + ts + '.' + body).digest('base64');
  assert.equal(S.signWebhook(key, id, ts, body), expect);
  assert.notEqual(S.signWebhook(key, id, '1700000001', body), expect);
});

test('webhook send: headers, independent signature, manual redirects, fresh timestamp per attempt', async () => {
  const key = Buffer.from('super-secret-key-bytes');
  const cfg = { url: 'https://hooks.example.com/x', key };
  const pending = { id: 'msg_abc', body: '{"type":"messages.new"}' };
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 204 }; };
  assert.equal(await S.sendWebhook(cfg, pending, fakeFetch, () => 1_700_000_000_500), 204);
  await S.sendWebhook(cfg, pending, fakeFetch, () => 1_700_000_007_000);
  const [a, b] = calls.map((c) => c.init);
  assert.equal(a.method, 'POST');
  assert.equal(a.redirect, 'manual');
  assert.ok(a.signal);
  assert.equal(a.body, pending.body);
  assert.equal(a.headers['content-type'], 'application/json');
  assert.equal(a.headers['webhook-id'], 'msg_abc');
  assert.equal(a.headers['webhook-timestamp'], '1700000000');
  assert.equal(b.headers['webhook-timestamp'], '1700000007');
  assert.equal(b.headers['webhook-id'], 'msg_abc');
  const expect = 'v1,' + require('node:crypto').createHmac('sha256', key).update(`msg_abc.1700000000.${pending.body}`).digest('base64');
  assert.equal(a.headers['webhook-signature'], expect);
  assert.notEqual(b.headers['webhook-signature'], a.headers['webhook-signature']);
  // no secret -> no signature header
  await S.sendWebhook({ url: cfg.url, key: null }, pending, fakeFetch);
  assert.equal(calls[2].init.headers['webhook-signature'], undefined);
});

test('webhook idle tick: an empty poll with an unchanged cursor does not write state', async () => {
  const h = whHarness({ polls: [{ cursor: 'C0', messages: [], has_more: false }] });
  const st = { cursor: 'C0', pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(h.saves.length, 0);
  assert.equal(h.posts.length, 0);
  assert.equal(st.cursor, 'C0');
});

test('webhook POST failure log includes the underlying fetch cause, host only', async () => {
  const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const h = whHarness({ statuses: [err] });
  const st = { cursor: 'C0', pending: { id: 'msg_x', body: '{}', next_cursor: 'C1' }, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /fetch failed/);
  assert.match(h.logs[0], /ECONNREFUSED/);
  assert.ok(h.logs[0].includes('https://hooks.example.com'));
  assert.ok(!h.logs[0].includes('token'));
});

test('webhook full mode: a batch over 64 KiB falls back to the ping shape with messages_omitted', () => {
  const big = Array.from({ length: 100 }, (_, i) => wm('m' + i, 'c1', '2026-01-01T00:00:0' + (i % 10) + 'Z', { text: 'x'.repeat(2000) }));
  const p = S.buildWebhookPayload(big, 'full', 1_700_000_000_000);
  const body = JSON.stringify(p);
  assert.ok(Buffer.byteLength(body) <= 65536);
  assert.equal(p.data.messages, undefined);
  assert.equal(p.data.messages_omitted, true);
  assert.equal(p.data.chats[0].count, 100);
  assert.equal(p.data.chats[0].message_ids.length, 100);
});

test('webhook full mode: a small batch keeps messages and has no messages_omitted', () => {
  const p = S.buildWebhookPayload([wm('a', 'c1', 't')], 'full', 1_700_000_000_000);
  assert.equal(p.data.messages.length, 1);
  assert.equal('messages_omitted' in p.data, false);
});

test('webhook config: secret must be canonical base64 of at least 16 bytes', () => {
  const enc = (n) => Buffer.alloc(n, 7).toString('base64');
  assert.equal(S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: 'whsec_' + enc(16) })).key.length, 16);
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: 'whsec_' + enc(15) })), /at least 16 bytes/);
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: 'whsec_' + enc(16) + ' \n' })), /at least 16 bytes/);
  assert.throws(() => S.webhookConfig(whEnv({ BEEPERBOX_WEBHOOK_SECRET: 'whsec_not base64 !!' })), /at least 16 bytes/);
  // applies to loopback URLs too
  assert.throws(() => S.webhookConfig({ BEEPERBOX_WEBHOOK_URL: 'http://127.0.0.1:9/x', BEEPERBOX_WEBHOOK_SECRET: 'whsec_' + enc(15) }), /at least 16 bytes/);
});

// ── outage gap: a full window that never reaches the cursor is flagged ──
const gapMsgs = (n, startSec) => Array.from({ length: n }, (_, i) => {
  const ts = new Date(Date.UTC(2026, 5, 15, 11, 0, startSec + n - 1 - i)).toISOString(); // newest first
  return pm('g' + (startSec + n - 1 - i), ts);
});

test('pollMessages gaps: a full 100-message window entirely after the cursor flags the chat', async () => {
  S._resetAccountCache();
  const state = {
    chats: [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: '2026-06-15T11:05:00.000Z' }],
    msgs: { c1: gapMsgs(100, 0) },
  };
  stubBeeper(state);
  try {
    const cur = S.encodeCursor({ ts: T1, ids: [] });
    const r = await S.pollMessages({ cursor: cur });
    assert.deepEqual(r.gaps, ['c1']);
  } finally { global.fetch = REAL_FETCH; S._resetAccountCache(); }
});

test('pollMessages gaps: a window that overlaps the cursor (or is not full) has no gaps key', async () => {
  S._resetAccountCache();
  const full = gapMsgs(99, 1); // 99 new + 1 old = full window that reaches the cursor
  full.push(pm('old', T0));
  const state = {
    chats: [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: '2026-06-15T11:05:00.000Z' }],
    msgs: { c1: full },
  };
  stubBeeper(state);
  try {
    const cur = S.encodeCursor({ ts: T1, ids: [] });
    const r = await S.pollMessages({ cursor: cur });
    assert.ok(!('gaps' in r));
    state.msgs.c1 = gapMsgs(50, 0); // not full
    const r2 = await S.pollMessages({ cursor: cur });
    assert.ok(!('gaps' in r2));
  } finally { global.fetch = REAL_FETCH; S._resetAccountCache(); }
});

test('webhookTick: gaps mark the chat possible_gap, log a WARN without text, and a gap-only chat just logs', async () => {
  const h = whHarness({ polls: [{ cursor: 'C1', has_more: false, gaps: ['c1', 'c2'], messages: [wm('m1', 'c1', '2026-06-15T10:00:00.000Z')] }] });
  const st = { cursor: 'C0', pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  const chats = JSON.parse(h.posts[0].body).data.chats;
  assert.equal(chats.length, 1);
  assert.equal(chats[0].possible_gap, true);
  assert.equal(h.logs.filter((l) => /possible gap/.test(l)).length, 2);
  assert.ok(!h.logs.join('\n').includes('SECRET TEXT'));
  // no gaps → no key
  const h2 = whHarness({ polls: [{ cursor: 'C1', has_more: false, messages: [wm('m1', 'c1', '2026-06-15T10:00:00.000Z')] }] });
  await S.webhookTick({ cursor: 'C0', pending: null, failures: 0 }, h2.deps);
  assert.ok(!('possible_gap' in JSON.parse(h2.posts[0].body).data.chats[0]));
});

// ── webhook state: corrupt files are moved aside, never silently reseeded ──
function whTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'whstate-')); }
const FRESH = { cursor: null, pending: null, failures: 0 };

test('webhook state: save -> load round-trips cursor and pending; mode 0600', () => {
  const d = whTmp(); const f = path.join(d, 'sub', 'ws.json'); const logs = [];
  const st = { cursor: 'C9', pending: { id: 'msg_1', body: '{"a":1}', next_cursor: 'C10' }, failures: 3 };
  S.saveWebhookState(f, st, (m) => logs.push(m));
  assert.deepEqual(S.loadWebhookState(f, (m) => logs.push(m)), { cursor: 'C9', pending: st.pending, failures: 0 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(logs, []);
});

test('webhook state: missing file -> fresh, silently', () => {
  const d = whTmp(); const logs = [];
  assert.deepEqual(S.loadWebhookState(path.join(d, 'nope.json'), (m) => logs.push(m)), FRESH);
  assert.deepEqual(logs, []);
});

for (const [name, content] of [['truncated JSON', '{"cursor":"C1","pend'], ['wrong field names', '{"cursr":"x"}'], ['empty file', ''], ['bad pending', '{"cursor":"C","pending":{"id":1}}'], ['not an object', '[1]']]) {
  test(`webhook state: ${name} -> WARN, moved to .corrupt-*, fresh`, () => {
    const d = whTmp(); const f = path.join(d, 'ws.json'); const logs = [];
    fs.writeFileSync(f, content);
    assert.deepEqual(S.loadWebhookState(f, (m) => logs.push(m)), FRESH);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /corrupt|invalid/i);
    assert.ok(!fs.existsSync(f));
    const moved = fs.readdirSync(d).filter((n) => n.startsWith('ws.json.corrupt-'));
    assert.equal(moved.length, 1);
    assert.equal(fs.readFileSync(path.join(d, moved[0]), 'utf8'), content);
  });
}

test('webhookTick: a gap chat with no message in the batch logs "in one chat" (no bogus network)', async () => {
  const h = whHarness({ polls: [{ cursor: 'C1', has_more: false, gaps: ['cX'], messages: [] }] });
  await S.webhookTick({ cursor: 'C0', pending: null, failures: 0 }, h.deps);
  const w = h.logs.filter((l) => /possible gap/.test(l));
  assert.equal(w.length, 1);
  assert.match(w[0], /in one chat since/);
  assert.equal(h.posts.length, 0);
});

// ── poll_messages lazy seed: no activity → empty-ts cursor; later polls finish the seed ──
const lazyOld = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, chatID: 'c1', timestamp: new Date(Date.UTC(2026, 5, 15, 10, 0, i)).toISOString(), text: 't', type: 'TEXT' })).reverse();
const lazyTs = (i) => new Date(Date.UTC(2026, 5, 15, 10, 0, i)).toISOString();
const emptyTs = (c) => S.decodeCursor(c).ts === '';

async function lazyFlow(base) {
  S._resetAccountCache();
  const state = { chats: [{ id: 'c1', title: 'one', accountID: 'matrix' }], msgs: { c1: [] } };
  stubBeeper(state);
  const seed = await S.pollMessages({ ...base });
  assert.equal(seed.seeded, true);
  assert.deepEqual(seed.messages, []);
  assert.ok(emptyTs(seed.cursor), 'no-activity seed yields an empty-ts cursor');
  const idle = await S.pollMessages({ ...base, cursor: seed.cursor });
  assert.equal(idle.messages.length, 0);
  assert.equal(idle.gaps, undefined);
  assert.ok(emptyTs(idle.cursor));
  // activity + 100 old messages appear
  state.msgs.c1 = lazyOld(100);
  state.chats = [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: lazyTs(99) }];
  const done = await S.pollMessages({ ...base, cursor: idle.cursor });
  assert.equal(done.messages.length, 0);
  assert.equal(done.gaps, undefined);
  assert.equal(done.seeded, true);
  assert.ok(!emptyTs(done.cursor));
  // one genuinely new message: delivered once
  state.msgs.c1 = [{ id: 'new1', chatID: 'c1', timestamp: lazyTs(500), text: 'n', type: 'TEXT' }, ...state.msgs.c1];
  state.chats[0].lastActivity = lazyTs(500);
  const got = await S.pollMessages({ ...base, cursor: done.cursor });
  assert.deepEqual(got.messages.map((m) => m.id), ['new1']);
  const again = await S.pollMessages({ ...base, cursor: got.cursor });
  assert.equal(again.messages.length, 0);
}

test('pollMessages lazy seed (inbox, no activity): empty-ts cursor, re-seeds when activity appears, no replay, new message once', () => lazyFlow({}));
test('pollMessages lazy seed (chat_id, no activity): empty-ts cursor, re-seeds when activity appears, no replay, new message once', () => lazyFlow({ chat_id: 'c1' }));

test('pollMessages lazy seed (zero chats): seed resolves to an empty-ts cursor; polling it stays empty with no gaps', async () => {
  S._resetAccountCache();
  stubBeeper({ chats: [], msgs: {} });
  const seed = await S.pollMessages({});
  assert.equal(seed.seeded, true);
  assert.ok(emptyTs(seed.cursor));
  const r = await S.pollMessages({ cursor: seed.cursor });
  assert.equal(r.messages.length, 0);
  assert.equal(r.gaps, undefined);
  assert.ok(emptyTs(r.cursor));
});

test('pollMessages lazy seed (restart resume): a persisted empty-ts cursor string in a later call re-seeds, no replay', async () => {
  S._resetAccountCache();
  const persisted = Buffer.from(JSON.stringify({ ts: '', ids: [] }), 'utf8').toString('base64');
  stubBeeper({ chats: [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: lazyTs(99) }], msgs: { c1: lazyOld(100) } });
  const r = await S.pollMessages({ cursor: persisted });
  assert.equal(r.messages.length, 0);
  assert.equal(r.gaps, undefined);
  assert.equal(r.seeded, true);
  assert.ok(!emptyTs(r.cursor));
});

test('webhookTick + real pollMessages: empty ticks log/POST nothing; activity appearing POSTs nothing; then 1 new message POSTs exactly it', async () => {
  S._resetAccountCache();
  const state = { chats: [{ id: 'c1', title: 'one', accountID: 'matrix' }], msgs: { c1: [] } };
  stubBeeper(state);
  const h = whHarness();
  h.deps.pollMessages = S.pollMessages;
  const st = { cursor: null, pending: null, failures: 0 };
  for (let i = 0; i < 3; i++) await S.webhookTick(st, h.deps);
  assert.equal(h.logs.filter((l) => /seed failed/.test(l)).length, 0, h.logs.join('|'));
  assert.equal(h.posts.length, 0);
  state.msgs.c1 = lazyOld(100);
  state.chats = [{ id: 'c1', title: 'one', accountID: 'matrix', lastActivity: lazyTs(99) }];
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 0);
  assert.equal(h.logs.filter((l) => /gap/.test(l)).length, 0, h.logs.join('|'));
  state.msgs.c1 = [{ id: 'new1', chatID: 'c1', timestamp: lazyTs(500), text: 'n', type: 'TEXT' }, ...state.msgs.c1];
  state.chats[0].lastActivity = lazyTs(500);
  await S.webhookTick(st, h.deps);
  await S.webhookTick(st, h.deps);
  assert.equal(h.posts.length, 1);
  const body = JSON.parse(h.posts[0].body);
  assert.deepEqual(body.data.chats.flatMap((c) => c.message_ids), ['new1']);
});

test('webhookTick: a seed-fetch failure (beeper api 503) leaves cursor null, saves nothing, POSTs nothing', async () => {
  const h = whHarness({ polls: [new Error('beeper api 503')] });
  const st = { cursor: null, pending: null, failures: 0 };
  await S.webhookTick(st, h.deps);
  assert.equal(st.cursor, null);
  assert.equal(h.saves.length, 0);
  assert.equal(h.posts.length, 0);
  assert.ok(h.logs.some((l) => /seed failed: beeper api 503/.test(l)));
});

// ── webhook state: an unreadable file is moved aside, never overwritten ──
test('webhook state: unreadable (EACCES) file with a pending batch -> WARN, moved to .unreadable-*, batch preserved', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores chmod; cannot make a file unreadable');
  const d = whTmp(); const f = path.join(d, 'ws.json'); const logs = [];
  const content = JSON.stringify({ cursor: 'C1', pending: { id: 'msg_1', body: '{"x":1}', next_cursor: 'C2' } });
  fs.writeFileSync(f, content); fs.chmodSync(f, 0);
  const st = S.loadWebhookState(f, (m) => logs.push(m));
  assert.deepEqual(st, FRESH);
  S.saveWebhookState(f, { cursor: 'C5', pending: null, failures: 0 }, (m) => logs.push(m));
  const moved = fs.readdirSync(d).filter((n) => n.startsWith('ws.json.unreadable-'));
  assert.equal(moved.length, 1);
  const mp = path.join(d, moved[0]);
  fs.chmodSync(mp, 0o600);
  assert.equal(fs.readFileSync(mp, 'utf8'), content);
  assert.ok(logs.some((l) => /unreadable/.test(l) && /EACCES/.test(l) && /unreadable-/.test(l)), logs.join('|'));
});

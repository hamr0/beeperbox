// End-to-end harness for download_asset + attachments, run against a STUB
// Beeper Desktop API (CI has no live account). Aimed at the TOUGH turns, not the
// happy path: binary integrity, BOTH cap paths (Content-Length pre-check AND the
// no-Content-Length buffered post-check), and the error branches. Honest about
// what a stub can and can't prove — the stub encodes our ASSUMPTION of how
// /v1/assets/serve behaves; this verifies our code against that assumption, not
// against real Beeper. Run: node scripts/asset-serve-check.js  (exit 0 = pass)
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const SMALL = crypto.randomBytes(1234);     // well under cap; random ⇒ text-decoding WOULD corrupt it
const BIG = crypto.randomBytes(4096);       // over the 2000-byte cap we set below

// ── stub Beeper Desktop API ───────────────────────────────────────
const beeper = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/v1/assets/serve') {
    const url = u.searchParams.get('url');
    if (url === 'mxc://h/big-known-length') {
      // Well-behaved: correct Content-Length ⇒ exercises the PRE-check.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BIG.length) });
      res.end(BIG);
    } else if (url === 'mxc://h/big-no-length') {
      // Chunked, NO Content-Length ⇒ pre-check can't fire; exercises the
      // buffered POST-check. This is the path my first POC never ran.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // chunked
      res.write(BIG.subarray(0, 2048));
      res.end(BIG.subarray(2048));
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(SMALL.length) });
      res.end(SMALL);
    }
    return;
  }

  if (u.pathname.includes('/messages/')) {
    const id = u.pathname.split('/').pop();
    if (id === 'm-multi') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, chatID: 'c1', type: 'MEDIA', attachments: [
        { type: 'image', fileName: 'a.png', mimeType: 'image/png', srcURL: 'mxc://h/a', fileSize: SMALL.length },
        { type: 'file', fileName: 'b.pdf', mimeType: 'application/pdf', srcURL: 'mxc://h/abc', fileSize: SMALL.length },
      ] }));
    } else if (id === 'm-nosrc') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, chatID: 'c1', type: 'MEDIA', attachments: [{ type: 'file', fileName: 'broken.bin' }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, chatID: 'c1', type: 'MEDIA', attachments: [
        { type: 'file', fileName: 'invoice.pdf', mimeType: 'application/pdf', srcURL: 'mxc://h/abc', fileSize: SMALL.length },
      ] }));
    }
    return;
  }
  res.writeHead(404).end();
});

function rpc(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    r.on('error', reject); r.end(data);
  });
}
// Defensive: a tool error (no .result) must surface as a clean assertion
// failure, never crash the harness — otherwise a regression that errors looks
// like a harness bug instead of the FAIL it is.
const parse = (r) => (r && r.result ? JSON.parse(r.result.content[0].text) : { __error: r && r.error && r.error.message });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beeper.listen(0, '127.0.0.1', () => {
  const beeperPort = beeper.address().port;
  const mcpPort = 28997;
  const srv = spawn('node', [SERVER], {
    env: { ...process.env, MCP_PORT: String(mcpPort), BEEPER_API: `http://127.0.0.1:${beeperPort}`, BEEPER_TOKEN: 'x', BEEPERBOX_MAX_ASSET_BYTES: '2000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  (async () => {
    await wait(700);
    let failures = 0;
    const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) failures++; };

    // ── binary integrity (the load-bearing claim) ──
    const d1 = parse(await rpc(mcpPort, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'mxc://h/abc' } } }));
    check(!d1.__error && Buffer.from(d1.data_base64 || '', 'base64').equals(SMALL), `base64 decodes to the EXACT original bytes (no text corruption)${d1.__error ? ' — got error: ' + d1.__error : d1.bytes !== SMALL.length ? ' — got ' + d1.bytes + ' bytes' : ''}`);
    check(d1.content_type === 'image/png' && d1.bytes === SMALL.length, 'content_type + byte count correct');

    // ── message-resolution path + index ──
    const d2 = parse(await rpc(mcpPort, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'download_asset', arguments: { chat_id: 'c1', message_id: 'm-multi', index: 1 } } }));
    check(d2.file_name === 'b.pdf' && d2.mime_type === 'application/pdf', 'index:1 selects the SECOND attachment (resolves its src_url + metadata)');

    // ── TOUGH TURN A: cap via Content-Length pre-check ──
    const c1 = await rpc(mcpPort, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'mxc://h/big-known-length' } } });
    check(/over the 2000-byte cap/.test(c1.error?.message || ''), `cap PRE-check (Content-Length present) rejects: ${c1.error?.message || 'NO ERROR'}`);

    // ── TOUGH TURN B: cap via buffered post-check (NO Content-Length) ──
    // The path the first POC silently skipped — chunked response, header absent.
    const c2 = await rpc(mcpPort, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'mxc://h/big-no-length' } } });
    check(/over the 2000-byte cap/.test(c2.error?.message || ''), `cap POST-check (no Content-Length, chunked) rejects: ${c2.error?.message || 'NO ERROR'}`);
    check(/4096 bytes/.test(c2.error?.message || ''), 'post-check reports the ACTUAL buffered length (4096), proving it measured bytes not the header');

    // ── error branches ──
    const e1 = await rpc(mcpPort, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'download_asset', arguments: { chat_id: 'c1', message_id: 'm-multi', index: 9 } } });
    check(/no attachment at index 9 \(found 2\)/.test(e1.error?.message || ''), `out-of-range index errors clearly: ${e1.error?.message || 'NO ERROR'}`);
    const e2 = await rpc(mcpPort, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'download_asset', arguments: { chat_id: 'c1', message_id: 'm-nosrc' } } });
    check(/has no src_url/.test(e2.error?.message || ''), `attachment without src_url errors clearly: ${e2.error?.message || 'NO ERROR'}`);
    const e3 = await rpc(mcpPort, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'download_asset', arguments: {} } });
    check(/requires src_url/.test(e3.error?.message || ''), 'missing ref errors clearly');

    // ── SECURITY: file:// (and non-Matrix schemes) must be refused BEFORE the
    // serve fetch — else an MCP caller reads arbitrary local files. The refusal
    // message is distinct from any serve-path error, proving the fetch never ran.
    const s1 = await rpc(mcpPort, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'file:///etc/passwd' } } });
    check(/file:\/\/ and other schemes are refused/.test(s1.error?.message || ''), `file:// src_url is REFUSED (local-file-read guard): ${s1.error?.message || 'NO ERROR'}`);
    const s2 = await rpc(mcpPort, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'http://169.254.169.254/latest/meta-data/' } } });
    check(/schemes are refused/.test(s2.error?.message || ''), 'http:// src_url (SSRF) is refused too');
    const s3 = parse(await rpc(mcpPort, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'download_asset', arguments: { src_url: 'localmxc://h/cached' } } }));
    check(!s3.__error, 'localmxc:// (legit local-cache attachment scheme) is still allowed');

    // ── attachments[] surfaced on a normalized read (via the message endpoint shape) ──
    const d3 = parse(await rpc(mcpPort, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'download_asset', arguments: { chat_id: 'c1', message_id: 'm1' } } }));
    check(d3.src_url === 'mxc://h/abc', 'single-attachment message resolves src_url at default index 0');

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    srv.kill(); beeper.close(); process.exit(failures === 0 ? 0 : 1);
  })().catch((e) => { console.error(e); srv.kill(); beeper.close(); process.exit(2); });
});

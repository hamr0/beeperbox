# Changelog

All notable changes to beeperbox are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

beeperbox follows [Semantic Versioning 2.0.0](https://semver.org/) with one concrete rule per bump type — scoped to what's *inside* the container, not how you get it:

- **MAJOR** (`X.0.0`) — held at `0` until the MCP tool set, HTTP API surface, and default ports are declared stable. Reserved for breaking changes to the runtime contract (removed MCP tool, renamed field in `Chat` / `Message` schema, default port reassigned). Bumping to `1.0.0` is an explicit "we're committing to this API" event.
- **MINOR** (`0.X.0`) — new runtime behavior: new MCP tool, new endpoint, new architecture support (e.g. `linux/arm64`), new schema field, new transport mode. May include breaking changes while `MAJOR == 0` per semver §4 — called out loudly in the release notes when it happens.
- **PATCH** (`0.0.X`) — bug fixes, docs, packaging, release-workflow changes, build-system tweaks that don't change what the running container does. The image hash may differ (rebuild from the same source still produces a fresh digest), but an agent calling the HTTP or MCP surface cannot tell the difference between two PATCH releases except for fixed bugs.

Published tags on GHCR: `:X.Y.Z` (exact, immutable), `:X.Y` (rolling within a minor), `:X` (rolling within a major — always `:0` today), `:latest` (newest release tag, rebuilt weekly to pick up upstream Beeper AppImage drift), `:edge` (every push to `master`, may break).

## [Unreleased]

**Lite mode** — a first-class, supported way to run beeperbox's MCP verb server standalone against a Beeper Desktop the user already runs locally (no Docker, no Electron, no Xvfb). Driven by [multis](https://github.com/hamr0/multis), beeperbox's first consumer: laptop users with Beeper already open get the verbs without the whole container, while the container stays the answer for always-on/VPS. Same single `mcp/server.js` either way, so the tool surface and `serverInfo.version` are identical by construction — lite mode is the *packaging*, not a fork. MINOR per the versioning policy (new runtime behavior — a boot preflight + new distribution mode), and it carries one bug fix that also mattered to the container. Validated live: the full send → restart → poll round-trip echo-guard persistence was proven against a real Beeper account running on the host.

### Added

- **npm package `beeperbox`** (`mcp/package.json`, zero runtime deps). Exposes a `beeperbox` bin, so the supported lite-mode install is `BEEPER_TOKEN=… npx beeperbox` (HTTP transport) or `npx beeperbox --stdio` (stdio). The published tarball is just `server.js` + a focused npm README — the same file the container runs.
- **Single-sourced version.** `serverInfo.version` now reads from the sibling `package.json` instead of a hardcoded string, so the npm package, the container (which `COPY`s `mcp/` into the image), and the MCP `initialize` response can never report three different versions. A unit test pins `serverInfo.version === package.json.version` and asserts the exact 12-verb tool set, so lite and container can't silently drift.
- **Startup preflight** (new runtime behavior). On boot the server fires one bounded probe of `/v1/accounts` (token-gated, so it proves reachability *and* that the token is accepted in a single hit) and logs a clear verdict — `preflight OK: <api> reachable, token accepted, N account(s)` or `preflight FAIL: … unreachable or token rejected — <reason>`. The container has a Docker `HEALTHCHECK` + supervises beepertexts; lite mode had neither, so a misconfig used to surface only at the first tool call. Best-effort and non-fatal (an unset token or down API never blocks boot — the container's first run legitimately has neither), logged to stderr so it's safe under both transports. Opt out with `BEEPERBOX_PREFLIGHT=0`; bound with `BEEPERBOX_PREFLIGHT_TIMEOUT_MS` (default 5000). **The container image sets `BEEPERBOX_PREFLIGHT=0`** — preflight is the lite-mode boot check, and the container already has a Docker `HEALTHCHECK` + supervisor + an API-wait loop; since the entrypoint starts the MCP server before the API is ready, a one-shot preflight would otherwise log a misleading `FAIL` on every container boot.

### Fixed

- **Sent-ledger now persists on a normal host (echo-guard no longer silently degrades in lite mode).** `BEEPERBOX_SENT_LEDGER`'s default was the container-only `/root/.config/beeperbox-sent-ledger.json`; on a non-root host that write fails, so the `source:"api"` echo-guard's ledger couldn't persist and the guard degraded to in-memory across restarts. The default is now a per-user XDG path — `$XDG_CONFIG_HOME/beeperbox/sent-ledger.json`, falling back to `~/.config/beeperbox/sent-ledger.json` — and the parent dir is created on first write. **One code path for both deployments, no container-detection:** `os.homedir()` is `/root` in the container, so the file still lands on the persisted `/root/.config` volume (the path moves from `…/beeperbox-sent-ledger.json` to `…/beeperbox/sent-ledger.json`; the ledger is best-effort and self-rebuilds from sends, so the move is transparent on upgrade). `BEEPERBOX_SENT_LEDGER` still overrides. Verified live: send → kill process → restart → read-back, where the prior send still reads `source:"api"` with its `client_tag`, from the reloaded ledger.

### Security

- **Lite mode binds loopback by default (new `MCP_BIND_ADDR`, default `127.0.0.1`).** The MCP server bound `0.0.0.0` unconditionally. That is safe in the container — Docker publishes the port on `127.0.0.1`, and that loopback *publish* is the boundary — but **lite mode has no such layer**: `npx beeperbox` listened on every interface, so a same-network attacker could reach the full tool surface (read every message, send across every network) **unauthenticated**, bypassing the `Host`/`Origin` allowlist by spoofing the `Host` header (a non-browser client trivially can; demonstrated live against the LAN IP during the `/security` pass). The bind address is now `MCP_BIND_ADDR`, defaulting to loopback; the container image bakes in `MCP_BIND_ADDR=0.0.0.0` (so its published port keeps working — and the CI guard-check, which runs `node` directly, still binds all interfaces). To expose lite mode deliberately, set `MCP_BIND_ADDR=0.0.0.0` **and** `MCP_AUTH_TOKEN` and front it with a tunnel. Found and fixed by `/security` on this change.

### Changed

- **De-containerized the `BEEPER_TOKEN`-missing error.** The message said "pass it to the container"; it now says "set the `BEEPER_TOKEN` environment variable" — transport-agnostic, since lite mode has no container.

### Documentation

- **README — new "Lite mode" section**: container-vs-lite comparison, prereqs (local Beeper Desktop + Developer API + dev token), the one command, the full env contract, the loopback-by-default security posture (set `MCP_AUTH_TOKEN` + `MCP_ALLOWED_HOSTS` + a tunnel to expose), and the systemd/pm2 supervision note. A focused `mcp/README.md` renders on the npm package page.

## [0.7.0] — 2026-06-16 `[MINOR]`

Cuts 0.7.0 (MINOR) so `:latest` carries attachment reach for multis's media flow (indexing files customers/the admin send — e.g. a PDF → FAQ). New `download_asset` MCP tool + `attachments[]` on every `Message`; validated end-to-end against a live Beeper account. Tag `v0.7.0` after merge triggers the gated publish (`:0.7.0`/`:0.7`/`:0`/`:latest`, old `:latest` → `:previous`).

### Added

- **Attachment reach for media messages.** Every normalized `Message` now carries an `attachments[]` array (`[]` when none); each entry is `{type, file_name, mime_type, src_url, size, is_voice_note}`, a pure passthrough of the raw Beeper message's `attachments[]`. Previously a media message arrived as `type: "MEDIA"`, `text: "[MEDIA]"` with no way to reach the file — an agent could see that a file existed but never read it. `src_url` (an `mxc://` / `localmxc://` / `file://` URL) is the download reference.
- **New MCP tool `download_asset`** (12 tools now). Fetches an attachment's actual bytes and returns them base64-encoded — the MCP-only path to a file's content, so a remote deployment publishing only `:23375` (not the raw Beeper API on `:23373`) can still read attachments. Reference the attachment by `src_url`, or by `chat_id` + `message_id` (+ optional `index`) in which case beeperbox resolves the `src_url` and also returns the file's `file_name` / `mime_type` / `size`. Internally proxies `GET /v1/assets/serve?url=…`. The payload rides base64 inside the JSON-RPC result, so it is capped at `BEEPERBOX_MAX_ASSET_BYTES` (default 8 MiB, tunable) — an oversized asset returns a clear error (Content-Length pre-check + buffered post-check) rather than a truncated body; raise the cap or hit `serve` directly for larger files.

### Security

- **`download_asset` confines `src_url` to attachments, not the filesystem (defense-in-depth).** Real attachment `src_url`s (verified against a live account) are `mxc://` / `localmxc://` for remote media and `file:///root/.config/BeeperTexts/media/…` once Beeper caches the file locally. Beeper's own `serve` endpoint already restricts this — it returns `403` for a `file://` outside its media dir and `400` for a non-`mxc`/`localmxc`/`file` scheme (confirmed live) — but `download_asset` is the network-reachable MCP surface and does not lean on that undocumented upstream behavior. It independently allows `mxc://` / `localmxc://`, allows `file://` **only when it resolves inside the media cache** (`BEEPERBOX_ASSET_FILE_ROOT`, default `/root/.config/BeeperTexts/media/`; the path is percent-decoded + normalized, and any URL authority/host or residual double-encoded `%2e`/`%2f` is refused, so `../`/UNC tricks can't escape the prefix check), and refuses everything else **before** the fetch — covering both the caller-supplied `src_url` and a `src_url` resolved off a (potentially hostile-sender-crafted) message attachment. The payoff is not "this was a confirmed exploit" — Beeper's guard blocks the raw case — but a second, in-repo, clear-error boundary that survives an upstream guard regressing. A per-call timeout (`BEEPERBOX_ASSET_TIMEOUT_MS`, default 30 s) bounds a hung or slow-drip source.

### Notes

- **Validated against a live Beeper account**, not just the stub: a real cached PDF downloads via both reference paths with exact byte length, the raw attachment shape matches the `normalizeAttachments` mapping, and the `file://` cache confinement blocks `/etc/passwd`, the sent-ledger, and `../` traversal while still serving real cached attachments. CI itself has no account, so `scripts/asset-serve-check.js` reproduces these against a stub `serve`; the pure `normalizeAttachments` / `assertServableSrcUrl` logic is unit-tested.

## [0.6.0] — 2026-06-15 `[MINOR]`

First release driven end-to-end by a real consumer ([multis](https://github.com/hamr0/multis), beeperbox's first customer): a watch primitive and a reliable echo-guard so an agent can react to incoming messages without reinventing the seed/poll/dedup loop or echo-looping on its own sends, plus two container-lifecycle robustness fixes. MINOR per the versioning policy — new MCP tool + additive schema fields + new runtime behavior, all backward compatible. **Live-validation note:** the `source` echo-guard and the `pendingMessageID` → final-bridge-id resolution were validated against a real Beeper account by multis (CI has none); the standard release gate (guard + VNC probes) still runs the server standalone.

### Added — `poll_messages` watch primitive + echo-guard `[MINOR]`

First feature driven by a real consumer ([multis](https://github.com/hamr0/multis), beeperbox's first customer). multis was hand-rolling a seed→poll→dedup loop against the raw `/v1/` API and hitting the usual off-by-ones (lost messages at the seed boundary, duplicate delivery of same-millisecond messages, echo-looping on its own sends). This adds the missing *ability* — leaving the *policy* (poll interval, what counts as "handled") with the integrator.

- **New MCP tool `poll_messages`** (11 tools now). A passive, cursor-based "what's new since I last looked?" feed across all recent chats (or one chat via `chat_id`). **Read-only** — never marks read, never archives, never mutates. First call (no cursor) **seeds** from now and returns an empty backlog plus a starting cursor; each subsequent call returns only messages newer than the cursor passed back, oldest-first, plus a fresh cursor. `has_more: true` means more is immediately fetchable — the cursor advances over only what was delivered, so an over-`limit` burst is paged out across successive polls rather than skipped (it fetches the newest 100 per chat for headroom; the only residual is a single chat receiving >100 messages between two polls, which Beeper's no-backward-paging API can't recover — documented).
  - **The cursor is opaque and fully stateless server-side** — persist it to disk and resume across a process/container restart with no missed or duplicated messages. Same-millisecond messages are deduplicated by id (the `{ts, ids@ts}` cursor encoding), which is the specific bug-class hand-rolled pollers get wrong.
- **Echo-guard via a new `source` field on every `Message`** (`"api"` | `"external"`), plus an echoed **`client_tag`**. On a single Beeper account both the human owner's own typed messages and the agent's API replies are `is_self: true`, so `is_self` cannot guard against an agent answering its own sends. `send_message` / `note_to_self` now accept an optional `client_tag` and record what they send to a ledger persisted in the config volume; on read-back (`poll_messages`, `read_chat`, `search_messages`) those messages are marked `source: "api"` with the tag echoed. Branch on `source`, not `is_self`: skip `"api"`, process `"external"` (the owner's own Note-to-self commands included). Retires the brittle text-prefix echo-hack.
  - **Schema additions are additive** (`source`, `client_tag` on `Message`; `client_tag` on the two send tools) — no existing field renamed or removed. New tool + new schema fields = MINOR per the versioning policy.
  - **Reliable echo via final-id resolution** (second multis ask). The first cut matched read-backs by the `pendingMessageID` returned at send time, but Beeper swaps that for the real bridge id on ack — so the id never matched and every match degraded to the fragile 15-minute text fallback. `send_message` / `note_to_self` now **resolve the pending id to the final bridge id** (GET `.../messages/{pendingMessageID}` until the id swaps, bounded + best-effort) and record **both** ids in the ledger, so a read-back matches by **exact id** whether or not the swap happened. The content fallback survives only as a last-ditch net **and only for sends whose final id could not be resolved** — once a send is resolved, its text fallback is retired, so a human re-typing identical text is no longer mis-tagged as the agent's own and dropped. Lets a consumer drop its own send-echo bookkeeping. Tunable via `BEEPERBOX_RESOLVE_RETRIES` (default 4) / `BEEPERBOX_RESOLVE_DELAY_MS` (default 250) / `BEEPERBOX_RESOLVE_TIMEOUT_MS` (default 3000, per-attempt fetch timeout so a hung API can't stall a send); set retries to 0 to disable resolution. Worst-case added send latency is bounded at `retries × (timeout + delay)`.
    - **Additive return fields** on `send_message` / `note_to_self`: `pending_message_id` (the raw pending id) and `resolved` (bool); `message_id` is now the final bridge id when `resolved: true`, else the pending id. No field removed.
  - **Honest limitation (documented loudly):** the `source` match is **unverified against a live Beeper account** (CI has none — the standing gate limitation). The exact-id resolution depends on Beeper's live id/ack behavior (the `pendingMessageID` → final-id swap was proven against a real account by multis but is not exercised in CI); validate against your own account before relying on it for a high-stakes auto-responder.
- **New env var `BEEPERBOX_SENT_LEDGER`** (default `/root/.config/beeperbox-sent-ledger.json`, inside the persisted config volume) — the echo-guard ledger path. Best-effort: a failed write degrades the guard to in-memory for that run and warns once to stderr; it never fails a send.
- **Input bounds on the new caller-supplied fields** (from a `/security` pass on the diff): the opaque `cursor`'s `ids` array is capped at 4096 on decode — rejected as malformed beyond that (a real cursor only holds the ids sharing one millisecond, so this never rejects a server-issued cursor) — closing an O(n)-per-message CPU-amplification path; and `client_tag` is truncated to 256 chars before it enters the ledger, closing a ledger-bloat path. Both are exercised by unit tests that fail without the cap.

### Tests
- **`mcp/server.test.js`** — `node --test` unit suite over the pure cursor/dedup/echo-guard logic (encode/decode round-trip, strict-after filtering, same-millisecond id dedup, cursor advance, a full seed→poll→restart-resume walk, the `source` matcher's id/content/window/cross-chat cases, and a real-temp-file ledger persistence round-trip). No live Beeper needed — this is the half of the feature that *is* deterministically testable, and it covers exactly the bug-class. Wired into `mcp-test.yml` as a fast `unit` job; `poll_messages` added to the guard-check + smoke-test tool-contract assertions.
  - **Final-id resolution cases** (26 tests now): a read-back tagged by its resolved bridge id; the key acceptance test that **a human re-typing identical text after a resolved send stays `external`** (the bug the resolution fixes); two identical-text sends each matched by their own resolved id; an unresolved entry still caught by the text fallback (safety net preserved); and an `addResolvedId` persist/reload round-trip. The decision logic was POC-validated against the prior matcher to confirm the old behavior mis-tags the human (the test can fail), and the entrypoint supervisor's `API_WAS_UP` gate was POC-simulated across the never-logged-in / half-dead / process-death scenarios.

### Documentation
- **Made the raw `/v1/` contract explicit** (`beeperbox.context.md`, `docs/GUIDE.md`) so direct-API consumers match the MCP layer instead of re-discovering its quirks: the `?limit=N` ~25-item *floor* (it's a lower bound — over-fetch then slice), the client-side cursor-enumeration recipe `poll_messages` implements (no server-side `since=`), and the canonical field heuristics (note-to-self = `participants.total === 1 && items[0].isSelf`; network via `accountID` → `/v1/accounts`; group = `type === 'group'`; `pendingMessageID` is not a stable delivered id).
- `poll_messages`, the `source`/`client_tag` schema fields, and a worked poll-loop pattern documented across `beeperbox.context.md`, `docs/GUIDE.md`, and `docs/PRD.md`.

### Documentation
- **README — added a shared "The bare ecosystem" section** (Core / Optional-reach list covering all six modules: `bareagent` · `bareguard` · `litectx`, plus `barebrowse` · `baremobile` · `beeperbox`). beeperbox sits under optional reach as the messaging member. The same section now ships across all six repos. Docs only — no container/runtime change.

### Fixed — `docker restart` no longer segfaults the display `[PATCH]`
- **`docker restart` reliably wedged the container with a stale Xvfb lock.** `docker restart` re-runs the entrypoint but preserves the container's writable layer, so Xvfb's `/tmp/.X99-lock` from the previous boot survived into the new process. Xvfb then saw display `:99` as "already active", half-initialized it, and **segfaulted** (`(EE) Server is already active for display 99`) — the backend never bound `127.0.0.1:23373`, socat looped on connection-refused, and the container sat stuck in `health: starting`. Only a full `docker compose down && up` (which discards `/tmp`) recovered. The entrypoint now removes the stale `/tmp/.X99-lock` and `/tmp/.X11-unix/X99` before starting Xvfb, so `docker restart` — the natural operation after any config change — is survivable. No runtime-contract change (MCP tools, HTTP API, schemas, ports bit-identical); PATCH per the versioning policy.

### Added — beepertexts is now supervised (no more silent half-dead container) `[MINOR]`
- **The entrypoint supervises Beeper Desktop instead of launching it unattended.** Previously beepertexts was started once with `&`: if its API/renderer process crashed while the Electron launcher lingered, the container looked "up" and the MCP layer (`:23375`) kept answering, but every tool call failed with `-32603 fetch failed` because the API (`:23373`) was gone — a half-dead container that never self-healed. The entrypoint now runs a supervision loop that **relaunches beepertexts if the process dies, and recycles it if the API stays down after having been up** (watching both the PID and `:23373/v1/spec`, since the launcher can outlive its crashed children).
  - **First-run login is protected by an `API_WAS_UP` gate.** Until the user enables "Start API on launch", the API is down *by design*, so the loop only ever recycles-for-API-down once the API has come up at least once this run — a never-logged-in container just runs Beeper steadily and waits for the human (the prior behavior). Clean `docker stop` shutdown (SIGTERM → flush → exit) is preserved.
  - **Tunable / reversible:** `BEEPERBOX_SUPERVISE` (default `1`; set `0` for the old forward-signal-and-wait behavior), `BEEPERBOX_SUPERVISE_INTERVAL` (default `10`s), `BEEPERBOX_SUPERVISE_API_GRACE` (default `6` checks ≈ 60s of API-down before recycle). The Docker `HEALTHCHECK` already probes the API through the socat path, so a genuinely dead backend still marks the container unhealthy; supervision adds the *recovery* the healthcheck alone can't provide.

## [0.5.1] — 2026-05-25 `[PATCH]`

Release-pipeline hardening and documentation. PATCH per the versioning policy — these change how releases are *built and described*, not what the running container does: the MCP tool surface, raw/HTTP API, `Chat`/`Message` schemas, and default ports are bit-identical to v0.5.0, and no client-code edits are required. The headline is that the release path is now **gated on the guard tests** with a `:previous` rollback tag, so a broken upstream Beeper can no longer silently become `:latest`.

### CI / release
- **Releases are now gated on the guard tests.** The publish path (tag push, weekly cron, manual dispatch) builds the image, runs the MCP guard matrix (`scripts/mcp-guard-check.sh`) and the VNC auth probe (`scripts/vnc-auth-check.sh`) against it, and **only pushes `:latest`/semver tags if they pass**. Closes the gap where the weekly rebuild could publish an untested `:latest` — e.g. if an auto-pulled newer Beeper broke startup. On failure the publish is skipped (previous `:latest` stays live as last-known-good) and the run is flagged in its summary.
- **Rolling known-good fallback.** Each successful publish first rolls the current `:latest` to `:previous` (a server-side manifest copy, no rebuild). If a future `:latest` ever misbehaves, `BEEPERBOX_IMAGE_TAG=previous docker compose up -d` drops back to the prior image without needing to know the version number. For a bit-exact pin, use the image **digest** (`@sha256:…`) — semver tags are rebuilt by the weekly cron and are not immutable while they're the newest release.
- **Shared test scripts** (`scripts/mcp-guard-check.sh`, `scripts/vnc-auth-check.sh`) are now the single source of truth for both the PR workflows (`mcp-test`, `vnc-test`) and the release gate, so "what the PR tests" and "what blocks a release" can't drift. The release gate sources these scripts from the latest workflow ref (not the release tag being rebuilt), so the weekly rebuild of an older tag that predates them still runs the current black-box checks against the freshly built image.
- **Known limitation (unchanged):** the gate runs the MCP server standalone (no live Beeper account), so it catches build/startup/guard regressions but **not** Beeper API-shape drift breaking the normalizers. `:previous` is the safety net for that case. `:edge` (master pushes) stays ungated by design.

### Docs
- **Added `docs/PRD.md` — the comprehensive product grounding doc.** Promoted from the prior hardening-only PRD into a full product spec covering purpose, what beeperbox is and explicitly is *not* (non-goals: single-network bots, laptop humans, multi-tenancy, typed SDKs, npm, streaming, in-place auto-update), target users, architecture, the raw-API + 10-tool MCP surface, the security model, the distribution/release model, versioning, release history, roadmap, and known limitations — all grounded in the CHANGELOG and commit history. This is now the reference for what changes are in-scope.
- **Removed `docs/PRD-mcp-http-hardening.md`** — folded into `docs/PRD.md` (§7 security model, §8 release model). The hardening detail is preserved; it's no longer a separate feature spec.
- Clarified in `docs/PRD.md` §6.2 that the `docker exec -i beeperbox …` stdio example uses the *default* container name (`BEEPERBOX_CONTAINER_NAME`-overridable for multi-instance hosts).

## [0.5.0] — 2026-05-24 `[MINOR]`

Security-hardening release — the full audit punchlist (3 HIGH plus the actionable MEDIUM/LOW) closed out. All new behavior is opt-in and backward compatible, with **one exception called out per the versioning policy**: the MCP HTTP transport now validates the `Host`/`Origin` header on every request against a loopback allowlist (the DNS-rebinding defense). Clients reaching `:23375` via `127.0.0.1`/`localhost` — i.e. the published-port default — are unaffected; anyone fronting it with a custom hostname (a reverse proxy) must now set `MCP_ALLOWED_HOSTS`. The MCP tool surface, `Chat`/`Message` schemas, and default ports are unchanged — no client-code edits required otherwise.

### Security
- **MCP HTTP transport gains optional bearer auth + always-on DNS-rebinding protection.** The HTTP transport on `:23375` previously executed any well-formed JSON-RPC request from anyone who could reach the port, with the user's `BEEPER_TOKEN` — the only thing standing between a caller and read/send across every connected network was the `127.0.0.1:` publish in `docker-compose.yml`. Two guards now run on every HTTP request (stdio transport is local-only and unaffected):
  - **`Origin` / `Host` validation** (always on). A `Host` header outside the allowlist (`localhost`, `127.0.0.1`, `::1`, `[::1]` by default) is rejected `403` — this is the DNS-rebinding defense, since a rebound browser request carries the attacker's domain as `Host`. A cross-origin browser request (any `Origin` outside the allowlist) is likewise rejected `403`. Native clients (curl, MCP runtimes) send no `Origin` and a loopback `Host`, so they are unaffected. Set `MCP_ALLOWED_HOSTS` (comma-separated) when terminating a reverse proxy in front.
  - **Bearer token** (opt-in). Set `MCP_AUTH_TOKEN` and every HTTP request must carry `Authorization: Bearer <token>` or get `401`. Left unset, the transport stays open for back-compat and relies on the loopback publish.
  - **Why the listener still binds `0.0.0.0`:** Docker published ports DNAT to the container's interface — a process bound to `127.0.0.1` *inside* the container is unreachable through `127.0.0.1:23375:23375`. Binding loopback would silently break MCP access, so the bind is deliberately unchanged; auth + Host/Origin checks are the defense, not the bind address. (An earlier proposed "default to loopback bind" fix was rejected after empirically confirming it breaks the published port.)
- **Request body cap on the MCP HTTP transport.** A POST body now aborts with `413` once it exceeds `MCP_MAX_BODY` bytes (default 1 MiB) instead of buffering unbounded into memory — closes a trivial memory-exhaustion vector (a 12 MB body previously returned `200` after fully buffering).
- **noVNC/x11vnc gains an optional password.** Set `VNC_PASSWORD` and x11vnc serves RFB security type *VNC authentication* (2) instead of *None* (1), so the noVNC session on `:6080` requires the password before granting control of the Beeper Desktop GUI (and the API token reachable from it). Left unset, the prior password-less behavior is kept — safe only while `:6080` stays loopback-only, the documented compose default. Mirrors the opt-in `MCP_AUTH_TOKEN` pattern.
- **Container privilege-escalation hardening.** `docker-compose.yml` now sets `security_opt: [no-new-privileges:true]`. Beeper Desktop runs as root with `--no-sandbox`, so blocking setuid escalation shrinks the blast radius of a renderer compromise. Verified the full stack (Xvfb, openbox, x11vnc, noVNC, socat, MCP) still boots under the flag. A full non-root + Chromium-sandbox rebuild was considered and rejected as too fragile for a single-tenant container that already trusts Beeper Desktop.
- **Reproducible / verifiable image builds (opt-in).** New `BEEPER_VERSION` and `BEEPER_SHA256` build args pin an exact Beeper AppImage and fail the build on hash mismatch. The default (both unset) keeps the rolling "stable" URL so the image **auto-updates** to the latest Beeper — the weekly cron rebuild depends on this and remains the default. Beeper publishes no independent signature/checksum, so the rolling path is TLS-authenticated only; pinning is the path for builds that need integrity guarantees.

### Added
- Three MCP HTTP transport env vars, all optional and back-compat (unset = prior behavior): `MCP_AUTH_TOKEN` (require a bearer token), `MCP_ALLOWED_HOSTS` (Host/Origin allowlist for reverse-proxy deployments), `MCP_MAX_BODY` (request body cap in bytes). Plumbed through `docker-compose.yml`. Startup banner now prints the auth posture (`OPEN` vs `required`) and the active allowed-hosts list.
- `VNC_PASSWORD` env var (optional, back-compat) to require a password on the noVNC/VNC connection; plumbed through `docker-compose.yml`. The entrypoint prints whether VNC auth is `required` or `OPEN` at startup.
- `BEEPER_VERSION` / `BEEPER_SHA256` Docker build args for pinned, hash-verified, reproducible image builds (default unset = rolling auto-update).

### Verified
- Validated against the running server (`node mcp/server.js`) with a live curl matrix, before/after: unauthenticated `tools/list` → served the full registry **before**, now still `200` when no token is set (back-compat / smoke-test path preserved); `Origin: https://evil.example` → `403`; `Host: evil.example` → `403`; `Origin: http://localhost:3000` → `200`; 12 MB body → `413` (was `200`); with `MCP_AUTH_TOKEN` set, missing/wrong token → `401`, correct token → `200`. Empty `MCP_ALLOWED_HOSTS` (as Compose passes when unset) correctly falls back to the loopback default.
- **CI coverage added.** `.github/workflows/mcp-test.yml` builds the real image, runs the MCP server standalone (no Beeper login needed), and replays the guard matrix (tool contract + `200`/`403`/`413`/`401`); runs on `workflow_dispatch` and PRs touching `mcp/**`, `Dockerfile`, `entrypoint.sh`, or `docker-compose.yml` — passing on GitHub Actions. `.github/workflows/vnc-test.yml` boots Xvfb + x11vnc and probes the RFB handshake to assert `VNC_PASSWORD` unset → security type None (1) and set → VNC auth (2), not None; runs on `workflow_dispatch` and PRs touching `entrypoint.sh`. Both also validated locally in a `debian:12-slim` container (the image base) before landing.
- **Supply-chain hardening verified:** the pinned-URL pattern resolves for both arches (`Beeper-<ver>-x86_64/arm64.AppImage`, HTTP 200), `sha256sum -c` aborts the build on a wrong hash, and the rolling default URL is unchanged. `no-new-privileges` confirmed applied and non-breaking by booting the published image with the flag.

### Security review: closed
All HIGH findings (H1 auth, H2 DNS-rebind/Origin, H3 VNC password) and the actionable MEDIUM/LOW items are resolved. Accepted-by-design residuals, documented here so they're auditable rather than forgotten:
- The default (auto-updating) AppImage download is TLS-authenticated only — Beeper publishes no independent signature; use `BEEPER_VERSION` + `BEEPER_SHA256` for a verified pinned build.
- In-container listeners bind `0.0.0.0` because Docker published ports require it; auth + Host/Origin validation + the loopback publish are the defense, not the bind address.
- The `-32001` error passes the upstream Beeper body verbatim by design, to help the agent self-correct (the consumer is the agent, not a browser; the token is never echoed).

## [0.4.0] — 2026-05-18 `[MINOR]`

Bug-fix-heavy release. Tagged MINOR rather than PATCH because two of the fixes change observable runtime behavior an agent may key off of: `note_to_self` now picks a deterministically different chat for some accounts (no longer the first single-self chat), and the entrypoint now propagates SIGTERM so containers exit cleanly under `docker stop`. The MCP tool surface, HTTP endpoints, default ports, and `Chat`/`Message` schemas are unchanged — no client-code edits required.

### Fixed
- **`note_to_self` no longer leaks onto third-party networks.** The resolver previously matched the first chat with `participants.total === 1 && isSelf === true`, which also catches each platform's saved-messages chat (Telegram "Saved Messages", WhatsApp "Send to yourself", etc.) — if any of those were more recently active than Beeper-native Note to self, agent self-notes would post there instead. Resolver now requires the chat to live on the Beeper-native matrix account and only falls back to a non-matrix single-self chat when no matrix one exists. Inbox-side `is_note_to_self` filtering is unchanged.
- **Clean shutdown on `docker stop`.** Entrypoint now traps SIGTERM/SIGINT and forwards to Beeper Desktop, then re-waits in a loop until the child is fully reaped. Previously bash's `wait` returned early on signal delivery and the container exited before Beeper finished its matrix sync flush / sqlite checkpoint, risking partial writes to `beeperbox_config`. Verified empirically — without the trap, child processes survive parent SIGTERM as orphans.

### Changed
- **Smoke test now probes the MCP server.** `scripts/smoke-test.sh` adds a 5th step that POSTs `tools/list` to `:23375` and walks `result.tools[*].name` via a Python JSON parse, asserting the full set of 10 expected tool names is present. Earlier substring `grep` would have false-positived if a tool was renamed but its old name still appeared in another tool's description — verified by a negative test.
- **JSON-RPC notification compliance.** A notification (no `id`) with a malformed `jsonrpc` field used to receive an error response; now correctly returns no response per the spec. Pure compliance cleanup — no client behavior change expected.
- **`note_to_self` fallback is now loud.** If no Beeper-native matrix single-self chat exists and the resolver has to fall back to a non-matrix single-self chat (third-party saved-messages chat), it writes a warning to stderr instead of silently routing self-notes off-platform. Validated against a mock where only a Telegram saved-messages chat exists — fallback now logs `note_to_self: no Beeper-native matrix chat found; falling back to non-matrix single-self chat …`.

### Docs
- **`docs/GUIDE.md` caveats updated.** Removed stale claims that beeperbox is "POC v0.1.0" and "not multi-arch yet" (current line is v0.4.x; `linux/amd64` and `linux/arm64` have been published since v0.3.0). The Limits section now references the [CHANGELOG](../CHANGELOG.md) versioning policy directly.
- `README.md` version-pin example bumped to `BEEPERBOX_IMAGE_TAG=0.4.0`.
- `beeperbox.context.md` version header, "v0.x.x is a POC" line, and version-compatibility table updated to v0.4.0.

### Dropped paths
- ~~Typed Node client (`@beeperbox/node`)~~ — MCP is the language-agnostic consumption layer; a Node SDK would duplicate that for a small non-agent audience that can already `fetch()` the raw API in ~5 lines. Revisit if someone files an issue.
- ~~Python client (`beeperbox` on PyPI)~~ — same reason.
- ~~Multi-tenant per-request token forwarding~~ — architecturally impossible: Beeper Desktop logs in as one user at a time. Run one container per account (documented in GUIDE as of v0.2.1).
- ~~Standalone npm package (`beeperbox-mcp`)~~ — beeperbox ships as a Docker image; `mcp/server.js` is the container's MCP interface at `/opt/mcp/server.js`. Republishing as an npm wrapper duplicates the distribution channel without serving a real audience (the README's target user runs the container, not a host-side npm wrapper). Reverted from master at `670f8c9`.

## [0.3.3] — 2026-05-13 `[PATCH]`

Two bugfixes for first-time installs, both reported in [#1](https://github.com/hamr0/beeperbox/issues/1) by [@ccailly](https://github.com/ccailly). No runtime-contract change — MCP tool surface, HTTP endpoints, ports, and schemas are bit-identical to v0.3.2; this is PATCH by the policy above.

### Fixed
- **Black VNC screen on first boot.** Recent Beeper Desktop builds bail in their crash-reporter init when the GPU process is disabled, leaving Xvfb stuck on the openbox background. Dropped `--disable-gpu` from the Beeper launch flags and added `libgl1-mesa-dri` to the image so Electron has a software GL driver to fall back to. The container still has no real GPU — Mesa's `swrast` software rasterizer handles GL; the only thing that changed is that Beeper's GPU process no longer aborts the renderer.
- **API unreachable from outside the container.** The socat forwarder dialed `[::1]:23373` over IPv6, which silently dropped traffic on hosts (or container runtimes) where the v6 loopback isn't routable — the `0.0.0.0:23380` listener accepted connections but the forwarder could never complete the upstream leg, so `curl http://localhost:23373/v1/info` from the host hung or reset. Switched both the socat forwarder and the MCP server's default `BEEPER_API` to IPv4 `127.0.0.1:23373`. Beeper Desktop's API listens on both loopback families, so IPv4 is the more portable target.

### Changed
- `docs/GUIDE.md` troubleshooting probe (`docker exec beeperbox curl -sf http://[::1]:23373/v1/info ...`) updated to use `127.0.0.1` to match the new forwarder target and to work on hosts with IPv6 disabled.
- `docs/GUIDE.md` "Desktop API binds to `[::1]:23373`" caveat in *Limits* rephrased — the binding is loopback-only, and our forwarder targets it via IPv4 for portability.
- `beeperbox.context.md` version header bumped to v0.3.3 and the version-compatibility table extended.

### Verified
- Local amd64 build from a clean cache produces a healthy container in ~15s; `curl http://localhost:23380/v1/info` from inside the container and `curl http://localhost:23373/v1/info` from the host both return 200.
- noVNC at `http://localhost:6080/vnc.html` now renders the Beeper Desktop login on first boot instead of a black canvas.

## [0.3.2] — 2026-04-14 `[PATCH]`

Packaging and release-workflow changes only. The running container is bit-identical to v0.3.1; this bump is PATCH by the policy above (no runtime contract changes).

### Changed
- Default consumption is now **pull a pre-built image from GHCR**, not clone-and-build. `docker-compose.yml` references `ghcr.io/hamr0/beeperbox:${BEEPERBOX_IMAGE_TAG:-latest}` so `curl -LO .../docker-compose.yml && docker compose up -d` is all a user needs — no clone, no multi-minute Beeper AppImage download on every host. Pin to `:0.3.2`, `:0.3`, or `:0` for reproducibility; `:latest` tracks the newest release; `:edge` tracks master and may break. A new `docker-compose.dev.yml` overlay restores `build: .` for developers and air-gapped setups (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`).
- `.github/workflows/release.yml` extended from "tag push only" to three triggers: (1) tag push publishes the semver tags + `:latest` as before; (2) push to master publishes `:edge`; (3) weekly cron (Mon 06 UTC) resolves the newest `v*.*.*` tag via `git ls-remote`, checks out that ref, and re-pushes all the released tags — so the bundled Beeper AppImage stays current on `:latest` without requiring a code release. Release metadata now also emits the major-only tag (`:0`) alongside `:X.Y.Z` and `:X.Y`.
- `beeperbox.context.md` bareagent integration section updated to match the v0.6.1 `createMCPBridge` API (replaces the older `discoverMcpServers` shape): discovery reads `.mcp.json` from the project root, tool names are namespaced `beeperbox_*`, and `.mcp-bridge.json` is auto-generated on first run with every tool set to `allow` — users edit it to `deny` what they don't want.
- README rewritten: removed internal architecture diagram, socat/noVNC implementation notes, persistent-data section, and verbose caveats — all of that moved to (or already lived in) `docs/GUIDE.md`. README now leads with a sharper "When to use and when not to" positioning: **if you only need Telegram, don't use this** (use a Telegram-first framework like openclaw); **if you need reach across 50+ messengers through one container, this is for you**. Status line bumped to v0.3.1, stale `:23374` example refs removed where they were presented as the default (the real default is `:23373`; `:23374` is only documented as the override for dev hosts that already run native Beeper Desktop). Roadmap trimmed: typed Node and Python clients dropped as next-in-line items with an honest explanation — MCP already covers language-agnostic consumption, and non-agent HTTP clients can hit the raw API in ~5 lines of vanilla `fetch` / `urllib` without an SDK. Revisit only if someone files an issue.
- `docs/GUIDE.md` MCP tools reference stub that still said "currently list_inbox, more coming in v0.2.0+" updated to list all 10 live tools.
- `beeperbox.context.md` version header bumped from v0.2.0 to v0.3.1 with the architectures column explicit.
- `.gitignore` extended to cover editor swap files (`.*.kate-swp`, `.*.swp`, `.*.swo`, `*~`) and scoped `.env.*` files so multi-instance deployment env files don't accidentally land in git.

## [0.3.1] — 2026-04-13 `[PATCH]`

Fixes the v0.3.0 arm64 cross-build failure. No user-visible behavior change beyond "the arm64 variant now actually builds and publishes".

### Fixed
- Dockerfile no longer runs the Beeper AppImage's launcher (`./file --appimage-extract`) to self-extract. Instead, it finds the embedded squashfs offset and extracts it directly with `unsquashfs -o <offset>`. Type 2 AppImages run their launcher stub as a real ELF binary, and that exec doesn't work cleanly under QEMU user-mode emulation during `docker buildx` cross-arch builds — v0.3.0's arm64 stage failed with `Exec format error` even on GitHub Actions runners, not just on the Fedora dev host.
- The squashfs magic `hsqs` occurs naturally inside the AppImage's ELF code/data too, so the first grep match is often a false positive. The Dockerfile now iterates every candidate offset and picks the first one where `unsquashfs -s` can read a valid superblock.
- Added `squashfs-tools` to the apt install list.

### Verified
- Native amd64 build succeeds via `docker compose build` with the new extraction path; container boots healthy in ~15s; both the raw Beeper API (`/v1/info`) and the MCP server (`tools/list`) return 200.
- Local amd64 test was the minimum sanity check; the arm64 cross-build happens on GHCR via the release workflow as part of this tag push. Previous v0.3.0 release failed at the `--appimage-extract` step during the arm64 stage; this fix removes the AppImage launcher from the build entirely.

## [0.3.0] — 2026-04-13 `[MINOR]`

**Superseded by v0.3.1 due to a cross-build arm64 failure — do not pull `ghcr.io/hamr0/beeperbox:0.3.0`; use `0.3.1` or `latest`.**

New architecture support (`linux/arm64`) is a runtime capability add — MINOR per the versioning policy. Multi-arch image. `ghcr.io/hamr0/beeperbox:0.3.0` and `:latest` are now published as a multi-platform manifest containing both `linux/amd64` and `linux/arm64`, so Raspberry Pi 4/5, Oracle Cloud's free ARM tier, Hetzner CAX-series ARM VPSes, AWS Graviton, and Apple Silicon Macs can pull the native-arch variant automatically with no code changes.

### Added
- `Dockerfile` reads the `TARGETARCH` buildx arg and selects the matching Beeper Desktop AppImage from Beeper's CDN: `TARGETARCH=amd64` → `linux/x64/stable`, `TARGETARCH=arm64` → `linux/arm64/stable`. Both URLs verified live against `api.beeper.com` (HTTP 302 → Beeper-4.2.715-x86_64.AppImage / Beeper-4.2.715-arm64.AppImage). Unknown `TARGETARCH` values fail the build with a clear error message.
- `.github/workflows/release.yml` gains `docker/setup-qemu-action@v3` (with `platforms: linux/amd64,linux/arm64`) and passes `platforms: linux/amd64,linux/arm64` to the `docker/build-push-action` step. Build cache is reused across both platforms via the existing GHA cache backend. GHCR receives a single multi-arch manifest per tag.
- Documentation: new "Architectures" row in the version-compatibility section (GUIDE + context file) noting that `docker pull ghcr.io/hamr0/beeperbox:latest` now works on both amd64 and arm64 hosts automatically.

### Changed
- Image tags `0.3.0`, `0.3`, `0`, and `latest` on GHCR are now multi-arch. Hosts pull the variant matching their CPU architecture with no flags needed. Users who need to force a specific variant can pass `--platform linux/arm64` to `docker pull`.

### Verified
- Local amd64 build via `docker buildx build --platform linux/amd64 --load` completes successfully with the new TARGETARCH switch — proves the Dockerfile change doesn't break the native path for existing users.
- arm64 local build was attempted but blocked by this host's missing `qemu-user-static` package (Fedora default). The real arm64 validation happens in the GHCR release workflow on GitHub Actions runners, which include QEMU by default via `setup-qemu-action@v3`.
- Beeper Desktop's download CDN confirmed to serve a native `ELF 64-bit LSB executable, ARM aarch64` at the arm64 URL (218MB), so the Dockerfile just needs to hit the right URL per architecture.

### Known limitations
- No `linux/arm/v7` (32-bit ARM) — Beeper does not publish a 32-bit ARM AppImage, so Raspberry Pi 2/3 and 32-bit Pi 4 OS installs are not supported. Install Raspberry Pi OS 64-bit on those devices.
- Image size on disk is still ~1.9GB per architecture; the multi-arch manifest doesn't reduce per-platform footprint, it just picks the right one for your host.

## [0.2.1] — 2026-04-13 `[PATCH]`

Docs-only release. No code changes, no image rebuild strictly required (the v0.2.0 image still works), but the GHCR workflow republishes on tag push.

### Added
- `docs/GUIDE.md` gains a "Read-only vs read-write tokens" subsection under "Create an access token" explaining how Beeper Desktop's "Allow sensitive actions" toggle gates write operations at token creation time. Read-only tokens can call the 6 read tools (`list_inbox`, `list_unread`, `read_chat`, `get_chat`, `search_messages`, `list_accounts`); write tools (`send_message`, `note_to_self`, `react_to_message`, `archive_chat`) return `401 Unauthorized`. No beeperbox code needed — scope is enforced inside Beeper Desktop itself.
- `docs/GUIDE.md` gains a new top-level "Running multiple instances on one VPS" section with the `docker compose -p <project> --env-file .env.<n>` pattern, per-instance env-override examples for three customers, a density table (Oracle Cloud free tier fits 20+, Hetzner CAX21 fits 6-8, etc.), orchestration notes (manual for 2-3, shell script for 5+, Swarm/k8s for 20+), and an explicit "why multi-tenant-in-one-container is not a feature" explanation.
- `beeperbox.context.md` gains matching shorter sections: read-only vs read-write token table, multi-tenancy explanation, density rule of thumb.

### Changed
- v0.2.0 CHANGELOG security note corrected — removed the misleading claim that "multi-tenant per-request token forwarding is a v0.3 item". That feature is dropped entirely; the honest architectural answer is "run one container per Beeper account".

## [0.2.0] — 2026-04-13 `[MINOR]`

First release with an opinionated Model Context Protocol server inside the container — 10 new runtime tools and a new transport. MINOR per the versioning policy. (Also changed the default host port from `23374` to `23373`, which is technically a breaking change; acceptable under semver §4 while `MAJOR == 0` but called out here for the record.) beeperbox is now consumable by any AI agent runtime that speaks MCP (Claude Code, Cursor, Cline, Continue, bareagent, etc.) over either HTTP or stdio transport — the LLM sees 10 semantic tools for multi-messenger operations and never has to touch raw Beeper Desktop API endpoints.

### Added

**MCP server**
- Opinionated MCP server inside the container, vanilla Node, zero npm deps, single-file `mcp/server.js` (~400 lines). Wraps Beeper Desktop's raw `/v1/*` HTTP API with 10 semantic tools, 2 normalized schemas (`Chat` and `Message`), and a note-to-self vs inbox split so agents never accidentally pollute customer conversations with command-channel messages.
- **Two transports, interchangeable**, both in the same process, picked at startup via `--stdio` argv flag:
  - **HTTP** (default, always-on): JSON-RPC 2.0 over POST on `127.0.0.1:23375` (env-overridable via `BEEPERBOX_MCP_PORT`). Started by the entrypoint. Use case: remote agents, multi-tenant SaaS, cross-container setups, cloud-hosted agent runtimes.
  - **stdio** (on demand): newline-delimited JSON-RPC over stdin/stdout. Stdout reserved for the protocol; all logging goes to stderr. Invoked via `docker exec -i beeperbox node /opt/mcp/server.js --stdio`. Use case: Claude Code, Cursor, Cline, bareagent, or any MCP client that spawns the server as a local subprocess.

**10 tools** (all verified end-to-end against a live Beeper account during development, one commit per tool for clean rollback):
- `list_accounts` — discover which messaging platforms are connected (returns `network` slug + `network_label` human name per account)
- `list_inbox` — top recently active chats, note-to-self filtered out
- `list_unread` — same as list_inbox but only chats where `unread_count > 0`
- `get_chat` — fetch one chat by ID, same `Chat` schema as list_inbox
- `read_chat` — last N messages from a chat, oldest-first within the page, each message carries `chat_id` + `network` + `network_label` for grounding
- `search_messages` — full-text across all chats; Beeper's response includes a `chats` map so hits resolve their network metadata in one round-trip, no N+1 fetches
- `send_message` — send text to a chat by ID, optional `reply_to_message_id`, returns Beeper's `pendingMessageID`
- `note_to_self` — send to the bot's own note-to-self chat with **auto-resolved chat ID**; the dedicated command/control channel for the agent, cached after first lookup, excluded from inbox views
- `react_to_message` — add an emoji reaction (unicode, shortcode, or custom key)
- `archive_chat` — archive or unarchive a chat; substituted for `mark_as_read` because Beeper Desktop does not expose a mark-as-read endpoint (the description explicitly tells the LLM this and names archive as the closest primitive for the "I am done with this conversation" pattern)

**Normalized schemas** — two shapes the LLM learns once and reuses everywhere:

```
Chat:     { id, title, network, network_label, is_group, is_note_to_self, last_message_at, unread_count }
Message:  { id, chat_id, network, network_label, sender{id, name, is_self}, text, type, timestamp, reply_to }
```

- Every chat and every message carries both `network` (machine slug: `whatsapp`, `telegram`, `discord`, etc.) and `network_label` (human: `"WhatsApp"`, `"Telegram"`, `"Discord"`, etc.)
- Network normalization driven by `/v1/accounts` (which already returns clean human-readable names); chat bridge IDs are parsed as a fallback
- `NETWORK_SLUGS` lookup table maps Beeper's display names to clean lowercase slugs: `whatsapp`, `imessage`, `telegram`, `signal`, `discord`, `slack`, `instagram`, `facebook`, `linkedin`, `gmessages`, `twitter`, `matrix`, `beeper`. Unknown networks fall back to alphanumeric-stripped lowercase of the Beeper label.

**Infrastructure**
- `nodejs` added to the Dockerfile (~80MB image growth, 4% on top of the existing 1.91GB). Zero npm deps; the server uses Node's built-in `http`, `fetch`, `crypto`, and stdlib only. No `package.json`, no `node_modules`, no supply-chain surface.
- `BEEPER_TOKEN` env var plumbed through `docker-compose.yml`. Customers save the token to a `.env` file next to `docker-compose.yml` (gitignored), and `docker compose up -d` picks it up. Setup is one-time — token survives container rebuilds, restarts, and host reboots.
- New port published: `127.0.0.1:23375 → 23375` for the MCP HTTP transport, env-overridable via `BEEPERBOX_MCP_PORT`.

**Documentation**
- `docs/GUIDE.md` gains a new top-level "Quick setup (10 minutes, one-time)" section walking users linearly from `git clone` → noVNC login → enable API → create token → `.env` file → `docker compose up -d` → verify → test MCP.
- Full token-creation walkthrough covering the real Beeper Desktop UI path (Settings → Developers → Approved Connections → +), the "allow sensitive actions" + "expiry never" choices, the noVNC-clipboard-workaround (paste token into Note to self, copy on your phone), the `.env` file pattern, the `up -d` vs `restart` gotcha (compose only re-reads env on `up -d`), and a token-survival matrix.
- New "MCP tools reference" section with all 10 tools, their required parameters, and worked curl + Claude Code + bareagent configuration examples.
- Added facts for common footguns: (a) Beeper Desktop syncs the top ~20 most recently active chats by default — older chats need pinning or search; (b) you can pair beeperbox with a Beeper account already configured on your phone — bridge state lives on Beeper's servers, so existing WhatsApp/Signal/etc. bridges inherit automatically.
- New `## Ports` section explaining the env-override pattern, container-vs-host port namespace separation (why container internal ports never collide with host ports), and `docker port beeperbox` for confirming the running mapping.

### Changed
- `docker-compose.yml` host ports are env-overridable with sensible defaults: `BEEPERBOX_HOST_PORT` (default `23373`, the canonical Beeper port), `BEEPERBOX_NOVNC_PORT` (default `6080`), `BEEPERBOX_MCP_PORT` (default `23375`). Previously the API was hardcoded to `23374` because the original test environment had a native Beeper Desktop on `23373`. The new default works for the common case out of the box; dev machines that already run native Beeper just pass `BEEPERBOX_HOST_PORT=23374 docker compose up -d`. One file, one toggle, no spaghetti.
- README and `docs/GUIDE.md` audience statement tightened: beeperbox is for **autonomous agents that need messaging reach without a human at a Beeper Desktop**. Laptop users with Beeper Desktop installed locally already have Beeper's native HTTP API and MCP server — they are explicitly not the target audience and the docs say so. This sharpening is doc-only — no behavior change.

### Fixed
- Five real-Beeper-API field-shape bugs found by testing the normalizer against live data before committing the initial `list_inbox` implementation:
  - `?limit=N` is ignored by Beeper (returns ~25 minimum) → slice client-side after normalization
  - Network is NOT in the room ID → it lives in `chat.accountID` and maps to `/v1/accounts[].network`; cached on first use
  - `lastActivity` is camelCase, not `last_activity`
  - Group flag is `type === 'group'`, not `isGroup`
  - Note-to-self detection: `participants.total === 1 AND items[0].isSelf === true` (catches both Beeper-native Note to self and each platform's saved-messages chat like Telegram Saved Messages and WhatsApp Send to yourself)
- `send_message` v1 returned empty `message_id` — fixed to read Beeper's `pendingMessageID` field (verified against the OpenAPI `SendMessageOutput` schema) in v2 before commit.
- `beeperFetch` refactored to support `method + body` for POST/DELETE endpoints and to handle empty-body responses (archive returns 200 with no JSON body → return `null` instead of throwing on `r.json()`).
- Stdio transport's `process.exit(0)` on stdin close was eagerly killing pending async tool handlers — removed. The Node event loop now exits naturally once all in-flight `fetch()` calls settle.

### Security
- No changes since v0.1.0. Published ports remain bound to `127.0.0.1` only. The MCP server inherits the same Bearer-token auth model as the raw Beeper API via the `BEEPER_TOKEN` env var. Read-only vs read-write token scoping is available today via Beeper Desktop's own "Allow sensitive actions" toggle — no beeperbox-side flag needed; documented in GUIDE + context file in v0.2.1.

### Verified
- Every MCP tool tested end-to-end against live Beeper data across 4 real accounts (Matrix, Discord, LinkedIn, Telegram)
- Stdio transport: 3 concurrent in-flight requests (initialize + tools/list + tools/call list_accounts) all return correctly via `docker exec -i` pipeline
- HTTP transport: same 3 requests return correctly via `curl -X POST http://localhost:23375`
- Image rebuilds cleanly, container boots, all smoke-test steps pass

## [0.1.0] — 2026-04-13 `[MINOR]`

First working proof-of-concept. Initial release. Headless Beeper Desktop in a Debian 12 container, one-time browser login, persistent local HTTP API.

### Added
- `Dockerfile` on `debian:12-slim` with Xvfb, openbox, x11vnc, noVNC, websockify, socat, and all Beeper Desktop Electron runtime deps
- `entrypoint.sh` orchestrating virtual display → window manager → VNC → noVNC → Beeper Desktop → socat forwarder → API readiness check
- Beeper Desktop AppImage extraction at build time (avoids FUSE requirement at runtime)
- `socat` forwarder bridging Beeper's IPv6-loopback-only API (`[::1]:23373`) to `0.0.0.0:23380` so Docker port mapping can reach it
- `docker-compose.yml` with `restart: unless-stopped`, persistent volume for Beeper config, localhost-bound port mappings `127.0.0.1:6080` (noVNC) and `127.0.0.1:23374 → :23380` (API)
- Docker `HEALTHCHECK` directive probing `http://127.0.0.1:23380/v1/info` every 30s with a 90s start-period. Probe goes through the socat forwarder — same path external clients use — so both a crashed Beeper API and a crashed forwarder mark the container unhealthy. Orchestrators (compose, k8s, systemd) can now observe degraded containers; plain Docker needs an autoheal sidecar to auto-restart on unhealthy, Swarm/Kubernetes do it natively. Process-death recovery is already covered by `restart: unless-stopped` + the entrypoint's `wait $BEEPER_PID`.
- `README.md` with architecture diagram, quick-start, port table, and roadmap
- `docs/GUIDE.md`: long-form user guide covering install, first-run login, access token creation (manual + OAuth2 PKCE), API examples in curl / vanilla Node / vanilla Python, VPS deployment patterns (SSH tunnel, Tailscale, Caddy reverse proxy with TLS + basic auth), operating commands, upgrading, a troubleshooting tree for the common symptoms, the two-layer security model, and known limits
- `scripts/smoke-test.sh`: repeatable end-to-end check that builds the image, starts the container, waits for `(healthy)`, and asserts `/v1/info` reports `"status":"running"` — exits non-zero with a clear reason on any failure
- `.github/workflows/release.yml`: GitHub Actions workflow that builds the image on semver tag push (`v*.*.*`) and publishes to GHCR at `ghcr.io/<owner>/beeperbox:<version>` + `:latest`, with buildx layer caching
- `.dockerignore` excluding docs, `.git`, `.github`, `.claude`, and markdown so build contexts stay small
- `LICENSE` (MIT)

### Security
- Published ports bound explicitly to `127.0.0.1` instead of Docker's `0.0.0.0` default. Before this, on a VPS with a public IP both the API and noVNC UI were reachable from the open internet — the Bearer token was the only control on the API and noVNC had no auth at all, so anyone hitting `:6080` could take over Beeper Desktop. After this change, only processes on the same host can reach the ports. Remote access now requires a deliberate opt-in (SSH tunnel, Tailscale/Wireguard, or a TLS-terminating reverse proxy with auth in front) — all three are documented in `docs/GUIDE.md`.

### Verified
- Image builds clean on Fedora 43 + Docker CE 29.3.1
- Container boots Beeper Desktop headless, Matrix sync loop stable, WhatsApp bridge reachable
- Browser-based first-run login via `http://localhost:6080/vnc.html` works
- After enabling **Settings → Developers → Enable API + Start API on launch**, `curl http://localhost:23374/v1/info` returns the Beeper Desktop info payload
- Config volume persists login across container restarts
- Healthcheck transitions `starting → healthy` within the 90s start-period with `FailingStreak: 0`
- All three failure modes (API down, API error, forwarder down) produce non-zero curl exit codes and flip the healthcheck
- Localhost-only port binding: `curl localhost:23374 → 200`, `curl <LAN-IP>:23374 → connection refused`
- `scripts/smoke-test.sh` completes 4/4 checks against a fresh build

### Known limitations
- Image size ~1GB, idle RAM ~500MB (Electron + Chromium are the bulk; Alpine is not a drop-in replacement — musl breaks Chromium)
- Beeper API binds to `[::1]:23373` inside the container and is not configurable; socat workaround is required
- Some bridges (notably WhatsApp on-device) log harmless `no bridge event found` backup errors during initial sync — safe to ignore
- x86_64 only — arm64 multi-arch build is on the roadmap
- Single user per container — multiple Beeper accounts need multiple containers with separate volumes and ports
- No streaming subscriptions — the Beeper Desktop API is request/response; real-time updates require polling or the advanced MCP path

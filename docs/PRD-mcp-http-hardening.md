# PRD — MCP HTTP Transport Hardening

> Status: shipped in **v0.5.0** — all HIGH and actionable MEDIUM/LOW findings closed; CI-tested (`mcp-test`, `vnc-test`). Release pipeline hardened post-0.5.0 (CI-gated publish + `:previous` rollback, in `[Unreleased]`).
> Scope: `mcp/server.js`, `entrypoint.sh`, `Dockerfile`, `docker-compose.yml`, `scripts/{vnc-auth-probe,mcp-guard-check,vnc-auth-check}.sh`, CI workflows. No changes to the MCP tool surface, schemas, ports, or default behavior.

## Problem

The MCP HTTP transport on `:23375` executes any well-formed JSON-RPC request from anyone who can reach the port, using the container's `BEEPER_TOKEN`. The only control was the `127.0.0.1:` publish in `docker-compose.yml` — a single load-bearing layer that the compose comments themselves invite users to remove ("To expose publicly … drop the `127.0.0.1` prefix"). Three concrete weaknesses were confirmed empirically against the running server:

1. **No authentication (H1).** Unauthenticated `tools/list` returned the full registry; unauthenticated `tools/call` reached dispatch and only failed *inside* the handler at the upstream call — i.e., with a real token it would have read/sent across every connected network.
2. **No `Origin`/`Host` validation (H2).** A cross-origin browser request (`text/plain` body = no CORS preflight) was parsed and dispatched; a DNS-rebinding attack could then read responses. The server accepted any `Origin` and any `Host`.
3. **Unbounded request body (M1).** A 12 MB POST returned `200` after fully buffering into memory — a trivial memory-exhaustion vector.

## Goals

- Make the HTTP transport safe to expose beyond loopback **without** breaking the documented loopback-publish or reverse-proxy deployments.
- Close the browser-driven attack surface (DNS rebinding / cross-origin) **by default**, with no configuration required.
- Bound request memory.
- Zero breaking change: unset configuration ⇒ identical prior behavior; stdio transport untouched; `smoke-test.sh` still passes.

## Non-goals / explicitly rejected

- **Binding the listener to `127.0.0.1`.** Rejected after empirical confirmation that a process bound to loopback *inside* a container is unreachable through a Docker published port (`127.0.0.1:23375:23375` DNATs to the container interface). The bind stays `0.0.0.0`; auth + Host/Origin checks are the defense.
- **Binding the socat API forwarder to loopback.** Same Docker-publish constraint (`23380` is the published API port). No change.
- **VNC password (H3)** and **AppImage checksum pinning (M2)** — real findings, deferred (see Open items).

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | `MCP_AUTH_TOKEN` (optional): when set, every HTTP request must send `Authorization: Bearer <token>`; otherwise `401`. Unset ⇒ no auth enforced. |
| R2 | `Host` header validated against an allowlist on every request; non-match ⇒ `403`. (DNS-rebinding defense.) Always on. |
| R3 | `Origin` header, when present, validated against the same allowlist; non-match ⇒ `403`. Absent `Origin` (native clients) ⇒ allowed. |
| R4 | `MCP_ALLOWED_HOSTS` (optional, comma-separated) overrides the allowlist; default `localhost,127.0.0.1,::1,[::1]`. Empty string ⇒ default. |
| R5 | `MCP_MAX_BODY` (optional, bytes, default 1 MiB): request body exceeding the cap aborts `413` and the socket is destroyed; no double-response. |
| R6 | stdio transport unchanged; guards apply to HTTP only. |
| R7 | Env vars plumbed through `docker-compose.yml` (Compose only forwards listed vars into the container). |
| R8 | Startup banner reflects auth posture and active allowlist. |

## Acceptance criteria (verified locally, before/after)

| Case | Expected | Result |
|------|----------|--------|
| No token, plain localhost `tools/list` (smoke-test path) | `200` + registry | ✅ |
| `Origin: https://evil.example` | `403` | ✅ |
| `Host: evil.example` (DNS-rebind) | `403` | ✅ |
| `Origin: http://localhost:3000` | `200` | ✅ |
| 12 MB body | `413` (was `200`) | ✅ |
| `MCP_AUTH_TOKEN` set, no auth header | `401` | ✅ |
| `MCP_AUTH_TOKEN` set, wrong token | `401` | ✅ |
| `MCP_AUTH_TOKEN` set, correct token | `200` | ✅ |
| Empty `MCP_ALLOWED_HOSTS` env | falls back to loopback default | ✅ |

## Addendum — VNC authentication (H3)

The noVNC/x11vnc session on `:6080` granted full control of the Beeper Desktop GUI (and the API token reachable through it) with no password (`x11vnc … -nopw`).

- **R-VNC1:** `VNC_PASSWORD` (optional): when set, the entrypoint runs `x11vnc -storepasswd` and serves `-rfbauth` so the RFB connection requires VNC authentication; unset keeps `-nopw` (back-compat). Plumbed through `docker-compose.yml`; entrypoint prints `required`/`OPEN` at startup.
- **Acceptance (verified locally in `debian:12-slim` and in CI `vnc-test`):** with `VNC_PASSWORD` unset the server offers RFB security type **None (1)**; with it set it offers **VNC auth (2)** and **not** None. `bash -n entrypoint.sh` passes; a grep guard in `vnc-test.yml` fails if the `VNC_PASSWORD`/`-rfbauth`/`-nopw` wiring is removed (anti-drift).
- Listener/port behavior unchanged; this only changes the RFB security type offered.

## Addendum — supply chain (M2) & container hardening (L2, L3)

- **M2 — AppImage integrity.** Beeper publishes no independent signature/checksum (the download endpoint exposes only a multipart S3 etag), and TLS already covers transport MITM. Resolved as **opt-in reproducible pinning**: `BEEPER_VERSION` + `BEEPER_SHA256` build args fetch an exact versioned artifact and fail the build on hash mismatch. The default stays the rolling auto-update URL (a hard requirement — the weekly cron depends on it). Verified: pinned URLs resolve for both arches, `sha256sum -c` aborts on mismatch, default path unchanged, full default build green in CI `mcp-test`.
- **L2 — `--no-sandbox` + root.** Full non-root + Chromium-sandbox rebuild rejected as too fragile for a single-tenant container that trusts Beeper Desktop. Mitigated with `security_opt: [no-new-privileges:true]` in compose — verified the full stack still boots under the flag. `cap_drop` not added (risks breaking X/dbus/socat without a dedicated boot test).
- **L3 — exposure comment.** `docker-compose.yml` exposure note now directs users to set `MCP_AUTH_TOKEN` and `VNC_PASSWORD` before dropping the loopback prefix.
- **L1 — error body verbatim:** kept by design (`-32001` aids agent self-correction; consumer is the agent, token never echoed). Not a fix.

## Addendum — safe rolling releases (CI-gated publish + rollback)

Came out of the auto-update discussion (see the supply-chain addendum). The weekly cron republished `:latest` **ungated**, and there was no retained tagged fallback (`0.4.0`↓ had aged out, and `:0.5.0` itself drifted across rebuilds), so a broken upstream Beeper could silently become the live image with no easy rollback.

- **R-REL1 — gate.** The release path (tag push / weekly cron / dispatch) is now `prepare → verify → publish`. `verify` builds the image and runs the shared guard scripts against it; `publish` runs **only if `verify` passed**. A failed gate skips the publish (previous `:latest` stays live as last-known-good) and `notify-failure` flags it.
- **R-REL2 — rollback.** Each publish first rolls the current `:latest` to `:previous` (server-side manifest copy, no rebuild). Recover with `BEEPERBOX_IMAGE_TAG=previous`; a **digest** pin is the bit-exact anchor.
- **R-REL3 — no drift.** `scripts/mcp-guard-check.sh` + `scripts/vnc-auth-check.sh` are the single source of truth for both the PR workflows and the release gate. The gate sources them from the **latest workflow ref** (not the release ref), so the weekly rebuild of an older tag that predates the scripts still runs the current black-box checks.
- **Acceptance (verified end-to-end via `workflow_dispatch`):** a dispatch whose build ref lacked the scripts correctly **failed the gate and skipped publish** (`notify-failure` fired, `:latest` untouched); after R-REL3, a dispatch **passed the gate, published, and created `:previous`** — both `:latest` and `:previous` confirmed multi-arch on GHCR.
- **Limitation:** the gate runs the MCP server standalone (no live Beeper), so it can't catch Beeper API-shape drift breaking the normalizers — `:previous` is the safety net. `:edge` (master pushes) is ungated by design.

## Open items / follow-up

- None blocking. All HIGH and actionable MEDIUM/LOW findings resolved; accepted-by-design residuals documented in CHANGELOG "Security review: closed".
- ~~**Gate the weekly `:latest` rebuild + keep a known-good fallback**~~ — done (safe-rolling-releases addendum above).
- ~~**M2 — AppImage integrity**~~ — done (opt-in pinning above).
- ~~**H3 — VNC `-nopw`**~~ — done (see VNC addendum above).
- ~~**CI functional test**~~ — done: `mcp-test.yml` (MCP guard matrix + image build) and `vnc-test.yml` (RFB security-type probe), both `workflow_dispatch` + path-scoped `pull_request`.

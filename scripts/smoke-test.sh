#!/bin/bash
# smoke-test.sh — build, run, wait for healthy, probe /v1/info, assert PASS/FAIL
#
# Usage: ./scripts/smoke-test.sh
#   Env: BEEPERBOX_HOST_PORT=23373  (host-side API port, default 23373)
#        MAX_WAIT=180               (seconds to wait for (healthy) status)
#
# BEEPERBOX_HOST_PORT is propagated to docker compose so the container is
# actually published on the same port the script then probes.
set -e

export BEEPERBOX_HOST_PORT="${BEEPERBOX_HOST_PORT:-23373}"
MAX_WAIT="${MAX_WAIT:-180}"

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
pass() { printf '\033[1;32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$1"; exit 1; }

step "1/4  build image"
docker compose build >/dev/null
pass "image built"

step "2/4  start container"
docker compose up -d >/dev/null
pass "container started"

step "3/4  wait for (healthy) — up to ${MAX_WAIT}s"
deadline=$(( $(date +%s) + MAX_WAIT ))
while true; do
  status=$(docker inspect beeperbox --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  case "$status" in
    healthy)  pass "container is healthy"; break ;;
    unhealthy) fail "container reports unhealthy — docker inspect beeperbox for details" ;;
    starting|missing) : ;;
    *) fail "unknown health status: $status" ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "timeout waiting for healthy (last status: $status)"
  fi
  sleep 5
done

step "4/4  probe http://localhost:${BEEPERBOX_HOST_PORT}/v1/info"
body=$(curl -sf "http://localhost:${BEEPERBOX_HOST_PORT}/v1/info") || fail "curl failed — API not reachable on :${BEEPERBOX_HOST_PORT}"
echo "$body" | grep -q '"status":"running"' || fail "/v1/info did not report server running — got: $body"
pass "/v1/info returns server running"

printf '\n\033[1;32mall checks passed\033[0m — POC is healthy\n\n'

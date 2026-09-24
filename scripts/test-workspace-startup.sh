#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wait-for-workspace.sh"

prefix="desktop-startup-test-$$"
cleanup() {
    docker rm -f "$prefix-ready" "$prefix-stopped" "$prefix-timeout" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Ready containers need not produce another log line (or any output at all).
docker run -d --name "$prefix-ready" --entrypoint sh node:22.14.0-slim -c \
    'mkdir -p /workspace; sleep 1; touch /workspace/.initial-setup-complete; exec tail -f /dev/null' >/dev/null
WORKSPACE_SETUP_TIMEOUT=10 wait_for_workspace "$prefix-ready"
[ -z "$(docker logs "$prefix-ready")" ]
echo "PASS: silent container becomes ready without waiting for log output"

docker run -d --name "$prefix-stopped" --entrypoint sh node:22.14.0-slim -c \
    'echo intentional-setup-failure; exit 9' >/dev/null
if output=$(WORKSPACE_SETUP_TIMEOUT=10 wait_for_workspace "$prefix-stopped" 2>&1); then
    echo "FAIL: stopped container was treated as ready" >&2
    exit 1
fi
[[ "$output" == *"Container stopped"* && "$output" == *"intentional-setup-failure"* ]]
echo "PASS: setup failure reports container logs and returns an error"

docker run -d --name "$prefix-timeout" --entrypoint sh node:22.14.0-slim -c \
    'exec tail -f /dev/null' >/dev/null
if output=$(WORKSPACE_SETUP_TIMEOUT=2 wait_for_workspace "$prefix-timeout" 2>&1); then
    echo "FAIL: unready container was treated as ready" >&2
    exit 1
fi
[[ "$output" == *"Timed out"* ]]
echo "PASS: silent setup timeout returns an error"

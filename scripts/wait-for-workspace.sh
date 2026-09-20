#!/bin/bash

# Sourced by both launchers. A log-follow pipeline can keep waiting for another
# log write after its reader sees the ready line and exits.
wait_for_workspace() {
    local container="$1"
    local deadline=$((SECONDS + ${WORKSPACE_SETUP_TIMEOUT:-300}))

    while [ "$SECONDS" -lt "$deadline" ]; do
        if docker exec "$container" test -f /workspace/.initial-setup-complete 2>/dev/null; then
            return 0
        fi
        if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
            echo "❌ Container stopped during repository setup" >&2
            docker logs --tail 40 "$container" >&2
            return 1
        fi
        sleep 1
    done

    echo "❌ Timed out waiting for repository setup in $container" >&2
    docker logs --tail 40 "$container" >&2
    return 1
}

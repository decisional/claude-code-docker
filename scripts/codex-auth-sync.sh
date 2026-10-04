#!/bin/bash
# Shared Codex CLI credential sync.
#
# Every container bind-mounts the repository's codex-data directory at
# /home/node/.codex, so a single write to codex-data/auth.json reaches every
# running container at once. The host keeps its session in ~/.codex/auth.json.
#
# Source this file and call sync_codex_credentials. It is sourced by cc-start,
# codex-start, and cc-auth alongside the Claude Code sync.

CODEX_AUTH_HOST_FILE="$HOME/.codex/auth.json"

# Usable means either a ChatGPT session with a refresh token or an API key.
codex_auth_credentials_are_valid() {
    local file="$1"

    [ -f "$file" ] || return 1
    jq -e '
        ((.tokens.refresh_token | type == "string" and length > 20)
         or (.OPENAI_API_KEY | type == "string" and length > 20))
    ' "$file" >/dev/null 2>&1
}

codex_auth_last_refresh() {
    jq -r '.last_refresh // ""' "$1" 2>/dev/null || echo ""
}

# Codex rotates the refresh token when it refreshes, so whichever side refreshed
# last holds the only working copy. Only overwrite the shared file when the host
# session is newer, or when the container session is unusable.
sync_codex_credentials() {
    local credentials_dir="${1:-$SCRIPT_DIR/codex-data}"
    local credentials_file="$credentials_dir/auth.json"
    local temporary_file
    local host_refresh
    local shared_refresh

    if ! codex_auth_credentials_are_valid "$CODEX_AUTH_HOST_FILE"; then
        if codex_auth_credentials_are_valid "$credentials_file"; then
            echo "  ⚠ No usable host Codex session; keeping the existing container session."
        else
            echo "  ⚠ No usable Codex session on the host or in the containers."
            echo "    Run 'codex login' on the host, then re-run this command."
        fi
        return 0
    fi

    mkdir -p "$credentials_dir"

    if codex_auth_credentials_are_valid "$credentials_file"; then
        host_refresh=$(codex_auth_last_refresh "$CODEX_AUTH_HOST_FILE")
        shared_refresh=$(codex_auth_last_refresh "$credentials_file")
        # ISO-8601 UTC timestamps compare correctly as strings.
        if [[ ! "$host_refresh" > "$shared_refresh" ]]; then
            echo "  ✓ Container Codex session is current; left it in place"
            return 0
        fi
    fi

    temporary_file=$(mktemp "$credentials_dir/auth.json.tmp.XXXXXX")
    cp "$CODEX_AUTH_HOST_FILE" "$temporary_file"
    chmod 600 "$temporary_file"
    mv -f "$temporary_file" "$credentials_file"
    echo "  ✓ Synced Codex authentication from the host"
    return 0
}

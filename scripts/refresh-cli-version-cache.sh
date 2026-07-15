#!/bin/bash
# Source this file from cc-start or codex-start. It refreshes both CLI versions
# at most once per UTC day and exposes LATEST_CLAUDE_CODE_VERSION and
# LATEST_CODEX_VERSION to the caller.

CLI_VERSION_CACHE_DIR="${CLI_VERSION_CACHE_DIR:-$SCRIPT_DIR/runtime-data}"
CLI_VERSION_CACHE_FILE="$CLI_VERSION_CACHE_DIR/cli-versions.env"
CLI_VERSION_CACHE_LOCK="$CLI_VERSION_CACHE_DIR/.cli-versions.lock"
CLI_VERSION_CACHE_DATE="$(date -u +%F)"

load_cli_version_cache() {
    LATEST_CLAUDE_CODE_VERSION=""
    LATEST_CODEX_VERSION=""
    CLI_VERSION_CACHE_CHECKED_ON=""

    if [ -f "$CLI_VERSION_CACHE_FILE" ]; then
        # This file is written only by this script with validated version values.
        # shellcheck disable=SC1090
        source "$CLI_VERSION_CACHE_FILE"
    fi
}

valid_version() {
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]
}

write_cli_version_cache() {
    local temporary_file
    temporary_file=$(mktemp "$CLI_VERSION_CACHE_DIR/.cli-versions.env.XXXXXX")
    {
        printf 'CLI_VERSION_CACHE_CHECKED_ON=%q\n' "$CLI_VERSION_CACHE_DATE"
        printf 'LATEST_CLAUDE_CODE_VERSION=%q\n' "$LATEST_CLAUDE_CODE_VERSION"
        printf 'LATEST_CODEX_VERSION=%q\n' "$LATEST_CODEX_VERSION"
    } >"$temporary_file"
    mv -f "$temporary_file" "$CLI_VERSION_CACHE_FILE"
}

mkdir -p "$CLI_VERSION_CACHE_DIR"
load_cli_version_cache

if [ "$CLI_VERSION_CACHE_CHECKED_ON" != "$CLI_VERSION_CACHE_DATE" ]; then
    if mkdir "$CLI_VERSION_CACHE_LOCK" 2>/dev/null; then
        # Another launcher may have completed the refresh while this one waited
        # for the lock, so always read the cache again after acquiring it.
        load_cli_version_cache
        if [ "$CLI_VERSION_CACHE_CHECKED_ON" != "$CLI_VERSION_CACHE_DATE" ]; then
            previous_claude_version="$LATEST_CLAUDE_CODE_VERSION"
            previous_codex_version="$LATEST_CODEX_VERSION"
            latest_claude_version=$(curl -fsSL --connect-timeout 3 --max-time 6 \
                'https://downloads.claude.ai/claude-code-releases/latest' 2>/dev/null || true)
            latest_codex_version=$(npm view @openai/codex version --fetch-timeout=5000 --fetch-retries=0 2>/dev/null || true)

            if valid_version "$latest_claude_version"; then
                LATEST_CLAUDE_CODE_VERSION="$latest_claude_version"
            else
                LATEST_CLAUDE_CODE_VERSION="$previous_claude_version"
            fi
            if valid_version "$latest_codex_version"; then
                LATEST_CODEX_VERSION="$latest_codex_version"
            else
                LATEST_CODEX_VERSION="$previous_codex_version"
            fi

            CLI_VERSION_CACHE_CHECKED_ON="$CLI_VERSION_CACHE_DATE"
            write_cli_version_cache
        fi
        rmdir "$CLI_VERSION_CACHE_LOCK"
    fi
fi

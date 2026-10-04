#!/bin/bash
# Shared Claude Code credential sync.
#
# Claude Code on macOS keeps its OAuth session in Keychain rather than
# ~/.claude/.credentials.json. Every container bind-mounts the repository's
# claude-data directory at /home/node/.claude, so a single write to
# claude-data/.credentials.json reaches every running container at once.
#
# Source this file and call sync_claude_credentials. It is sourced by cc-start,
# codex-start, and the standalone cc-auth command so that launching any
# container refreshes the session for all of them.

CLAUDE_AUTH_KEYCHAIN_SERVICE="Claude Code-credentials"
CLAUDE_AUTH_CONTAINER_IMAGE_PREFIX="llm-docker-claude-code"

# A credential is only usable when both tokens are present. The previous check
# accepted any JSON object, so a blanked-out file (empty accessToken, empty
# refreshToken, expiresAt 0) counted as valid and silently stranded every
# container sharing it.
claude_auth_credentials_are_valid() {
    local file="$1"

    [ -f "$file" ] || return 1
    jq -e '
        .claudeAiOauth
        | (.accessToken  | type == "string" and length > 20)
          and (.refreshToken | type == "string" and length > 20)
    ' "$file" >/dev/null 2>&1
}

claude_auth_expires_at() {
    local file="$1"
    jq -r '.claudeAiOauth.expiresAt // 0' "$file" 2>/dev/null || echo 0
}

# Identifies a credential without printing the secret, for change detection and
# for comparing what a container sees against what the host holds.
claude_auth_fingerprint() {
    local file="$1"
    jq -r '.claudeAiOauth.accessToken // "" | if length > 12 then .[-12:] else "none" end' \
        "$file" 2>/dev/null || echo "none"
}

claude_auth_read_keychain() {
    local destination="$1"

    security find-generic-password -s "$CLAUDE_AUTH_KEYCHAIN_SERVICE" -w >"$destination" 2>/dev/null || return 1
    claude_auth_credentials_are_valid "$destination" || return 1
    return 0
}

# Lists every running container built from the Claude Code image, so a refresh
# fans out to Codex-flavoured instances too — they mount claude-data as well.
claude_auth_running_containers() {
    docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null \
        | awk -F'\t' -v prefix="$CLAUDE_AUTH_CONTAINER_IMAGE_PREFIX" \
            'index($2, prefix) == 1 { print $1 }'
}

# Claude keeps the account name shown by `claude auth status` in ~/.claude.json
# rather than in the credential file. Preserve the container's other settings
# but replace the cached profile so it cannot display a stale account.
#
# hasCompletedOnboarding travels with the profile: Claude clears it when the
# signed-in account changes, and an unset flag sends the interactive CLI into
# the first-run wizard (which reads as a login prompt) even though the synced
# token is valid. Track the host's flag so a container cannot get stranded there.
claude_auth_sync_profile() {
    local credentials_dir="$1"
    local host_profile_file="$HOME/.claude.json"
    local container_profile_file="$credentials_dir/.claude.json"
    local temporary_profile_file

    [ -f "$host_profile_file" ] || return 0
    jq -e '.oauthAccount | type == "object"' "$host_profile_file" >/dev/null 2>&1 || return 0

    temporary_profile_file=$(mktemp "$credentials_dir/.claude.json.tmp.XXXXXX")
    if [ -f "$container_profile_file" ]; then
        jq --slurpfile host_profile "$host_profile_file" \
            '.oauthAccount = $host_profile[0].oauthAccount
             | .hasCompletedOnboarding = ($host_profile[0].hasCompletedOnboarding // false)' \
            "$container_profile_file" >"$temporary_profile_file" 2>/dev/null || true
    else
        jq '{oauthAccount: .oauthAccount,
             hasCompletedOnboarding: (.hasCompletedOnboarding // false)}' \
            "$host_profile_file" >"$temporary_profile_file" 2>/dev/null || true
    fi

    if jq -e '.oauthAccount | type == "object"' "$temporary_profile_file" >/dev/null 2>&1; then
        chmod 600 "$temporary_profile_file"
        mv -f "$temporary_profile_file" "$container_profile_file"
    else
        rm -f "$temporary_profile_file"
    fi
    return 0
}

# Pushes the shared credential into any running container that is not already
# seeing it. Containers that bind-mount claude-data pick the write up for free;
# the copy is the fallback for an instance mounting its own credential file.
claude_auth_fan_out() {
    local credentials_file="$1"
    local expected_fingerprint
    local container
    local container_fingerprint
    local refreshed=0
    local already=0

    expected_fingerprint=$(claude_auth_fingerprint "$credentials_file")

    while IFS= read -r container; do
        [ -n "$container" ] || continue
        container_fingerprint=$(docker exec "$container" sh -lc \
            'jq -r ".claudeAiOauth.accessToken // \"\" | if length > 12 then .[-12:] else \"none\" end" /home/node/.claude/.credentials.json 2>/dev/null' \
            2>/dev/null | tr -d '\r\n') || container_fingerprint=""

        if [ "$container_fingerprint" = "$expected_fingerprint" ]; then
            already=$((already + 1))
            continue
        fi

        if docker cp "$credentials_file" "${container}:/home/node/.claude/.credentials.json" >/dev/null 2>&1; then
            docker exec "$container" sh -lc 'chmod 600 /home/node/.claude/.credentials.json' >/dev/null 2>&1 || true
            refreshed=$((refreshed + 1))
        else
            echo "  ⚠ Could not refresh $container"
        fi
    done <<<"$(claude_auth_running_containers)"

    if [ "$((refreshed + already))" -gt 0 ]; then
        echo "  ✓ Session live in $((refreshed + already)) running container(s)"
    fi
    return 0
}

# Refresh the mounted credential before every start/attach so containers follow
# the account currently signed in on the host, then fan the result out to every
# running instance.
sync_claude_credentials() {
    local credentials_dir="${1:-$SCRIPT_DIR/claude-data}"
    local credentials_file="$credentials_dir/.credentials.json"
    local keychain_file
    local on_disk_expiry
    local keychain_expiry
    local on_disk_valid="false"

    mkdir -p "$credentials_dir"
    keychain_file=$(mktemp "$credentials_dir/.credentials.json.tmp.XXXXXX")

    if ! claude_auth_read_keychain "$keychain_file"; then
        rm -f "$keychain_file"
        if claude_auth_credentials_are_valid "$credentials_file"; then
            echo "  ⚠ Could not read a valid host Claude Code session from Keychain; keeping the existing container session."
        else
            echo "  ⚠ Could not read the host Claude Code session from Keychain, and the container session is blank."
            echo "    Run 'claude /login' on the host, then re-run this command."
        fi
        return 0
    fi

    claude_auth_credentials_are_valid "$credentials_file" && on_disk_valid="true"

    # A container that refreshes its token rotates the refresh token, leaving the
    # host Keychain copy stale. Writing that stale copy back is what blanks the
    # shared credential: the next refresh fails and Claude clears both tokens. So
    # only overwrite when the host session is genuinely newer, or when the
    # container session is unusable.
    if [ "$on_disk_valid" = "true" ]; then
        on_disk_expiry=$(claude_auth_expires_at "$credentials_file")
        keychain_expiry=$(claude_auth_expires_at "$keychain_file")
        if [ "$on_disk_expiry" -gt "$keychain_expiry" ] 2>/dev/null; then
            rm -f "$keychain_file"
            echo "  ✓ Container Claude Code session is newer than the host's; left it in place"
            claude_auth_sync_profile "$credentials_dir"
            claude_auth_fan_out "$credentials_file"
            return 0
        fi
    fi

    chmod 600 "$keychain_file"
    mv -f "$keychain_file" "$credentials_file"

    if [ "$on_disk_valid" = "true" ]; then
        echo "  ✓ Synced Claude Code authentication from the host"
    else
        echo "  ✓ Repaired a blank container session with the host's Claude Code authentication"
    fi

    claude_auth_sync_profile "$credentials_dir"
    claude_auth_fan_out "$credentials_file"
    return 0
}

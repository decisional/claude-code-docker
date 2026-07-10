#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

extract_docker_arg() {
    local variable_name="$1"
    sed -nE "s/^ARG ${variable_name}=([^[:space:]]+)$/\\1/p" "$ROOT_DIR/Dockerfile"
}

extract_shell_default() {
    local variable_name="$1"
    local file_path="$2"
    sed -nE "s/^${variable_name}=\"\\\$\\{${variable_name}:-([^}]+)\\}\"$/\\1/p" "$file_path"
}

check_pin() {
    local display_name="$1"
    local variable_name="$2"
    local start_script="$3"
    local docker_version
    local build_version
    local start_version

    docker_version="$(extract_docker_arg "$variable_name")"
    build_version="$(extract_shell_default "$variable_name" "$ROOT_DIR/build.sh")"
    start_version="$(extract_shell_default "$variable_name" "$ROOT_DIR/$start_script")"

    if [ -z "$docker_version" ] || [ -z "$build_version" ] || [ -z "$start_version" ]; then
        echo "Could not extract every $display_name version pin" >&2
        echo "  Dockerfile: ${docker_version:-missing}" >&2
        echo "  build.sh:   ${build_version:-missing}" >&2
        echo "  $start_script: ${start_version:-missing}" >&2
        return 1
    fi

    if [ "$docker_version" != "$build_version" ] || [ "$docker_version" != "$start_version" ]; then
        echo "$display_name version pins do not match" >&2
        echo "  Dockerfile: $docker_version" >&2
        echo "  build.sh:   $build_version" >&2
        echo "  $start_script: $start_version" >&2
        return 1
    fi

    echo "✓ $display_name version pin: $docker_version"
}

check_pin "Claude Code CLI" "CLAUDE_CODE_VERSION" "cc-start"
check_pin "Codex CLI" "CODEX_VERSION" "codex-start"
